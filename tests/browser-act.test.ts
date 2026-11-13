import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import type { ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { BROWSER_TOOLS, browserClick, browserOpen, browserRead, browserType } from '../src/tools/builtin/browser.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { PendingStore } from '../src/pending/store.ts';
import { replayAction } from '../src/pending/replay.ts';
import { FakeBrowserDriver, type FakePage, type FakeSite } from './helpers/fake-browser.ts';
import { tempDir, testConfig } from './helpers.ts';

// T-20〜T-29（AU-6b）: browser_click / browser_type。偽の driver で、パイプライン込みの流れを確かめる（本物のブラウザは起動しない）

const PAGE = 'https://example.com/form';
const OTHER = 'https://example.com/other';
const SNAPSHOT = [
  '- heading "Form" [level=1]',
  '- textbox "Search"',
  '- button "Send"',
  '- textbox "Password"',
  '- textbox "Code"',
  '- textbox "Account"',
  '- button "Hidden"',
  '- iframe:',
  '  - button "Inner"',
  '- button "Pop"',
  '- button "Busy"',
  '- link "Off"',
].join('\n');
// e1 Search / e2 Send / e3 Password / e4 Code / e5 Account / e6 Hidden / e7 Pop / e8 Busy / e9 Off（iframe の中は番号なし）
const SITE: FakeSite = {
  title: 'Form', text: 'form', snapshot: SNAPSHOT,
  rows: [
    { role: 'textbox', name: 'Search' },
    { role: 'button', name: 'Send', effect: { navigate: OTHER, dialogs: 1, downloads: 1, fileChoosers: 1 } },
    { role: 'textbox', name: 'Password' },
    { role: 'textbox', name: 'Code', autocomplete: 'one-time-code' },
    { role: 'textbox', name: 'Account', type: 'password' },
    { role: 'button', name: 'Hidden', state: { visible: false, enabled: true } },
    { role: 'button', name: 'Pop', effect: { popups: 2 } },
    { role: 'button', name: 'Busy', effect: { fail: 'act_failed' } },
    { role: 'link', name: 'Off', state: { visible: true, enabled: false } },
  ],
};
const OTHER_SITE: FakeSite = { title: 'Other', text: 'other', snapshot: '- textbox "Search"\n- button "Send"', rows: [{ role: 'textbox', name: 'Search' }, { role: 'button', name: 'Send' }] };

type Rig = ReturnType<typeof rig>;

const withoutSubmits = (def: ToolDef): ToolDef => Object.fromEntries(Object.entries(def).filter(([key]) => key !== 'submits')) as unknown as ToolDef;

function rig(t: { after: (fn: () => void | Promise<void>) => void }, options: {
  mutate?: (c: AppConfig) => void; mode?: PermissionMode; classify?: (prompt: ClassifierPrompt) => Promise<string> | string; plain?: boolean;
} = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.sites = ['example.com'];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const driver = new FakeBrowserDriver().site(PAGE, SITE).site(OTHER, OTHER_SITE);
  const session = new BrowserSession({ driver, config: () => parsed, paths: { browserProfile: 'C:\\data\\browser-profile' }, secrets: () => [] });
  t.after(() => session.close());
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry();
  for (const def of BROWSER_TOOLS) registry.register((options.plain && (def as ToolDef).submits ? withoutSubmits(def as ToolDef) : def) as never);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const state = { mode: options.mode ?? 'normal' as PermissionMode };
  const ctx = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: state.mode,
    services: { browser: session }, model: { id: 'm', vision: true },
  } as unknown as ToolContext;
  const classify = options.classify;
  const call = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals, pending, judgeAll: true, db, emit: () => undefined, permissionMode: () => state.mode, conversationAutoRead: () => false,
    ...(classify ? { autoClassify: async (prompt: ClassifierPrompt) => classify(prompt), lastUserRequest: () => 'フォームに入れて', conversationTainted: () => false } : {}),
  });
  const approve = (id: number, tools: ToolRegistry = registry) => replayAction(pending.claim(id), {
    db, store: pending, registry: tools, config: () => parsed, paths, conversationExists: () => true, services: () => ({ browser: session }) as ToolContext['services'],
  });
  return { ctx, call, approvals, db, driver, session, parsed, pending, approve };
}

