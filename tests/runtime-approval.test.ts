import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatMessage, RunEvent } from '../src/engine/types.ts';
import type { PendingRow } from '../src/pending/store.ts';
import type { RefusalCode } from '../src/runtimes/approval-map.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { settled, uuid, waitFor } from './app-setup.ts';
import { rig, SECRET } from './helpers/runtime-rig.ts';
import type { Script } from './helpers/scripted-runtime.ts';

// AR-8a: 実行役の承認の求めは、写して守りを当て（モデルは呼ばない）、守りに当たらないものだけ持ち主に聞く。答えは実行役へ返すだけで、beat は何も動かさない

type Rig = Awaited<ReturnType<typeof rig>>;
let n = 600;
const AUTO = { permissionMode: 'auto' };

interface Req { id: string; tool: string; input: unknown; forReply?: true; trace?: 'full' | 'start' | 'none' }

const answerOf = (r: Rig, id: string) => r.runtime.approvals.find(a => a.requestId === id)?.decision;
const untilAnswer = (r: Rig, id: string) => waitFor(() => answerOf(r, id) !== undefined, `answer to ${id}`);
const runtimeRows = (r: Rig) => r.s.app.db.prepare("SELECT * FROM pending_actions WHERE kind = 'runtime' ORDER BY id").all() as unknown as PendingRow[];
const requestOf = (row: PendingRow): string => (JSON.parse(row.state ?? 'null') as { runtime: { request: string } }).runtime.request;
const rowOf = (r: Rig, requestId: string): PendingRow => runtimeRows(r).find(row => requestOf(row) === requestId)!;
const count = (r: Rig, table: string) => (r.s.app.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const approve = (r: Rig, id: number, body?: unknown) => r.s.json(`/api/pending/${id}/approve`, 'POST', body);
const reject = (r: Rig, id: number, reason?: string) => r.s.json(`/api/pending/${id}/reject`, 'POST', reason === undefined ? {} : { reason });
const toolMessages = (r: Rig, conversation: string) => r.rows(conversation).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
const resultEvents = (r: Rig, runId: string) => r.events.filter((e): e is Extract<RunEvent, { type: 'tool.result' }> => e.type === 'tool.result' && e.runId === runId);

// 求めを出し、答えが返るまで待って、道具の結果を返し、返事を終える（実行役が答えを待つ様子）
function asking(r: Rig, requests: Req[], after: () => Promise<void> | void = () => undefined): Script {
  return async feed => {
    feed.push({ type: 'text', delta: 'Working. ' });
    for (const q of requests) {
      if (q.trace !== 'none') feed.push({ type: 'tool_start', id: q.id, name: q.tool, input: q.input });
      feed.push({ type: 'approval', requestId: q.id, tool: q.tool, input: q.input, ...(q.forReply ? { forReply: true as const } : {}) });
    }
    for (const q of requests) {
      await untilAnswer(r, q.id);
      const allowed = answerOf(r, q.id) === 'accept' || answerOf(r, q.id) === 'accept_for_reply';
      if ((q.trace ?? 'full') === 'full') feed.push({ type: 'tool_end', id: q.id, output: allowed ? 'done' : 'The owner declined this request.', isError: !allowed });
    }
    await after();
    feed.push({ type: 'text', delta: 'Finished.' });
    feed.done();
  };
}

async function start(r: Rig, projectId: string, extra: Record<string, unknown> = AUTO) {
  const conversation = uuid(++n);
  const sent = await r.send(conversation, 'go', { projectId, modelId: 'cc', ...extra });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  return { conversation, runId: sent.body.runId as string };
}

const writeInput = (root: string, name = 'new.txt', content = 'hello') => ({ file_path: join(root, name), content });

test('持ち主が許すと、答えが実行役へ返るだけで、beat は何も動かさない。待っているあいだ返事は終わらず、行は Pending の一覧に出る', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { conversation, runId } = await start(r, projectId);

  await waitFor(() => runtimeRows(r).length === 1, 'the request reached Pending');
  const row = runtimeRows(r)[0]!;
  assert.deepEqual([row.status, row.kind, row.tool, row.run_id, row.conversation_id, row.project_id], ['waiting', 'runtime', 'claude-code:Write', runId, conversation, projectId]);
  assert.equal(row.bind, null);
  assert.equal(r.s.app.runs.get(runId)!.ended_at, null, 'the reply waits for the owner');
  assert.equal(r.runtime.approvals.length, 0, 'nothing was answered without the owner');
  assert.equal(r.s.app.runtimeApprovals.size, 1);
  const listed = await r.s.json('/api/pending', 'GET');
  const item = listed.body.items.find((i: { id: number }) => i.id === row.id);
  assert.deepEqual([item.status, item.kind, item.title, item.runtime, item.parts.body], ['waiting', 'runtime', 'Write new.txt', { id: 'claude-code', reply: false }, 'hello']);
  assert.match(item.reason, /Claude Code is waiting for your answer: Write/u);

  const res = await approve(r, row.id);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await settled(r.s.app, runId);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'accept' }], 'the answer was relayed, once');
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  assert.equal(r.s.app.pending.row(row.id)!.status, 'answered');
  assert.equal(r.s.app.runtimeApprovals.size, 0);

  assert.equal(existsSync(join(root, 'new.txt')), false, 'approving does not make beat write the file');
  for (const table of ['tool_calls', 'file_changes']) assert.equal(count(r, table), 0, table);
  assert.equal(count(r, 'pending_actions'), 1);
  const tool = toolMessages(r, conversation)[0]!;
  assert.deepEqual([tool.toolCallId, tool.content, tool.gate], ['rt_req-1', 'done', { by: 'owner', id: row.id, allowed: true }]);
  const result = resultEvents(r, runId)[0]!;
  assert.deepEqual([result.decision, result.gate, result.ok], ['allow', { by: 'owner', id: row.id, allowed: true }, true]);
  assert.deepEqual(r.events.filter(e => e.type === 'pendingAction.changed' && e.id === row.id).map(e => (e as { status: string }).status), ['waiting', 'running', 'answered']);
});

