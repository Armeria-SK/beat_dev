import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent } from '../src/engine/types.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { tempDir } from './helpers.ts';
import { OK_STATUS, ScriptedRuntime, scriptedFactory, type Script } from './helpers/scripted-runtime.ts';

// AR-7: 会話を外の実行役で動かす橋（src/engine/runtime-bridge.ts と ChatEngine の分かれ道）。実行役の本体は起こさず、台本どおりに出来事を返すにせものを使う

const SECRET = 'zq-env-secret-value-7f3a9c1d5e';
let n = 200;

async function rig(t: Parameters<typeof startApp>[0], options: { permission?: string; kind?: 'claude-code' | 'codex'; env?: Record<string, string> } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const holder: { current?: ScriptedRuntime } = {};
  const kind = options.kind ?? 'claude-code';
  const s = await startApp(t, {
    models: [{ id: 'cc', runtime: kind, model: 'sonnet', vision: false }, fakeModel('m1')],
    configure: config => {
      config.runtimes = [{ id: kind, kind, enabled: true, ...(options.permission ? { permission: options.permission } : {}) }];
      config.routing.chat = ['cc', 'm1'];
    },
    runtimeFactories: { [kind]: scriptedFactory(holder) },
    projectFolderExempt: [products],
    runtimeStopGraceMs: 150,
    env: options.env ?? { FAKE_KEY: SECRET },
  });
  assert.ok(s.app.runtimes.find(s.app.config(), kind).ok);
  const runtime = holder.current!;
  const product = async (name = 'prod', files: Record<string, string> = {}) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const events: RunEvent[] = [];
  s.app.bus.subscribe(entry => events.push(entry.event));
  const check = async () => { const res = await s.json(`/api/runtimes/${kind}/check`, 'POST'); assert.equal(res.status, 200, JSON.stringify(res.body)); };
  const send = async (conversation: string, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${conversation}/messages`, 'POST', { text, ...extra });
  const turn = async (conversation: string, text: string, extra: Record<string, unknown> = {}) => {
    const sent = await send(conversation, text, extra);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    return sent.body.runId as string;
  };
  const rows = (conversation: string) => s.app.conversations.messages(conversation, 100).map(r => r.message);
  return { s, runtime, product, events, check, send, turn, rows, products };
}

const toolScript = (extra: Partial<{ input: unknown; output: string; isError: boolean }> = {}): Script => async feed => {
  feed.push({ type: 'text', delta: 'Looking. ' });
  feed.push({ type: 'tool_start', id: 'toolu_1', name: 'Bash', input: extra.input ?? { command: 'ls' } });
  feed.push({ type: 'tool_end', id: 'toolu_1', output: extra.output ?? 'a.txt', isError: extra.isError ?? false });
  feed.push({ type: 'text', delta: 'Done.' });
  feed.done();
};

test('実行役の会話: 文と道具が seam.md の形で保存され、画面へ流れ、beat の道具の表には何も書かれない', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = toolScript();
  const conversation = uuid(++n);
  const runId = await r.turn(conversation, 'list the files', { projectId, modelId: 'cc' });

  const stored = r.rows(conversation);
  assert.deepEqual(stored.map(m => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal((stored[1] as { content: string }).content, 'Looking. ');
  const call = stored[2] as { content: string; toolCalls: Array<{ id: string; name: string; arguments: unknown }>; runtime?: true };
  assert.equal(call.content, '');
  assert.equal(call.runtime, true);
  assert.equal(call.toolCalls[0]!.id, 'rt_toolu_1');
  assert.equal(call.toolCalls[0]!.name, 'claude-code:Bash');
  assert.deepEqual(call.toolCalls[0]!.arguments, { command: 'ls' });
  const tool = stored[3] as { toolCallId: string; name: string; content: string; gate: unknown; runtime?: true; isError?: boolean };
  assert.deepEqual({ id: tool.toolCallId, name: tool.name, content: tool.content, gate: tool.gate, runtime: tool.runtime, isError: tool.isError }, { id: 'rt_toolu_1', name: 'claude-code:Bash', content: 'a.txt', gate: { by: 'runtime' }, runtime: true, isError: undefined });
  assert.equal((stored[4] as { content: string }).content, 'Done.');

  // beat は何も動かしていない: 道具の記録・ファイルの変更・Pending は 0
  const db = r.s.app.db;
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get() as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM file_changes').get() as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM pending_actions').get() as { c: number }).c, 0);
  // 道具の行の名前は beat の道具のどれにも当たらない
  assert.equal(r.s.app.tools.get(call.toolCalls[0]!.name), undefined);

  // 画面への出来事: 実行の始まり → 文の流れ → 道具の呼び出し → 結果 → 終わり
  const mine = r.events.filter(e => 'runId' in e && e.runId === runId);
  assert.deepEqual(mine.map(e => e.type).filter(type => ['run.start', 'text.delta', 'tool.call', 'tool.result', 'run.end'].includes(type)), ['run.start', 'text.delta', 'tool.call', 'tool.result', 'text.delta', 'run.end']);
  const result = mine.find(e => e.type === 'tool.result') as Extract<RunEvent, { type: 'tool.result' }>;
  assert.deepEqual({ decision: result.decision, gate: result.gate, ok: result.ok }, { decision: 'allow', gate: { by: 'runtime' }, ok: true });

  // 実行の記録と会話の結び付き
  const run = r.s.app.runs.get(runId)!;
  assert.equal(run.ok, 1);
  assert.equal(run.provider_id, null);
  assert.equal(run.tainted, 1);
  assert.equal(run.tool_calls, 1);
  const recorded = JSON.parse(run.runtime!) as { runtime: string; kind: string; permission: string; resumed: boolean; sessionStart: string; sessionEnd: string };
  assert.deepEqual({ runtime: recorded.runtime, kind: recorded.kind, permission: recorded.permission, resumed: recorded.resumed, sessionEnd: recorded.sessionEnd }, { runtime: 'claude-code', kind: 'claude-code', permission: 'default', resumed: false, sessionEnd: 'sess-1' });
  const row = r.s.app.conversations.get(conversation)!;
  assert.equal(row.runtime_id, 'claude-code');
  assert.equal(row.runtime_session, 'sess-1');
  assert.equal(row.ever_tainted, 1);
  // 実行役へは発言の文だけを渡す（人格・記憶・beat の system は足さない）
  assert.deepEqual(r.runtime.sent, ['list the files']);
  assert.equal(r.runtime.closes, 1);
});

test('実行役が動かした道具の入力・結果は、鍵の名前の値と環境の API キーの値を伏せて保存・表示される', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = toolScript({ input: { command: `curl -H "x: ${SECRET}"`, api_key: 'plain-visible-value', nested: { note: SECRET } }, output: `token ${SECRET}\nsecond line` });
  const conversation = uuid(++n);
  await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const dump = JSON.stringify(r.rows(conversation)) + JSON.stringify(r.events);
  assert.ok(!dump.includes(SECRET), 'the environment key value is nowhere in the saved rows or the events');
  assert.ok(!dump.includes('plain-visible-value'), 'the value of a key-named field is hidden');
  const call = r.rows(conversation).find(m => m.role === 'assistant' && m.toolCalls?.length) as { toolCalls: Array<{ arguments: Record<string, unknown> }> };
  assert.equal(call.toolCalls[0]!.arguments.api_key, '[REDACTED]');
  const tool = r.rows(conversation).find(m => m.role === 'tool') as { content: string };
  assert.match(tool.content, /second line/u, 'the lines of the output are kept');
});

test('終わりの知らせが来ない道具は「結果が届かなかった」行になり、子の担当の道具には nested の印が付く', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'tool_start', id: 'parent', name: 'Agent', input: { prompt: 'x' } });
    feed.push({ type: 'tool_start', id: 'child', name: 'Read', input: { file_path: 'a' }, nested: true });
    feed.push({ type: 'tool_end', id: 'child', output: 'text', isError: false, nested: true });
    feed.push({ type: 'tool_start', id: 'never', name: 'Bash', input: { command: 'sleep 99' } });
    feed.done();
  };
  const conversation = uuid(++n);
  await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const tools = r.rows(conversation).filter(m => m.role === 'tool') as Array<{ toolCallId: string; content: string; isError?: boolean; nested?: true }>;
  assert.deepEqual(tools.map(m => m.toolCallId), ['rt_child', 'rt_parent', 'rt_never']);
  assert.equal(tools[0]!.nested, true);
  assert.equal(tools[1]!.nested, undefined);
  assert.equal(tools[2]!.content, '(The result did not arrive)');
  assert.equal(tools[2]!.isError, true);
  assert.equal(tools[1]!.content, '(The result did not arrive)', 'the parent agent call never ended either');
  const assistants = r.rows(conversation).filter(m => m.role === 'assistant' && m.toolCalls?.length) as Array<{ nested?: true; toolCalls: Array<{ id: string }> }>;
  assert.deepEqual(assistants.map(m => [m.toolCalls[0]!.id, m.nested]), [['rt_child', true], ['rt_parent', undefined], ['rt_never', undefined]]);
});

test('製品が無い会話・beat 自身のフォルダやデータのフォルダの製品では、実行役を起こさず、何も保存せず、理由を返す', async t => {
  const r = await rig(t);
  await r.check();
  const none = await r.send(uuid(++n), 'hi', { modelId: 'cc' });
  assert.equal(none.status, 409);
  assert.equal(none.body.errorCode, 'engine.runtime.no_project');
  assert.equal(r.runtime.starts.length, 0);

  const { id: projectId, root } = await r.product();
  const app = r.s.app;
  const own = dirname(app.paths.templates);
  for (const folder of [own, app.paths.data, join(app.paths.data, 'inside'), dirname(own)]) {
    mkdirSync(folder, { recursive: true });
    const real = realpathSync.native(folder);
    app.db.prepare('UPDATE projects SET root = ?, root_key = ? WHERE id = ?').run(folder, rootKeyOf(real), projectId);
    const conversation = uuid(++n);
    const refused = await r.send(conversation, 'hi', { projectId, modelId: 'cc' });
    assert.equal(refused.status, 409, folder);
    assert.equal(refused.body.errorCode, 'engine.runtime.folder_refused', folder);
    assert.match(refused.body.errorMessage, /overlaps the (folder beat is installed in|beat data folder)/u, folder);
    assert.equal(app.conversations.messages(conversation, 5).length, 0, 'nothing is saved');
  }
  assert.equal(r.runtime.starts.length, 0);
  app.db.prepare('UPDATE projects SET root = ?, root_key = ? WHERE id = ?').run(root, rootKeyOf(realpathSync.native(root)), projectId);
});

test('許可の設定は、起こすたびに設定から決め直す（知らない値・何でも通す値は既定に倒れる）', async t => {
  for (const [configured, expected] of [[undefined, 'default'], ['acceptEdits', 'acceptEdits'], ['bypassPermissions', 'default']] as const) {
    const r = await rig(t, { ...(configured ? { permission: configured } : {}) });
    const { id: projectId } = await r.product();
    await r.check();
    r.runtime.script = feed => feed.done();
    await r.turn(uuid(++n), 'go', { projectId, modelId: 'cc' });
    assert.equal(r.runtime.starts[0]!.permission, expected, `${configured}`);
  }
});

test('始められない確かめ（契約ではないログイン）は、会話を始める前に断る。確かめが無ければ返事の始まりで 1 回確かめる', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  r.runtime.status = { ...OK_STATUS, login: 'other' };
  await r.check();
  const refused = await r.send(uuid(++n), 'hi', { projectId, modelId: 'cc' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.errorCode, 'engine.runtime.not_ready');
  assert.equal(r.runtime.starts.length, 0);

  const fresh = await rig(t);
  const product = await fresh.product();
  fresh.runtime.script = feed => feed.done();
  const runId = await fresh.turn(uuid(++n), 'go', { projectId: product.id, modelId: 'cc' });
  assert.equal(fresh.runtime.probes, 1, 'the unchecked runtime was checked once at the start of the reply');
  assert.equal(fresh.s.app.runs.get(runId)!.ok, 1);

  const blocked = await rig(t);
  const p2 = await blocked.product();
  blocked.runtime.status = { ...OK_STATUS, login: 'other' };
  const sent = await blocked.send(uuid(++n), 'go', { projectId: p2.id, modelId: 'cc' });
  assert.equal(sent.status, 202);
  await settled(blocked.s.app, sent.body.runId);
  const run = blocked.s.app.runs.get(sent.body.runId)!;
  assert.deepEqual({ ok: run.ok, kind: run.error_kind }, { ok: 0, kind: 'provider_error' });
  assert.equal(blocked.runtime.starts.length, 0, 'a check that cannot start a conversation stops the reply before the runtime is started');
});

test('承認の求めが来たら、何も許さずに返事を止めて「承認の橋はまだ」を返す', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'text', delta: 'About to write. ' });
    feed.push({ type: 'approval', requestId: 'req-1', tool: 'Write', input: { file_path: 'x', content: SECRET } });
    await feed.stopped;
    feed.done();
  };
  const conversation = uuid(++n);
  const runId = await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const run = r.s.app.runs.get(runId)!;
  assert.deepEqual({ ok: run.ok, kind: run.error_kind }, { ok: 0, kind: 'provider_error' });
  assert.match(run.error_message!, /approval/u);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'cancel' }], 'the request was answered with a decline, never an accept');
  assert.ok(r.runtime.interrupts >= 1);
  assert.ok(!JSON.stringify(r.rows(conversation)).includes(SECRET));
  assert.equal((r.s.app.db.prepare('SELECT COUNT(*) AS c FROM pending_actions').get() as { c: number }).c, 0);
});

test('実行役が落ちた・失敗を返したら、画面にはっきり出る。理由の文の制御文字と鍵は消える', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = feed => { feed.push({ type: 'failed', kind: 'process', message: `boom\u001b[31m‮evil ${SECRET}\nsecond` }); };
  const conversation = uuid(++n);
  const runId = await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const run = r.s.app.runs.get(runId)!;
  assert.deepEqual({ ok: run.ok, kind: run.error_kind }, { ok: 0, kind: 'provider_error' });
  assert.ok(!run.error_message!.includes(SECRET));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f‮]/u.test(run.error_message!), 'control and bidi characters are gone');
  const end = r.events.find(e => e.type === 'run.end' && e.runId === runId) as Extract<RunEvent, { type: 'run.end' }>;
  assert.deepEqual({ ok: end.ok, kind: end.errorKind }, { ok: false, kind: 'provider_error' });
  assert.ok(!r.s.logs.join('\n').includes(SECRET));

  // 終わりの知らせが来ないまま落ちた
  r.runtime.script = feed => { feed.push({ type: 'text', delta: 'partial' }); (feed as { done: () => void }).done = () => undefined; throw new Error('the runtime crashed'); };
  const second = await r.turn(conversation, 'again', { projectId, modelId: 'cc' });
  assert.equal(r.s.app.runs.get(second)!.ok, 0);
  assert.match(r.s.app.runs.get(second)!.error_message!, /crashed/u);
  assert.equal(r.s.app.conversations.get(conversation)!.runtime_session, 'sess-1');
});

test('止めるボタン: 実行役に止めを伝え、そこまでの文を残し、終わりが来なくても待ちすぎない。次の返事は続きの ID で始まる', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'text', delta: 'half a sentence' });
    await feed.stopped;
    feed.done();
  };
  const conversation = uuid(++n);
  const sent = await r.send(conversation, 'long job', { projectId, modelId: 'cc' });
  assert.equal(sent.status, 202);
  await waitFor(() => r.events.some(e => e.type === 'text.delta'), 'the first text');
  assert.equal(r.s.app.engine.stop(sent.body.runId), true);
  await settled(r.s.app, sent.body.runId);
  const run = r.s.app.runs.get(sent.body.runId)!;
  assert.deepEqual({ ok: run.ok, kind: run.error_kind }, { ok: 0, kind: 'cancelled' });
  assert.equal(r.runtime.interrupts, 1);
  const last = r.rows(conversation).at(-1) as { role: string; content: string };
  assert.match(last.content, /^half a sentence/u);
  assert.equal(r.runtime.closes, 1);

  // 続き: 保存した ID で始まる
  r.runtime.script = feed => feed.done();
  await r.turn(conversation, 'next', { projectId, modelId: 'cc' });
  assert.equal(r.runtime.starts[1]!.resume, 'sess-1');
  assert.equal(r.runtime.sent.at(-1), 'next');
  assert.equal(JSON.parse(r.s.app.runs.latestChat(conversation)!.runtime!).resumed, true);

  // 終わりの知らせを返さない実行役も、待ちすぎずに閉じる
  r.runtime.script = async feed => { feed.push({ type: 'text', delta: 'stuck' }); await new Promise(() => undefined); };
  const hung = await r.send(conversation, 'hang', { projectId, modelId: 'cc' });
  await waitFor(() => r.events.some(e => e.type === 'text.delta' && e.text === 'stuck'), 'hung text');
  r.s.app.engine.stop(hung.body.runId);
  await settled(r.s.app, hung.body.runId);
  assert.equal(r.s.app.runs.get(hung.body.runId)!.error_kind, 'cancelled');
});

test('実行役の会話は、最初の 1 回で結ばれて替わらない。やり直しも断る', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = feed => feed.done();
  const conversation = uuid(++n);
  await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const toProvider = await r.send(conversation, 'again', { modelId: 'm1' });
  assert.deepEqual({ status: toProvider.status, code: toProvider.body.code }, { status: 409, code: 'http.runtime_fixed' });
  const retry = await r.s.json(`/api/conversations/${conversation}/retry`, 'POST');
  assert.equal(retry.status, 409);
  assert.equal(retry.body.errorCode, 'engine.runtime.no_retry');
  // 提供元の会話に発言があれば、実行役のモデルには替えられない
  const plain = uuid(++n);
  r.s.adapter().scripts = [];
  const created = r.s.app.conversations.create({ id: plain, projectId });
  r.s.app.conversations.append(created.id, { role: 'user', content: 'hello' });
  const notFresh = await r.send(plain, 'now runtime', { modelId: 'cc' });
  assert.deepEqual({ status: notFresh.status, code: notFresh.body.code }, { status: 409, code: 'http.runtime_not_fresh' });
  // 長さの目盛りは出さない
  const usage = await r.s.json(`/api/conversations/${conversation}/context`, 'GET');
  assert.equal(usage.status, 409);
  assert.equal(usage.body.errorCode, 'engine.usage.runtime');
  // 続きの ID は画面に出ない
  const shown = await r.s.json(`/api/conversations/${conversation}/messages`, 'GET');
  assert.equal(shown.body.conversation.runtime_id, 'claude-code');
  assert.equal('runtime_session' in shown.body.conversation, false);
});

test('提供元のモデルが 1 つも無くても、実行役の会話は動く', async t => {
  const products = realpathSync.native(tempDir(t as never));
  const holder: { current?: ScriptedRuntime } = {};
  const s = await startApp(t, {
    models: [{ id: 'cc', runtime: 'claude-code', model: 'sonnet', vision: false }],
    configure: config => { config.runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }]; config.routing.chat = ['cc']; },
    runtimeFactories: { 'claude-code': scriptedFactory(holder) },
    projectFolderExempt: [products],
  });
  assert.ok(s.app.runtimes.find(s.app.config(), 'claude-code').ok);
  holder.current!.script = feed => { feed.push({ type: 'text', delta: 'hi' }); feed.done(); };
  const root = join(products, 'p');
  mkdirSync(root);
  const made = await s.json('/api/projects', 'POST', { root });
  await s.json('/api/runtimes/claude-code/check', 'POST');
  const sent = await s.json(`/api/conversations/${uuid(++n)}/messages`, 'POST', { text: 'go', projectId: made.body.project.id });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.runs.get(sent.body.runId)!.ok, 1);
  assert.equal(holder.current!.starts.length, 1);
});

test('製品の CLAUDE.md は全文のまま実行役（Claude Code）へ渡る。無い・ふつうのファイルでない・Codex のときは渡さない', async t => {
  const r = await rig(t);
  const body = `# Rules\n${'Keep the tests green. '.repeat(4000)}\nEND-OF-FILE`;
  const withFile = await r.product('with-file', { 'CLAUDE.md': body });
  await r.check();
  r.runtime.script = feed => feed.done();
  await r.turn(uuid(++n), 'go', { projectId: withFile.id, modelId: 'cc' });
  const passed = r.runtime.starts[0]!.instructions!;
  assert.ok(passed.endsWith('END-OF-FILE'), 'the whole file, not only its beginning');
  assert.ok(passed.length > 60_000);

  const without = await r.product('without-file');
  await r.turn(uuid(++n), 'go', { projectId: without.id, modelId: 'cc' });
  assert.equal('instructions' in r.runtime.starts[1]!, false);

  const asFolder = await r.product('as-folder');
  mkdirSync(join(asFolder.root, 'CLAUDE.md'));
  await r.turn(uuid(++n), 'go', { projectId: asFolder.id, modelId: 'cc' });
  assert.equal('instructions' in r.runtime.starts[2]!, false, 'a folder named CLAUDE.md is not read');
  assert.ok(r.s.logs.some(line => /Did not pass CLAUDE\.md/u.test(line)));

  const codex = await rig(t, { kind: 'codex' });
  const product = await codex.product('codex-prod', { 'CLAUDE.md': 'rules' });
  await codex.check();
  codex.runtime.script = feed => feed.done();
  await codex.turn(uuid(++n), 'go', { projectId: product.id, modelId: 'cc' });
  assert.equal('instructions' in codex.runtime.starts[0]!, false, 'Codex reads its own files; beat passes nothing');
});

test('実行役の知らせ（止まった理由・出来事）は、状態の行の「止まった理由」に覚えさせる', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  const stop = () => r.s.app.runtimeChecks.get('claude-code')!.stop;
  assert.equal(stop(), null);

  r.runtime.script = feed => { feed.push({ type: 'failed', kind: 'process', message: 'unreviewed tools', issue: { code: 'tools_unreviewed', detail: 'mcp__x__send, mcp__x__delete' } }); };
  await r.turn(uuid(++n), 'go', { projectId, modelId: 'cc' });
  assert.deepEqual(stop(), { code: 'tools_unreviewed', detail: 'mcp__x__send, mcp__x__delete' });

  await r.check();
  assert.equal(stop(), null, 'the next check clears it');
  r.runtime.script = feed => { feed.push({ type: 'issue', issue: { code: 'world_writable', detail: 'C:\shared' } }); feed.push({ type: 'text', delta: 'ok' }); feed.done(); };
  const runId = await r.turn(uuid(++n), 'go', { projectId, modelId: 'cc' });
  assert.equal(r.s.app.runs.get(runId)!.ok, 1, 'a warning does not stop the reply');
  assert.equal(stop()!.code, 'world_writable');

  await r.check();
  r.runtime.startError = Object.assign(new Error('The sandbox is not ready'), { reason: 'sandbox_not_ready' });
  const failed = await r.turn(uuid(++n), 'go', { projectId, modelId: 'cc' });
  assert.equal(r.s.app.runs.get(failed)!.ok, 0);
  assert.equal(stop()!.code, 'sandbox_not_ready');

  const blocked = await rig(t);
  const p = await blocked.product();
  blocked.runtime.status = { ...OK_STATUS, issues: [{ code: 'too_old', detail: '1.0.0' }] };
  await blocked.check();
  const refused = await blocked.send(uuid(++n), 'go', { projectId: p.id, modelId: 'cc' });
  assert.equal(refused.status, 409);
  assert.equal(blocked.s.app.runtimeChecks.get('claude-code')!.stop!.code, 'too_old');
  assert.equal(blocked.runtime.starts.length, 0);
});

