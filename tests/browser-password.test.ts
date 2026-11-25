import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { QuestionStore } from '../src/questions/store.ts';
import { guardText } from '../src/shared/messages/guard.ts';
import { redactSecrets } from '../src/shared/redaction.ts';
import { toolText } from '../src/shared/messages/tools.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { actPreview, browserActCheck, fieldKind } from '../src/tools/browser/checks.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { BackgroundJobs } from '../src/tools/shell/background.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';
import { BROWSER_TOOLS, browserAct, browserFind, browserOpen, browserRead, browserType } from '../src/tools/builtin/browser.ts';
import { refusedKeysOf } from '../src/tools/hooks/decision-order.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { PreCheck, ToolContext } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { tempDir, testConfig, withLoad, type Script } from './helpers.ts';
import { FakeBrowserDriver, type FakePage, type FakeSite } from './helpers/fake-browser.ts';

// browser-rethink P7: 暗証番号の欄。beat が自分で起動して、いま動いている開発サーバーのページの password・認証コードの欄にだけ、password の引数で試しの値を入れてよい。
// カードの欄はどこでも断る。値は道具の行・記録・履歴・結果の文・あとの出力のどこにも出さず、判定役にも Pending にも持ち主のフックにも渡さない（断る）。
// 試しの値だけを使う（本物の鍵・パスワードは使わない）

const WINDOWS = process.platform === 'win32';
const LISTED = 'https://example.com/login';
const DEV = 'http://localhost:5173/';
const OTHER_LOOP = 'http://localhost:4900/';
const PASS = 'test-pass-1234';
const KEYLIKE = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const en = (key: Parameters<typeof toolText>[1], params?: Parameters<typeof toolText>[2]): string => toolText('en', key, params);
const gt = (key: Parameters<typeof guardText>[1], params?: Parameters<typeof guardText>[2]): string => guardText('en', key, params);

// 入れたあとの画面（入れた値を、本文・要素の名前・入力欄の値として出す）
const ADMIN: FakeSite = {
  title: 'Admin', text: `Admin\nSigned in\nSecret echo: ${PASS}`,
  snapshot: ['- heading "Admin"', `- textbox "Password": ${PASS}`, '- button "Log out"', `- link "Profile ${PASS}"`].join('\n'),
  rows: [{ role: 'textbox', name: 'Password', type: 'password' }, { role: 'button', name: 'Log out' }, { role: 'link', name: `Profile ${PASS}` }],
};
// e1 Search / e2 Password（type=password。Enter つきで入れると ADMIN になる）/ e3 Code（one-time-code）/ e4 Card number（cc-number）/ e5 PIN（type=password と cc-csc の両方）/ e6 Sign in / e7 Name
const loginSite = (after: FakeSite | undefined = ADMIN): FakeSite => ({
  title: 'Login', text: 'Login\nEnter the admin password',
  snapshot: ['- textbox "Search"', '- textbox "Password"', '- textbox "Code"', '- textbox "Card number"', '- textbox "PIN"', '- button "Sign in"', '- textbox "Name"'].join('\n'),
  rows: [
    { role: 'textbox', name: 'Search' },
    { role: 'textbox', name: 'Password', type: 'password', ...(after ? { effect: { mutate: after } } : {}) },
    { role: 'textbox', name: 'Code', autocomplete: 'one-time-code' },
    { role: 'textbox', name: 'Card number', autocomplete: 'cc-number' },
    { role: 'textbox', name: 'PIN', type: 'password', autocomplete: 'cc-csc' },
    { role: 'button', name: 'Sign in', submits: true },
    { role: 'textbox', name: 'Name' },
  ],
});

interface RigOptions {
  kind?: 'chat' | 'task';
  // 製品の実行（開発サーバーを開ける）。既定は true
  product?: boolean;
  ownerText?: readonly string[];
  // この会話・タスクの裏のコマンドが出力に出したポート
  printed?: number[];
  // 偽の「待ち受けがこの持ち主のジョブの中にある」ポート（試験の途中で変えられる）
  owned?: Set<number>;
  stopped?: number[];
  // 本物の裏のコマンドの入れ物（Windows の本物のプロセスの試験）
  background?: BackgroundJobs;
  mutate?: (c: AppConfig) => void;
  secrets?: string[];
}