test('持ち主が断ると実行役へ「断った」が返り、返事は続く。道具の行は「持ち主が断った」で残る', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { conversation, runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 1);
  const row = runtimeRows(r)[0]!;
  const res = await reject(r, row.id, 'not that file');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await settled(r.s.app, runId);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'decline' }]);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  assert.deepEqual([r.s.app.pending.row(row.id)!.status, r.s.app.pending.row(row.id)!.reject_reason], ['rejected', 'not that file']);
  const tool = toolMessages(r, conversation)[0]!;
  assert.deepEqual([tool.gate, tool.isError], [{ by: 'owner', id: row.id, allowed: false }, true]);
  assert.equal(resultEvents(r, runId)[0]!.decision, 'deny');
  assert.equal(existsSync(join(root, 'new.txt')), false);
});

test('同時に 2 つの求めが来ても、答えは求めの ID どおりの相手だけに届く。同じ求めへの 2 回目の答えは断られる', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [{ id: 'req-a', tool: 'Write', input: writeInput(root, 'a.txt') }, { id: 'req-b', tool: 'Write', input: writeInput(root, 'b.txt') }]);
  const { conversation, runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 2);
  const [a, b] = [rowOf(r, 'req-a'), rowOf(r, 'req-b')];
  assert.notEqual(a.id, b.id);
  assert.equal(r.s.app.runtimeApprovals.size, 2);

  assert.equal((await approve(r, b.id)).status, 202);
  await untilAnswer(r, 'req-b');
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-b', decision: 'accept' }], 'the other request still waits');
  assert.equal(r.s.app.pending.row(a.id)!.status, 'waiting');

  for (const again of [await approve(r, b.id), await reject(r, b.id), await approve(r, b.id, { reply: true })]) {
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.match(again.body.code, /not_waiting/u);
  }
  assert.equal(await r.s.app.runtimeApprovals.accept(b.id, false), undefined, 'the waiting entry is gone: nothing can be sent for this request again');
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-b', decision: 'accept' }]);

  assert.equal((await reject(r, a.id, 'no')).status, 200);
  await settled(r.s.app, runId);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-b', decision: 'accept' }, { requestId: 'req-a', decision: 'decline' }]);
  assert.deepEqual(r.runtime.refused, [], 'the runtime was never asked twice for one request');
  const byId = Object.fromEntries(toolMessages(r, conversation).map(m => [m.toolCallId, m.gate]));
  assert.deepEqual(byId, { 'rt_req-a': { by: 'owner', id: a.id, allowed: false }, 'rt_req-b': { by: 'owner', id: b.id, allowed: true } });
});

test('求めの札・行・画面への返事・会話・ログのどこにも、預かった鍵の値は出ない', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [
    { id: 'req-w', tool: 'Write', input: { file_path: join(root, `note-${SECRET}.txt`), content: `token=${SECRET}\nline two` } },
    { id: 'req-b', tool: 'Bash', input: { command: `echo ${SECRET}`, description: `uses ${SECRET}` } },
    { id: 'req-m', tool: 'mcp__x__tool', input: { key: SECRET } },
  ]);
  const { conversation, runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 3);
  const listed = JSON.stringify((await r.s.json('/api/pending', 'GET')).body);
  assert.ok(!listed.includes(SECRET), 'the list the screen reads');
  assert.ok(listed.includes('BEAT-SECRET'), 'the value is replaced by a mark, not dropped');
  assert.ok(!JSON.stringify(runtimeRows(r)).includes(SECRET), 'the rows as stored');
  for (const row of runtimeRows(r)) assert.equal((await approve(r, row.id)).status, 202);
  await settled(r.s.app, runId);
  assert.ok(!JSON.stringify(runtimeRows(r)).includes(SECRET), 'the rows after they were answered');
  assert.ok(!JSON.stringify(r.rows(conversation)).includes(SECRET), 'the conversation');
  assert.ok(!JSON.stringify(r.events).includes(SECRET), 'the events');
  assert.ok(!r.s.logs.join('\n').includes(SECRET), 'the log');
  assert.ok(runtimeRows(r).every(row => row.masked > 0), 'each card says it hides something');
});