// ページを開いて、触れるものの一覧を読む（ここは読むだけの道具を直接呼ぶ）
async function opened(r: Rig, url = PAGE): Promise<FakePage> {
  const out = await browserOpen.execute({ url }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  return r.driver.current!.pageList[0]!;
}

const observe = async (r: Rig, name: string, args: unknown) => ({ outcome: await r.call(name, args) });

const parkedId = (r: Rig): number => r.pending.list({ status: 'waiting' })[0]!.id;

const preCheck = (r: Rig, tool: typeof browserClick | typeof browserType, input: unknown) => (tool.preCheck as (i: unknown, c: ToolContext) => Promise<import('../src/tools/types.ts').PreCheck>)(input, r.ctx);

// ── T-20: 札の中身と、事前の判定の形 ──

test('T-20: 事前の判定は ask。sends・askKinds web・bind・fetched・札の中身を持ち、onceOnly ではない', async t => {
  const r = rig(t);
  await opened(r);
  const check = await preCheck(r, browserType, { ref: 'e1', text: 'こんにちは', submit: true });
  assert.equal(check.decision, 'ask');
  assert.equal(check.sends, true);
  assert.deepEqual(check.askKinds, ['web']);
  assert.equal(check.onceOnly, undefined, '持ち主の決定: onceOnly にしない（会話の許可で通す）');
  assert.equal(check.fetched, true);
  assert.equal(check.bind, JSON.stringify(['t1', PAGE, 'textbox', 'Search', 0, null]));
  const file = check.preview![0]!;
  assert.ok(file.path.includes(PAGE));
  assert.ok(file.text.includes('textbox') && file.text.includes('Search'));
  assert.ok(file.text.includes('name given by the page'), 'ページが付けた名前だと添える');
  assert.ok(file.text.includes('こんにちは'), '入れる文字の全文');
  assert.ok(file.text.includes('Then Enter is pressed'));
  const click = await preCheck(r, browserClick, { ref: 'e2' });
  assert.equal(click.decision, 'ask');
  assert.equal(click.sends, true);
  assert.ok(!click.preview![0]!.text.includes('Enter'), 'click に Enter の行は無い');
  assert.equal(browserClick.submits, true);
  assert.equal(browserType.submits, true);
  assert.equal(browserClick.effect, 'network');
  assert.deepEqual([...browserType.allowedIn], ['chat']);
});

test('T-20: 名前は 120 文字・改行なしに整え、入れる文字は 2000 文字まで全文出す', async t => {
  const r = rig(t);
  const longName = `長い\n名前${'あ'.repeat(300)}`;
  r.driver.site(PAGE, { ...SITE, snapshot: `- textbox ${JSON.stringify(longName)}`, rows: [{ role: 'textbox', name: longName }] });
  await opened(r);
  const text = 'x'.repeat(2000);
  const check = await preCheck(r, browserType, { ref: 'e1', text });
  const body = check.preview![0]!.text;
  const targetLine = body.split('\n')[0]!;
  assert.ok(!targetLine.includes('\n') && targetLine.includes('…'));
  assert.ok(targetLine.length < 200);
  assert.ok(body.includes(text), '2000 文字の全文');
  assert.equal(check.preview![0]!.truncated, false);
  const over = await preCheck(r, browserType, { ref: 'e1', text: `${text}y` });
  assert.equal(over.decision, 'deny');
});

// ── 4-2d: 押す・入れる（submits）は送る操作なので、会話でも札にせず Pending に積む ──

test('4-2d: browser_click・browser_type は、ふつうのモードでも、会話の許可より前に Pending に積まれ、札は出ず、押さない', async t => {
  const r = rig(t);
  const page = await opened(r);
  for (const [name, args] of [['browser_type', { ref: 'e1', text: 'abc' }], ['browser_click', { ref: 'e2' }], ['browser_type', { ref: 'e1', text: 'abc' }]] as const) {
    const seen = await observe(r, name, args);
    assert.equal(seen.outcome.decidedBy, 'pending', name);
    assert.equal(seen.outcome.output.isError, undefined);
  }
  assert.equal(page.acts.length, 0);
  assert.deepEqual(r.pending.list({ status: 'waiting' }).map(row => [row.tool, row.kind]).reverse(), [['browser_type', 'send'], ['browser_click', 'send'], ['browser_type', 'send']]);
});

test('4-2d: 人のいない実行（タスク・子の担当）の押す・入れるは、積まずに断る', async t => {
  const r = rig(t);
  const page = await opened(r);
  const submitting: ToolDef = { ...(browserClick as unknown as ToolDef), name: 'submit_stub', allowedIn: ['chat', 'task', 'agent'] };
  const registry = new ToolRegistry().register(submitting);
  for (const kind of ['task', 'agent'] as const) {
    const outcome = await runToolCall({ id: `u-${kind}`, name: 'submit_stub', arguments: { ref: 'e2' } }, { ...r.ctx, kind }, {
      registry, approvals: r.approvals, pending: r.pending, judgeAll: true, db: r.db, emit: () => undefined, permissionMode: () => 'auto', conversationAutoRead: () => false,
    });
    assert.equal(outcome.decision, 'deny', kind);
    assert.match(outcome.output.content, /submits in the browser, and nobody is watching this run/u, kind);
  }
  assert.equal(r.pending.list({ status: 'waiting' }).length, 0);
  assert.equal(page.acts.length, 0);
});

// ── T-22: 承認と実行のあいだに変わったら実行しない ──

test('T-22: 承認のあいだに遷移したら、実行しない（同じ呼び出しの再比較）', async t => {
  const r = rig(t);
  const page = await opened(r);
  assert.equal((await r.call('browser_type', { ref: 'e1', text: 'abc' })).decidedBy, 'pending');
  assert.equal((await r.approve(parkedId(r))).status, 'ran', '変わっていなければ、承認で 1 回だけ動く');
  assert.equal(page.acts.length, 1);
  assert.equal((await r.call('browser_click', { ref: 'e2' })).decidedBy, 'pending');
  page.navigateTo(OTHER);
  const result = await r.approve(parkedId(r));
  assert.equal(result.status, 'failed');
  assert.match(result.output ?? '', /The page has changed/u);
  assert.equal(page.acts.length, 1);
});

test('T-22: 承認のあいだに同じ番号が別の要素になったら、実行しない（bind の不一致）', async t => {
  const r = rig(t);
  const page = await opened(r);
  assert.equal((await r.call('browser_click', { ref: 'e2' })).decidedBy, 'pending');
  // ページが書き換わり、読み直したら e2 は別の名前のボタンになった（同じ URL）
  page.mutate({ ...SITE, snapshot: SNAPSHOT.replace('button "Send"', 'button "Delete account"'), rows: SITE.rows!.map(x => x.name === 'Send' ? { ...x, name: 'Delete account' } : x) });
  await browserRead.execute({ mode: 'elements' }, r.ctx);
  const result = await r.approve(parkedId(r));
  assert.equal(result.status, 'stale');
  assert.equal(page.acts.length, 0);
});

test('T-22: 実行の直前の探し直し: 数が変わった・隠れた・無効なら、押さない', async t => {
  const r = rig(t);
  const page = await opened(r);
  // 札なしの実行でも探し直す（preCheck を通さず execute を直接）
  page.mutate({ ...SITE, rows: SITE.rows!.map(x => x.name === 'Send' ? { ...x, state: { visible: false, enabled: true } } : x) });
  const hidden = await browserClick.execute({ ref: 'e2' }, r.ctx);
  assert.equal(hidden.isError, true);
  page.mutate({ ...SITE, rows: SITE.rows!.filter(x => x.name !== 'Send') });
  const gone = await browserClick.execute({ ref: 'e2' }, r.ctx);
  assert.equal(gone.isError, true);
  const disabled = await browserClick.execute({ ref: 'e9' }, r.ctx);
  assert.equal(disabled.isError, true);
  assert.equal(page.acts.length, 0);
});

// 積んだ呼び出しの、承認後の比べ（replay）から実行（act の探し直し）までのあいだに、ページが書き換わる場合
function runWithSwapAfterRecheck(r: Rig, onLastPreCheck: () => Promise<void>) {
  let calls = 0;
  const original = browserClick.preCheck! as (i: unknown, c: ToolContext) => Promise<import('../src/tools/types.ts').PreCheck>;
  const swapped = {
    ...(browserClick as unknown as ToolDef),
    preCheck: async (input: never, ctx: ToolContext) => {
      calls += 1;
      const result = await original(input, ctx);
      if (calls === 3) await onLastPreCheck();
      return result;
    },
  };
  const registry = new ToolRegistry();
  registry.register(swapped as never);
  const run = () => runToolCall({ id: 'k', name: 'browser_click', arguments: { ref: 'e2' } }, r.ctx, {
    registry, approvals: r.approvals, pending: r.pending, judgeAll: true, db: r.db, emit: () => undefined, permissionMode: () => 'normal', conversationAutoRead: () => false,
  });
  return { run, registry, calls: () => calls };
}

test('承認後の比べのあと、実行の直前に別の要素へ入れ替わったら押さない（bind を act に渡して比べ直す）', async t => {
  const r = rig(t);
  const page = await opened(r);
  const swap = async (): Promise<void> => {
    page.mutate({ ...SITE, snapshot: SNAPSHOT.replace('button "Send"', 'button "Delete account"'), rows: SITE.rows!.map(x => x.name === 'Send' ? { ...x, name: 'Delete account' } : x) });
    await browserRead.execute({ mode: 'elements' }, r.ctx);
  };
  const rigged = runWithSwapAfterRecheck(r, swap);
  assert.equal((await rigged.run()).decidedBy, 'pending');
  const outcome = await r.approve(parkedId(r), rigged.registry);
  assert.equal(rigged.calls(), 3, '積む前に 1 回、承認のあとに 2 回');
  assert.equal(outcome.status, 'failed');
  assert.equal(page.acts.length, 0, '許した要素と違うものには押さない');
});

// ── T-23: 自動承認 ──

test('T-23: 自動承認モードでも、押す・入れるは送る操作なので判定役に回らず、Pending に積まれる', async t => {
  const classified: ClassifierPrompt[] = [];
  const r = rig(t, { mode: 'auto', classify: prompt => { classified.push(prompt); return '{"decision":"allow","reason":"x"}'; } });
  const page = await opened(r);
  const result = await observe(r, 'browser_type', { ref: 'e1', text: 'abc' });
  assert.equal(result.outcome.decidedBy, 'pending');
  assert.equal(classified.length, 0, '判定役には回らない');
  assert.equal(page.acts.length, 0);
});

// ── T-24: サイト一覧 ──

test('T-24: サイト一覧に無いサイト・空の一覧は deny（札にしない）。実行もしない', async t => {
  for (const sites of [['other.example.org'], []]) {
    const r = rig(t, { mutate: c => { c.tools.browser.sites = sites; } });
    const page = await opened(r);
    for (const [tool, input] of [[browserClick, { ref: 'e2' }], [browserType, { ref: 'e1', text: 'a' }]] as const) {
      const check = await preCheck(r, tool, input);
      assert.equal(check.decision, 'deny', JSON.stringify(sites));
      assert.ok(check.reasons[0]!.includes('example.com'));
      const out = await tool.execute(input as never, r.ctx);
      assert.equal(out.isError, true);
    }
    const asked = await observe(r, 'browser_click', { ref: 'e2' });
    assert.equal(asked.outcome.decision, 'deny');
    assert.equal(page.acts.length, 0);
  }
});

// ── T-25: 秘密の欄 ──

test('T-25: password 欄（type・autocomplete・名前）への browser_type は拒否する。click は別の判定', async t => {
  const r = rig(t);
  const page = await opened(r);
  for (const ref of ['e3', 'e4', 'e5']) {
    const check = await preCheck(r, browserType, { ref, text: 'hunter2' });
    assert.equal(check.decision, 'deny', ref);
    const out = await browserType.execute({ ref, text: 'hunter2' }, r.ctx);
    assert.equal(out.isError, true, ref);
  }
  assert.equal(page.acts.length, 0);
  // 文字を入れる欄でないものは、browser_type で拒否
  assert.equal((await preCheck(r, browserType, { ref: 'e2', text: 'a' })).decision, 'deny');
  // 普通の欄は ask
  assert.equal((await preCheck(r, browserType, { ref: 'e1', text: 'a' })).decision, 'ask');
});

test('T-25: cc-* の autocomplete と current-password / new-password も拒否する', async t => {
  for (const autocomplete of ['cc-number', 'cc-csc', 'current-password', 'new-password', 'section-x one-time-code']) {
    const r = rig(t);
    r.driver.site(PAGE, { ...SITE, snapshot: '- textbox "Field"', rows: [{ role: 'textbox', name: 'Field', autocomplete }] });
    await opened(r);
    assert.equal((await preCheck(r, browserType, { ref: 'e1', text: '1' })).decision, 'deny', autocomplete);
  }
  // 対照: 属性が普通の欄は通る
  const ok = rig(t);
  ok.driver.site(PAGE, { ...SITE, snapshot: '- textbox "Field"', rows: [{ role: 'textbox', name: 'Field', autocomplete: 'email' }] });
  await opened(ok);
  assert.equal((await preCheck(ok, browserType, { ref: 'e1', text: '1' })).decision, 'ask');
});

// ── T-26: 古い番号・iframe ──

test('T-26: 遷移のあとの古い番号・表を読んでいないタブ・iframe の中の要素は拒否する', async t => {
  const r = rig(t);
  const page = await opened(r);
  page.navigateTo(OTHER);
  const stale = await preCheck(r, browserClick, { ref: 'e2' });
  assert.equal(stale.decision, 'deny');
  assert.ok(stale.reasons[0]!.includes('The page has changed'));
  page.navigateTo(PAGE);
  // iframe の中のボタン（Inner）には番号が無い。e12 は存在しない
  const frame = await preCheck(r, browserClick, { ref: 'e12' });
  assert.equal(frame.decision, 'deny');
  assert.ok(frame.reasons[0]!.includes('e12'));
  // タブが無ければ、ブラウザを起動せず deny
  const empty = rig(t);
  const check = await preCheck(empty, browserClick, { ref: 'e1' });
  assert.equal(check.decision, 'deny');
  assert.equal(empty.driver.launches, 0);
});

// ── 実行の結果 ──

test('click: 結果は短い要約（ref・タブ・いまのページ）。名前や中身は書かず、外の内容の注意を添える', async t => {
  const r = rig(t);
  const page = await opened(r);
  const out = await browserClick.execute({ ref: 'e2' }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.equal(out.fetched, true);
  assert.ok(out.content.includes('e2') && out.content.includes('t1'));
  assert.ok(out.content.includes(OTHER) && out.content.includes('Other'));
  assert.ok(!out.content.includes('Send'));
  assert.deepEqual(page.acts.map(x => [x.kind, x.role, x.name, x.nth]), [['click', 'button', 'Send', 0]]);
  assert.equal(page.url(), OTHER);
  // 遷移したので、古い表は捨てられ、同じ番号はもう押せない
  assert.equal((await preCheck(r, browserClick, { ref: 'e2' })).decision, 'deny');
});

test('type: 入れた文字数を書き、文字そのものは結果に書かない。submit は Enter を送る', async t => {
  const r = rig(t);
  const page = await opened(r);
  const out = await browserType.execute({ ref: 'e1', text: 'ひみつの文', submit: true }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.ok(out.content.includes('Typed 5 characters') && out.content.includes('Enter'));
  assert.ok(!out.content.includes('ひみつ'));
  assert.deepEqual(page.acts.map(x => [x.kind, x.text, x.submit]), [['fill', 'ひみつの文', true]]);
});

// ── T-28: ダイアログ・ポップアップ・ダウンロード・ファイル選択 ──

test('T-28: ダイアログ・ダウンロード・ファイル選択は断って結果に書く', async t => {
  const r = rig(t);
  await opened(r);
  const out = await browserClick.execute({ ref: 'e2' }, r.ctx);
  assert.ok(out.content.includes('dialog(s) from the page'));
  assert.ok(out.content.includes('download(s) started by the page'));
  assert.ok(out.content.includes('file chooser(s) from the page'));
});

test('T-28: ポップアップは新しいタブとして残し、上限を超えたら閉じて結果に書く', async t => {
  const r = rig(t, { mutate: c => { c.tools.browser.limits.maxTabs = 2; } });
  await opened(r);
  const before = r.session.tabCount('c1');
  const out = await browserClick.execute({ ref: 'e7' }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.equal(before, 1);
  assert.equal(r.session.tabCount('c1'), 2, '上限 2: 1 つだけ残る');
  assert.ok(out.content.includes('t2'));
  assert.ok(out.content.includes('were closed because of the tab limit') && out.content.includes('1'));
  assert.equal(r.driver.current!.pageList.length, 2, '閉じた窓は残らない');
});

test('T-28: 操作が失敗したら、ポップアップは残さず、短い文で返す', async t => {
  const r = rig(t);
  await opened(r);
  const out = await browserClick.execute({ ref: 'e8' }, r.ctx);
  assert.equal(out.isError, true);
  assert.equal(out.noRemoteContent, true);
  assert.equal(r.session.tabCount('c1'), 1);
});

// ── T-29: tools.policies ──

test('T-29: 方針が allow（既定）でも札は出る。ask は毎回札（会話の許可は効かない）。block は拒否', async t => {
  const r = rig(t);
  const first = await opened(r);
  assert.equal((await observe(r, 'browser_type', { ref: 'e1', text: 'a' })).outcome.decidedBy, 'pending', '既定（allow）でも Pending に積む');
  assert.deepEqual(r.pending.list({ status: 'waiting' }).map(row => row.kind), ['send']);
  assert.equal(first.acts.length, 0);

  const every = rig(t, { plain: true, mutate: c => { c.tools.policies = { browser_type: 'ask' }; } });
  await opened(every);
  assert.equal((await observe(every, 'browser_type', { ref: 'e1', text: 'a' })).outcome.decidedBy, 'pending', 'ask: Pending に積む');
  assert.equal((await observe(every, 'browser_type', { ref: 'e1', text: 'a' })).outcome.decidedBy, 'pending', 'ask: 毎回');
  assert.deepEqual(every.pending.list({ status: 'waiting' }).map(row => row.kind), ['policy', 'policy']);

  const blocked = rig(t, { mutate: c => { c.tools.policies = { browser_click: 'block' }; } });
  const page = await opened(blocked);
  const result = await observe(blocked, 'browser_click', { ref: 'e2' });
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.output.isError, true);
  assert.equal(page.acts.length, 0);
});

test('T-29: 方針が allow でも、サイト一覧外の deny と password 欄の拒否は外れない', async t => {
  const r = rig(t, { mutate: c => { c.tools.policies = { browser_click: 'allow', browser_type: 'allow' }; } });
  const page = await opened(r);
  const secret = await observe(r, 'browser_type', { ref: 'e5', text: 'hunter2' });
  assert.equal(secret.outcome.decision, 'deny');
  assert.equal(secret.outcome.output.isError, true);
  const outside = rig(t, { mutate: c => { c.tools.browser.sites = ['other.example.org']; c.tools.policies = { browser_click: 'allow' }; } });
  const outsidePage = await opened(outside);
  const result = await observe(outside, 'browser_click', { ref: 'e2' });
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.output.isError, true);
  assert.equal(page.acts.length + outsidePage.acts.length, 0);
});