function rig(t: TestContext, options: RigOptions = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.sites = ['example.com'];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const driver = new FakeBrowserDriver().site(LISTED, loginSite()).site(DEV, loginSite()).site(OTHER_LOOP, loginSite());
  const session = new BrowserSession({ driver, config: () => parsed, paths: { browserProfile: 'C:\\data\\browser-profile' }, secrets: () => options.secrets ?? [], canShowWindow: () => true });
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
  const owned = options.owned ?? new Set<number>();
  const asked: Array<{ owner: unknown; port: number }> = [];
  const background = options.background ?? {
    printedPorts: () => new Set(options.printed ?? []),
    ownsPort: async (owner: unknown, port: number) => { asked.push({ owner, port }); return owned.has(port); },
    stoppedPort: (_owner: unknown, port: number) => (options.stopped?.includes(port) ? { port, jobId: 'bg-9' } : undefined),
  };
  const ctx = {
    runId: 'r1', conversationId: kind === 'chat' ? 'c1' : 'c-task', kind, signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
    services: { browser: session, questions, tasks, background }, model: { id: 'm', vision: true },
    ownerText: () => [...(options.ownerText ?? [])],
    ...(kind === 'task' ? { task: { id: task.id, control: { kind: 'none' } } } : {}),
    ...(options.product === false ? {} : { project: { id: 'p1', root: 'C:\\work\\shop' } }),
  } as unknown as ToolContext;
  let judged = 0;
  const events: RunEvent[] = [];
  const call = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals, pending, db, emit: event => { events.push(event); }, permissionMode: () => 'auto',
    autoClassify: async () => { judged += 1; return '{"decision":"allow","reason":"test judge"}'; },
    lastUserRequest: () => 'ログインして', conversationTainted: () => false,
  });
  const pages = (): FakePage[] => [...driver.browsers.flatMap(b => b.pageList), ...driver.workBrowsers.flatMap(w => w.contexts.flatMap(c => c.pageList))];
  const counts = () => ({
    judge: judged,
    judgeRows: (db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n,
    pending: pending.list({ status: 'waiting' }).length,
    questions: (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE kind = 'submit_refused'").get() as { n: number }).n,
    acts: pages().reduce((n, page) => n + page.acts.length, 0),
  });
  const open = async (url: string): Promise<{ page: FakePage; content: string }> => {
    const out = await browserOpen.execute({ url }, ctx);
    assert.equal(out.isError, undefined, out.content);
    return { page: pages().find(page => page.url() === url)!, content: out.content };
  };
  const fills = (): Array<[string, string | undefined]> => pages().flatMap(page => page.acts.filter(a => a.kind === 'fill').map((a): [string, string | undefined] => [a.name, a.text]));
  return { ctx, call, counts, open, pages, fills, driver, session, db, pending, events, asked, owned, task };
}

const own = (extra: Partial<RigOptions> = {}): RigOptions => ({ printed: [5173], owned: new Set([5173]), ...extra });
const NONE = { judge: 0, judgeRows: 0, pending: 0, questions: 0 };
const preCheck = (tool: typeof browserType | typeof browserAct, input: unknown, ctx: ToolContext) => (tool.preCheck as (i: unknown, c: ToolContext) => Promise<PreCheck>)(input, ctx);
const everything = (value: unknown): string => JSON.stringify(value);

// ── 入れてよい場合 ──

test('P7: 自分で起動して動いている開発サーバーの password 欄・認証コード欄に、password で入れる。判定役 0・Pending 0・質問 0。結果の文に値も字数も無い', async t => {
  for (const [ref, name] of [['e2', 'Password'], ['e3', 'Code']] as const) {
    const r = rig(t, own());
    const { page } = await r.open(DEV);
    const check = await preCheck(browserType, { ref, password: PASS }, r.ctx);
    assert.equal(check.decision, 'allow', ref);
    assert.deepEqual(check.reasonKeys, ['web.password_input'], '断る鍵（方針・フックの ask を、判定役・Pending より前に断る）');
    assert.deepEqual(refusedKeysOf(check.reasonKeys ?? []), ['web.password_input']);
    const outcome = await r.call('browser_type', { ref, password: PASS });
    assert.equal(outcome.decision, 'allow', outcome.output.content);
    assert.equal(outcome.output.isError, undefined, outcome.output.content);
    assert.deepEqual(page.acts.map(a => [a.kind, a.name, a.text, a.permit]), [['fill', name, PASS, 'loopback']]);
    assert.equal(outcome.output.content.split('\n')[0], en('browser.acted_password', { ref, tab: 't1' }));
    assert.ok(!outcome.output.content.includes(PASS) && !/\b14\b|characters/u.test(outcome.output.content.split('\n')[0]!), 'ひと言目に値も字数も無い');
    assert.deepEqual({ ...r.counts(), acts: undefined }, { ...NONE, acts: undefined }, ref);
  }
});

test('P7: browser_act の type の step も同じ（番号・名前で指した目標）。ふつうの欄の text と同じ呼び出しに混ぜられる。結果の行に値も字数も無い', async t => {
  const r = rig(t, own());
  const { page } = await r.open(DEV);
  const outcome = await r.call('browser_act', { steps: [{ type: 'e7', text: 'admin' }, { type: 'e2', password: PASS }, { type: { role: 'textbox', name: 'Code' }, password: '123456', submit: false }], then: 'none' });
  assert.equal(outcome.decision, 'allow', outcome.output.content);
  assert.equal(outcome.output.isError, undefined, outcome.output.content);
  assert.deepEqual(r.fills(), [['Name', 'admin'], ['Password', PASS], ['Code', '123456']]);
  assert.deepEqual(outcome.output.content.split('\n'), [
    en('browser.act_step_type', { n: 1, count: 5, target: 'e7' }),
    en('browser.act_step_password', { n: 2, target: 'e2' }),
    en('browser.act_step_password', { n: 3, target: en('browser.act_named', { role: 'textbox' }) }),
  ]);
  assert.ok(!outcome.output.content.includes(PASS) && !outcome.output.content.includes('123456'));
  assert.equal(page.acts[1]!.permit, 'loopback');
  assert.deepEqual({ ...r.counts(), acts: undefined }, { ...NONE, acts: undefined });
});

// ── 断る場合（入れない・判定役にも Pending にも質問票にも回さない） ──

async function refused(t: TestContext, options: RigOptions, url: string, name: 'browser_type' | 'browser_act', args: Record<string, unknown>, expected: string, ref = 'e2'): Promise<void> {
  const r = rig(t, options);
  await r.open(url);
  const input = name === 'browser_type' ? { ref, ...args } : { steps: [{ type: ref, ...args }], then: 'none' };
  if (name === 'browser_type') {
    const check = await preCheck(browserType, input, r.ctx);
    assert.equal(check.decision, 'deny', `${url} ${everything(args)}: ${everything(check)}`);
    assert.ok(check.reasons[0]!.includes(expected), check.reasons[0]);
  }
  const outcome = await r.call(name, input);
  assert.equal(outcome.decision, name === 'browser_type' ? 'deny' : 'allow', outcome.output.content);
  assert.equal(outcome.output.isError, true, outcome.output.content);
  assert.ok(outcome.output.content.includes(expected), `${expected} / ${outcome.output.content}`);
  assert.ok(!outcome.output.content.includes(PASS), outcome.output.content);
  if (name === 'browser_type') {
    const direct = await browserType.execute(input as never, r.ctx);
    assert.equal(direct.isError, true, '直接の実行でも断る');
    assert.ok(direct.content.includes(expected), direct.content);
  }
  assert.deepEqual(r.counts(), { ...NONE, acts: 0 }, `${url} ${everything(args)}`);
}

test('P7: 出力にポートが出ただけの開発サーバー（待ち受けがジョブの中にない）・持ち主が書いただけのポート・公開のページ・開発サーバーでないループバックには、password で入れない', async t => {
  const notOwn = gt('browser.act.password_own_only');
  for (const name of ['browser_type', 'browser_act'] as const) {
    // 出力にポートが出ただけ（待ち受けはこの持ち主のジョブの中にない）
    await refused(t, { printed: [5173], owned: new Set() }, DEV, name, { password: PASS }, notOwn);
    // 持ち主が会話に書いただけのポート（開発サーバーの見分けには入るが、自分で起動した証拠ではない）
    await refused(t, { ownerText: ['http://localhost:5173 を見て'], owned: new Set() }, DEV, name, { password: PASS }, notOwn);
    // 公開のページ（一覧のサイト）。待ち受けの問い合わせの答えが何でも入れない
    await refused(t, { owned: new Set([443, 80, 5173]) }, LISTED, name, { password: PASS }, notOwn);
    // ジョブの中の待ち受けはあるが、出力に出ていない・持ち主も書いていないポート（開発サーバーの見分けに入らない）
    await refused(t, { printed: [5173], owned: new Set([4900]) }, OTHER_LOOP, name, { password: PASS }, notOwn);
  }
});

test('P7: 止まった開発サーバー（持ち主が止めた・自分で終わった）のページには、止まった理由の文で断る', async t => {
  await refused(t, { printed: [], owned: new Set([5173]), stopped: [5173] }, DEV, 'browser_type', { password: PASS }, gt('browser.act.server_ended', { port: 5173, job: 'bg-9' }));
  await refused(t, { printed: [], owned: new Set([5173]), stopped: [5173] }, DEV, 'browser_act', { password: PASS }, gt('browser.act.server_ended', { port: 5173, job: 'bg-9' }));
});

test('P7: 待ち受けの確かめは、事前の判定と実行の直前の両方で通る（判定のあとにジョブの外へ移ったサーバーには入れない）', async t => {
  const r = rig(t, own());
  const { page } = await r.open(DEV);
  assert.equal((await preCheck(browserType, { ref: 'e2', password: PASS }, r.ctx)).decision, 'allow');
  r.owned.delete(5173);
  const direct = await browserType.execute({ ref: 'e2', password: PASS }, r.ctx);
  assert.equal(direct.isError, true);
  assert.ok(direct.content.includes(gt('browser.act.password_own_only')), direct.content);
  assert.deepEqual(page.acts, []);
  // 押す直前（要素をつかんだあと）にも、もう一度確かめる
  r.owned.add(5173);
  page.beforePin = () => { r.owned.delete(5173); };
  const lateOutcome = await r.call('browser_type', { ref: 'e2', password: PASS });
  assert.equal(lateOutcome.output.isError, true, lateOutcome.output.content);
  assert.deepEqual(page.acts, [], '押す直前に外れたら入れない');
  r.owned.add(5173);
  const lateStep = await r.call('browser_act', { steps: [{ type: 'e2', password: PASS }], then: 'none' });
  assert.equal(lateStep.output.isError, true, lateStep.output.content);
  assert.deepEqual(page.acts, [], 'browser_act の step でも、押す直前に外れたら入れない');
  page.beforePin = undefined;
  // 欄の種類も、押す直前に読み直す（判定のあとに、欄がカードの欄に変わったら入れない）
  r.owned.add(5173);
  const asCard = loginSite();
  asCard.rows![1] = { ...asCard.rows![1]!, autocomplete: 'cc-number' };
  page.beforePin = () => { page.mutate(asCard); };
  const changed = await r.call('browser_type', { ref: 'e2', password: PASS });
  assert.equal(changed.output.isError, true, changed.output.content);
  assert.deepEqual(page.acts, [], '欄の種類が変わったら入れない');
  page.mutate(loginSite());
  const changedStep = await r.call('browser_act', { steps: [{ type: 'e2', password: PASS }], then: 'none' });
  assert.equal(changedStep.output.isError, true, changedStep.output.content);
  assert.deepEqual(page.acts, [], 'browser_act の step でも、欄の種類が変わったら入れない');
  page.beforePin = undefined;
});

test('P7: カードの欄（cc-*・カードの名前）は、自分の開発サーバーでも、password でも text でも断る。type=password と cc-csc の両方に当たる欄もカードとして断る', async t => {
  for (const name of ['browser_type', 'browser_act'] as const) {
    for (const ref of ['e4', 'e5']) {
      await refused(t, own(), DEV, name, { password: PASS }, gt('browser.act.secret_field', { ref }), ref);
      if (name === 'browser_type') await refused(t, own(), DEV, name, { text: '4242424242424242' }, gt('browser.act.secret_field', { ref }), ref);
    }
  }
});

test('P7: text で暗証番号の欄に入れるのは断る（password を使うよう案内する）。ふつうの欄に password で入れる形も断る', async t => {
  for (const ref of ['e2', 'e3']) {
    await refused(t, own(), DEV, 'browser_type', { text: 'abc' }, gt('browser.act.password_use_field', { ref }), ref);
    await refused(t, own(), DEV, 'browser_act', { text: 'abc' }, gt('browser.act.password_use_field', { ref: ref }), ref);
  }
  for (const ref of ['e1', 'e7']) {
    await refused(t, own(), DEV, 'browser_type', { password: PASS }, gt('browser.act.password_not_secret', { ref }), ref);
    await refused(t, own(), DEV, 'browser_act', { password: PASS }, gt('browser.act.password_not_secret', { ref }), ref);
  }
});

test('P7: text と password はどちらか 1 つ（両方・どちらも無しは断る）。長すぎる・鍵に見える値は、判定役に見せずに断る', async t => {
  await refused(t, own(), DEV, 'browser_type', { text: 'a', password: PASS }, gt('browser.act.text_or_password'));
  await refused(t, own(), DEV, 'browser_type', {}, gt('browser.act.text_or_password'));
  await refused(t, own(), DEV, 'browser_act', { text: 'a', password: PASS }, gt('browser.act.text_or_password'));
  await refused(t, own(), DEV, 'browser_type', { password: KEYLIKE }, gt('browser.act.password_key_like'));
  await refused(t, own(), DEV, 'browser_act', { password: KEYLIKE }, gt('browser.act.password_key_like'));
  await refused(t, { ...own(), kind: 'task' }, DEV, 'browser_type', { password: KEYLIKE }, gt('browser.act.password_key_like'));
});

// ── 承認待ち・判定役・持ち主のフックに回さない ──

test('P7: 方針が ask でも、暗証番号の入力は承認待ちにも判定役にも回さず断る（Pending の行 0・判定役 0）。ふつうの欄の入力は今までどおり回る', async t => {
  const r = rig(t, { ...own(), mutate: c => { c.tools.policies = { browser_type: 'ask' }; } });
  const { page } = await r.open(DEV);
  const outcome = await r.call('browser_type', { ref: 'e2', password: PASS });
  assert.equal(outcome.decision, 'deny', outcome.output.content);
  assert.equal(outcome.output.isError, true);
  assert.ok(!outcome.output.content.includes(PASS), outcome.output.content);
  assert.deepEqual(r.counts(), { ...NONE, acts: 0 });
  assert.deepEqual(page.acts, []);
  const ordinary = await r.call('browser_type', { ref: 'e7', text: 'admin' });
  assert.notEqual(ordinary.decision, 'deny', 'ふつうの欄は今までどおり承認に回る');
  assert.equal(ordinary.decidedBy, 'pending');
  assert.equal(r.counts().pending, 1);
  assert.ok(!r.pending.list({ status: 'waiting' }).some(row => everything(row).includes(PASS)));
});

test('P7: 持ち主のフックが ask を返しても、暗証番号の入力は断る。フックには値を渡さない（password は伏せた形）', async t => {
  const dir = tempDir(t);
  const seen = join(dir, 'hook-input.json');
  const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(seen)},s);console.log(JSON.stringify({decision:'ask',reason:'hook asks'}));});`;
  const r = rig(t, { ...own(), mutate: c => { c.tools.hooks.preToolUse = [{ matcher: 'browser_type', command: [process.execPath, '-e', script], timeoutMs: 10_000, onError: 'deny' }]; } });
  const { page } = await r.open(DEV);
  const outcome = await r.call('browser_type', { ref: 'e2', password: PASS });
  assert.equal(outcome.decision, 'deny', outcome.output.content);
  assert.deepEqual(r.counts(), { ...NONE, acts: 0 });
  assert.deepEqual(page.acts, []);
  const payload = readFileSync(seen, 'utf8');
  assert.ok(!payload.includes(PASS), payload);
  const toolInput = (JSON.parse(payload) as { tool_input: { password?: string; ref: string } }).tool_input;
  assert.equal(toolInput.ref, 'e2');
  assert.notEqual(toolInput.password, PASS);
  assert.ok(typeof toolInput.password === 'string' && toolInput.password.length > 0, '欄は残す（伏せた印）');
});

test('P7: 実行後のフックにも値を渡さない。browser_act は、フックが browser_type に当たる間は使えない（今までどおり）', async t => {
  const dir = tempDir(t);
  const seen = join(dir, 'post-input.json');
  const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(seen)},s);});`;
  const r = rig(t, { ...own(), mutate: c => { c.tools.hooks.postToolUse = [{ matcher: 'browser_type', command: [process.execPath, '-e', script], timeoutMs: 10_000, onError: 'deny' }]; } });
  await r.open(DEV);
  const outcome = await r.call('browser_type', { ref: 'e2', password: PASS });
  assert.equal(outcome.decision, 'allow', outcome.output.content);
  const payload = readFileSync(seen, 'utf8');
  assert.ok(!payload.includes(PASS), payload);
  const batch = await r.call('browser_act', { steps: [{ type: 'e2', password: PASS }] });
  assert.equal(batch.decision, 'deny');
  assert.equal(r.counts().acts, 1);
});