test('知らない出来事は印（runtime_unknown）を残して先へ進み、起こした先がまとめられなかった旨は画面の警告に出る', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.containReason = 'the job object could not be created\u001b[31m\u202e';
  r.runtime.script = feed => {
    for (let i = 0; i < 9; i += 1) feed.push({ type: 'unknown', raw: `{"weird":${i}}` });
    feed.push({ type: 'text', delta: 'fine' });
    feed.done();
  };
  const runId = await r.turn(uuid(++n), 'go', { projectId, modelId: 'cc' });
  const run = r.s.app.runs.get(runId)!;
  assert.equal(run.ok, 1);
  assert.deepEqual(JSON.parse(run.flags), ['runtime', 'runtime_unknown']);
  assert.equal(r.s.logs.filter(line => /sent an event beat does not know/u.test(line)).length, 5, 'the log keeps the first five only');
  const warning = r.events.find(e => e.type === 'warning' && e.runId === runId) as Extract<RunEvent, { type: 'warning' }>;
  assert.equal(warning.code, 'runtime_contain');
  assert.match(warning.message, /job object could not be created/u);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u202e]/u.test(warning.message), 'the reason from the runtime is cleaned of control and bidi characters before it reaches the screen');
  assert.ok(!r.s.logs.some(line => /[\u0000-\u0008\u000b-\u001f\u202e]/u.test(line)));
  assert.equal(JSON.parse(run.runtime!).contained, false);
});

