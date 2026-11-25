import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { UNTRUSTED_RUN, type Task } from '../src/tasks/store.ts';
import { TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { CONVERSATION, fakeModel, settled, startApp, waitFor } from './app-setup.ts';
import { fail, FakeAdapter, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

// 段 8b: 自動承認を、会話のエンジンから通して確かめる（判定役は同じモデルの提供元に、偽のアダプタが答える）

type Started = Awaited<ReturnType<typeof startApp>>;

const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const toolCall = (name: string, args: unknown, before = ''): Script => async function* (req) {
  if (before) yield { type: 'text', delta: before };
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const ALLOW = '{"decision":"allow","reason":"依頼どおりに外のメモを読むだけです"}';
const ASK = '{"decision":"ask","reason":"check"}';
const REQUEST = '外のメモ（outside.txt）を読んで';

function outsideRead(s: Started): { path: string; command: string } {
  mkdirSync(s.paths.workspace, { recursive: true });
  const path = join(s.paths.data, 'outside.txt');
  writeFileSync(path, '外のメモの中身');
  return { path, command: process.platform === 'win32' ? `Get-Content "${path}"` : `cat "${path}"` };
}

const post = (s: Started, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text, ...extra });
const isClassifier = (req: { tools: unknown[]; system: { frozen: string } }) => req.tools.length === 0 && req.system.frozen.includes('safety checker');
const classifierText = (s: { adapter: () => FakeAdapter }): string => s.adapter().calls.filter(isClassifier).map(c => JSON.stringify(c.messages) + c.system.frozen + c.system.dynamic).join('\n');
const autoRows = (s: { app: App }) => s.app.db.prepare("SELECT status, scope, reasons FROM approvals WHERE scope = 'auto'").all() as Array<{ status: string; scope: string; reasons: string }>;

test('自動承認（エンジン）: 外のメモを読むコマンドは、判定役（同じモデル）が allow なら札なしで動き、判定役が見るのは利用者の最後の発言と操作だけ', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'TOOL-RESULT-MARKER');
  s.adapter().scripts = [
    toolCall('file_read', { path: 'a.txt' }, 'ASSISTANT-TEXT-MARKER まず a.txt を読みます'),
    toolCall('shell_run', { command: outside.command }),
    say(ALLOW),
    say('読みました'),
  ];
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event); });
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  const calls = s.adapter().calls;
  assert.equal(calls.length, 4, '本体 2 回 + 判定役 1 回 + 本体の最後 1 回');
  const classifier = calls[2]!;
  assert.ok(isClassifier(classifier), '3 番目は判定役の呼び出し（道具なし）');
  assert.ok(calls.filter(isClassifier).length === 1);
  assert.equal(classifier.model.id, calls[1]!.model.id, '判定役は、その実行が使っているモデルそのもの');
  assert.equal(classifier.messages.length, 1);
  const shown = JSON.stringify(classifier.messages) + classifier.system.frozen + classifier.system.dynamic;
  assert.ok(shown.includes(REQUEST), '利用者の最後の発言を見せる');
  assert.ok(shown.includes('outside.txt'), '操作（コマンド）を見せる');
  assert.ok(!shown.includes('TOOL-RESULT-MARKER'), '道具の結果は見せない');
  assert.ok(!shown.includes('ASSISTANT-TEXT-MARKER'), 'beat の返事は見せない');
  assert.ok(!shown.includes('外のメモの中身'), 'ファイルの中身は見せない');
  const final = JSON.stringify(calls[3]!.messages);
  assert.ok(final.includes('外のメモの中身'), '許したコマンドは実際に動き、その結果を本体が読む');
  const toolTurn = calls[3]!.messages.find(m => m.role === 'tool' && m.content.includes('外のメモの中身'));
  assert.ok(toolTurn, '前提: 最後の呼び出しに道具の結果が入っている');
  assert.equal(calls.flatMap(c => c.messages).some(m => 'gate' in m), false, 'モデルに渡す履歴に道具の行の gate（判定役の理由）を入れない');
  assert.ok(!final.includes('safety checker') && !final.includes('依頼どおりに外のメモを読むだけです'), '判定役のやり取りは会話の履歴に入らない');
  const rows = autoRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'approved');
  assert.match((JSON.parse(rows[0]!.reasons) as string[]).at(-1)!, /依頼どおりに外のメモを読むだけです/u);
  const api = await s.json('/api/tool-calls?limit=10', 'GET');
  const shell = api.body.toolCalls.find((c: { tool: string }) => c.tool === 'shell_run');
  assert.deepEqual([shell.decision, shell.decided_by, shell.autoReason], ['allow', 'auto-mode', '依頼どおりに外のメモを読むだけです']);
  assert.equal(api.body.toolCalls.find((c: { tool: string }) => c.tool === 'file_read').autoReason, null, 'ほかの呼び出しは null');
  assert.deepEqual(seen.filter(e => e.type === 'tool.auto').map(e => (e as { state: string }).state), ['checking', 'allowed']);
  const results = seen.filter(e => e.type === 'tool.result') as Array<{ name: string; gate?: unknown }>;
  assert.deepEqual(results.map(e => [e.name, e.gate]), [['file_read', undefined], ['shell_run', { by: 'judge', reason: '依頼どおりに外のメモを読むだけです' }]], '判定役が通した行だけ、理由を出来事で運ぶ');
  const history = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'GET');
  const gates = (history.body.messages as Array<{ toolName?: string; gate?: unknown }>).filter(m => m.toolName).map(m => [m.toolName, m.gate]);
  assert.deepEqual(gates, [['file_read', undefined], ['shell_run', { by: 'judge', reason: '依頼どおりに外のメモを読むだけです' }]], '開き直した会話でも、判定役の理由が道具の行に出る');
  assert.equal(s.app.runs.get(sent.body.runId)!.model_id, calls[1]!.model.id);
  assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM engine_runs').get()!.n, 1, '判定役の呼び出しは engine_runs に入れない');
});