test('P7: 方針が ask の browser_act も、暗証番号の step を Pending に積まず、実行もしない（値を持った控えが残らない）', async t => {
  const r = rig(t, { ...own(), mutate: c => { c.tools.policies = { browser_act: 'ask' }; } });
  await r.open(DEV);
  const outcome = await r.call('browser_act', { steps: [{ type: 'e2', password: PASS }] });
  assert.deepEqual([outcome.decision, outcome.decidedBy, outcome.output.isError], ['ask', 'not-parked', true]);
  assert.deepEqual(r.counts(), { ...NONE, acts: 0 });
  assert.ok(!everything([...r.pending.list({ status: 'waiting' }), ...r.pending.list({ status: 'decided' })]).includes(PASS));
});

// ── 伏せる（道具の行・記録・結果・要約・承認の札・フックに値が出ない） ──

test('P7: tool.call の知らせ・tool_calls の記録・tool.result・結果の文・要約・承認の札の中身に、入れた値が出ない（browser_type と browser_act の両方）', async t => {
  const r = rig(t, own());
  await r.open(DEV);
  const typed = await r.call('browser_type', { ref: 'e2', password: PASS });
  const batch = await r.call('browser_act', { steps: [{ type: 'e3', password: PASS }], then: 'none' });
  assert.equal(typed.output.isError, undefined, typed.output.content);
  assert.equal(batch.output.isError, undefined, batch.output.content);
  const called = r.events.filter(e => e.type === 'tool.call');
  assert.equal(called.length, 2);
  for (const event of called) {
    assert.ok(!everything(event).includes(PASS), everything(event));
    assert.ok(event.type === 'tool.call' && event.input.includes('[REDACTED]'), '値だけでなく欄ごと伏せる');
  }
  const rows = r.db.prepare('SELECT input, output_preview FROM tool_calls').all() as Array<{ input: string; output_preview: string }>;
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.ok(!row.input.includes(PASS) && !row.output_preview.includes(PASS), everything(row));
  for (const event of r.events.filter(e => e.type === 'tool.result')) assert.ok(!everything(event).includes(PASS), everything(event));
  assert.ok(!typed.output.content.includes(PASS) && !batch.output.content.includes(PASS));
  // 要約（判定役・フックの cwd・承認の札が使う）
  const summary = browserType.summarize!({ ref: 'e2', password: PASS }, 'en');
  assert.ok(!everything(summary).includes(PASS), everything(summary));
  assert.match(summary.body, /••••/u);
  const batchSummary = browserAct.summarize!({ steps: [{ type: 'e2', password: PASS, submit: true }, { type: { role: 'textbox', name: 'Code' }, password: PASS }] }, 'en');
  assert.ok(!everything(batchSummary).includes(PASS), everything(batchSummary));
  assert.match(batchSummary.body, /••••/u);
  // 承認の札の中身（preview）と指紋
  const found = { ok: true as const, tab: { instance: 'i', id: 't1' }, pageUrl: DEV, item: { ref: 'e2', role: 'textbox', name: 'Password' } };
  const shown = actPreview('type', { ref: 'e2', password: PASS }, found as never, 'en');
  assert.ok(!everything(shown).includes(PASS), everything(shown));
  // フックに渡す形
  const hook = browserType.hookInput!({ ref: 'e2', password: PASS });
  assert.ok(!everything(hook).includes(PASS), everything(hook));
  const batchHook = browserAct.hookInput!({ steps: [{ click: 'e6' }, { type: 'e2', password: PASS }, { type: 'e7', text: 'admin' }] });
  assert.ok(!everything(batchHook).includes(PASS) && everything(batchHook).includes('admin'), everything(batchHook));
});