test('同じ決まりは、画面の口（HTTP）を通らない呼び出し（エンジンへ直に）でも守られる', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = feed => feed.done();
  const conversation = uuid(++n);
  await r.turn(conversation, 'go', { projectId, modelId: 'cc' });
  const engine = r.s.app.engine;
  const refusal = (outcome: ReturnType<typeof engine.send>) => (outcome.ok ? { ok: true } : { ok: false, code: outcome.errorCode });

  assert.deepEqual(refusal(engine.send(conversation, 'again', [], [], { modelId: 'm1' })), { ok: false, code: 'engine.runtime.fixed' }, 'a bound conversation does not move to a provider model');
  assert.deepEqual(refusal(engine.reply(conversation)), { ok: false, code: 'engine.runtime.no_retry' });
  assert.deepEqual(refusal(engine.retry(conversation)), { ok: false, code: 'engine.runtime.no_retry' });
  const usage = engine.contextUsage(conversation, 'm1');
  assert.deepEqual({ ok: usage.ok, code: usage.ok ? undefined : usage.errorCode }, { ok: false, code: 'engine.usage.runtime' }, 'a runtime conversation has no length gauge, whichever model is asked about');

  const plain = uuid(++n);
  r.s.app.conversations.create({ id: plain, projectId });
  r.s.app.conversations.append(plain, { role: 'user', content: 'hello' });
  assert.deepEqual(refusal(engine.send(plain, 'now runtime', [], [], { modelId: 'cc' })), { ok: false, code: 'engine.runtime.not_fresh' }, 'a provider conversation with messages does not become a runtime conversation');
  assert.equal(r.runtime.starts.length, 1, 'no refused call started a runtime');
});