test('自動承認（エンジン）: 判定役はその実行が使っているモデル。会話でモデルを選んでいれば、そのモデル', async t => {
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2')] });
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto', modelId: 'm2' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['m2', 'm2', 'm2']);
  assert.ok(isClassifier(s.adapter().calls[1]!));
});

test('自動承認（エンジン）: 判定役のモデルの呼び出しが失敗したら、judge_failed で Pending に積まれる。持ち主が許せば動く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), fail(new Error('接続できません')), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  const [row] = s.app.pending.list({ status: 'waiting' });
  assert.equal(row?.kind, 'judge_failed');
  assert.match(row!.reason, /the judge could not be called/u);
  assert.equal(autoRows(s).length, 0);
  s.app.replayPending(s.app.pending.claim(row!.id));
  await waitFor(() => s.app.pending.row(row!.id)?.status === 'ran', '許した行が動く');
});

test('自動承認（エンジン）: 製品の外でコードを動かす今回だけの確かめは、判定役が決める（allow なら動く）。添付つきの発言（よそから来た文）のあとの外読みも、判定役が決める', async t => {
  const s = await startApp(t);
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'put.js'), "console.log('x');\n");
  s.adapter().scripts = [toolCall('shell_run', { command: 'node put.js' }), say(ALLOW), say('おわり')];
  const sent = await post(s, '動かして', { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'auto-mode');

  // 添付つきの発言は、よそから来た文。そのあとの外読みも、判定役が決める（Q16）。判定役には「よそから来た文を読んだ会話」と伝わる
  const t2 = await startApp(t);
  const outside = outsideRead(t2);
  const upload = t2.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  t2.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const attached = await t2.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: REQUEST, attachments: [upload.id], permissionMode: 'auto' });
  await settled(t2.app, attached.body.runId);
  assert.equal(t2.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(t2).includes(TAINTED_NOTE), '判定役に、よそから来た文を読んだ会話だと伝える');
  assert.equal(autoRows(t2).length, 1);
});

// ── 外から読んだ内容のあと（Web）。同じ実行の中でも、止めたあとの次の実行にも持ち越す ──

async function webApp(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [fakeModel('m')];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const network: PageNetwork = {
    resolve: async () => ['93.184.216.34'],
    get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>ページの本文</p></main></body></html>') }) as PageResponse,
  };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, pendingWaitMs: 0, botMemory: true, webNetwork: network, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  const outsidePath = join(paths.data, 'outside.txt');
  writeFileSync(outsidePath, '外のメモの中身');
  const command = process.platform === 'win32' ? `Get-Content "${outsidePath}"` : `cat "${outsidePath}"`;
  return { app, adapter: () => adapter, command, paths };
}