const dataFile = (r: Rig) => join(r.s.paths.data, 'beat.db');

test('守りに当たる求め（秘密・beat のデータ・製品の外・リンク・守るファイル・beat 自身）は、持ち主に聞かずに断る。聞く行は作らず、道具の行はちょうど 1 つ', async t => {
  const r = await rig(t, { configure: config => { config.tools.hooks.preToolUse = [structuredClone(DEFAULT_PROTECT_FILES)]; } });
  const { id: projectId, root } = await r.product();
  mkdirSync(join(root, 'real-dir'), { recursive: true });
  symlinkSync(join(root, 'real-dir'), join(root, 'link-dir'), 'junction');
  mkdirSync(join(r.products, 'elsewhere'), { recursive: true });
  symlinkSync(join(r.products, 'elsewhere'), join(root, 'out-link'), 'junction');
  await r.check();
  const port = r.s.app.config().server.port;
  const cases: Array<{ name: string; tool: string; input: unknown; code: RefusalCode }> = [
    { name: '.env', tool: 'Write', input: writeInput(root, '.env', `KEY=${SECRET}`), code: 'secret' },
    { name: 'beat data', tool: 'Edit', input: { file_path: dataFile(r), old_string: 'a', new_string: 'b' }, code: 'secret' },
    { name: 'outside the product folder', tool: 'Write', input: { file_path: join(r.products, 'other', 'x.txt'), content: 'x' }, code: 'outside_write' },
    { name: 'a link itself', tool: 'Write', input: { file_path: join(root, 'link-dir'), content: 'x' }, code: 'link_write' },
    { name: 'a path through a link that points outside', tool: 'Write', input: { file_path: join(root, 'out-link', 'x.txt'), content: 'x' }, code: 'outside_write' },
    { name: 'a protected file', tool: 'Write', input: writeInput(root, '.github/workflows/ci.yml'), code: 'protect_files' },
    { name: 'a command that reads .env', tool: 'Bash', input: { command: 'cat .env' }, code: 'secret' },
    { name: 'a command that writes outside', tool: 'Bash', input: { command: 'echo x > ../outside.txt' }, code: 'outside_write' },
    { name: 'beat itself', tool: 'Bash', input: { command: `curl http://127.0.0.1:${port}/api/pending` }, code: 'self_target' },
    { name: 'running with administrator rights', tool: 'Bash', input: { command: 'sudo ls' }, code: 'shell_deny' },
  ];
  for (const c of cases) {
    const id = `req-${c.code}-${++n}`;
    r.runtime.script = asking(r, [{ id, tool: c.tool, input: c.input }]);
    const before = count(r, 'pending_actions');
    const { conversation, runId } = await start(r, projectId);
    await settled(r.s.app, runId);
    assert.equal(answerOf(r, id), 'decline_by_beat', c.name);
    assert.equal(count(r, 'pending_actions'), before, `${c.name}: the owner was not asked`);
    assert.equal(r.s.app.runs.get(runId)!.ok, 1, c.name);
    const tools = toolMessages(r, conversation);
    assert.equal(tools.length, 1, `${c.name}: exactly one tool row`);
    assert.deepEqual(tools[0]!.gate, { by: 'guard', key: c.code }, c.name);
    assert.equal(tools[0]!.isError, true);
    assert.match(tools[0]!.content, /^Not allowed by beat: .*You were not asked$/u, c.name);
    assert.ok(!tools[0]!.content.includes(SECRET));
    assert.deepEqual(resultEvents(r, runId).map(e => [e.decision, e.gate]), [['deny', { by: 'guard', key: c.code }]], c.name);
    assert.ok(r.s.logs.some(line => line.includes(`declined it without asking the owner (${c.code})`)), c.name);
  }
  assert.equal(r.s.app.runtimeApprovals.size, 0);
  for (const name of ['tool_calls', 'file_changes']) assert.equal(count(r, name), 0);
  assert.equal(existsSync(join(root, '.env')), false);
});

