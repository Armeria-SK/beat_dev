import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { Worker } from '../src/tasks/worker.ts';
import type { RunKind, TaskControl, ToolContext, ToolDef, ToolRunResult } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, withLoad } from './helpers.ts';

const hiddenProbe: ToolDef = {
  name: 'probe_hidden', description: 'Test tool: given to no run.', input: Type.Object({}, { additionalProperties: false }), effect: 'read', allowedIn: [],
  async execute() { return { content: 'hidden tool ran' }; },
};
const emptyNames = (tools: readonly ToolDef[]) => tools.filter(tool => tool.allowedIn.length === 0).map(tool => tool.name);
const KINDS: readonly RunKind[] = ['chat', 'task', 'review', 'agent'];
const FIXED = Date.parse('2026-11-14T03:00:00Z');

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

type Options = NonNullable<Parameters<typeof startApp>[1]>;

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(), ...options });
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string; name: string; root: string };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  const task = async (body: Record<string, unknown>) => {
    const made = await s.json('/api/tasks', 'POST', { when: new Date(s.app.now() - 1000).toISOString(), ...body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.task.id as string;
  };
  const calls = (runId: string) => s.app.db.prepare("SELECT tool, decision, decided_by, ok, output_preview FROM tool_calls WHERE run_id = ? AND tool != 'tool_search' ORDER BY rowid").all(runId)
    .map(r => ({ ...r })) as Array<{ tool: string; decision: string; decided_by: string; ok: number; output_preview: string }>;
  const lastRun = (taskId: string) => (s.app.db.prepare("SELECT run_id FROM task_events WHERE task_id = ? AND kind = 'run' ORDER BY id DESC LIMIT 1").get(taskId) as { run_id: string }).run_id;
  return { ...s, products, product, send, task, calls, lastRun };
}

async function requestsOf(t: Parameters<typeof startApp>[0], tools: ToolDef[]) {
  const s = await setup(t, { tools, now: () => FIXED, configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b'), reply('c'), reply('d')];
  await s.send(uuid(1), { text: 'hi', permissionMode: 'auto' });
  await s.send(uuid(2), { text: 'hi', permissionMode: 'plan' });
  await s.send(uuid(3), { text: 'do it', projectId: shop.id, permissionMode: 'auto' });
  await s.send(uuid(4), { text: 'plan it', projectId: shop.id, permissionMode: 'plan' });
  s.adapter().scripts = [call('agent_run', { task: 'look' }), reply('child'), reply('parent')];
  await s.send(uuid(5), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  await s.task({ title: 'Tidy', projectId: shop.id });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  await s.task({ title: 'Loose' });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  s.app.engine.lastUserActivity = 0;
  s.app.reviews.enqueue('manual', 'manual:seam', { conversationId: uuid(1), kind: 'skill' });
  s.adapter().scripts = [reply('No changes')];
  assert.equal(await s.app.worker.tick(), 'ran');
  const local = [s.products, s.app.paths.data, shop.id].flatMap(text => [text, text.replaceAll('\\', '/'), text.replaceAll('\\', '\\\\')]);
  const plain = (text: string) => local.reduce((out, part) => out.replaceAll(part, '<local>'), text).replace(/[0-9a-f]{16}/gu, '<nonce>');
  const requests = s.adapter().calls.map(req => ({ frozen: plain(req.system.frozen), dynamic: plain(req.system.dynamic), tools: plain(JSON.stringify(req.tools)) }));
  const offered = new Set(s.adapter().calls.flatMap(req => req.tools.map(tool => tool.name)));
  return { requests, offered };
}

test('5-0 頼みは変わらない: 会話・計画・製品の会話・子の担当・タスク・振り返りのモデルへの頼み（system と道具）は、allowedIn が空の道具を登録しても 1 文字も変わらず、空の道具はどの頼みにも入らない', async t => {
  const all = [...builtinTools(), hiddenProbe];
  const before = await requestsOf(t, all.filter(tool => tool.allowedIn.length > 0));
  const after = await requestsOf(t, all);
  assert.equal(after.requests.length, 10);
  assert.deepEqual(after.requests, before.requests);
  assert.ok(emptyNames(all).includes('probe_hidden'));
  for (const name of emptyNames(all)) assert.ok(!after.offered.has(name), name);
  assert.ok(after.offered.has('task_complete') && after.offered.has('plan_write'));
});

test('5-0 allowedIn が空の道具: どの種類の実行にも渡らず、道具の一覧の口に出ず、モデルが名前を呼んでも断られて動かない。組み込みのうちまだ空の道具は、じかに動かしても「まだ使えない」の誤りを返す', async t => {
  const all = [...builtinTools(), hiddenProbe];
  const s = await setup(t, { tools: all });
  const hidden = emptyNames(all);
  assert.ok(hidden.includes('probe_hidden'));
  const skeletons = builtinTools().filter(def => def.allowedIn.length === 0 && !def.name.startsWith('curiosity_'));
  for (const tool of skeletons) {
    const out = await tool.execute({}, { config: s.app.config() } as ToolContext);
    assert.equal(out.isError, true, tool.name);
    assert.match(out.content, /not available yet/u, tool.name);
  }
  for (const kind of KINDS) assert.deepEqual(s.app.tools.forRun(kind).map(tool => tool.name).filter(name => hidden.includes(name)), [], kind);
  const listed = ((await s.json('/api/tools', 'GET')).body.tools as Array<{ name: string }>).map(tool => tool.name);
  assert.ok(listed.includes('shell_run'));
  assert.deepEqual(listed.filter(name => hidden.includes(name)), []);

  const id = await s.task({ title: 'Call the skeleton tools' });
  s.adapter().scripts = [...hidden.map(name => call(name, {})), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const rows = s.calls(s.lastRun(id)).filter(row => hidden.includes(row.tool));
  assert.deepEqual(rows.map(row => [row.tool, row.decision, row.decided_by, row.ok]), hidden.map(name => [name, 'deny', 'registry', 0]));
  assert.ok(!rows.some(row => row.output_preview.includes('hidden tool ran')));
});

const probeRun: ToolDef<{ tool: string; input: Record<string, unknown> }> = {
  name: 'probe_run',
  description: 'Test tool: starts another tool from code.',
  input: Type.Object({ tool: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'agent'],
  async execute(input, ctx) {
    if (!ctx.runTool) return { content: 'no runTool here', isError: true };
    const out = await ctx.runTool(input.tool, input.input);
    return { content: `inner ${out.output.isError ? 'error' : 'ok'} [${out.decision}/${out.decidedBy}/${out.gate?.by ?? '-'}]: ${out.output.content}` };
  },
};

test('5-0 ctx.runTool: タスクの実行の道具がコードから別の道具を呼ぶと、モデルが呼んだときと同じ判定になり、道具の記録が 1 行できる。断られる命令は断られ、どの実行にも渡らない道具は呼べず、入れ子は 1 段まで。会話と子の担当には口が無い', async t => {
  const s = await setup(t, { tools: [...builtinTools(), probeRun, hiddenProbe], configure: c => { c.tools.agent.enabled = true; c.tools.agent.inTasks = true; c.tools.policies = { agent_run: 'allow' }; } });
  const guarded = join(s.app.paths.projects, 'x', 'plan.md').replaceAll('\\', '/');
  const plain = { command: 'echo seam-ok' };
  const refused = { command: `cat "${guarded}"` };

  const id = await s.task({ title: 'Probe' });
  s.adapter().scripts = [
    call('shell_run', plain), call('probe_run', { tool: 'shell_run', input: plain }),
    call('shell_run', refused), call('probe_run', { tool: 'shell_run', input: refused }),
    call('probe_run', { tool: 'probe_hidden', input: {} }),
    call('probe_run', { tool: 'probe_run', input: { tool: 'shell_run', input: plain } }),
    call('probe_run', { tool: 'no_such_tool', input: {} }),
    call('task_complete', { summary: 'done' }),
  ];
  assert.equal(await s.app.worker.tick(), 'ran');
  const runId = s.lastRun(id);
  const rows = s.calls(runId);
  const verdict = (row: (typeof rows)[number]) => [row.tool, row.decision, row.decided_by, row.ok];
  assert.deepEqual(rows.map(row => row.tool), [
    'shell_run', 'shell_run', 'probe_run', 'shell_run', 'shell_run', 'probe_run', 'probe_hidden', 'probe_run', 'probe_run', 'probe_run', 'no_such_tool', 'probe_run', 'task_complete',
  ]);
  assert.deepEqual(verdict(rows[1]!), verdict(rows[0]!));
  assert.deepEqual(verdict(rows[0]!), ['shell_run', 'allow', rows[0]!.decided_by, 1]);
  assert.match(rows[1]!.output_preview, /seam-ok/u);
  assert.ok(rows[2]!.output_preview.startsWith(`inner ok [allow/${rows[0]!.decided_by}/-]: `), rows[2]!.output_preview);
  assert.match(rows[2]!.output_preview, /seam-ok/u);
  assert.deepEqual(verdict(rows[4]!), verdict(rows[3]!));
  assert.equal(rows[3]!.decision, 'deny');
  assert.ok(rows[5]!.output_preview.startsWith(`inner error [deny/${rows[3]!.decided_by}/-]: `), rows[5]!.output_preview);
  assert.deepEqual(verdict(rows[6]!), ['probe_hidden', 'deny', 'registry', 0]);
  assert.ok(rows[7]!.output_preview.startsWith('inner error [deny/registry/-]: '), rows[7]!.output_preview);
  assert.ok(rows[8]!.output_preview.startsWith('inner error [deny/run_tool/-]: A tool started by another tool cannot start one more'), rows[8]!.output_preview);
  assert.match(rows[9]!.output_preview, /^inner ok \[allow\/[^\]]+\/-\]: inner error \[deny\/run_tool\/-\]: A tool started by another tool/u);
  assert.deepEqual(verdict(rows[10]!), ['no_such_tool', 'deny', 'registry', 0]);
  assert.equal((s.app.db.prepare('SELECT tool_calls FROM engine_runs WHERE id = ?').get(runId) as { tool_calls: number }).tool_calls, 14);
  assert.equal(s.app.tasks.get(id)!.status, 'done');

  s.adapter().scripts = [call('probe_run', { tool: 'shell_run', input: plain }), reply('ok')];
  await s.send(uuid(1), { text: 'probe', permissionMode: 'auto' });
  const chatRun = (s.app.db.prepare('SELECT id FROM engine_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1').get(uuid(1)) as { id: string }).id;
  assert.deepEqual(s.calls(chatRun).map(row => [row.tool, row.output_preview]), [['probe_run', 'no runTool here']]);

  const parent = await s.task({ title: 'Delegate the probe' });
  s.adapter().scripts = [call('agent_run', { task: 'probe' }), call('probe_run', { tool: 'shell_run', input: plain }), reply('child done'), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const childRun = (s.app.db.prepare('SELECT id FROM engine_runs WHERE parent_run_id = ?').get(s.lastRun(parent)) as { id: string }).id;
  assert.deepEqual(s.calls(childRun).map(row => [row.tool, row.output_preview]), [['probe_run', 'no runTool here']]);
});

test('5-0 ctx.runTool の返り: Pending に積まれた呼び出しは ask / pending と積んだ番号を、判定役が通した呼び出しは allow / auto-mode と判定役の理由を、文を読まずに返りの値で見分けられる', async t => {
  const seen: ToolRunResult[] = [];
  const probeSeen: ToolDef<{ tool: string; input: Record<string, unknown> }> = {
    ...probeRun, name: 'probe_seen',
    async execute(input, ctx) { seen.push(await ctx.runTool!(input.tool, input.input)); return { content: 'looked' }; },
  };
  const s = await setup(t, { tools: [...builtinTools(), probeSeen], judge: '{"decision":"allow","reason":"within the request"}', configure: c => { c.tools.policies = { file_write: 'ask' }; } });
  const outside = join(s.app.paths.data, 'outside.txt');
  writeFileSync(outside, 'outside-note');
  const id = await s.task({ title: 'Read the outside note and write a file' });
  s.adapter().scripts = [
    call('probe_seen', { tool: 'file_write', input: { path: 'parked.md', content: '1' } }),
    call('probe_seen', { tool: 'shell_run', input: { command: process.platform === 'win32' ? `Get-Content "${outside}"` : `cat "${outside}"` } }),
    call('task_complete', { summary: 'done' }),
  ];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(seen.length, 2);
  const [parked, judged] = seen as [ToolRunResult, ToolRunResult];
  const waiting = s.app.pending.list({ status: 'waiting' });
  assert.equal(waiting.length, 1);
  assert.deepEqual([parked.decision, parked.decidedBy, parked.gate], ['ask', 'pending', { by: 'pending', id: waiting[0]!.id }]);
  assert.equal(parked.output.isError, undefined);
  assert.equal(existsSync(join(s.app.paths.workspace, 'parked.md')), false);
  assert.deepEqual([judged.decision, judged.decidedBy, judged.gate], ['allow', 'auto-mode', { by: 'judge', reason: 'within the request' }]);
  assert.match(judged.output.content, /outside-note/u);
  const rows = s.calls(s.lastRun(id)).filter(row => row.tool === 'file_write' || row.tool === 'shell_run');
  assert.deepEqual(rows.map(row => [row.tool, row.decision, row.decided_by]), [['file_write', parked.decision, parked.decidedBy], ['shell_run', judged.decision, judged.decidedBy]]);
});

test('5-0 EngineResult.workDone: 成功した実行の結果に、実際に動いた task_ で始まらない道具の呼び出しの数が載る（コードから呼んだ分も数える）', async t => {
  const s = await setup(t, { tools: [...builtinTools(), probeRun] });
  const run = async (scripts: Script[]) => {
    const id = await s.task({ title: 'Count' });
    const conversation = s.app.conversations.create({ kind: 'task', title: 'Count' });
    s.adapter().scripts = scripts;
    const started = s.app.engine.runTask(s.app.tasks.get(id)!, conversation.id, 'work');
    assert.ok(started.ok);
    const result = await started.done;
    assert.ok(result.ok);
    return result.workDone;
  };
  assert.equal(await run([call('task_complete', { summary: 'done' })]), 0);
  assert.equal(await run([call('calculate', { expression: '1+1' }), call('file_list', { path: '.' }), call('task_complete', { summary: 'done' })]), 2);
  assert.equal(await run([call('probe_run', { tool: 'file_list', input: { path: '.' } }), call('task_complete', { summary: 'done' })]), 2);
  assert.equal(await run([call('probe_run', { tool: 'calculate', input: { expression: '1+1' } }), call('task_complete', { summary: 'done' })]), 1, 'コードから呼んで断られた分（decision が deny）は数えない');
});

test('5-0 知らせの製品: notify に渡した projectId が notifications.project_id に入り、渡さなければ NULL。ワーカーのタスクの知らせは、そのタスクの製品を持つ', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const column = (id: number) => (s.app.db.prepare('SELECT project_id FROM notifications WHERE id = ?').get(id) as { project_id: string | null }).project_id;
  assert.equal(column(s.app.notifications.notify({ kind: 'info', title: 'with', projectId: shop.id })!.id), shop.id);
  assert.equal(column(s.app.notifications.notify({ kind: 'info', title: 'without' })!.id), null);

  const inProduct = await s.task({ title: 'In the product', projectId: shop.id });
  const loose = await s.task({ title: 'Loose' });
  s.adapter().scripts = [call('task_complete', { summary: 'done' }), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'ran');
  const done = s.app.db.prepare("SELECT link, project_id FROM notifications WHERE kind = 'task_done' ORDER BY id").all().map(r => ({ ...r }));
  assert.deepEqual(done.sort((a, b) => String(a.link).localeCompare(String(b.link))), [{ link: `#/tasks/${inProduct}`, project_id: shop.id }, { link: `#/tasks/${loose}`, project_id: null }].sort((a, b) => a.link.localeCompare(b.link)));
});

test('5-0 見回りの口: ワーカーは見回りのたびに pendingWake を 1 回呼ぶ。App のワーカーは口を持ち、何も変えない', async t => {
  const s = await setup(t);
  let swept = 0;
  const worker = new Worker({
    db: s.app.db, tasks: s.app.tasks, engine: s.app.engine, conversations: s.app.conversations, notifications: s.app.notifications, kv: s.app.kv,
    config: () => s.app.config(), log: () => undefined, autoSchedule: false, pendingWake: () => { swept += 1; },
  });
  assert.equal(await worker.tick(), 'idle');
  assert.equal(await worker.tick(), 'idle');
  assert.equal(swept, 2);
  assert.equal(await s.app.worker.tick(), 'idle');
});

test('5-0 型の骨組み: TaskControl に yield と failed、出来事に question.changed がある（まだだれも出さない）', async t => {
  const s = await setup(t);
  const controls: TaskControl[] = [{ outcome: 'yield', reason: 'children left' }, { outcome: 'failed', reason: 'check failed' }];
  assert.deepEqual(controls.map(control => control.outcome), ['yield', 'failed']);
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(entry => seen.push(entry.event));
  const event: RunEvent = { type: 'question.changed', id: 1, projectId: null, status: 'open' };
  s.app.bus.publish(event);
  assert.deepEqual(seen, [event]);
  const id = await s.task({ title: 'Plain' });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.ok(!seen.some(e => e.type === 'question.changed' && e !== event));
});

test('5-0 services.questions: 会話とタスクの道具に、App の質問票の store が渡る', async t => {
  const seen: unknown[] = [];
  const probeServices: ToolDef = {
    name: 'probe_services', description: 'Test tool: looks at the services.', input: Type.Object({}, { additionalProperties: false }), effect: 'read', allowedIn: ['chat', 'task'],
    async execute(_input, ctx) { seen.push(ctx.services?.questions); return { content: 'looked' }; },
  };
  const s = await setup(t, { tools: [...builtinTools(), probeServices] });
  s.adapter().scripts = [call('probe_services', {}), reply('ok')];
  await s.send(uuid(1), { text: 'look', permissionMode: 'auto' });
  await s.task({ title: 'Look' });
  s.adapter().scripts = [call('probe_services', {}), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(seen.length, 2);
  assert.ok(seen.every(store => store === s.app.questions));
});