test('4-3a 本番の守り: 既定の設定で作った App では、確かめの要る呼び出しは会話でも判定役に回り、Pending に積まれ、札の出来事は出ない', async t => {
  const s = await webApp(t);
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event); });
  s.adapter().scripts = [toolCall('shell_run', { command: s.command }), say(ASK), say('おわり')];
  const sent = s.app.engine.send('c1', '外のメモを読んで');
  assert.ok(sent.ok);
  await settled(s.app, sent.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役に回る');
  assert.deepEqual(s.app.pending.list({ status: 'waiting' }).map(r => [r.tool, r.kind]), [['shell_run', 'judge']]);
  assert.equal(seen.filter(e => (e.type as string) === 'approval.requested').length, 0, '札の出来事は出ない');
});

test('自動承認（エンジン）: Web を読んだあとの外読みは、判定役が決める（taint）。allow なら札なしで動く', async t => {
  const s = await webApp(t);
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  const sent = s.app.engine.send('c1', 'このページを読んで、外のメモも読んで');
  assert.ok(sent.ok);
  await settled(s.app, sent.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  const rows = s.app.db.prepare("SELECT reasons FROM approvals WHERE scope = 'auto'").all() as Array<{ reasons: string }>;
  assert.equal(rows.length, 1);
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '判定役に、よそから来た文を読んだ会話だと伝える');
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'auto-mode');
});

// 送るは順 3 のまま。記憶を消す道具は P3 で外を読んだあとも確かめなし
test('自動承認（エンジン）: Web を読んだあとの送る操作は、判定役に回さず持ち主に聞く（Pending の send）。記憶を消す道具は、外を読んだあとも確かめなしに動く（P3）', async t => {
  const upload = process.platform === 'win32' ? 'curl.exe -s -X POST -d note=x https://beat-test.invalid/' : 'curl -s -X POST -d note=x https://beat-test.invalid/';
  for (const [label, step, kinds] of [
    ['送る', toolCall('shell_run', { command: upload }), [['send', true]]],
    ['消す（記憶）', toolCall('memory_forget', { id: 1, reason: 'x' }), []],
  ] as const) {
    const s = await webApp(t);
    s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), step, say('おわり')];
    s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
    const sent = s.app.engine.send('c1', 'このページを読んで、続けて');
    assert.ok(sent.ok);
    await settled(s.app, sent.runId);
    const rows = s.app.pending.list({ status: 'waiting' });
    assert.deepEqual(rows.map(r => [r.kind, r.tainted]), kinds, label);
    assert.equal(s.adapter().calls.filter(isClassifier).length, 0, label);
    assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'auto'").get()!.n, 0, label);
  }
});

test('自動承認（エンジン）: Web を読んだ実行が止められたあとの次の実行も、よそから来た文を読んだ扱い（持ち越し）。外読みは判定役が決め、判定役にはそう伝わる', async t => {
  const s = await webApp(t);
  const untilStopped: Script = async function* (req) {
    await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  };
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), untilStopped];
  const first = s.app.engine.send('c1', 'このページを読んで');
  assert.ok(first.ok);
  await waitFor(() => s.adapter().calls.length >= 2, '道具のあとの 2 回目の呼び出し');
  s.app.engine.stop(first.runId);
  await settled(s.app, first.runId);
  await s.app.engine.wait(first.runId);
  assert.equal(s.app.runs.get(first.runId)!.tainted, 1);

  s.adapter().scripts = [toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  const second = s.app.engine.send('c1', '続けて、外のメモも読んで');
  assert.ok(second.ok);
  await settled(s.app, second.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '持ち越した印は、判定役に伝わる');
});

test('自動承認（エンジン）: 外のメモを自動で読んだあとの、許可の一覧にある取得（curl）は、同じ返事の中では確かめなしに動く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://beat-test.invalid/SECRET' : 'curl -s https://beat-test.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), toolCall('shell_run', { command: fetch }), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が見たのは外読みだけ');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
  assert.deepEqual(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run' ORDER BY created_at").all().map(r => r.decided_by), ['auto-mode', 'builtin']);
  assert.equal(autoRows(s).length, 1, '自動で許したのは最初の外読みだけ');
});

test('自動承認（エンジン）: シェルで外から取得したら、実行の記録に「外から読んだ」印が残る。そのあとの外読みは判定役が決める', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://beat-test.invalid/SECRET' : 'curl -s https://beat-test.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: fetch }), toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.equal(s.app.runs.get(sent.body.runId)!.tainted, 1, '実行の記録に印が残る（止めた・落ちた実行の次の実行へ引き継ぐ材料）');
  assert.equal(autoRows(s).length, 1);
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '判定役に、よそから来た文を読んだ会話だと伝える');
});