test('「外は許さない」設定の外を読む求め・Monitor の守りも、橋を通して聞かずに断る（理由は読む側の文で、道具の行は 1 つ）', async t => {
  const r = await rig(t, { configure: config => { config.tools.outsideRoots = 'deny'; } });
  const { id: projectId, root } = await r.product();
  await r.check();
  const port = r.s.app.config().server.port;
  const cases: Array<{ name: string; tool: string; input: unknown; code: RefusalCode; text: RegExp }> = [
    { name: 'a read outside', tool: 'Read', input: { file_path: join(r.products, 'other', 'x.txt') }, code: 'outside_read', text: /it reads outside the product folder/u },
    { name: 'a Glob that lists outside', tool: 'Glob', input: { pattern: join(r.products, 'other', '**', '*.txt') }, code: 'outside_read', text: /it reads outside the product folder/u },
    { name: 'a Monitor command that reads .env', tool: 'Monitor', input: { description: 'w', timeout_ms: 1000, command: 'cat .env' }, code: 'secret', text: /secrets/u },
    { name: 'a Monitor socket to beat itself', tool: 'Monitor', input: { description: 'w', timeout_ms: 1000, ws: { url: `ws://127.0.0.1:${port}/events` } }, code: 'self_target', text: /talks to beat itself/u },
  ];
  for (const c of cases) {
    const id = `req-${c.code}-${++n}`;
    r.runtime.script = asking(r, [{ id, tool: c.tool, input: c.input }]);
    const before = count(r, 'pending_actions');
    const { conversation, runId } = await start(r, projectId);
    await settled(r.s.app, runId);
    assert.equal(answerOf(r, id), 'decline_by_beat', c.name);
    assert.equal(count(r, 'pending_actions'), before, `${c.name}: the owner was not asked`);
    const tools = toolMessages(r, conversation);
    assert.equal(tools.length, 1, `${c.name}: exactly one tool row`);
    assert.deepEqual(tools[0]!.gate, { by: 'guard', key: c.code }, c.name);
    assert.match(tools[0]!.content, c.text, c.name);
  }
  assert.equal(r.s.app.runtimeApprovals.size, 0);
  const inside = r.runtime.approvals.length;
  r.runtime.script = asking(r, [{ id: 'req-inside', tool: 'Read', input: { file_path: join(root, 'a.txt') } }]);
  const { runId: last } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 1, 'a read inside the product folder still reaches the owner');
  assert.equal(r.runtime.approvals.length, inside, 'and it was not answered by beat');
  assert.equal((await reject(r, runtimeRows(r)[0]!.id)).status, 200);
  await settled(r.s.app, last);
});

test('断った求めの道具の行は、実行役が道具の知らせを出さない・始めだけ出す場合でも、返事の終わりでちょうど 1 つになる', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  for (const trace of ['none', 'start', 'full'] as const) {
    const id = `req-${trace}`;
    r.runtime.script = asking(r, [{ id, tool: 'Write', input: writeInput(root, '.env'), trace }]);
    const { conversation, runId } = await start(r, projectId);
    await settled(r.s.app, runId);
    const tools = toolMessages(r, conversation);
    assert.deepEqual(tools.map(m => [m.toolCallId, m.gate, m.isError]), [['rt_' + id, { by: 'guard', key: 'secret' }, true]], trace);
    const calls = r.rows(conversation).filter(m => m.role === 'assistant' && m.toolCalls?.length);
    assert.equal(calls.length, 1, `${trace}: one call row`);
    assert.equal(resultEvents(r, runId).length, 1, `${trace}: one result event`);
    assert.equal(r.s.app.runs.get(runId)!.tool_calls, 1, trace);
  }
});

test('写せない・知らない求め（知らない道具・読めない入力・Codex の権限・ネットワーク・実行中の命令への入力）は、断らず必ず持ち主に回し、札に「beat は検査していない」と出す', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  const cases: Array<[string, unknown]> = [['mcp__x__y', { a: 1 }], ['Write', null], ['Bash', { command: 5 }], ['WebFetch', { url: 'https://example.com' }]];
  for (const [tool, input] of cases) {
    const id = `req-${++n}`;
    r.runtime.script = asking(r, [{ id, tool, input, forReply: true }]);
    const { runId } = await start(r, projectId);
    await waitFor(() => runtimeRows(r).some(row => requestOf(row) === id), `${tool} reached Pending`);
    const row = rowOf(r, id);
    assert.equal(row.status, 'waiting', tool);
    assert.equal(answerOf(r, id), undefined, `${tool}: not answered by beat`);
    const view = r.s.app.pending.view(row.id)!;
    assert.ok(view.checks.some(line => /does not check|could not read/u.test(line)), JSON.stringify(view.checks));
    assert.ok(view.checks.some(line => /so only you decide it/u.test(line)), JSON.stringify(view.checks));
    assert.deepEqual(view.runtime, { id: 'claude-code', reply: false }, 'never offered as "do not ask again"');
    assert.equal((await reject(r, row.id)).status, 200);
    await settled(r.s.app, runId);
    assert.equal(answerOf(r, id), 'decline');
  }

  const codex = await rig(t, { kind: 'codex' });
  const { id: codexProject, root: codexRoot } = await codex.product();
  await codex.check();
  const codexCases: Array<[string, unknown]> = [
    ['permissions', { permissions: { network: { enabled: true } }, cwd: codexRoot, reason: 'net' }],
    ['commandExecution', { kind: 'command', itemId: 'i-net', command: 'curl example.com', cwd: codexRoot, reason: null, network: { host: 'example.com', protocol: 'https' }, actions: [] }],
    ['commandExecution', { kind: 'writeStdin', itemId: 'i-in', command: null, cwd: codexRoot, reason: null, network: null, actions: [] }],
  ];
  for (const [tool, input] of codexCases) {
    const id = `cx-${++n}`;
    codex.runtime.script = asking(codex, [{ id, tool, input, forReply: true, trace: 'none' }]);
    const { runId } = await start(codex, codexProject);
    await waitFor(() => runtimeRows(codex).some(row => requestOf(row) === id), `${tool} reached Pending`);
    const row = rowOf(codex, id);
    assert.equal(codex.s.app.pending.view(row.id)!.runtime!.reply, false);
    assert.equal(answerOf(codex, id), undefined);
    assert.equal((await reject(codex, row.id)).status, 200);
    await settled(codex.s.app, runId);
  }
});