test('P7: 入れたあとの出力（差分・触れるものの表・本文・探す）に、入れた値が出ない。ページが値を出しても伏せる（タブをまたいでも、会話のあいだ）', async t => {
  const r = rig(t, own());
  await r.open(DEV);
  const typed = await r.call('browser_type', { ref: 'e2', password: PASS, submit: true });
  assert.equal(typed.output.isError, undefined, typed.output.content);
  assert.match(typed.output.content, /Admin/u, '押したあとの画面は返っている');
  assert.ok(typed.output.content.includes('[REDACTED]'), typed.output.content);
  assert.ok(!typed.output.content.includes(PASS), typed.output.content);
  for (const mode of ['elements', 'text'] as const) {
    const read = await browserRead.execute({ mode }, r.ctx);
    assert.ok(!read.content.includes(PASS), `${mode}: ${read.content}`);
    assert.ok(read.content.includes('[REDACTED]'), `${mode}: ${read.content}`);
  }
  const found = await browserFind.execute({ query: 'Secret echo' } as never, r.ctx);
  assert.ok(!found.content.includes(PASS), found.content);
  // 同じ会話の別のタブ・あとのページでも伏せる
  r.driver.site('https://example.com/other', { title: 'Other', text: `Other ${PASS}`, snapshot: `- link "Mine ${PASS}"`, rows: [{ role: 'link', name: `Mine ${PASS}` }] });
  const other = await browserOpen.execute({ url: 'https://example.com/other' }, r.ctx);
  assert.ok(!other.content.includes(PASS), other.content);
  assert.ok(r.session.secretsFor('c1').includes(PASS));
  assert.ok(!r.session.secretsFor('c2').includes(PASS), 'ほかの会話では覚えない');
});

test('P7: browser_act の step で入れたあとの差分・あとの step の出力にも、入れた値が出ない', async t => {
  const r = rig(t, own());
  await r.open(DEV);
  const outcome = await r.call('browser_act', { steps: [{ type: 'e2', password: PASS, submit: true }] });
  assert.equal(outcome.output.isError, undefined, outcome.output.content);
  assert.ok(!outcome.output.content.includes(PASS), outcome.output.content);
  assert.ok(outcome.output.content.includes('[REDACTED]'), outcome.output.content);
  const read = await browserRead.execute({ mode: 'text' }, r.ctx);
  assert.ok(!read.content.includes(PASS), read.content);
});

test('P7: 覚えた値は会話ごと・上限つき（古いものから捨てる）。会話を消すと忘れる。URL の形でも伏せる', async t => {
  const r = rig(t, own());
  r.session.rememberTyped('c1', 'a b&c');
  assert.ok(r.session.secretsFor('c1').includes('a b&c'));
  assert.equal(redactSecrets('x?q=a%20b%26c&y=a+b%26c', r.session.secretsFor('c1')), 'x?q=[REDACTED]&y=[REDACTED]', 'URL に入った形も');
  r.session.rememberTyped('c1', '   ');
  for (let i = 0; i < 40; i += 1) r.session.rememberTyped('c1', `pass-${i}-xxxxxxxx`);
  const kept = r.session.secretsFor('c1').filter(s => s.startsWith('pass-'));
  assert.ok(kept.length <= 32 && kept.includes('pass-39-xxxxxxxx') && !kept.includes('pass-0-xxxxxxxx'), `${kept.length}`);
  await r.session.closeConversation(['c1']);
  assert.deepEqual(r.session.secretsFor('c1').filter(s => s.startsWith('pass-') || s === 'a b&c'), []);
});

// ── 欄の種類の見分け ──

test('P7: fieldKind: 暗証番号（type=password・current-password・new-password・one-time-code・名前）とカード（cc-*・名前）を分け、両方に当たればカード', () => {
  const kind = (detail: { type?: string; autocomplete?: string }, name = 'Field') => fieldKind(detail, name);
  assert.equal(kind({}), 'ordinary');
  assert.equal(kind({ type: 'text' }, 'Search'), 'ordinary');
  assert.equal(kind({ type: 'password' }), 'password');
  for (const autocomplete of ['current-password', 'new-password', 'one-time-code', 'section-x one-time-code']) assert.equal(kind({ autocomplete }), 'password', autocomplete);
  for (const name of ['Password', 'Your passcode', 'パスワード', '暗証番号', 'One-time code', 'Verification code', '認証コード']) assert.equal(kind({}, name), 'password', name);
  for (const autocomplete of ['cc-number', 'cc-csc', 'cc-exp', 'section-pay cc-name']) assert.equal(kind({ autocomplete }), 'card', autocomplete);
  for (const name of ['Card number', 'カード番号', 'CVC', 'CVV', 'Security code', 'セキュリティコード']) assert.equal(kind({}, name), 'card', name);
  assert.equal(kind({ type: 'password', autocomplete: 'cc-csc' }), 'card', '両方に当たる欄はカード');
  assert.equal(kind({ type: 'password' }, 'Card number'), 'card');
  assert.equal(kind({ autocomplete: 'one-time-code' }, 'CVV'), 'card');
});

test('P7: 暗証番号の欄は、click・select・press には今までどおり（select・press は断る）。password の引数は browser_click には無い', async t => {
  const r = rig(t, own());
  await r.open(DEV);
  const click = await r.call('browser_click', { ref: 'e2', password: PASS });
  assert.equal(click.decision, 'deny');
  assert.equal(click.invalidArguments, true);
  assert.ok(!click.output.content.includes(PASS), click.output.content);
});

// ── 履歴の API・tool.call の知らせ（本物の App を通す） ──

const callScript = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const finish: Script = async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; };