// ── 会話の印（一度でも外から読んだ会話）と、自動承認で外を読んだあとの実行 ──

test('自動承認（エンジン）: 一度でもよそから来た文を読んだ実行のある会話は、最後まで返事を書いて「読んだ」扱いが切れたあとの別の実行でも、判定役に「よそから来た文を読んだ会話」と伝える。外読みは判定役が決める', async t => {
  const s = await webApp(t);
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), say('読みました')];
  const first = s.app.engine.send('c1', 'このページを読んで');
  assert.ok(first.ok);
  await settled(s.app, first.runId);
  await s.app.engine.wait(first.runId);
  assert.equal(s.app.runs.get(first.runId)!.ok, 1);
  assert.equal(s.app.conversations.everTainted('c1'), true);

  s.adapter().scripts = [toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  const second = s.app.engine.send('c1', '外のメモも読んで');
  assert.ok(second.ok);
  await settled(s.app, second.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '会話の印は、判定役に伝わる');
  const reasons = JSON.parse(autoRows(s)[0]!.reasons) as string[];
  assert.ok(!reasons.some(r => /text that came from somewhere else/u.test(r)), 'この実行は読んでいないので、taint の理由は載らない');
});

test('自動承認（エンジン）: 外から読んだことの無い会話には印が付かない。シェルで取得した・添付を付けた会話には付く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.conversations.everTainted(CONVERSATION), false, '外を読んだだけでは付かない（許可フォルダの外のファイルは、外から来た文ではない）');

  const fetching = await startApp(t);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://beat-test.invalid/' : 'curl -s https://beat-test.invalid/';
  fetching.adapter().scripts = [toolCall('shell_run', { command: fetch }), say('取得しました')];
  const second = await post(fetching, '取得して');
  await settled(fetching.app, second.body.runId);
  assert.equal(fetching.app.conversations.everTainted(CONVERSATION), true);

  const attached = await startApp(t);
  const upload = attached.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  attached.adapter().scripts = [say('読みました')];
  const third = await post(attached, REQUEST, { attachments: [upload.id] });
  await settled(attached.app, third.body.runId);
  assert.equal(attached.app.conversations.everTainted(CONVERSATION), true);
});

test('自動承認（エンジン）: 自動で外を読んだ実行を止めた・失敗したあとの次の実行のシェルのコマンドは、確かめなしに動く（会話に印を残さない）', async t => {
  const untilStopped: Script = async function* (req) {
    await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  };
  const stopped = await startApp(t);
  const outside = outsideRead(stopped);
  stopped.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), untilStopped];
  const first = await post(stopped, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => stopped.adapter().calls.length >= 3, '外を読んだあとの 2 回目の呼び出し');
  stopped.app.engine.stop(first.body.runId);
  await settled(stopped.app, first.body.runId);
  await stopped.app.engine.wait(first.body.runId);
  stopped.adapter().scripts = [toolCall('shell_run', { command: 'echo hello' }), say('おわり')];
  const second = await post(stopped, '続けて', { permissionMode: 'auto' });
  await settled(stopped.app, second.body.runId);
  assert.equal(stopped.adapter().calls.filter(isClassifier).length, 1, '次の実行のコマンドは判定役に回らない');
  assert.equal(stopped.app.pending.list({ status: 'waiting' }).length, 0);

  const failing = await startApp(t, { models: [fakeModel('only')] });
  const outside2 = outsideRead(failing);
  failing.adapter().scripts = [toolCall('shell_run', { command: outside2.command }), say(ALLOW), fail(new Error('接続できません'))];
  const third = await post(failing, REQUEST, { permissionMode: 'auto' });
  await settled(failing.app, third.body.runId);
  await failing.app.engine.wait(third.body.runId);
  assert.equal(failing.app.runs.get(third.body.runId)!.ok, 0);
  failing.adapter().scripts = [toolCall('shell_run', { command: 'echo hello' }), say('おわり')];
  const fourth = await post(failing, '続けて', { permissionMode: 'auto' });
  await settled(failing.app, fourth.body.runId);
  assert.equal(failing.adapter().calls.filter(isClassifier).length, 1, '失敗した実行のあとも判定役に回らない');
  assert.equal(failing.app.pending.list({ status: 'waiting' }).length, 0);
});