test('Codex の求め: 道具の行は項目の ID と結ばれ、作業フォルダが製品の外なら断る', async t => {
  const r = await rig(t, { kind: 'codex' });
  const { id: projectId, root } = await r.product();
  await r.check();
  const command = (itemId: string, cwd: string) => ({ kind: 'command', itemId, command: 'ls', cwd, reason: null, network: null, actions: [] });
  r.runtime.script = async feed => {
    feed.push({ type: 'tool_start', id: 'item-ok', name: 'commandExecution', input: { command: 'ls' } });
    feed.push({ type: 'approval', requestId: 'codex-n1', tool: 'commandExecution', input: command('item-ok', root), forReply: true });
    feed.push({ type: 'tool_start', id: 'item-out', name: 'commandExecution', input: { command: 'ls' } });
    feed.push({ type: 'approval', requestId: 'codex-n2', tool: 'commandExecution', input: command('item-out', r.products) });
    await untilAnswer(r, 'codex-n1');
    await untilAnswer(r, 'codex-n2');
    feed.push({ type: 'tool_end', id: 'item-ok', output: 'a.txt', isError: false });
    feed.push({ type: 'tool_end', id: 'item-out', output: 'declined', isError: true });
    feed.done();
  };
  const { conversation, runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 1);
  assert.equal(answerOf(r, 'codex-n2'), 'decline_by_beat', 'outside the product folder: declined at once');
  assert.equal(answerOf(r, 'codex-n1'), undefined);
  const row = rowOf(r, 'codex-n1');
  assert.deepEqual(r.s.app.pending.view(row.id)!.runtime, { id: 'codex', reply: true });
  assert.equal(r.s.app.pending.row(row.id)!.tool, 'codex:commandExecution');
  assert.equal((await approve(r, row.id)).status, 202);
  await settled(r.s.app, runId);
  const byId = Object.fromEntries(toolMessages(r, conversation).map(m => [m.toolCallId, m.gate]));
  assert.deepEqual(byId, { 'rt_item-ok': { by: 'owner', id: row.id, allowed: true }, 'rt_item-out': { by: 'guard', key: 'outside_cwd' } });
});

test('計画モードの会話では、書く・動かす・読むのどの求めも、持ち主に聞かずに断る。実行役は一番慎重な許可で起こされ、聞く行は作らない', async t => {
  const r = await rig(t, { permission: 'acceptEdits' });
  const { id: projectId, root } = await r.product();
  await r.check();
  const requests: Req[] = [
    { id: 'p-write', tool: 'Write', input: writeInput(root) }, { id: 'p-bash', tool: 'Bash', input: { command: 'ls' } },
    { id: 'p-read', tool: 'Read', input: { file_path: join(root, 'a.txt') } }, { id: 'p-mcp', tool: 'mcp__x__y', input: {} },
  ];
  r.runtime.script = asking(r, requests);
  const { conversation, runId } = await start(r, projectId, { permissionMode: 'plan' });
  await settled(r.s.app, runId);
  assert.equal(r.runtime.starts[0]!.permission, 'default', 'started with the most careful permission, though the setting is looser');
  assert.deepEqual(requests.map(q => answerOf(r, q.id)), ['decline_by_beat', 'decline_by_beat', 'decline_by_beat', 'decline_by_beat']);
  assert.equal(count(r, 'pending_actions'), 0, 'plan mode never asks the owner');
  assert.deepEqual(toolMessages(r, conversation).map(m => m.gate), requests.map(() => ({ by: 'guard', key: 'plan_mode' })));
  assert.match(toolMessages(r, conversation)[0]!.content, /plan mode.*You were not asked/u);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);

  r.runtime.script = asking(r, [{ id: 'a-write', tool: 'Write', input: writeInput(root) }]);
  const auto = await start(r, projectId, AUTO);
  await waitFor(() => runtimeRows(r).length === 1, 'the same request in an ordinary conversation is asked');
  assert.equal((await reject(r, runtimeRows(r)[0]!.id)).status, 200);
  await settled(r.s.app, auto.runId);
});