test('P7: 会話の AI が password を渡した呼び出し（断られても）の値が、会話の履歴の API・tool.call の出来事・道具の記録の API に出ない。会話にはそのまま残る（モデルに戻す分）', async t => {
  const driver = new FakeBrowserDriver().site(LISTED, loginSite());
  const s = await startApp(t, {
    models: [fakeModel('m1')], browserDriver: driver,
    configure: c => { c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; },
  });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  s.adapter().scripts = [callScript('browser_open', { url: LISTED }), callScript('browser_type', { ref: 'e2', password: PASS }), callScript('browser_act', { steps: [{ type: 'e2', password: PASS }] }), finish];
  const id = uuid(71);
  s.app.conversations.create({ id, title: '会話' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId);
  const listing = await (await s.api(`/api/conversations/${id}/messages`)).text();
  assert.ok(!listing.includes(PASS), listing);
  const shown = (JSON.parse(listing) as { messages: Array<{ toolCalls?: Array<{ name: string; input: string }> }> }).messages.flatMap(m => m.toolCalls ?? []).filter(c => c.name === 'browser_type' || c.name === 'browser_act');
  assert.equal(shown.length, 2);
  for (const call of shown) assert.ok(call.input.includes('[REDACTED]'), call.input);
  const called = events.filter(e => e.type === 'tool.call');
  assert.ok(called.length >= 3);
  assert.ok(!everything(called).includes(PASS), everything(called));
  assert.ok(!(await (await s.api('/api/tool-calls')).text()).includes(PASS));
  const rows = s.app.db.prepare('SELECT input, output_preview FROM tool_calls').all() as Array<{ input: string; output_preview: string }>;
  for (const row of rows) assert.ok(!row.input.includes(PASS) && !row.output_preview.includes(PASS), everything(row));
  const stored = s.app.conversations.messages(id).flatMap(m => (m.message.role === 'assistant' ? m.message.toolCalls ?? [] : []));
  assert.ok(stored.some(call => everything(call.arguments).includes(PASS)), '会話には引数をそのまま保存する（モデルに戻す分）');
  assert.ok(!s.logs.some(line => line.includes(PASS)), 'ログにも出ない');
});

// ── 審査の指摘（P7 の差し戻し）: URL の形・本文のツール呼び出し・欄の URL と題名・承認の札・短い値 ──

// GET のフォームの送り先は、+（空白）と %21（!）の形で値を URL に載せる。名前は伏せる名前の一覧に無い q
const VALUE = 'Pass/w0rd! x';
const FORM = 'Pass%2Fw0rd%21+x';
const AFTER = `${DEV}after?q=${FORM}`;
const afterLogin = (): FakeSite => {
  const base = loginSite(undefined);
  return { ...base, rows: (base.rows ?? []).map(row => (row.name === 'Password' ? { ...row, effect: { navigate: AFTER } } : row)) };
};
const afterPage: FakeSite = { title: `Welcome ${VALUE}`, text: 'Welcome', snapshot: ['- heading "Welcome"', `- link "Profile ${VALUE}"`].join('\n'), rows: [{ role: 'link', name: `Profile ${VALUE}` }] };

test('P7: 値の URL の形（フォームの + と %21・大文字小文字の違う 16 進・%20）も伏せる。値を 1 つ覚えれば、どの形でも', async t => {
  const r = rig(t, own());
  r.session.rememberTyped('c1', 'Passw0rd! x');
  const secrets = r.session.secretsFor('c1');
  const form = new URLSearchParams([['', 'Passw0rd! x']]).toString().slice(1);
  assert.equal(form, 'Passw0rd%21+x');
  for (const shown of [form, encodeURIComponent('Passw0rd! x'), 'Passw0rd%21%20x', 'Passw0rd! x']) {
    const out = redactSecrets(`http://localhost:5173/after?q=${shown}`, secrets);
    assert.ok(!out.includes('Passw0rd'), `${shown} -> ${out}`);
  }
  r.session.rememberTyped('c1', VALUE);
  for (const shown of [FORM, 'Pass%2fw0rd%21+x', 'Pass%2Fw0rd%21%20x', 'Pass%2fw0rd%21%20x', encodeURIComponent(VALUE)]) {
    const out = redactSecrets(`http://localhost:5173/after?q=${shown}`, r.session.secretsFor('c1'));
    assert.ok(!out.includes('w0rd'), `${shown} -> ${out}`);
  }
});

test('P7: GET のフォームの送り先 URL に載った値（+ や %21 の形）が、結果の見出し・差分・出来事・記録に出ない', async t => {
  const r = rig(t, own());
  r.driver.site(DEV, afterLogin()).site(AFTER, afterPage);
  await r.open(DEV);
  const typed = await r.call('browser_type', { ref: 'e2', password: VALUE, submit: true });
  assert.equal(typed.output.isError, undefined, typed.output.content);
  assert.match(typed.output.content, /Welcome/u, '送ったあとの画面は返っている');
  assert.ok(!typed.output.content.includes('w0rd') && !typed.output.content.includes('Pass%2'), typed.output.content);
  const batch = await r.call('browser_act', { steps: [{ type: 'e2', password: VALUE, submit: true }], then: 'none' });
  assert.ok(!batch.output.content.includes('w0rd'), batch.output.content);
  for (const event of r.events.filter(e => e.type === 'tool.result' || e.type === 'tool.call')) assert.ok(!everything(event).includes('w0rd'), everything(event));
  const rows = r.db.prepare('SELECT input, output_preview FROM tool_calls').all() as Array<{ input: string; output_preview: string }>;
  for (const row of rows) assert.ok(!row.input.includes('w0rd') && !row.output_preview.includes('w0rd'), everything(row));
});

test('P7: ブラウザの欄（ミラー）に出す URL と題名も、入れた値を伏せる', async t => {
  const r = rig(t, own());
  r.driver.site(DEV, afterLogin()).site(AFTER, afterPage);
  await r.open(DEV);
  const typed = await r.call('browser_type', { ref: 'e2', password: VALUE, submit: true });
  const link = /\b(e\d+)\b[^\n]*link/u.exec(typed.output.content)?.[1];
  assert.ok(link !== undefined, typed.output.content);
  await r.call('browser_click', { ref: link });
  const view = r.session.view('p1', () => ({ attended: true }));
  assert.ok(view, '欄に出せるタブがある');
  assert.ok(view.url.startsWith(`${DEV}after`), view.url);
  assert.ok(view.title.startsWith('Welcome'), view.title);
  assert.equal(view.action.kind, 'click');
  assert.ok(view.action.target.startsWith('Profile'), view.action.target);
  assert.ok(!view.url.includes('w0rd') && !view.title.includes('w0rd') && !view.action.target.includes('w0rd'), everything(view));
});

test('P7: 質問の記録（断った送信）に書かれる、開いているページの URL も、入れた値を伏せる', async t => {
  const r = rig(t, own());
  r.driver.site(DEV, afterLogin()).site(AFTER, afterPage);
  await r.open(DEV);
  assert.equal(r.session.tabUrl('c1'), DEV, '入れる前はそのまま（対照）');
  await r.call('browser_type', { ref: 'e2', password: VALUE, submit: true });
  const url = r.session.tabUrl('c1');
  assert.ok(url !== undefined && url.startsWith(`${DEV}after`), url);
  assert.ok(!url.includes('w0rd'), url);
});

test('P7: 入れた値を名前・URL に含むページの承認の札（preview）も、値を伏せる。札を出すのは暗証番号でない呼び出しだけ', async t => {
  const r = rig(t, own());
  const url = `${LISTED}?q=${PASS}`;
  r.driver.site(url, { title: 'Shop', text: 'Shop', snapshot: `- button "Send ${PASS}"`, rows: [{ role: 'button', name: `Send ${PASS}`, submits: true }] });
  await r.open(url);
  const control = await browserActCheck('click', { ref: 'e1' }, r.ctx);
  assert.equal(control.decision, 'ask', JSON.stringify(control));
  assert.ok(everything(control.preview).includes(PASS), '値を覚える前は、そのまま出る（対照）');
  r.session.rememberTyped('c1', PASS);
  const check = await browserActCheck('click', { ref: 'e1' }, r.ctx);
  assert.equal(check.decision, 'ask');
  assert.ok(check.preview?.[0]?.text.includes('Send'), '札には名前が出る');
  // 札に出す中身だけ（承認のあとに比べる指紋 bind は札に出ず、中身は beat の中の比べ物なので、ここでは見ない）
  assert.ok(!everything(check.preview).includes(PASS), everything(check.preview));
});

test('P7: 4 文字より短い値は、あとの出力の伏せ用に覚えない（1 を入れても e12 のような番号は壊れない）。4 文字以上は伏せる。呼び出しの行は今までどおり伏せる', async t => {
  const r = rig(t, own());
  for (const short of ['1', '12', '123', '  12  ']) r.session.rememberTyped('c1', short);
  assert.deepEqual(r.session.secretsFor('c1'), []);
  r.session.rememberTyped('c1', '1234');
  assert.ok(r.session.secretsFor('c1').includes('1234'));
  const quiet = rig(t, own());
  await quiet.open(DEV);
  const typed = await quiet.call('browser_type', { ref: 'e3', password: '1' });
  assert.equal(typed.output.isError, undefined, typed.output.content);
  const elements = await browserRead.execute({ mode: 'elements' }, quiet.ctx);
  assert.match(elements.content, /\be1\b/u, elements.content);
  assert.match(elements.content, /\be7\b/u, elements.content);
  assert.ok(!elements.content.includes('[REDACTED]'), elements.content);
  const called = quiet.events.filter(e => e.type === 'tool.call');
  assert.ok(called.every(event => event.type === 'tool.call' && event.input.includes('[REDACTED]')), '呼び出しの行の password は 1 文字でも伏せる');
});

// 本文に書かれたツール呼び出し（<tool_call>）: 引数は、印のあとに来る。印が見えたら、そこから先は画面への知らせにも再接続の写しにも書きかけの履歴にも流さない
const STREAM_CHUNKS = ['試します。<tool_', 'call>{"name":"browser_type","argu', 'ments":{"ref":"e2","pass', `word":"${PASS}"}}</tool_`, 'call>'];
// 引数の欄の名前か、値の頭が 1 つでも出たら漏れ
const leaks = (text: string): boolean => text.includes('password') || text.includes(PASS.slice(0, 6));

async function streamApp(t: TestContext) {
  const s = await startApp(t, {
    models: [fakeModel('m1')], browserDriver: new FakeBrowserDriver().site(LISTED, loginSite()),
    configure: c => { c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; },
  });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  return { s, events };
}

test('P7: 本文に書かれたツール呼び出しの引数は、text.delta・再接続の写し（drafts）・履歴の API の書きかけに流さない。印の前の本文は今までどおり流す。保存される返事と呼び出しは変わらない', async t => {
  const { s, events } = await streamApp(t);
  const id = uuid(72);
  const probes: string[] = [];
  const streamed: Script = async function* () {
    for (const part of STREAM_CHUNKS) {
      yield { type: 'text', delta: part };
      probes.push(`${s.app.bus.drafts().map(draft => draft.text).join('|')}\n${await (await s.api(`/api/conversations/${id}/messages`)).text()}`);
    }
    yield { type: 'done', stop: 'end_turn' as StopReason };
  };
  s.adapter().scripts = [streamed, finish];
  s.app.conversations.create({ id, title: '会話' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId);
  assert.equal(probes.length, STREAM_CHUNKS.length);
  assert.ok(probes[0]!.includes('試します。'), `印の前の本文は流れる: ${probes[0]}`);
  for (const probe of probes) assert.ok(!leaks(probe), probe);
  const deltas = events.filter(e => e.type === 'text.delta');
  const shown = deltas.map(e => (e.type === 'text.delta' ? e.text : '')).join('');
  assert.ok(shown.startsWith('試します。') && !leaks(shown), shown);
  assert.ok(!everything(events).includes(PASS), 'どの出来事にも出ない');
  const ring = (s.app.bus.since(0) ?? []).filter(e => e.event.type === 'text.delta');
  assert.ok(ring.length >= 1 && !leaks(everything(ring)), '再接続の写し（バッファ）の本文にも出ない');
  assert.match(s.app.runs.get(sent.body.runId)!.flags, /text_tool_calls/u);
  const saved = s.app.conversations.messages(id);
  assert.equal(saved.find(m => m.role === 'assistant')!.text, '試します。', '保存される返事は印の前の本文');
  assert.ok(saved.some(m => m.message.role === 'assistant' && (m.message.toolCalls ?? []).some(call => call.name === 'browser_type')), '本文の呼び出しは拾われる');
  assert.ok(!(await (await s.api(`/api/conversations/${id}/messages`)).text()).includes(PASS));
});

// 引数を先に書く・args という欄・名前と arguments のあいだに別の欄・1 つの囲みの配列、のあとに普通の呼び出しが続く返事（審査・確かめ役が挙げた形）。
// 引数を 1 文字でも流した呼び出しは実行しない: 流す前に止まる（流れない）ので、呼び出しは今までどおり拾って実行してよい
const FENCE = '```';
const READ_BLOCK = '{"name":"browser_read","arguments":{}}';
const withSecondCall = (body: string): string => `まず\n${FENCE}json\n${body}\n${FENCE}\n次に\n${FENCE}json\n${READ_BLOCK}\n${FENCE}`;
const REPLY_SHAPES: Array<[string, string]> = [
  ['arguments before name', withSecondCall(`{"arguments":{"ref":"e2","password":"${PASS}"},"name":"browser_type"}`)],
  ['args key', withSecondCall(`{"name":"browser_type","args":{"ref":"e2","password":"${PASS}"}}`)],
  ['extra key between name and arguments', withSecondCall(`{"name":"browser_type","id":"c1","arguments":{"ref":"e2","password":"${PASS}"}}`)],
  ['one fence holding an array', `${FENCE}json\n[{"arguments":{"ref":"e2","password":"${PASS}"},"name":"browser_type"},${READ_BLOCK}]\n${FENCE}`],
];

test('P7: 本文のツール呼び出しの形が、引数が先・args・間に別の欄・配列でも、引数は text.delta・再接続の写し・履歴の書きかけに流れない。呼び出しは今までどおり拾う', async t => {
  for (const [name, reply] of REPLY_SHAPES) {
    const { s, events } = await streamApp(t);
    const id = uuid(80 + REPLY_SHAPES.findIndex(([known]) => known === name));
    const probes: string[] = [];
    s.adapter().scripts = [async function* () {
      for (let at = 0; at < reply.length; at += 9) {
        yield { type: 'text', delta: reply.slice(at, at + 9) };
        probes.push(`${s.app.bus.drafts().map(draft => draft.text).join('|')}\n${await (await s.api(`/api/conversations/${id}/messages`)).text()}`);
      }
      yield { type: 'done', stop: 'end_turn' as StopReason };
    }, finish];
    s.app.conversations.create({ id, title: '会話' });
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    assert.ok(probes.length >= 5, name);
    for (const probe of probes) assert.ok(!leaks(probe), `${name}: ${probe}`);
    const shown = events.filter(e => e.type === 'text.delta').map(e => (e.type === 'text.delta' ? e.text : '')).join('');
    assert.ok(shown.startsWith('まず') || shown.startsWith(FENCE) || shown === '', `${name}: ${shown}`);
    assert.ok(!leaks(shown), `${name}: ${shown}`);
    const ring = (s.app.bus.since(0) ?? []).filter(e => e.event.type === 'text.delta');
    assert.ok(ring.length >= 1 && !leaks(everything(ring)), name);
    assert.ok(!everything(events).includes(PASS), name);
    assert.match(s.app.runs.get(sent.body.runId)!.flags, /text_tool_calls/u, name);
    const called = s.app.conversations.messages(id).flatMap(m => (m.message.role === 'assistant' ? m.message.toolCalls ?? [] : [])).map(call => call.name);
    assert.ok(called.includes('browser_type'), `${name}: ${called.join()}`);
    assert.ok(!(await (await s.api(`/api/conversations/${id}/messages`)).text()).includes(PASS), name);
  }
});

// 拾って動かした呼び出しの外に残る本文（別の書き方で繰り返した呼び出し・壊れた呼び出し・知らない道具の呼び出し・あとの説明）に値が書かれていても、保存される返事（履歴の API）に残さない
const TAG_CALL = `<tool_call>{"name":"browser_type","arguments":{"ref":"e2","password":"${PASS}"}}</tool_call>`;
const FENCED_CALL = `${FENCE}json\n{"name":"browser_type","arguments":{"ref":"e2","password":"${PASS}"}}\n${FENCE}`;
const KEPT_SHAPES: Array<[string, string]> = [
  ['the same call repeated in a fence', `ログインします。\n${TAG_CALL}\n念のため同じ呼び出し:\n${FENCED_CALL}`],
  ['a fenced explanation, then the call', `手順:\n${FENCED_CALL}\n${TAG_CALL}`],
  ['a second call with broken JSON', `${TAG_CALL}\n<tool_call>{"name":"browser_type","arguments":{"ref":"e2","password":"${PASS}"</tool_call>`],
  ['a call naming an unknown tool, then the real one', `<tool_call>{"name":"no_such_tool","arguments":{"password":"${PASS}"}}</tool_call>\n${TAG_CALL}`],
  ['narration after the call', `${TAG_CALL}\n入力しました（${PASS}）。`],
];

test('P7: 拾った呼び出しの外に残る本文（繰り返した呼び出し・壊れた呼び出し・知らない道具・あとの説明）に値があっても、保存される返事・履歴の API に残さない。呼び出しは今までどおり拾う', async t => {
  for (const [name, reply] of KEPT_SHAPES) {
    const { s, events } = await streamApp(t);
    const id = uuid(90 + KEPT_SHAPES.findIndex(([known]) => known === name));
    const probes: string[] = [];
    s.adapter().scripts = [async function* () {
      for (let at = 0; at < reply.length; at += 9) {
        yield { type: 'text', delta: reply.slice(at, at + 9) };
        probes.push(`${s.app.bus.drafts().map(draft => draft.text).join('|')}\n${await (await s.api(`/api/conversations/${id}/messages`)).text()}`);
      }
      yield { type: 'done', stop: 'end_turn' as StopReason };
    }, finish];
    s.app.conversations.create({ id, title: '会話' });
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    const head = PASS.slice(0, 6);
    for (const probe of probes) assert.ok(!probe.includes(head), `${name}: ${probe}`);
    const saved = s.app.conversations.messages(id);
    const said = saved.filter(m => m.role === 'assistant').map(m => `${m.text}\n${m.message.role === 'assistant' ? m.message.content : ''}`).join('\n');
    assert.ok(said.length > 0 && !said.includes(head), `${name}: ${said}`);
    assert.ok(!(await (await s.api(`/api/conversations/${id}/messages`)).text()).includes(head), name);
    assert.ok(!everything(events).includes(head), name);
    const called = saved.flatMap(m => (m.message.role === 'assistant' ? m.message.toolCalls ?? [] : [])).map(call => call.name);
    assert.ok(called.includes('browser_type'), `${name}: ${called.join()}`);
  }
});

test('P7: password の引数の説明は、目立つ値（8 文字以上・ページに出ている語や数でないもの）を選ぶよう案内する', () => {
  const description = (browserType.input.properties as Record<string, { description?: string }>).password?.description ?? '';
  assert.match(description, /8 or more characters/u);
  assert.match(description, /not a word or number shown on the page/u);
});

test('P7: browser_act の password（説明文と 1 手ごとの欄の説明）も、目立つ値を選ぶよう案内する', () => {
  assert.match(browserAct.description, /give a test value as "password" instead of "text"\. Pick a distinctive value of 8 or more characters that is not a word or number shown on the page/u);
  const steps = (browserAct.input.properties as Record<string, { items?: { anyOf?: Array<{ properties?: Record<string, { description?: string }> }> } }>).steps;
  const typeStep = steps?.items?.anyOf?.find(step => step.properties?.password !== undefined);
  assert.match(typeStep?.properties?.password?.description ?? '', /8 or more characters.*not a word or number shown on the page/u);
});

// JSON の書き方で繰り返した値（\uXXXX・\/）も、保存される返事に残さない。16 進は大文字でも小文字でも
const BS = String.fromCharCode(92);
const ESCAPED_COPIES: Array<[string, string, string]> = [
  ['at sign as a unicode escape', 'P@ss-Leak-77', `P${BS}u0040ss-Leak-77`],
  ['slash as a backslash slash', 'a/b-Leak-88', `a${BS}/b-Leak-88`],
  ['tilde as an uppercase and a lowercase unicode escape', 'Zq~Leak-99', `Zq${BS}u007ELeak-99 Zq${BS}u007eLeak-99`],
  ['slash as a unicode escape', 'c/d-Leak-66', `c${BS}u002fd-Leak-66`],
];

test('P7: 値を JSON の書き方（\\uXXXX・\\/）で繰り返した本文があっても、保存される返事・履歴の API に残さない', async t => {
  for (const [name, value, copy] of ESCAPED_COPIES) {
    const { s, events } = await streamApp(t);
    const id = uuid(120 + ESCAPED_COPIES.findIndex(([known]) => known === name));
    const reply = `<tool_call>{"name":"browser_type","arguments":{"ref":"e2","password":"${value}"}}</tool_call> JSON で書くと: {"password":"${copy}"}`;
    s.adapter().scripts = [async function* () {
      yield { type: 'text', delta: reply };
      yield { type: 'done', stop: 'end_turn' as StopReason };
    }, finish];
    s.app.conversations.create({ id, title: '会話' });
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    const saved = s.app.conversations.messages(id);
    const said = saved.filter(m => m.role === 'assistant').map(m => `${m.text}\n${m.message.role === 'assistant' ? m.message.content : ''}`).join('\n');
    assert.ok(said.includes('JSON で書くと'), `${name}: ${said}`);
    const tail = value.slice(value.indexOf('Leak'));
    assert.ok(!said.includes(tail), `${name}: ${said}`);
    assert.ok(!(await (await s.api(`/api/conversations/${id}/messages`)).text()).includes(tail), name);
    assert.ok(!everything(events).includes(tail), name);
  }
});

test('P7: 返事の途中で印が見えたあとは、本文を見直さない（続きがどれだけ長くても、見直しの回数は増えない）', async t => {
  const { s } = await streamApp(t);
  const id = uuid(99);
  const head = '前置き。';
  const call = '<tool_call>{"name":"browser_read","arguments":{}}</tool_call>';
  const tail = 'x'.repeat(2000);
  let scans = 0;
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, subject: string): RegExpExecArray | null {
    if (this.source.includes('arguments|parameters|args')) scans += 1;
    return realExec.call(this, subject);
  } as typeof RegExp.prototype.exec;
  try {
    s.adapter().scripts = [async function* () {
      yield { type: 'text', delta: head };
      yield { type: 'text', delta: call };
      for (let at = 0; at < tail.length; at += 4) yield { type: 'text', delta: tail.slice(at, at + 4) };
      yield { type: 'done', stop: 'end_turn' as StopReason };
    }, finish];
    s.app.conversations.create({ id, title: '会話' });
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '読んで' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  } finally { RegExp.prototype.exec = realExec; }
  assert.ok(scans > 0 && scans <= 3, `印が見えたあとの続き 500 回では見直さない: ${scans}`);
  assert.equal(s.app.conversations.messages(id).find(m => m.role === 'assistant')!.text, head + tail, '保存される返事は変わらない');
});

test('P7: 印の無い返事は、今までどおり 1 つずつ流す（欠けも並べ替えも無い）', async t => {
  const { s, events } = await streamApp(t);
  const id = uuid(73);
  const parts = ['やあ、', '今日は', '<b>', ' 晴れ'];
  s.adapter().scripts = [async function* () { for (const part of parts) yield { type: 'text', delta: part }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  s.app.conversations.create({ id, title: '会話' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'こんにちは' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(events.filter(e => e.type === 'text.delta').map(e => (e.type === 'text.delta' ? e.text : '')), parts);
});

test('P7: 本文のツール呼び出しの途中で止めても、止めた返事（途中まで）に引数が残らない', async t => {
  const { s, events } = await streamApp(t);
  const id = uuid(74);
  s.adapter().scripts = [async function* () {
    for (const part of STREAM_CHUNKS.slice(0, 4)) yield { type: 'text', delta: part };
    s.app.engine.stop(s.app.engine.activeRuns()[0]!.runId);
    throw new Error('aborted');
  }];
  s.app.conversations.create({ id, title: '会話' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'ログインして' });
  await settled(s.app, sent.body.runId);
  const saved = s.app.conversations.messages(id).filter(m => m.role === 'assistant');
  assert.equal(saved.length, 1, '止めた返事は保存される');
  assert.ok(saved[0]!.text.startsWith('試します。'), saved[0]!.text);
  assert.ok(!leaks(saved[0]!.text) && !everything(saved).includes(PASS), everything(saved));
  assert.ok(!everything(events).includes(PASS));
  assert.ok(!(await (await s.api(`/api/conversations/${id}/messages`)).text()).includes(PASS));
});

// ── 本物のプロセス（Windows）: ジョブの中で動くサーバーには入れ、ジョブの外のサーバーは、ポートが出力に出ていても断る ──

const LISTENER = "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port)); setInterval(() => {}, 1000);";
// 根は 1.5 秒待ってから、待ち受ける孫を起こし、そのポートを「Local: http://localhost:…/」として出す（開発サーバーの出力のまね）
const SERVER_ROOT = `setTimeout(() => { const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LISTENER)}], { stdio: ['ignore', 'pipe', 'ignore'] }); c.stdout.on('data', d => { const m = /PORT (\\d+)/.exec(String(d)); if (m) console.log('Local: http://localhost:' + m[1] + '/'); }); }, 1500); setInterval(() => {}, 1000);`;

async function until<T>(probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const refIn = (content: string, name: string): string => new RegExp(`^(e\\d+) textbox "${name}"$`, 'mu').exec(content)![1]!;

test('P7（Windows の本物のプロセス）: 裏のコマンドが起こした開発サーバーには入れる。ポートが出力に出ただけのジョブの外のサーバーには、判定役にも回さず入れない。止めたあとも入れない', { skip: !WINDOWS && 'Windows only' }, async t => {
  const dir = tempDir(t);
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs') });
  t.after(() => jobs.closeAll());
  const started = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', SERVER_ROOT], env: scrubEnv(), fetched: false });
  assert.ok('id' in started, JSON.stringify(started));
  const portOf = (id: string): number | false => { const m = /Local: http:\/\/localhost:(\d+)\//u.exec(jobs.peek(id, 0)?.text ?? ''); return m ? Number(m[1]) : false; };
  const inside = await until(() => portOf(started.id));
  // ジョブの外のサーバー（beat が起こしたものではない）。別の裏のコマンドが、そのポートを出力に出す
  const outsideChild: ChildProcess = spawn(process.execPath, ['-e', LISTENER], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { outsideChild.kill(); } catch { /* already gone */ } });
  const outside = await new Promise<number>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('the outside listener did not start')), 10_000);
    outsideChild.stdout!.on('data', (chunk: Buffer) => { seen += chunk.toString('utf8'); const m = /PORT (\d+)/u.exec(seen); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const printer = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', `console.log('Local: http://localhost:${outside}/'); setInterval(() => {}, 1000);`], env: scrubEnv(), fetched: false });
  assert.ok('id' in printer);
  await until(() => jobs.printedPorts({ conversationId: 'c1' }).has(outside));
  assert.equal(jobs.printedPorts({ conversationId: 'c1' }).has(inside), true);

  const r = rig(t, { background: jobs });
  const insideUrl = `http://localhost:${inside}/`;
  const outsideUrl = `http://localhost:${outside}/`;
  r.driver.site(insideUrl, loginSite()).site(outsideUrl, loginSite());
  const first = await r.open(insideUrl);
  const second = await r.open(outsideUrl);
  const insideRef = refIn(first.content, 'Password');
  const outsideRef = refIn(second.content, 'Password');
  const ok = await r.call('browser_type', { tab: 't1', ref: insideRef, password: PASS });
  assert.equal(ok.decision, 'allow', ok.output.content);
  assert.deepEqual(first.page.acts.map(a => [a.kind, a.text]), [['fill', PASS]], 'ジョブの中のサーバーには入れた');
  // 同じ場所の押すは、出力にポートが出ていれば開発サーバーとして押せる（今までどおり）。暗証番号だけが、待ち受けがジョブの中かを求める
  const refused1 = await r.call('browser_type', { tab: 't2', ref: outsideRef, password: PASS });
  assert.equal(refused1.decision, 'deny', refused1.output.content);
  assert.ok(refused1.output.content.includes(gt('browser.act.password_own_only')), refused1.output.content);
  assert.deepEqual(second.page.acts, [], 'ジョブの外のサーバーには入れない');
  assert.deepEqual({ ...r.counts(), acts: undefined }, { ...NONE, acts: undefined });
  const outsideBatch = await r.call('browser_act', { tab: 't2', steps: [{ type: outsideRef, password: PASS }] });
  assert.equal(outsideBatch.output.isError, true, outsideBatch.output.content);
  assert.deepEqual(second.page.acts, []);
  // 止めたあと
  await jobs.stop(started.id, 'model', 'c1');
  const stopped = await r.call('browser_type', { tab: 't1', ref: insideRef, password: PASS });
  assert.equal(stopped.output.isError, true, stopped.output.content);
  assert.equal(first.page.acts.length, 1, '止めたあとは入れない');
});

// 符号化の仕方が違う URL（審査・確かめ役が挙げた形）: ブラウザの URL（%20 と ! ( ) * がそのまま・' は %27）、PHP urlencode・Python quote_plus（+ と %21 %28 %29 %2A %27）、ページの JS の足し算（P@ss%20word・a/b%20c!d）
const URL_CASES: Array<[string, string, string]> = [
  ["a b!c(d)e*f'g", 'a%20b!c(d)e*f%27g', 'b!c'],
  ["a b!c(d)e*f'g", 'a+b%21c%28d%29e%2Af%27g', 'b%21c'],
  ['P@ss word', 'P@ss%20word', 'ss%20word'],
  ['a/b c!d', 'a/b%20c!d', 'b%20c'],
];

test('P7: 値の URL の形が、ブラウザ・PHP・Python・ページの JS のどの符号化でも、結果の見出し・欄の URL・質問の URL・記録に出ない', async t => {
  for (const [value, form, fragment] of URL_CASES) {
    const url = `${DEV}after?q=${form}`;
    const r = rig(t, own());
    const base = loginSite(undefined);
    r.driver.site(DEV, { ...base, rows: (base.rows ?? []).map(row => (row.name === 'Password' ? { ...row, effect: { navigate: url } } : row)) }).site(url, { title: 'After', text: 'After', snapshot: '- heading "After"', rows: [] });
    await r.open(DEV);
    const typed = await r.call('browser_type', { ref: 'e2', password: value, submit: true });
    assert.equal(typed.output.isError, undefined, typed.output.content);
    assert.match(typed.output.content, /After/u);
    assert.ok(!typed.output.content.includes(fragment), `${form}: ${typed.output.content}`);
    const view = r.session.view('p1', () => ({ attended: true }));
    assert.ok(view && view.url.startsWith(`${DEV}after`) && !view.url.includes(fragment), `${form}: ${view?.url}`);
    const asked = r.session.tabUrl('c1');
    assert.ok(asked !== undefined && !asked.includes(fragment), `${form}: ${asked}`);
    const rows = r.db.prepare('SELECT input, output_preview FROM tool_calls').all() as Array<{ input: string; output_preview: string }>;
    for (const row of rows) assert.ok(!row.input.includes(fragment) && !row.output_preview.includes(fragment), `${form}: ${everything(row)}`);
    for (const event of r.events) assert.ok(!everything(event).includes(fragment), `${form}: ${everything(event)}`);
  }
});