test('自動承認（エンジン）: Pending で持ち主が許した git clone も、動かしたら「外から読んだ」印が付く。そのあとの外読みは判定役に「よそから来た文を読んだ会話」と伝わる', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  // 名前が引けない宛先（.invalid）なので、動いても外には出ず、失敗して終わる。失敗しても印は付く
  s.adapter().scripts = [toolCall('shell_run', { command: 'git clone https://beat-test.invalid/x.git' }), say(ASK), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  const [row] = s.app.pending.list({ status: 'waiting' });
  assert.equal(row?.kind, 'judge');
  assert.equal(s.app.conversations.everTainted(CONVERSATION), false, 'Pending のあいだは、まだ動いていない');
  s.app.replayPending(s.app.pending.claim(row!.id));
  await waitFor(() => s.app.pending.row(row!.id)?.status === 'ran', '許した git clone が動く');
  assert.equal(s.app.conversations.everTainted(CONVERSATION), true, '動かしたら印が付く');

  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const next = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, next.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 2, '外読みは判定役が決めた');
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '判定役に印が伝わる（clone の判定のときは、まだ読んでいない）');
  assert.equal(autoRows(s).length, 1);
});

test('自動承認（エンジン）: 外のメモを自動で読んだ会話でも、その返事が終わったあとの発言のシェルのコマンド（許可の一覧にある curl も）は確かめなしに動く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://x.invalid/SECRET' : 'curl -s https://x.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const first = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, first.body.runId);
  await s.app.engine.wait(first.body.runId);
  assert.equal(s.app.runs.get(first.body.runId)!.ok, 1, '最後まで返事を書いて終わった');
  assert.equal(autoRows(s).length, 1);

  s.adapter().scripts = [toolCall('shell_run', { command: fetch }), say('おわり')];
  const second = await post(s, '続けて、これを取ってきて');
  await settled(s.app, second.body.runId);
  await s.app.engine.wait(second.body.runId);
  s.adapter().scripts = [toolCall('shell_run', { command: 'echo hello' }), say('おわり')];
  const third = await post(s, 'もう一つ');
  await settled(s.app, third.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が見たのは最初の外読みだけ');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
  assert.deepEqual(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run' ORDER BY created_at").all().map(r => r.decided_by), ['auto-mode', 'builtin', 'builtin']);
});

// ── タスクの実行（持ち主の判断 2026-11-12: タスクは自動承認で動く） ──

const TASK_PROMPT = 'タスク: 天気のデータを取ってきて、保存したファイルの中身を読む';

async function runTaskWith(s: Awaited<ReturnType<typeof webApp>>, scripts: Script[], make?: () => Task) {
  s.adapter().scripts = scripts;
  const task = make?.() ?? s.app.tasks.create({ title: '天気を調べる', origin: 'schedule', actor: 'system' });
  const conversation = s.app.conversations.create({ kind: 'task' });
  const started = s.app.engine.runTask(task, conversation.id, TASK_PROMPT);
  assert.ok(started.ok);
  return started;
}

function workspaceRead(s: Awaited<ReturnType<typeof webApp>>): string {
  const path = join(s.paths.workspace, 'weather.json');
  writeFileSync(path, '{"temp":21}');
  return process.platform === 'win32' ? `Get-Content "${path}" | ConvertFrom-Json` : `cat "${path}"`;
}

test('自動承認（タスク）: Web を読んだあとの、許可フォルダの中のシェルの読み取りは、判定役を呼ばずに動く（R19）。外読みは判定役が allow なら持ち主に聞かずに動き、記録は chat と同じく auto-mode', async t => {
  const s = await webApp(t);
  const command = workspaceRead(s);
  const started = await runTaskWith(s, [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('shell_run', { command }), toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')]);
  await started.done;
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0, 'Pending に積まれない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めたのは外読みだけ');
  assert.ok(classifierText(s).includes('天気を調べる'), '判定役が見る依頼は、持ち主が書いたタスクの題');
  assert.ok(!classifierText(s).includes(TASK_PROMPT), 'ワーカーが組み立てた文は見せない');
  assert.ok(classifierText(s).includes(TAINTED_NOTE));
  const shells = s.app.db.prepare("SELECT decision, decided_by, ok FROM tool_calls WHERE tool = 'shell_run' ORDER BY created_at").all() as Array<{ decision: string; decided_by: string; ok: number }>;
  assert.deepEqual(shells.map(r => [r.decision, r.decided_by, r.ok]), [['allow', 'builtin', 1], ['allow', 'auto-mode', 1]]);
  const rows = s.app.db.prepare("SELECT run_id, status FROM approvals WHERE scope = 'auto'").all() as Array<{ run_id: string; status: string }>;
  assert.deepEqual(rows.map(r => [r.run_id, r.status]), [[started.runId, 'approved']]);
});

test('自動承認（タスク）: 判定役が答えられない（モデルを呼べない）ときは、chat と同じく judge_failed で Pending に積まれる', async t => {
  const s = await webApp(t);
  const command = s.command;
  const started = await runTaskWith(s, [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('shell_run', { command }), fail(new Error('接続できません')), say('おわり')]);
  const { rows } = await parked(s, started, '判定役が答えられない');
  assert.deepEqual(rows.map(r => [r.tool, r.kind, r.tainted]), [['shell_run', 'judge_failed', true]]);
  assert.match(rows[0]!.reason, /the judge could not be called/u);
});

test('自動承認（タスク）: Web を読んだあとの送る操作・消す操作は、判定役に回さず持ち主に聞く（Pending の send・delete）。記憶を消す道具は AP-1c（Q2）で判定役へ（下の試験）', async t => {
  const upload = process.platform === 'win32' ? 'curl.exe -s -X POST -d note=x https://beat-test.invalid/' : 'curl -s -X POST -d note=x https://beat-test.invalid/';
  for (const [label, step, kind] of [
    ['送る', toolCall('shell_run', { command: upload }), 'send'],
    ['消す（シェル）', null, 'delete'],
  ] as const) {
    const s = await webApp(t);
    const target = join(s.paths.workspace, 'old.txt');
    writeFileSync(target, '古いメモ');
    const next = step ?? toolCall('shell_run', { command: process.platform === 'win32' ? `Remove-Item "${target}"` : `rm "${target}"` });
    const started = await runTaskWith(s, [toolCall('web_fetch', { url: 'https://news.example.com/' }), next, say('おわり')]);
    const { classified, rows } = await parked(s, started, label);
    assert.deepEqual(rows.map(r => [r.kind, r.tainted]), [[kind, true]], label);
    if (step === null) assert.match(rows[0]!.shown, /Remove-Item|rm/u, label);
    assert.equal(classified, 0, `${label}: 判定役を呼ばない`);
    assert.ok(existsSync(target), `${label}: ファイルは残る`);
  }
});

// 実行の終わりを待ち、札が出ず自動でも許していないことを確かめる。判定役を呼んだ回数と、持ち主を待つ Pending の行を返す
async function parked(s: Awaited<ReturnType<typeof webApp>>, started: { runId: string; done: Promise<unknown> }, label: string) {
  await started.done;
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'auto'").get()!.n, 0, `${label}: 自動では許していない`);
  return { classified: s.adapter().calls.filter(isClassifier).length, rows: s.app.pending.list({ status: 'waiting' }) };
}

async function noRequest(s: Awaited<ReturnType<typeof webApp>>, started: { runId: string; done: Promise<unknown> }, label: string): Promise<number> {
  const { classified, rows } = await parked(s, started, label);
  assert.deepEqual(rows.map(r => [r.tool, r.kind, r.tainted]), [['shell_run', 'judge_failed', true]], label);
  assert.match(rows[0]!.reason, /there is no request from the owner to judge it against/u, label);
  return classified;
}

const WEB = () => toolCall('web_fetch', { url: 'https://news.example.com/' });

test('自動承認（タスク、P3 で反転）: よそから来た文を読んだあとの、タスクを作る・記憶を消す道具の行き先は、外を読んでいないタスクの実行と同じ（判定役は呼ばれない）', async t => {
  for (const [label, step] of [
    ['task_create', () => toolCall('task_create', { title: '毎時の作業', requested_by_user: true, repeat: '0 * * * *' })],
    ['memory_forget', () => toolCall('memory_forget', { id: 1, reason: 'x' })],
  ] as const) {
    const seen: unknown[] = [];
    for (const web of [false, true]) {
      const s = await webApp(t);
      const started = await runTaskWith(s, [...(web ? [WEB()] : []), step(), say('おわり')]);
      const out = await parked(s, started, label);
      const decided = (s.app.db.prepare('SELECT decided_by FROM tool_calls WHERE tool = ?').all(label) as Array<{ decided_by: string }>).map(r => r.decided_by);
      seen.push([out.classified, out.rows.map(r => [r.tool, r.kind]), decided]);
    }
    assert.deepEqual(seen[1], seen[0], `${label}: ${JSON.stringify(seen)}`);
    assert.equal((seen[1] as [number])[0], 0, `${label}: 判定役は呼ばれない`);
  }
});

test('自動承認（タスク）: よそから来た文を読んだあとの、許可フォルダの外を読む確かめ（outside_read）は判定役が決める。allow なら動く', async t => {
  const s = await webApp(t);
  const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')]);
  await started.done;
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
  assert.ok(classifierText(s).includes(TAINTED_NOTE));
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'auto-mode');
});

test('自動承認（タスク）: 判定役に見せる依頼は、持ち主の書いた題・詳細・終わりの条件だけ。次の一手・経過・ワーカーの文は見せない', async t => {
  const s = await webApp(t);
  const command = s.command;
  const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')], () => {
    const task = s.app.tasks.create({ title: 'TITLE-MARKER', body: 'BODY-MARKER', doneCriteria: 'DONE-MARKER', nextAction: 'NEXT-ACTION-MARKER', origin: 'user', actor: 'user' });
    s.app.tasks.event(task.id, 'reason', 'beat', 'HISTORY-MARKER');
    return task;
  });
  await started.done;
  const shown = classifierText(s);
  for (const marker of ['TITLE-MARKER', 'BODY-MARKER', 'DONE-MARKER']) assert.ok(shown.includes(marker), marker);
  for (const marker of ['NEXT-ACTION-MARKER', 'HISTORY-MARKER', TASK_PROMPT]) assert.ok(!shown.includes(marker), marker);
});