test('「次回の決まりとして覚える」は実行役の求めにはできない。「この返事のあいだ聞かない」は、実行役がそれを持つ求めにだけ', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [
    { id: 'plain', tool: 'Bash', input: { command: 'ls' } },
    { id: 'offer', tool: 'Bash', input: { command: 'ls -la' }, forReply: true },
    { id: 'wide', tool: 'Write', input: writeInput(root, '.git/config'), forReply: true },
    { id: 'direct', tool: 'Bash', input: { command: 'pwd' } },
  ]);
  const { runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 4);
  const [plain, offer, wide, direct] = ['plain', 'offer', 'wide', 'direct'].map(id => rowOf(r, id));
  const rules = () => count(r, 'approval_rules');

  const remember = await approve(r, plain!.id, { remember: true });
  assert.equal(remember.status, 409);
  assert.match(remember.body.code, /not_rememberable/u);
  assert.equal(r.s.app.pending.row(plain!.id)!.status, 'waiting');
  assert.equal(rules(), 0, 'no rule was learned');
  assert.equal((await approve(r, plain!.id, { reply: true, remember: true })).status, 400);
  assert.equal((await approve(r, plain!.id, { reply: 'yes' })).status, 400);

  const noOffer = await approve(r, plain!.id, { reply: true });
  assert.equal(noOffer.status, 409);
  assert.match(noOffer.body.code, /reply_unavailable/u);
  assert.equal((await approve(r, wide!.id, { reply: true })).status, 409, 'the runtime can hold it, but a write beat asked about is never offered as "do not ask again"');
  assert.equal(r.runtime.approvals.length, 0);
  assert.deepEqual([plain, offer, wide].map(row => r.s.app.pending.row(row!.id)!.status), ['waiting', 'waiting', 'waiting']);
  assert.deepEqual([offer, plain, wide, direct].map(row => r.s.app.runtimeApprovals.offersReply(row!.id)), [true, false, false, false], 'the table of waiting requests offers it only where the runtime holds it');
  assert.equal(await r.s.app.runtimeApprovals.accept(direct!.id, true), 'accept', 'even asked for it, a runtime that does not hold it is answered plainly');

  assert.deepEqual([offer, plain, wide].map(row => r.s.app.pending.view(row!.id)!.runtime!.reply), [true, false, false]);
  assert.equal((await approve(r, offer!.id, { reply: true })).status, 202);
  await untilAnswer(r, 'offer');
  assert.equal(answerOf(r, 'offer'), 'accept_for_reply');
  assert.equal((await approve(r, plain!.id)).status, 202);
  assert.equal((await reject(r, wide!.id)).status, 200);
  await settled(r.s.app, runId);
  assert.deepEqual([answerOf(r, 'plain'), answerOf(r, 'wide'), answerOf(r, 'direct')], ['accept', 'decline', 'accept']);
  assert.equal(r.s.app.pending.row(offer!.id)!.status, 'answered');
  assert.match(r.s.app.pending.row(offer!.id)!.reject_reason ?? '', /not asked again until the reply ends/u);
  assert.equal(rules(), 0);
});

test('答えを待つあいだに返事が終わる・止められる・実行役が失敗すると、その行は「古くなった」で閉じ、あとから許しても何も起きない', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();

  r.runtime.script = async feed => {
    feed.push({ type: 'tool_start', id: 'ended', name: 'Write', input: writeInput(root) });
    feed.push({ type: 'approval', requestId: 'ended', tool: 'Write', input: writeInput(root) });
    feed.done();
  };
  const ended = await start(r, projectId);
  await settled(r.s.app, ended.runId);
  const endedRow = rowOf(r, 'ended');
  assert.equal(r.s.app.runs.get(ended.runId)!.ok, 1);
  assert.deepEqual([endedRow.status, endedRow.reject_reason], ['stale', 'The reply that asked for this ended before it was answered']);
  assert.equal((await approve(r, endedRow.id)).status, 409, 'a late allow is refused');
  assert.equal(r.runtime.approvals.length, 0, 'the runtime that no longer waits is not answered');
  assert.equal(r.s.app.runtimeApprovals.size, 0);

  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'stopped', tool: 'Write', input: writeInput(root) });
    await feed.stopped;
    feed.done();
  };
  const stopped = await start(r, projectId);
  await waitFor(() => runtimeRows(r).some(row => requestOf(row) === 'stopped'));
  assert.equal(r.s.app.engine.stop(stopped.runId), true);
  await settled(r.s.app, stopped.runId);
  const stoppedRow = rowOf(r, 'stopped');
  assert.equal(r.s.app.runs.get(stopped.runId)!.error_kind, 'cancelled');
  assert.deepEqual([stoppedRow.status, stoppedRow.reject_reason], ['stale', 'The reply that asked for this was stopped before it was answered']);
  assert.equal((await approve(r, stoppedRow.id)).status, 409);

  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'failed', tool: 'Write', input: writeInput(root) });
    feed.push({ type: 'failed', kind: 'process', message: 'the runtime crashed' });
  };
  const failed = await start(r, projectId);
  await settled(r.s.app, failed.runId);
  const failedRow = rowOf(r, 'failed');
  assert.equal(r.s.app.runs.get(failed.runId)!.ok, 0);
  assert.equal(failedRow.status, 'stale');
  assert.equal((await approve(r, failedRow.id)).status, 409);
  assert.deepEqual(r.runtime.approvals, [], 'nothing was ever answered to a runtime that had gone');
  assert.equal(r.s.app.runtimeApprovals.size, 0);
});