test('実行役が返事を書いているあいだに送った発言は、待たせておき、終わってから続きの ID で新しい返事として読ませる', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  r.runtime.script = async (feed, text) => {
    feed.push({ type: 'text', delta: `echo ${text}` });
    if (text === 'first') await gate;
    feed.done();
  };
  const conversation = uuid(++n);
  const first = await r.send(conversation, 'first', { projectId, modelId: 'cc' });
  assert.equal(first.status, 202);
  await waitFor(() => r.events.some(e => e.type === 'text.delta'), 'the first text');
  const queued = await r.send(conversation, 'second');
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.queued, true);
  release();
  await settled(r.s.app, first.body.runId);
  await waitFor(() => r.runtime.sent.length === 2, 'the queued message starts a new reply');
  await waitFor(() => r.s.app.engine.activeRuns().length === 0, 'the second reply ends');
  assert.deepEqual(r.runtime.sent, ['first', 'second']);
  assert.equal(r.runtime.starts[1]!.resume, 'sess-1', 'the second reply continues the same runtime conversation');
  assert.deepEqual(r.rows(conversation).map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('画像は実行役の会話へは送れない（最初の版は断ったまま）。実行役は起こされず、何も保存されない', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await r.s.api('/api/uploads?name=a.png', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  const uploadId = ((await up.json()) as { upload: { id: string } }).upload.id;
  const conversation = uuid(++n);
  const sent = await r.send(conversation, 'look', { projectId, modelId: 'cc', attachments: [uploadId] });
  assert.deepEqual({ status: sent.status, error: sent.body.error }, { status: 409, error: 'no_vision' });
  assert.equal(r.runtime.starts.length, 0);
  assert.equal(r.s.app.conversations.get(conversation), undefined, 'a refused first message leaves no conversation behind');
});