test('自動承認（タスク）: beat が自分で決めたタスク・好奇心のタスク・それを元にした予定のタスクは、依頼が持ち主の文でないので judge_failed（no_request）で持ち主に聞く', async t => {
  for (const [label, make] of [
    ['self', (s: Awaited<ReturnType<typeof webApp>>) => s.app.tasks.create({ title: '自分で決めた', origin: 'self', actor: 'beat' })],
    ['curiosity', (s: Awaited<ReturnType<typeof webApp>>) => s.app.tasks.create({ title: '気になる', origin: 'curiosity', actor: 'worker' })],
    ['self の予定', (s: Awaited<ReturnType<typeof webApp>>) => s.app.tasks.spawnNow(s.app.tasks.create({ title: '自分で決めた予定', origin: 'self', actor: 'beat', cron: '0 9 * * *' }).id)!],
  ] as const) {
    const s = await webApp(t);
    const command = s.command;
    const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')], () => make(s));
    assert.equal(await noRequest(s, started, label), 0, `${label}: 判定役を呼ばない`);
  }
});

test('自動承認（タスク）: beat が自分で決めたタスク・好奇心のタスクの実行が作るタスクは、requested_by_user でも beat が決めたもの（self）になる', async t => {
  for (const origin of ['self', 'curiosity', 'user'] as const) {
    const s = await webApp(t);
    const started = await runTaskWith(s, [toolCall('task_create', { title: `作る-${origin}`, requested_by_user: true }), say('おわり')], () => s.app.tasks.create({ title: '元のタスク', origin, actor: 'beat' }));
    await started.done;
    const made = s.app.db.prepare('SELECT origin FROM tasks WHERE title = ?').get(`作る-${origin}`) as { origin: string } | undefined;
    assert.equal(made?.origin, origin === 'user' ? 'user' : 'self', origin);
  }
});