test('待っている求めを beat 側で取り下げると、実行役へは「取り消し」が返る', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { conversation, runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 1);
  assert.equal(r.s.app.pending.cancelConversations([conversation]), 1);
  await settled(r.s.app, runId);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'cancel' }]);
  assert.equal(r.s.app.pending.row(runtimeRows(r)[0]!.id)!.status, 'cancelled');
  assert.deepEqual(toolMessages(r, conversation)[0]!.gate, { by: 'owner', id: runtimeRows(r)[0]!.id, allowed: false, closed: true }, 'a request taken back by beat is shown as closed, not as declined by the owner');
});

test('答えが決まった時間のうちに来ないと、求めは取り消され、行は古くなり、返事は「待ちきれなかった」で終わる。あとから許しても何も起きない', async t => {
  const r = await rig(t, { approvalWaitMs: 150 });
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  const row = rowOf(r, 'req-1');
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'cancel' }]);
  assert.deepEqual([row.status, row.reject_reason], ['stale', 'No answer came in time, so the request was cancelled']);
  const run = r.s.app.runs.get(runId)!;
  assert.deepEqual([run.ok, run.error_kind], [0, 'provider_error']);
  assert.match(run.error_message!, /waited more than 1 minutes for your answer.*Nothing was allowed/u);
  assert.equal((await approve(r, row.id)).status, 409);
  assert.equal(r.s.app.runtimeApprovals.size, 0);
  assert.deepEqual(toolMessages(r, conversation)[0]!.gate, { by: 'owner', id: row.id, allowed: false, closed: true }, 'a request nobody answered in time is shown as closed, not as declined by the owner');
});

test('答えを待たずに道具が終わった求め（実行役が自分で取り下げた）は、道具の行を「持ち主が断った」にせず、古くして閉じる', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'tool_start', id: 'req-1', name: 'Write', input: writeInput(root) });
    feed.push({ type: 'approval', requestId: 'req-1', tool: 'Write', input: writeInput(root) });
    feed.push({ type: 'tool_end', id: 'req-1', output: 'The tool was interrupted', isError: true });
    await waitFor(() => runtimeRows(r).some(row => requestOf(row) === 'req-1' && row.status === 'stale'), 'the row is closed as soon as the tool ends, not only when the reply does');
    assert.equal(r.s.app.runtimeApprovals.size, 0);
    feed.done();
  };
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  const row = rowOf(r, 'req-1');
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  assert.equal(row.status, 'stale');
  assert.deepEqual(toolMessages(r, conversation)[0]!.gate, { by: 'owner', id: row.id, allowed: false, closed: true }, 'closed without an answer, not "declined"');
  assert.equal(r.runtime.approvals.length, 0);
  assert.equal(r.s.app.runtimeApprovals.size, 0);
});

test('返事の終わりに待ちの片付け（closeRun）が落ちても、実行役のセッションは必ず閉じられ、返事は終わる', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.s.app.runtimeApprovals.closeRun = () => { throw new Error('the database is gone'); };
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).length === 1, 'the request reached Pending');
  assert.equal((await approve(r, runtimeRows(r)[0]!.id)).status, 202);
  await settled(r.s.app, runId);
  assert.equal(r.runtime.closes, 1, 'the runtime session was closed although the cleanup before it failed');
  assert.equal(r.s.app.runs.get(runId)!.ok, 1, 'the reply still ended normally');
  assert.ok(r.s.logs.some(line => line.includes('Could not close the approval requests') && line.includes('the database is gone')), r.s.logs.join(' | '));
});

test('返事が終わる・止められるとき閉じるのは、その返事の求めだけ。ほかの返事が待っている求めは残り、あとで答えられる', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = async (feed, text) => {
    feed.push({ type: 'approval', requestId: `${text}-req`, tool: 'Write', input: writeInput(root, `${text}.txt`) });
    if (text === 'first') { await feed.stopped; feed.done(); return; }
    await untilAnswer(r, 'second-req');
    feed.done();
  };
  const go = async (text: string): Promise<string> => {
    const sent = await r.send(uuid(++n), text, { projectId, modelId: 'cc', ...AUTO });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    return sent.body.runId as string;
  };
  const first = await go('first');
  const second = await go('second');
  await waitFor(() => runtimeRows(r).length === 2, 'both requests reached Pending');
  assert.equal(r.s.app.engine.stop(first), true);
  await settled(r.s.app, first);
  const [stopped, waiting] = ['first-req', 'second-req'].map(id => rowOf(r, id));
  assert.deepEqual([stopped!.status, waiting!.status], ['stale', 'waiting'], 'the other reply keeps waiting for the owner');
  assert.equal(r.s.app.runtimeApprovals.size, 1);
  assert.equal(r.s.app.runs.get(second)!.ended_at, null);

  assert.equal((await approve(r, waiting!.id)).status, 202);
  await settled(r.s.app, second);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'second-req', decision: 'accept' }]);
  assert.equal(r.s.app.pending.row(waiting!.id)!.status, 'answered');
});

