import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { builtinTools } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { QuestionStore } from '../src/questions/store.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { actRoute } from '../src/tools/browser/checks.ts';
import { elementFacts, PlaywrightBrowser, type LaunchOptions, type WorkContextOptions } from '../src/tools/browser/driver.ts';
import { navigationMethodVerdict, type SendGuard, type SubmitPermit } from '../src/tools/browser/route.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { ownerHostAllows, ownerLoopbackPorts } from '../src/tools/browser/sites.ts';
import { BackgroundJobs } from '../src/tools/shell/background.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';
import { BROWSER_TOOLS, browserClick, browserOpen, browserRead, browserType } from '../src/tools/builtin/browser.ts';
import { outboundOfCall } from '../src/tools/hooks/outbound.ts';
import { planAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { PreCheck, ToolContext } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { tempDir, testConfig, withLoad, type Script } from './helpers.ts';
import { FakeBrowserDriver, type FakePage, type FakeSite } from './helpers/fake-browser.ts';

// 9-1b: 押す・入れるの決め方（Approach 4 の 6 つの順・送信の見分け D-5・持ち主の URL D-7・送信の守り D-8）。
// 脅威の表の T11〜T16・T19。判定役の呼び出しの数・pending_actions の行・questions の行を数える。本物のブラウザは起動しない

const LISTED = 'https://example.com/form';
const UNLISTED = 'https://shop.example.org/form';
const DEV = 'http://localhost:5173/';
// 試しの beat のような、許されたループバックだが、その実行の開発サーバーではないポート
const OTHER_LOOP = 'http://localhost:4900/';
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const SNAPSHOT = ['- textbox "Search"', '- button "Send"', '- link "More"', '- textbox "Password"'].join('\n');
// e1 Search / e2 Send（フォームの送信）/ e3 More（送信でない）/ e4 Password
const site = (over: { moreSubmits?: boolean } = {}): FakeSite => ({
  title: 'Form', text: 'form', snapshot: SNAPSHOT,
  rows: [
    { role: 'textbox', name: 'Search' },
    { role: 'button', name: 'Send', submits: true },
    { role: 'link', name: 'More', submits: over.moreSubmits === true },
    { role: 'textbox', name: 'Password', type: 'password' },
  ],
});

type Kind = 'chat' | 'task' | 'agent';
interface RigOptions {
  kind?: Kind;
  product?: boolean;
  ownerText?: readonly string[];
  judge?: 'allow' | 'ask';
  // 判定役が呼ばれたときに動かす（ページの入れ替えなど）
  onJudge?: () => void;
  parentKind?: 'chat' | 'task';
  // この会話・タスクの裏のコマンドが出力に出したループバックのポート
  printed?: readonly number[];
  // 本物の裏のコマンドの入れ物（止めたポートの試し）。無ければ printed の作り物
  background?: BackgroundJobs;
}

function rig(t: TestContext, options: RigOptions = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.sites = ['example.com'];
  const parsed = parseConfig(config);
  const driver = new FakeBrowserDriver().site(LISTED, site()).site(UNLISTED, site()).site(DEV, site()).site(OTHER_LOOP, site());
  const session = new BrowserSession({ driver, config: () => parsed, paths: { browserProfile: 'C:\\data\\browser-profile' }, secrets: () => [], canShowWindow: () => true });
  t.after(() => session.close());
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry();
  for (const def of BROWSER_TOOLS) registry.register(def as never);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const questions = new QuestionStore(db);
  const tasks = new TaskStore(db);
  const task = tasks.create({ title: 'Web job', origin: 'user', actor: 'user' });
  const policy = buildPolicy(parsed, paths);
  const kind = options.kind ?? 'chat';
  const ctxFor = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: kind === 'chat' ? 'c1' : `c-${kind}`, kind, signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
    services: { browser: session, questions, tasks, background: options.background ?? { printedPorts: () => new Set(options.printed ?? []) } }, model: { id: 'm', vision: true },
    ownerText: () => [...(options.ownerText ?? [])],
    ...(kind === 'task' ? { task: { id: task.id, control: { kind: 'none' } } } : {}),
    ...(kind === 'agent' ? { parent: { runId: 'rp', conversationId: 'c1', kind: options.parentKind ?? 'task', title: '', ...(options.parentKind === 'chat' ? {} : { taskId: task.id }) } } : {}),
    ...(options.product ? { project: { id: 'p1', root: 'C:\\work\\shop' } } : {}),
    ...over,
  } as unknown as ToolContext);
  const ctx = ctxFor();
  let judged = 0;
  const call = (name: string, args: unknown, callCtx: ToolContext = ctx) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, callCtx, {
    registry, approvals, pending, db, emit: () => undefined, permissionMode: () => 'auto',
    autoClassify: async () => { judged += 1; options.onJudge?.(); return `{"decision":"${options.judge ?? 'ask'}","reason":"test judge"}`; },
    lastUserRequest: () => 'フォームを見て', conversationTainted: () => false,
  });
  const approve = (id: number) => replayAction(pending.claim(id), {
    db, store: pending, registry, config: () => parsed, paths, conversationExists: () => true, services: () => ({ browser: session }) as ToolContext['services'],
  });
  const pages = (): FakePage[] => [...driver.browsers.flatMap(b => b.pageList), ...driver.workBrowsers.flatMap(w => w.contexts.flatMap(c => c.pageList))];
  const counts = () => ({
    judge: judged,
    judgeRows: (db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n,
    pending: pending.list({ status: 'waiting' }).map(row => row.kind),
    questions: (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE kind = 'submit_refused'").get() as { n: number }).n,
    acts: pages().reduce((n, page) => n + page.acts.length, 0),
  });
  const open = async (url: string): Promise<FakePage> => {
    const out = await browserOpen.execute({ url }, ctx);
    assert.equal(out.isError, undefined, out.content);
    return pages().find(page => page.url() === url)!;
  };
  return { ctx, ctxFor, call, approve, counts, open, pages, driver, session, pending, db, task };
}

const preCheck = (tool: typeof browserClick | typeof browserType, input: unknown, ctx: ToolContext) => (tool.preCheck as (i: unknown, c: ToolContext) => Promise<PreCheck>)(input, ctx);
const NONE = { judge: 0, judgeRows: 0, pending: [] as string[], questions: 0 };

// ── Approach 4 の順 1: 今までの拒否（秘密の欄）は、判定役・Pending・質問票より前 ──

test('順 1: 秘密の欄は、一覧のサイトでも一覧に無いサイトでも、会話でもタスクでも断る（判定役 0・Pending 0・質問 0・押さない）', async t => {
  for (const kind of ['chat', 'task'] as const) {
    for (const url of [LISTED, UNLISTED]) {
      const r = rig(t, { kind, judge: 'allow' });
      await r.open(url);
      const outcome = await r.call('browser_type', { ref: 'e4', text: 'hunter2' });
      assert.equal(outcome.decision, 'deny', `${kind} ${url}`);
      assert.deepEqual(r.counts(), { ...NONE, acts: 0 }, `${kind} ${url}`);
    }
  }
});

// ── 順 2: 許されたループバック（開発サーバー）は、送信も判定役なし ──

test('順 2: 製品の会話・タスクの開発サーバー（持ち主が書いたポート・裏のコマンドが出したポート）では、送信の押すも判定役なしで押せる。許しは loopback', async t => {
  for (const [kind, over] of [['chat', { ownerText: ['http://localhost:5173 を見て'] }], ['task', { ownerText: ['127.0.0.1:5173'] }], ['task', { printed: [5173] }], ['agent', { printed: [5173] }]] as const) {
    const r = rig(t, { kind, product: true, judge: 'ask', ...over });
    const page = await r.open(DEV);
    const check = await preCheck(browserClick, { ref: 'e2' }, r.ctx);
    assert.deepEqual([check.decision, check.submits, check.sends], ['allow', undefined, undefined], kind);
    const outcome = await r.call('browser_click', { ref: 'e2' });
    assert.equal(outcome.decision, 'allow', `${kind}: ${outcome.output.content}`);
    assert.deepEqual(r.counts(), { ...NONE, acts: 1 }, kind);
    assert.equal(page.acts[0]!.permit, 'loopback');
    assert.equal(page.permit, undefined, '押し終えたら外す');
    assert.match((await browserRead.execute({}, r.ctx)).content, /dev server on this PC/u, '読んだ結果の終わりに開発サーバーだと書く');
  }
});

// ── R-8（審査 9-1b）: その実行の開発サーバーでない許されたループバックは、一覧外の公開のサイトと同じ ──

test('R-8: 持ち主が書いていない・裏のコマンドが出していないループバックのポート（試しの beat など）は、送信でない押すは判定役へ、送信はタスクで断り会話で Pending', async t => {
  for (const over of [{}, { ownerText: ['http://localhost:5173 を見て'] }, { printed: [5173] }]) {
    const chat = rig(t, { product: true, judge: 'ask', ...over });
    await chat.open(OTHER_LOOP);
    assert.match((await browserRead.execute({}, chat.ctx)).content, /not this run's dev server/u);
    assert.equal((await chat.call('browser_click', { ref: 'e3' })).decidedBy, 'pending');
    assert.deepEqual(chat.counts(), { ...NONE, judge: 1, judgeRows: 1, pending: ['judge'], acts: 0 }, JSON.stringify(over));
    assert.equal((await chat.call('browser_click', { ref: 'e2' })).decidedBy, 'pending');
    assert.deepEqual([...chat.counts().pending].sort(), ['judge', 'send']);
    const task = rig(t, { kind: 'task', product: true, judge: 'allow', ...over });
    await task.open(OTHER_LOOP);
    const sent = await task.call('browser_click', { ref: 'e2' });
    assert.equal(sent.decision, 'deny');
    assert.deepEqual(task.counts(), { ...NONE, questions: 1, acts: 0 }, JSON.stringify(over));
    const page = task.pages()[0]!;
    assert.equal((await task.call('browser_click', { ref: 'e3' })).decision, 'allow', '判定役が allow なら押す');
    assert.deepEqual([task.counts().judge, page.acts.length, page.acts[0]!.permit], [1, 1, undefined], '開発サーバーでないので送信の許しは立てない');
  }
});

// ── 審査 9-1b: 入れる文が API の鍵・トークンに見えるとき ──

test('秘密に見える文: 一覧のサイト・持ち主の URL のサイト・開発サーバーでないループバックへは、会話でもタスクでも判定役なしで断り、押さない', async t => {
  for (const kind of ['chat', 'task'] as const) {
    for (const [url, over] of [[LISTED, {}], [UNLISTED, { ownerText: [UNLISTED] }], [OTHER_LOOP, { product: true }]] as const) {
      const r = rig(t, { kind, judge: 'allow', ...over });
      await r.open(url);
      for (const submit of [false, true]) {
        const outcome = await r.call('browser_type', { ref: 'e1', text: `key ${SECRET}`, submit });
        assert.equal(outcome.decision, 'deny', `${kind} ${url} ${submit}`);
      }
      const counts = r.counts();
      assert.deepEqual([counts.judge, counts.pending, counts.acts], [0, [], 0], `${kind} ${url}`);
      const direct = await browserType.execute({ ref: 'e1', text: SECRET }, r.ctx);
      assert.equal(direct.isError, true, '直接の実行でも入れない');
      assert.equal(r.counts().acts, 0);
    }
  }
});

test('秘密に見える文: その実行の開発サーバーへは判定役に見せる（聞かずには通さない）。ふつうの文は判定役なし', async t => {
  for (const kind of ['chat', 'task'] as const) {
    const r = rig(t, { kind, product: true, judge: 'ask', printed: [5173] });
    await r.open(DEV);
    assert.equal((await r.call('browser_type', { ref: 'e1', text: SECRET })).decidedBy, 'pending', kind);
    assert.deepEqual(r.counts(), { ...NONE, judge: 1, judgeRows: 1, pending: ['judge'], acts: 0 }, kind);
    assert.equal((await r.call('browser_type', { ref: 'e1', text: 'plain' })).decision, 'allow');
    assert.equal(r.counts().judge, 1);
  }
});

// ── 順 3: 送信（T11・T15） ──

test('順 3（T15）: 会話では、一覧のサイトでも一覧に無いサイトでも、送信は判定役なしで Pending の send に積まれ、押さない', async t => {
  for (const url of [LISTED, UNLISTED]) {
    for (const [name, args] of [['browser_click', { ref: 'e2' }], ['browser_type', { ref: 'e1', text: 'abc', submit: true }]] as const) {
      const r = rig(t, { judge: 'allow', ownerText: [`見て ${url}`] });
      await r.open(url);
      const outcome = await r.call(name, args);
      assert.equal(outcome.decidedBy, 'pending', `${url} ${name}`);
      assert.deepEqual(r.counts(), { ...NONE, pending: ['send'], acts: 0 }, `${url} ${name}`);
    }
  }
});

test('順 3（T11・T15）: タスク・子の担当の送信は、判定役なしで断り、質問票に submit_refused が 1 行、Pending は 0、押さない', async t => {
  for (const kind of ['task', 'agent'] as const) {
    for (const url of [LISTED, UNLISTED]) {
      for (const [name, args] of [['browser_click', { ref: 'e2' }], ['browser_type', { ref: 'e1', text: 'abc', submit: true }]] as const) {
        const r = rig(t, { kind, judge: 'allow', ownerText: [url] });
        await r.open(url);
        const outcome = await r.call(name, args);
        assert.equal(outcome.decision, 'deny', `${kind} ${url} ${name}`);
        assert.match(outcome.output.content, /submits in the browser, and nobody is watching this run/u);
        assert.deepEqual(r.counts(), { ...NONE, questions: 1, acts: 0 }, `${kind} ${url} ${name}`);
      }
    }
  }
});

test('順 3: 持ち主の会話から任された子の担当も、送信は断る（Pending に積まない。質問票の行はタスクが無いので作らない）', async t => {
  const r = rig(t, { kind: 'agent', parentKind: 'chat', judge: 'allow' });
  await r.open(LISTED);
  const outcome = await r.call('browser_click', { ref: 'e2' });
  assert.equal(outcome.decision, 'deny');
  assert.deepEqual(r.counts(), { ...NONE, acts: 0 });
});

// ── 順 4: 一覧のサイトの送信でない押す・入れる ──

test('順 4: 一覧のサイトの送信でない押す・入れる（Enter なし）は、会話でもタスクでも判定役なしで通る。送信の許しは立てない', async t => {
  for (const kind of ['chat', 'task', 'agent'] as const) {
    const r = rig(t, { kind, judge: 'ask' });
    const page = await r.open(LISTED);
    for (const [name, args] of [['browser_click', { ref: 'e3' }], ['browser_type', { ref: 'e1', text: 'abc' }]] as const) {
      const outcome = await r.call(name, args);
      assert.equal(outcome.decision, 'allow', `${kind} ${name}: ${outcome.output.content}`);
    }
    assert.deepEqual(r.counts(), { ...NONE, acts: 2 }, kind);
    assert.deepEqual(page.acts.map(act => [act.kind, act.submit, act.permit]), [['click', undefined, undefined], ['fill', false, undefined]]);
  }
});

// ── 順 5: 持ち主が書いた URL のホスト（D-7） ──

test('順 5: 一覧に無いサイトでも、持ち主が書いた URL のホストなら判定役なしで押せる。ホストは完全一致（親のドメイン・別のホストでは判定役へ）', async t => {
  const allowed = rig(t, { judge: 'ask', ownerText: ['このページを見て https://shop.example.org/ ほかは見ないで'] });
  await allowed.open(UNLISTED);
  assert.equal((await allowed.call('browser_click', { ref: 'e3' })).decision, 'allow');
  assert.deepEqual(allowed.counts(), { ...NONE, acts: 1 });
  for (const text of ['https://example.org/', 'https://www.shop.example.org/', 'shop.example.org（URL の形でない）', 'https://shop.example.org.evil.test/']) {
    const r = rig(t, { judge: 'ask', ownerText: [text] });
    await r.open(UNLISTED);
    const outcome = await r.call('browser_click', { ref: 'e3' });
    assert.equal(outcome.decidedBy, 'pending', text);
    assert.deepEqual(r.counts(), { ...NONE, judge: 1, judgeRows: 1, pending: ['judge'], acts: 0 }, text);
  }
});

// ── 順 6: そのほかは判定役 ──

test('順 6: 一覧に無いサイトの送信でない押すは判定役へ。allow なら押し、ask なら Pending の judge に積む（会話・タスクとも）', async t => {
  for (const kind of ['chat', 'task'] as const) {
    const yes = rig(t, { kind, judge: 'allow' });
    await yes.open(UNLISTED);
    const ran = await yes.call('browser_click', { ref: 'e3' });
    assert.deepEqual([ran.decision, ran.decidedBy], ['allow', 'auto-mode'], kind);
    assert.deepEqual(yes.counts(), { ...NONE, judge: 1, judgeRows: 1, acts: 1 }, kind);
    const no = rig(t, { kind, judge: 'ask' });
    await no.open(UNLISTED);
    const parked = await no.call('browser_type', { ref: 'e1', text: 'abc' });
    assert.equal(parked.decidedBy, 'pending', kind);
    assert.deepEqual(no.counts(), { ...NONE, judge: 1, judgeRows: 1, pending: ['judge'], acts: 0 }, kind);
  }
});

// ── T13: 判定のあいだ・承認のあいだに、押す先が送信の部品に入れ替わる ──

test('T13: 判定役のあいだに要素が送信の部品に変わると、会話は変わった旨で断り、タスクは送信として断って質問票に 1 行。どちらも押さない', async t => {
  for (const kind of ['chat', 'task'] as const) {
    let page: FakePage | undefined;
    const r = rig(t, { kind, judge: 'allow', onJudge: () => page!.mutate(site({ moreSubmits: true })) });
    page = await r.open(UNLISTED);
    const outcome = await r.call('browser_click', { ref: 'e3' });
    assert.equal(outcome.decision, 'deny', kind);
    if (kind === 'chat') {
      assert.match(outcome.output.content, /changed while/iu);
      assert.deepEqual(r.counts(), { ...NONE, judge: 1, judgeRows: 1, acts: 0 });
    } else {
      assert.match(outcome.output.content, /nobody is watching this run/u);
      assert.deepEqual(r.counts(), { ...NONE, judge: 1, judgeRows: 1, questions: 1, acts: 0 });
    }
  }
});

test('T13: 事前の判定のあとで送信の部品に変わったものは、act が押さない（承認なし・送信でない承認・タスクでの送信の承認）', async t => {
  const r = rig(t);
  const page = await r.open(UNLISTED);
  page.mutate(site({ moreSubmits: true }));
  for (const info of [undefined, { approvedOnce: true, check: { decision: 'ask' as const, reasons: [] } }]) {
    const out = await browserClick.execute({ ref: 'e3' }, r.ctx, info);
    assert.equal(out.isError, true);
    assert.match(out.content, /submit/iu);
  }
  const task = rig(t, { kind: 'task' });
  const taskPage = await task.open(UNLISTED);
  const out = await browserClick.execute({ ref: 'e2' }, task.ctx, { approvedOnce: true, check: { decision: 'ask', reasons: [], submits: true } });
  assert.equal(out.isError, true, 'タスクでは承認の印があっても送信を押さない');
  assert.equal(page.acts.length + taskPage.acts.length, 0);
});

test('T13: 判定役の ask で積んだ送信でない押すを、要素が送信に変わってから承認すると、古くなったとして押さない', async t => {
  const r = rig(t, { judge: 'ask' });
  const page = await r.open(UNLISTED);
  assert.equal((await r.call('browser_click', { ref: 'e3' })).decidedBy, 'pending');
  page.mutate(site({ moreSubmits: true }));
  const result = await r.approve(r.pending.list({ status: 'waiting' })[0]!.id);
  assert.notEqual(result.status, 'ran');
  assert.equal(page.acts.length, 0);
});

// ── T14: 持ち主の文の出どころ（engine/chat.ts と tasks/store.ts） ──

const callScript = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function engine(t: TestContext) {
  const driver = new FakeBrowserDriver().site(UNLISTED, site());
  const s = await startApp(t, {
    models: [fakeModel('m1')], browserDriver: driver, judge: '{"decision":"ask","reason":"check"}',
    configure: c => {
      c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.tools.policies = { browser_open: 'allow' };
      c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; c.worker.maxRunsPerHour = 100;
    },
  });
  const judged = () => (s.app.db.prepare("SELECT COUNT(*) AS n FROM judge_calls WHERE tool = 'browser_click'").get() as { n: number }).n;
  const clicks = () => [...driver.browsers.flatMap(b => b.pageList), ...driver.workBrowsers.flatMap(w => w.contexts.flatMap(c => c.pageList))].reduce((n, p) => n + p.acts.length, 0);
  return { s, driver, judged, clicks };
}

async function chatClick(t: TestContext, text: string, attachments: string[] = []) {
  const e = await engine(t);
  e.s.adapter().scripts = [callScript('browser_open', { url: UNLISTED }), callScript('browser_click', { ref: 'e3' }), async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  const id = uuid(91);
  e.s.app.conversations.create({ id, title: '会話' });
  const sent = await e.s.json(`/api/conversations/${id}/messages`, 'POST', { text, ...(attachments.length ? { attachments } : {}) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(e.s.app, sent.body.runId);
  return e;
}

test('T14: 会話で持ち主が書いた URL のホストでは判定役を呼ばずに押す。書いていなければ判定役を呼ぶ', async t => {
  const owner = await chatClick(t, `このページのボタンを押して ${UNLISTED}`);
  assert.deepEqual([owner.judged(), owner.clicks()], [0, 1]);
  const none = await chatClick(t, 'さっきのページのボタンを押して');
  assert.deepEqual([none.judged(), none.clicks()], [1, 0]);
});

test('T14: 添付のファイルの中にだけある URL は持ち主の URL にしない（判定役を呼ぶ）', async t => {
  const e = await engine(t);
  const upload = e.s.app.uploads.save({ name: 'notes.txt', mime: 'text/plain', body: Buffer.from(`visit ${UNLISTED} and press the button`) });
  e.s.adapter().scripts = [callScript('browser_open', { url: UNLISTED }), callScript('browser_click', { ref: 'e3' }), async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  const id = uuid(92);
  e.s.app.conversations.create({ id, title: '会話' });
  const sent = await e.s.json(`/api/conversations/${id}/messages`, 'POST', { text: '添付のページのボタンを押して', attachments: [upload.id] });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(e.s.app, sent.body.runId);
  assert.ok(e.s.app.conversations.messages(id).some(({ message }) => message.role === 'user' && message.content.includes(UNLISTED)), '添付の中身は発言に入っている');
  assert.deepEqual([e.judged(), e.clicks()], [1, 0]);
});

test('審査 9-1b: ask_owner の札への答え（選んだ札の文は AI が書いたもの）は持ち主の文に数えない。札の答えに URL があっても判定役を呼ぶ', async t => {
  const e = await engine(t);
  const id = uuid(93);
  e.s.app.conversations.create({ id, title: '会話' });
  e.s.adapter().scripts = [callScript('ask_owner', { questions: [{ question: 'Which page?', header: 'Page', options: [{ label: UNLISTED }, { label: 'none' }] }] })];
  const first = await e.s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ページを選ばせて' });
  assert.equal(first.status, 202);
  await settled(e.s.app, first.body.runId);
  e.s.adapter().scripts = [callScript('browser_open', { url: UNLISTED }), callScript('browser_click', { ref: 'e3' }), async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  const answer = await e.s.json(`/api/conversations/${id}/messages`, 'POST', { text: `Here are my answers:\n- Page: ${UNLISTED}` });
  assert.equal(answer.status, 202);
  await settled(e.s.app, answer.body.runId);
  const users = e.s.app.conversations.messages(id).filter(({ message }) => message.role === 'user').map(({ message }) => (message as { askAnswer?: true }).askAnswer === true);
  assert.deepEqual(users, [false, true], '札が開いているあいだの発言だけに印');
  assert.deepEqual([e.judged(), e.clicks()], [1, 0]);
  // 札に答えたあとに持ち主が自分で書いた発言は、今までどおり持ち主の文
  e.s.adapter().scripts = [callScript('browser_click', { ref: 'e3' }), async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  const own = await e.s.json(`/api/conversations/${id}/messages`, 'POST', { text: `${UNLISTED} のボタンを押して` });
  assert.equal(own.status, 202);
  await settled(e.s.app, own.body.runId);
  const marks = e.s.app.conversations.messages(id).filter(({ message }) => message.role === 'user').map(({ message }) => (message as { askAnswer?: true }).askAnswer === true);
  assert.deepEqual(marks, [false, true, false]);
  assert.deepEqual([e.judged(), e.clicks()], [1, 1]);
});

async function taskClick(t: TestContext, create: Parameters<TaskStore['create']>[0]) {
  const e = await engine(t);
  const task = e.s.app.tasks.create(create);
  e.s.adapter().scripts = [callScript('browser_open', { url: UNLISTED }), callScript('browser_click', { ref: 'e3' }), callScript('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c' })];
  assert.equal(await e.s.app.worker.tick(), 'ran');
  return { ...e, task };
}

test('T14: タスクは持ち主の頼み（owner_request）の URL だけを持ち主の URL にする。AI が作ったタスクの本文・外を読んだ出どころの頼みでは判定役を呼ぶ', async t => {
  const owner = await taskClick(t, { title: 'Press the button', body: `Open ${UNLISTED} and press More`, origin: 'user', ownerRequest: true, actor: 'user' });
  assert.deepEqual([owner.judged(), owner.clicks()], [0, 1], '持ち主の頼み');
  // 会話の AI が task_create で作ったタスク（持ち主の頼みの印なし）
  const ai = await taskClick(t, { title: 'Press the button', body: `Open ${UNLISTED} and press More`, origin: 'user', actor: 'beat' });
  assert.deepEqual([ai.judged(), ai.clicks()], [1, 0], 'AI が作ったタスク');
  const outside = await taskClick(t, { title: 'Press the button', body: `Open ${UNLISTED} and press More`, origin: 'user', ownerRequest: true, ownerPlanOutside: true, ownerPlan: 'plan', actor: 'user' });
  assert.deepEqual([outside.judged(), outside.clicks()], [1, 0], '外を読んだ出どころの頼み');
});

test('ownerRequestText: 題・本文・終わりの条件だけ。計画の抜き書き・受け入れの項目・outside の頼み・持ち主の頼みの無いタスクは入れない。子のタスクは親の頼みを使う', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const tasks = new TaskStore(db);
  const plain = tasks.create({ title: 'T', body: 'see https://a.example/', doneCriteria: 'done when https://b.example/ works', origin: 'user', ownerRequest: true, actor: 'user' });
  const text = tasks.ownerRequestText(plain.id)!;
  assert.ok(text.includes('https://a.example/') && text.includes('https://b.example/') && text.includes('T'));
  const planned = tasks.create({ title: 'P', body: 'b', origin: 'user', ownerRequest: true, ownerPlan: 'plan https://plan.example/', ownerItems: ['item https://item.example/'], acceptanceItems: ['item https://item.example/'], actor: 'user' });
  const plannedText = tasks.ownerRequestText(planned.id) ?? '';
  assert.ok(!plannedText.includes('plan.example') && !plannedText.includes('item.example'), plannedText);
  assert.equal(tasks.ownerRequestText(tasks.create({ title: 'O', body: 'https://o.example/', origin: 'user', ownerRequest: true, ownerPlanOutside: true, ownerPlan: 'x', actor: 'user' }).id), undefined);
  assert.equal(tasks.ownerRequestText(tasks.create({ title: 'AI', body: 'https://ai.example/', origin: 'self', actor: 'beat' }).id), undefined);
  // 採った提案（AI が書いた題・本文）は、持ち主が承認しても持ち主の文に数えない。判定役の依頼は今までどおり（審査 9-1b）
  const proposal = tasks.create({ title: 'Check https://proposal.example/', body: 'AI wrote this', origin: 'self', propose: true, actor: 'beat' });
  tasks.approve(proposal.id);
  assert.equal(tasks.ownerRequestText(proposal.id), undefined);
  assert.match(tasks.judgeRequest(proposal.id), /proposal\.example/u);
  const child = tasks.create({ title: 'child https://child.example/', origin: 'user', spawnedBy: plain.id, actor: 'beat' });
  const childText = tasks.ownerRequestText(child.id) ?? '';
  assert.ok(childText.includes('https://a.example/') && !childText.includes('child.example'), childText);
  t.after(() => db.close());
});

test('ownerLoopbackPorts: localhost / 127.0.0.1 / [::1] にポートを付けた書き方だけ（http:// は有っても無くても）', () => {
  assert.deepEqual([...ownerLoopbackPorts(['open http://localhost:5173/ and 127.0.0.1:8080 and http://[::1]:3000/x'])].sort(), [3000, 5173, 8080]);
  assert.deepEqual([...ownerLoopbackPorts(['localhost', 'http://localhost/', 'mylocalhost:5173', 'evil.localhost:5174', 'localhost:99999', 'https://example.com:5175/'])], []);
  assert.deepEqual([...ownerLoopbackPorts([])], []);
});

test('actRoute: 開発サーバーでないループバックは、持ち主の文や一覧にそのホストがあっても判定役へ（127.0.0.10 のようにホストの決めに残る書き方）', () => {
  assert.equal(actRoute({ place: 'loopback', submits: false, pageUrl: 'http://127.0.0.10:9999/' }, [], ['http://127.0.0.10:8080/'], false), 'judge');
  assert.equal(actRoute({ place: 'loopback', submits: false, pageUrl: 'http://127.0.0.10:9999/' }, ['127.0.0.10'], [], false), 'judge');
});

test('BackgroundJobs.printedPorts: 動いている裏のコマンドの出力のループバックの URL のポートを、始めた会話かタスクだけに返す。止まると返さない', async t => {
  // 落ちたときも、作業フォルダを消す前に裏のコマンドを止める（後片付けは登録した順に走る）
  let jobs: BackgroundJobs | undefined;
  t.after(async () => { jobs?.closeAll(); await new Promise(done => setTimeout(done, 200)); });
  const dir = tempDir(t);
  jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs') });
  const script = "console.log('  Local:   http://localhost:5173/'); console.log('  Network: http://localhost:\\u001b[1m5174\\u001b[22m/ http://192.168.0.2:5175/'); setInterval(() => {}, 1000);";
  const started = jobs.start({ conversationId: 'c1', projectId: 'p1', taskId: 't1', command: 'node dev', cwd: dir, file: process.execPath, args: ['-e', script], env: scrubEnv(), fetched: false });
  assert.ok('id' in started);
  const deadline = Date.now() + 15_000;
  while (!jobs.printedPorts({ conversationId: 'c1' }).has(5174) && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  assert.deepEqual([...jobs.printedPorts({ conversationId: 'c1' })].sort(), [5173, 5174]);
  assert.deepEqual([...jobs.printedPorts({ conversationId: 'c2', taskId: 't1' })].sort(), [5173, 5174], '同じタスクの別の実行');
  assert.deepEqual([...jobs.printedPorts({ conversationId: 'c2' })], []);
  assert.deepEqual([...jobs.printedPorts({ conversationId: 'c2', taskId: 't2' })], []);
  await jobs.stop(started.id, 'owner');
  assert.deepEqual([...jobs.printedPorts({ conversationId: 'c1' })], [], '止まった裏のコマンドのポートは数えない');
});

// ── P2（#56）: 止めた・自分で終わった開発サーバーのページは、判定役に回さずすぐ断る ──

const STOPPED_PORT = Number(new URL(OTHER_LOOP).port);
const serve = (exitAfterMs?: number): string => "console.log('  Local:   " + OTHER_LOOP + "');" + (exitAfterMs === undefined ? ' setInterval(() => {}, 1000);' : ' setTimeout(() => {}, ' + exitAfterMs + ');');

function backgroundRig(t: TestContext) {
  const dir = tempDir(t);
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs') });
  t.after(async () => { jobs.closeAll(); await new Promise(done => setTimeout(done, 200)); });
  const start = async (owner: { conversationId: string; taskId?: string }, script: string): Promise<string> => {
    const started = jobs.start({ ...owner, projectId: 'p1', command: 'node dev', cwd: dir, file: process.execPath, args: ['-e', script], env: scrubEnv(), fetched: false });
    assert.ok('id' in started);
    const deadline = Date.now() + 15_000;
    while (!jobs.printedPorts(owner).has(STOPPED_PORT) && jobs.get(started.id)!.state === 'running' && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    return started.id;
  };
  const ended = async (id: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (jobs.get(id)!.state === 'running' && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    assert.notEqual(jobs.get(id)!.state, 'running');
  };
  return { jobs, start, ended };
}

const stoppedText = (id: string): RegExp => new RegExp('port ' + STOPPED_PORT + ' has stopped \\(' + id + '\\)', 'u');

test('P2: 動いている開発サーバーは聞かずに押す。止めたら判定役なしで断り（新しい文）、直接の実行も押さない。同じポートで起動し直すと今どおり聞かない。自分で終わっても同じく断る', async t => {
  const bg = backgroundRig(t);
  const r = rig(t, { product: true, judge: 'allow', background: bg.jobs });
  const page = await r.open(OTHER_LOOP);
  const first = await bg.start({ conversationId: 'c1' }, serve());
  assert.equal((await r.call('browser_click', { ref: 'e3' })).decision, 'allow', '動いている間');
  assert.deepEqual(r.counts(), { ...NONE, acts: 1 });

  await bg.jobs.stop(first, 'owner');
  const stopped = await r.call('browser_click', { ref: 'e3' });
  assert.equal(stopped.decision, 'deny');
  assert.match(stopped.output.content, stoppedText(first));
  assert.equal((await r.call('browser_type', { ref: 'e1', text: 'hello' })).decision, 'deny', '入れるも断る');
  assert.equal((await r.call('browser_click', { ref: 'e2' })).decision, 'deny', '送信も Pending に積まずに断る');
  assert.deepEqual(r.counts(), { ...NONE, acts: 1 }, '判定役 0・Pending 0・押さない');
  const direct = await browserClick.execute({ ref: 'e3' }, r.ctx);
  assert.equal(direct.isError, true);
  assert.match(direct.content, stoppedText(first), '直接の実行でも押さない');
  assert.equal(page.acts.length, 1);

  const again = await bg.start({ conversationId: 'c1' }, serve());
  assert.equal((await r.call('browser_click', { ref: 'e3' })).decision, 'allow', '起動し直したら、動いている方が勝つ');
  assert.deepEqual(r.counts(), { ...NONE, acts: 2 });
  await bg.jobs.stop(again, 'model', 'c1');

  const crashed = await bg.start({ conversationId: 'c1' }, serve(300));
  await bg.ended(crashed);
  assert.equal(bg.jobs.get(crashed)!.state, 'exited');
  const after = await r.call('browser_click', { ref: 'e3' });
  assert.equal(after.decision, 'deny', '自分で終わった（落ちた）サーバーも断る');
  assert.match(after.output.content, stoppedText(crashed), 'いちばん新しく止まった裏のコマンドを言う');
  assert.deepEqual(r.counts(), { ...NONE, acts: 2 });
});

test('P2: 別の会話が止めたポートは今どおり判定役へ。同じタスクの別の実行が止めたポートは断る', async t => {
  const bg = backgroundRig(t);
  const chat = rig(t, { product: true, judge: 'ask', background: bg.jobs });
  await chat.open(OTHER_LOOP);
  const other = await bg.start({ conversationId: 'c-other' }, serve());
  await bg.jobs.stop(other, 'owner');
  assert.equal((await chat.call('browser_click', { ref: 'e3' })).decidedBy, 'pending');
  assert.deepEqual(chat.counts(), { ...NONE, judge: 1, judgeRows: 1, pending: ['judge'], acts: 0 });

  const task = rig(t, { kind: 'task', product: true, judge: 'allow', background: bg.jobs });
  await task.open(OTHER_LOOP);
  const sameTask = await bg.start({ conversationId: 'c-earlier-run', taskId: task.task.id }, serve());
  await bg.jobs.stop(sameTask, 'owner');
  const refused = await task.call('browser_click', { ref: 'e3' });
  assert.equal(refused.decision, 'deny');
  assert.match(refused.output.content, stoppedText(sameTask));
  assert.deepEqual(task.counts(), { ...NONE, acts: 0 });
});

// ── 純関数: ownerHostAllows・navigationMethodVerdict ──

test('ownerHostAllows: 文の中の http(s):// の URL のホストと完全一致だけ。大文字・末尾の点・www の付け外しは normalizeSiteHost に従う', () => {
  assert.equal(ownerHostAllows(['see https://Shop.Example.org/path?x=1'], UNLISTED), true);
  assert.equal(ownerHostAllows(['(https://shop.example.org)'], UNLISTED), true);
  assert.equal(ownerHostAllows(['<https://shop.example.org/>'], UNLISTED), true);
  assert.equal(ownerHostAllows([], UNLISTED), false);
  assert.equal(ownerHostAllows(['shop.example.org'], UNLISTED), false, 'URL の形でない');
  assert.equal(ownerHostAllows(['https://example.org/'], UNLISTED), false, '親のドメイン');
  assert.equal(ownerHostAllows(['https://sub.shop.example.org/'], UNLISTED), false, 'サブドメイン');
  assert.equal(ownerHostAllows(['https://shop.example.org.evil.test/'], UNLISTED), false);
  assert.equal(ownerHostAllows(['https://user@evil.test/?shop.example.org'], UNLISTED), false);
  assert.equal(ownerHostAllows(['ftp://shop.example.org/'], UNLISTED), false);
  assert.equal(ownerHostAllows(['https://shop.example.org/'], 'not a url'), false);
});

test('navigationMethodVerdict: 読む方法は通す。人のいない実行は公開のホストへの送る方法を全部断る。持ち主が見ている実行は遷移だけ any の許しが要る。許されたループバックは通す', () => {
  const allowed = (url: string) => url.startsWith('http://localhost:5173');
  const v = (method: string, url: string, navigation: boolean, guard: SendGuard, permit?: SubmitPermit) => navigationMethodVerdict({ method, url, navigation, guard, permit, allowed }).allow;
  for (const method of ['GET', 'head']) for (const guard of ['attended', 'unattended'] as const) assert.equal(v(method, UNLISTED, true, guard), true, `${method} ${guard}`);
  // OPTIONS は読む方法に数えない（審査 9-1b）
  assert.equal(v('OPTIONS', UNLISTED, false, 'unattended'), false, '人のいない実行の OPTIONS');
  assert.equal(v('OPTIONS', UNLISTED, true, 'attended'), false, '持ち主が見ている実行の OPTIONS の遷移');
  assert.equal(v('OPTIONS', UNLISTED, false, 'attended'), true, '持ち主が見ている実行のスクリプトは R-3 のまま');
  // 持ち主が見ている実行
  assert.equal(v('POST', UNLISTED, true, 'attended'), false, '許しの無い POST の遷移');
  assert.equal(v('POST', UNLISTED, true, 'attended', 'loopback'), false, 'loopback の許しでは公開へ送れない');
  assert.equal(v('POST', UNLISTED, true, 'attended', 'any'), true);
  assert.equal(v('PUT', UNLISTED, true, 'attended'), false);
  assert.equal(v('POST', UNLISTED, false, 'attended'), true, 'スクリプトの POST は通す（R-3）');
  // 人のいない実行
  for (const permit of [undefined, 'loopback', 'any'] as const) {
    assert.equal(v('POST', UNLISTED, true, 'unattended', permit), false, `遷移 ${permit}`);
    assert.equal(v('POST', UNLISTED, false, 'unattended', permit), false, `fetch ${permit}`);
    assert.equal(v('DELETE', UNLISTED, false, 'unattended', permit), false);
  }
  // ループバック
  for (const guard of ['attended', 'unattended'] as const) {
    assert.equal(v('POST', 'http://localhost:5173/api', true, guard), false, `許しの無い送信の遷移 ${guard}`);
    assert.equal(v('POST', 'http://localhost:5173/api', true, guard, 'loopback'), true, `loopback の許しの送信の遷移 ${guard}`);
    assert.equal(v('POST', 'http://localhost:5173/api', true, guard, 'any'), true, guard);
    assert.equal(v('POST', 'http://localhost:5173/api', false, guard), true, `スクリプトの送信 ${guard}`);
    assert.equal(v('POST', 'http://localhost:9999/api', false, guard, 'any'), false, `許しの無いポート ${guard}`);
  }
});

// ── D-5: 送信の部品の見分け（elementFacts。本物の DOM の代わりに jsdom） ──

test('elementFacts: 送信の部品・フォームの外・label の先・中の要素・formaction/formmethod・form 属性', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <form id="f" action="/send" method="post">
      <input id="text" type="text">
      <button id="plain">Send</button>
      <button id="typed" type="submit"><span id="inner">Go</span></button>
      <button id="button" type="button">Not</button>
      <button id="reset" type="reset">Reset</button>
      <input id="submit" type="submit">
      <input id="image" type="image">
      <input id="ibutton" type="button" formaction="/other">
      <button id="method" type="button" formmethod="post">M</button>
      <label id="lab" for="submit">label</label>
      <a id="link" href="#">link</a>
    </form>
    <button id="outside">Out</button>
    <button id="owned" form="f">Owned</button>
    <label id="lab2" for="outside">label</label>
    <input id="secret" type="password" autocomplete="Current-Password">
  </body>`);
  const doc = dom.window.document;
  const facts = (id: string) => elementFacts(doc.getElementById(id)!);
  assert.deepEqual(facts('text'), { type: 'text', autocomplete: null, inForm: true, submits: false });
  for (const id of ['plain', 'typed', 'inner', 'submit', 'image', 'owned', 'lab', 'ibutton', 'method']) assert.equal(facts(id).submits, true, id);
  for (const id of ['button', 'reset', 'link', 'outside', 'lab2', 'secret']) assert.equal(facts(id).submits, false, id);
  assert.equal(facts('link').inForm, true);
  assert.equal(facts('outside').inForm, false);
  assert.equal(facts('owned').inForm, true, 'form 属性でフォームに属す');
  assert.deepEqual([facts('secret').type, facts('secret').autocomplete], ['password', 'current-password']);
});

test('本物の PlaywrightPage: 要素の見分けが読めない形なら送信とみなす。入れる（submit なし）は Enter を押さない', async () => {
  const pressed: string[] = [];
  const make = (facts: unknown) => new PlaywrightBrowser({} as BrowserContext).wrap({
    on: () => {},
    getByRole: () => ({
      count: async () => 1,
      nth: () => ({
        isVisible: async () => true, isEnabled: async () => true, evaluate: async () => facts,
        click: async () => { pressed.push('click'); }, fill: async (text: string) => { pressed.push(`fill ${text}`); }, press: async (key: string) => { pressed.push(`press ${key}`); },
      }),
    }),
    waitForLoadState: async () => {},
  } as unknown as Page);
  const target = { role: 'textbox', name: 'Search', nth: 0, count: 1 };
  assert.equal((await make({ type: null, autocomplete: null, inForm: true }).locate(target))!.form.submits, true, 'submits が無い');
  assert.equal((await make({ type: null, autocomplete: null, inForm: true, submits: 'yes' }).locate(target))!.form.submits, true, '形が違う');
  assert.equal((await make({ type: null, autocomplete: null, inForm: true, submits: false }).locate(target))!.form.submits, false);
  const page = make({ type: null, autocomplete: null, inForm: true, submits: false });
  await page.fill(target, 'abc', false, 1000);
  assert.deepEqual(pressed, ['fill abc']);
  await page.fill(target, 'abc', true, 1000);
  assert.deepEqual(pressed, ['fill abc', 'fill abc', 'press Enter']);
});

// ── D-8: 横取りの方法の判定（T12・T19）。偽の Route / Request / Frame / Page ──

interface FakeTab { on: () => void; url: () => string; opener: () => Promise<FakeTab | null> }

function routeRig(guard: SendGuard | undefined) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = { on: () => {}, route: async (_p: string, fn: (route: Route) => Promise<void>) => { handler = fn; }, pages: () => [] as Page[] } as unknown as BrowserContext;
  const browser = new PlaywrightBrowser(context, () => [], url => url.startsWith('http://localhost:5173'), guard);
  const tab: FakeTab = { on: () => {}, url: () => UNLISTED, opener: async () => null };
  const loopTab: FakeTab = { on: () => {}, url: () => DEV, opener: async () => null };
  const fire = async (target: FakeTab, method: string, url: string, over: { navigation?: boolean; main?: boolean } = {}): Promise<string> => {
    let out = '';
    const main = { url: () => target.url(), parentFrame: () => null, page: () => target };
    const frame = over.main === false ? { url: () => 'https://frame.example.net/', parentFrame: () => main, page: () => target } : main;
    const request = { url: () => url, method: () => method, isNavigationRequest: () => over.navigation !== false, frame: () => frame, redirectedFrom: () => null };
    await handler!({ request: () => request, continue: async () => { out = 'continue'; }, abort: async () => { out = 'abort'; } } as unknown as Route);
    return out;
  };
  return { browser, tab, loopTab, fire, install: () => browser.install() };
}

test('T12: 持ち主が見ている文脈で、許しの無い POST の遷移（type="button" からの form.submit()）は main frame でも iframe でも断り、断った数が結果に残る', async () => {
  const r = routeRig('attended');
  await r.install();
  const page = r.browser.wrap(r.tab as unknown as Page);
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/send'), 'abort');
  assert.equal(await r.fire(r.tab, 'POST', 'https://frame.example.net/send', { main: false }), 'abort', 'iframe の中のフォーム');
  assert.equal(page.lastRefusal(), 'submit');
  assert.equal(await r.fire(r.tab, 'GET', 'https://shop.example.org/next'), 'continue');
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/api', { navigation: false }), 'continue', 'スクリプトの POST は通す（R-3）');
  page.permitSubmits('loopback');
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/send'), 'abort', 'loopback の許しでは公開へ送れない');
  page.permitSubmits('any');
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/send'), 'continue', '承認された送信');
  page.permitSubmits(undefined);
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/send'), 'abort', '許しを外せば戻る');
});

test('T12: 押すあいだにページが出した送信を横取りが断ると、その数が押した結果（events.blocked）に入り、道具の結果に断った旨が出る', async t => {
  const r = routeRig('attended');
  await r.install();
  const tab = { ...r.tab, getByRole: () => ({ count: async () => 1, nth: () => ({ click: async () => { assert.equal(await r.fire(tab as never, 'POST', 'https://shop.example.org/send'), 'abort'); } }) }), waitForLoadState: async () => {} };
  const page = r.browser.wrap(tab as unknown as Page);
  const events = await page.click({ role: 'button', name: 'More', nth: 0, count: 1 }, 1000);
  assert.equal(events.blocked, 1);
  const tool = rig(t, { judge: 'allow' });
  tool.driver.site(UNLISTED, { ...site(), rows: site().rows!.map(row => row.name === 'More' ? { ...row, effect: { blocked: 2 } } : row) });
  await tool.open(UNLISTED);
  const outcome = await tool.call('browser_click', { ref: 'e3' });
  assert.match(outcome.output.content, /Blocked 2 request\(s\)/u);
});

test('T19: 人のいない文脈は、公開のホストへの fetch の POST・sendBeacon（POST）・遷移を許しがあっても断る。許されたループバックへの POST は通す', async () => {
  const r = routeRig('unattended');
  await r.install();
  const page = r.browser.wrap(r.tab as unknown as Page);
  r.browser.wrap(r.loopTab as unknown as Page);
  page.permitSubmits('any');
  assert.equal(await r.fire(r.tab, 'POST', 'https://collect.example.net/api', { navigation: false }), 'abort', 'fetch POST');
  assert.equal(await r.fire(r.tab, 'POST', 'https://collect.example.net/beacon', { navigation: false }), 'abort', 'sendBeacon');
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/send'), 'abort', '遷移');
  assert.equal(await r.fire(r.tab, 'GET', 'https://collect.example.net/pixel.gif', { navigation: false }), 'continue');
  assert.equal(await r.fire(r.loopTab, 'POST', 'http://localhost:5173/api', { navigation: false }), 'continue', 'ループバックへの POST');
});

test('送信の守りの無い文脈（ログイン用の窓）は、POST の遷移もスクリプトの POST も通す', async () => {
  const r = routeRig(undefined);
  await r.install();
  r.browser.wrap(r.tab as unknown as Page);
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/login'), 'continue');
  assert.equal(await r.fire(r.tab, 'POST', 'https://shop.example.org/api', { navigation: false }), 'continue');
});

// ── session: どの文脈にどの守りを付けるか ──

test('session: 持ち主のブラウザは attended、ログイン用の窓は守りなし、タスクの作業用の文脈は unattended。持ち主が見ている文脈を人のいない実行に使い回さない', async t => {
  const config = testConfig();
  config.tools.browser.enabled = true;
  const driver = new FakeBrowserDriver();
  const session = new BrowserSession({ driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' }, canShowWindow: () => true });
  t.after(() => session.close());
  const call = (attended: boolean, loopback = true) => ({ grant: { conversationId: 'c1', runId: 'r1', attended, loopback, productId: 'p1' }, signal: new AbortController().signal });
  await session.run(call(true, false), async api => { await api.openTab('owner'); });
  assert.equal((driver.current!.options as LaunchOptions).sendGuard, 'attended');
  await session.run(call(true), async api => { await api.openTab('work'); });
  const attended = driver.context!;
  assert.equal((attended.contextOptions as WorkContextOptions).sendGuard, 'attended');
  await session.run(call(false), async api => { await api.openTab('work'); });
  const unattended = driver.context!;
  assert.notEqual(unattended, attended, '作り直す');
  assert.equal(attended.closed, true);
  assert.equal((unattended.contextOptions as WorkContextOptions).sendGuard, 'unattended');
  await session.run(call(true), async api => { await api.openTab('work'); });
  assert.equal(driver.context, unattended, '厳しい方の文脈はそのまま使う');
  await session.openLogin();
  assert.equal((driver.current!.options as LaunchOptions).sendGuard, undefined);
});

test('子の担当は、持ち主の会話のタブに触れない（タブは会話ごと）', async t => {
  const r = rig(t, { judge: 'allow' });
  const page = await r.open(LISTED);
  const child = r.ctxFor({ kind: 'agent', conversationId: 'a1', parent: { runId: 'r1', conversationId: 'c1', kind: 'chat', title: '' } } as Partial<ToolContext>);
  for (const [name, args] of [['browser_click', { tab: 't1', ref: 'e3' }], ['browser_type', { tab: 't1', ref: 'e1', text: 'x' }]] as const) {
    const outcome = await r.call(name, args, child);
    assert.equal(outcome.output.isError, true, name);
  }
  assert.equal(page.acts.length, 0);
});

test('outboundOfCall: 事前の判定を持つ道具は check.submits で送るに数える。持たない道具は道具の印で数える', () => {
  const withPre = { preCheck: async () => ({ decision: 'allow' as const, reasons: [] }), submits: true as const };
  assert.equal(outboundOfCall(withPre, { decision: 'allow', reasons: [] }, 'en'), undefined);
  assert.equal(outboundOfCall(withPre, { decision: 'ask', reasons: [], submits: true }, 'en')?.kind, 'send');
  assert.equal(outboundOfCall({ submits: true }, undefined, 'en')?.kind, 'send');
  assert.equal(outboundOfCall({}, { decision: 'ask', reasons: [], submits: true }, 'en'), undefined);
});

test('計画モードでは押す・入れるはモデルに渡らない（submits の印のまま planAllows が外す）', () => {
  const tools = builtinTools().filter(tool => tool.name === 'browser_click' || tool.name === 'browser_type');
  assert.equal(tools.length, 2);
  for (const tool of tools) assert.equal(planAllows(tool), false, tool.name);
});