test('自動承認（タスク）: 繰り返しの予定を消しても、beat が決めた予定から作った実行のタスクは、beat が決めたもの（判定役に見せる依頼は空）のまま', async t => {
  const s = await webApp(t);
  for (const origin of ['self', 'user'] as const) {
    const template = s.app.tasks.create({ title: `予定-${origin}`, origin, actor: 'beat', cron: '0 9 * * *' });
    const instance = s.app.tasks.spawnNow(template.id)!;
    s.app.tasks.finish(instance.id, 'done', null, 'user');
    s.app.tasks.remove(template.id);
    const after = s.app.tasks.get(instance.id)!;
    assert.equal(after.parent_id, null, origin);
    assert.equal(after.origin, origin === 'self' ? 'self' : 'schedule', origin);
    assert.equal(s.app.tasks.judgeRequest(instance.id), origin === 'self' ? '' : `予定-${origin}`, origin);
  }
});

test('自動承認（タスク）: よそから来た文を読んだ実行（その会話）が作った・書き足したタスクは、依頼が持ち主の文と言えないので judge_failed（no_request）で持ち主に聞く。読んでいない実行なら判定役が決める', async t => {
  for (const [label, tainted, kind] of [
    ['作った（読んだ実行）', true, 'context'], ['書き足した（読んだ実行）', true, 'note'], ['書き換えた（読んだ実行）', true, 'edited'],
    ['記録の無い実行', 'missing', 'note'], ['作った（読んでいない実行）', false, 'context'], ['書き換えた（読んでいない実行）', false, 'edited'],
  ] as const) {
    const s = await webApp(t);
    const command = s.command;
    const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')], () => {
      const chat = s.app.conversations.create({ title: '作った会話' });
      const runId = `run-${label}`;
      if (tainted !== 'missing') s.app.runs.start(runId, 'chat', chat.id);
      if (tainted === true) s.app.runs.markTainted(runId);
      const task = s.app.tasks.create({ title: '作られたタスク', origin: 'user', actor: 'beat' });
      s.app.tasks.event(task.id, kind, 'beat', 'x', runId);
      return task;
    });
    if (tainted) assert.equal(await noRequest(s, started, label), 0, label);
    else {
      await started.done;
      assert.equal(s.adapter().calls.filter(isClassifier).length, 1, label);
    }
  }
});