test('答える相手の実行役がもういない行は、許しても何も動かさず「古くなった」で閉じる。答えを返す呼びかけが落ちた場合も同じ', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  const orphan = r.s.app.pending.parkRuntime({
    runtimeId: 'claude-code', tool: 'claude-code:Write', requestId: 'orphan', title: 'Write orphan.txt', body: 'x', cwd: null, extra: null, reason: 'waits', reply: false, root, runId: 'run-gone', conversationId: uuid(++n), projectId,
  });
  assert.equal((await approve(r, orphan.id)).status, 202);
  await waitFor(() => r.s.app.pending.row(orphan.id)!.status === 'stale', 'the orphan row was closed');
  assert.equal(r.s.app.pending.row(orphan.id)!.reject_reason, 'The runtime no longer waits for an answer to this');
  assert.equal(r.runtime.approvals.length, 0);
  assert.equal(existsSync(join(root, 'orphan.txt')), false);

  r.runtime.approve = async () => { throw new Error('the runtime is gone'); };
  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'dropped', tool: 'Write', input: writeInput(root, 'dropped.txt') });
    await feed.stopped;
    feed.done();
  };
  const { runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).some(row => requestOf(row) === 'dropped'));
  const row = rowOf(r, 'dropped');
  assert.equal((await approve(r, row.id)).status, 202);
  await waitFor(() => r.s.app.pending.row(row.id)!.status === 'stale', 'the row was closed when the answer could not be passed');
  assert.notEqual(r.s.app.pending.row(row.id)!.status, 'answered');
  assert.equal(r.s.app.engine.stop(runId), true);
  await settled(r.s.app, runId);
  assert.equal(existsSync(join(root, 'dropped.txt')), false);
});

test('Pending に積めなかった求めは、許さず断る。返事はそのまま続く', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  r.s.app.pending.parkRuntime = () => { throw new Error('the database is full'); };
  r.runtime.script = asking(r, [{ id: 'req-1', tool: 'Write', input: writeInput(root) }]);
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  assert.deepEqual(r.runtime.approvals, [{ requestId: 'req-1', decision: 'decline_by_beat' }]);
  assert.equal(runtimeRows(r).length, 0);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  assert.equal(r.s.app.runtimeApprovals.size, 0);
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(toolMessages(r, conversation)[0]!.isError, true);
});

test('答えが来ないままの時間切れは、返事の終わりの知らせが「成功」で来ても、失敗として終わる', async t => {
  const r = await rig(t, { approvalWaitMs: 150 });
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'req-1', tool: 'Write', input: writeInput(root) });
    await untilAnswer(r, 'req-1');
    feed.push({ type: 'text', delta: 'Gave up waiting, finishing normally.' });
    feed.done();
  };
  const { runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  const run = r.s.app.runs.get(runId)!;
  assert.deepEqual([run.ok, run.error_kind], [0, 'provider_error']);
  assert.match(run.error_message!, /waited more than 1 minutes for your answer/u);
});

test('beat のシェルの検査が拒否するコマンド（取り返しのつかない削除・管理者の権限・fork bomb）は、持ち主に聞かずに断る。聞く段のコマンドは、理由つきで持ち主に回る', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  const cases: Array<{ name: string; command: string; code: RefusalCode }> = [
    { name: 'a delete of the product folder (the protected-files list answers before the shell check)', command: 'rm -rf .', code: 'protect_files' },
    { name: 'running with administrator rights', command: 'sudo ls', code: 'shell_deny' },
    { name: 'a fork bomb', command: ':(){ :|:& };:', code: 'shell_deny' },
  ];
  for (const c of cases) {
    const id = `req-deny-${++n}`;
    r.runtime.script = asking(r, [{ id, tool: 'Bash', input: { command: c.command } }]);
    const before = count(r, 'pending_actions');
    const { conversation, runId } = await start(r, projectId);
    await settled(r.s.app, runId);
    assert.equal(answerOf(r, id), 'decline_by_beat', c.name);
    assert.equal(count(r, 'pending_actions'), before, `${c.name}: the owner was not asked`);
    assert.equal(r.s.app.runs.get(runId)!.ok, 1, c.name);
    const tools = toolMessages(r, conversation);
    assert.deepEqual(tools.map(m => m.gate), [{ by: 'guard', key: c.code }], c.name);
    assert.match(tools[0]!.content, /^Not allowed by beat: .*You were not asked$/u, c.name);
    if (c.code === 'shell_deny') assert.match(tools[0]!.content, /shell check .* refuses this command/u, c.name);
  }
  assert.equal(r.s.app.runtimeApprovals.size, 0);
  assert.equal(existsSync(root), true, 'the product folder is still there');

  const id = `req-ask-${++n}`;
  r.runtime.script = asking(r, [{ id, tool: 'Bash', input: { command: 'npm test' }, forReply: true }]);
  const { runId } = await start(r, projectId);
  await waitFor(() => runtimeRows(r).some(row => requestOf(row) === id), 'the ask-level command reached Pending');
  const view = r.s.app.pending.view(rowOf(r, id).id)!;
  assert.equal(view.status, 'waiting');
  assert.ok(view.checks.length > 0, 'the reasons beat found are on the card');
  assert.deepEqual(view.runtime, { id: 'claude-code', reply: false });
  assert.equal(answerOf(r, id), undefined);
  assert.equal((await reject(r, view.id)).status, 200);
  await settled(r.s.app, runId);
});