test('自動承認（タスク）: 実行の記録が無い印（untrusted-input）がタスクの経過にあれば、判定役に見せる依頼は空になり、judge_failed（no_request）で持ち主に聞く', async t => {
  const s = await webApp(t);
  const command = s.command;
  let taskId = '';
  const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')], () => {
    const task = s.app.tasks.create({ title: '印の付いたタスク', origin: 'user', actor: 'user' });
    taskId = task.id;
    assert.equal(s.app.tasks.judgeRequest(task.id), '印の付いたタスク');
    s.app.tasks.markUntrusted(task.id, 'build', 'x');
    assert.equal(s.app.runs.get(UNTRUSTED_RUN), undefined, '印の run id には実行の記録が無い');
    assert.equal(s.app.tasks.judgeRequest(task.id), '');
    return task;
  });
  assert.equal(await noRequest(s, started, 'untrusted-input'), 0);
  assert.equal(s.app.tasks.judgeRequest(taskId), '');
});

test('自動承認（タスク）: よそから来た文を読んだ会話（ever_tainted）の実行が作ったタスクも、judge_failed（no_request）で持ち主に聞く', async t => {
  const s = await webApp(t);
  const command = s.command;
  const started = await runTaskWith(s, [WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')], () => {
    const chat = s.app.conversations.create({ title: '読んだ会話' });
    s.app.conversations.markTainted(chat.id);
    s.app.runs.start('run-clean', 'chat', chat.id);
    const task = s.app.tasks.create({ title: '作られたタスク', origin: 'user', actor: 'beat' });
    s.app.tasks.event(task.id, 'context', 'beat', 'x', 'run-clean');
    return task;
  });
  assert.equal(await noRequest(s, started, 'ever_tainted'), 0);
});

test('自動承認（タスク）: 道具を何十回も使った長い実行でも、判定役は持ち主の依頼を見られる（会話の最後の 50 件に依頼が無くても）', async t => {
  const s = await webApp(t);
  const command = s.command;
  const many = Array.from({ length: 30 }, (_, i) => toolCall('calculate', { expression: `${i}+1` }));
  const started = await runTaskWith(s, [...many, WEB(), toolCall('shell_run', { command }), say(ALLOW), say('おわり')]);
  await started.done;
  assert.ok(s.app.conversations.messages(s.app.runs.get(started.runId)!.conversation_id!).length > 50, '前提: 会話は 50 件を超える');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0, 'Pending に積まれない');
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'auto-mode');
});

test('自動承認（エンジン）: 判定役の返事が max_tokens で途中で切れたら、最後の行が allow に見えても許さず、judge_failed（unparsable）で Pending に積まれる', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const cutOff = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'max_tokens' as StopReason }; };
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), cutOff(ALLOW), cutOff(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 2, 'AP-1d: a cut-off reply is asked once more, then judge_failed');
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.deepEqual(rows.map(r => r.kind), ['judge_failed']);
  assert.match(rows[0]!.reason, /the judge's answer could not be read/u);
  assert.equal(autoRows(s).length, 0);
});
