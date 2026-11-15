import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, withLoad } from './helpers.ts';

const CURIOSITY_TOOLS = ['curiosity_add', 'curiosity_list', 'curiosity_update'];
const MARK = 'MARK-7-4C-CURIOSITY-FILE';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function setup(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, {
    models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(),
    configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; },
  });
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string };
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
  const items = () => (s.app.db.prepare('SELECT COUNT(*) AS n FROM curiosity_items').get() as { n: number }).n;
  return { ...s, product, send, task, items };
}

test('7-4c 好奇心の道具はどの実行にも渡らない: 会話・計画・製品の会話・製品の計画・タスク・振り返りの頼みに curiosity_* が無く、system に CURIOSITY.md の中身も curiosity の語も無い（子の担当〔agent_run〕と CURIOSITY.md の目印は、変更の前から通る見張りだけ）', async t => {
  const s = await setup(t);
  writeFileSync(join(s.app.paths.workspace, 'CURIOSITY.md'), `# CURIOSITY\n\n- ${MARK}\n`);
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
  s.app.reviews.enqueue('manual', 'manual:off', { conversationId: uuid(1), kind: 'skill' });
  s.adapter().scripts = [reply('No changes')];
  assert.equal(await s.app.worker.tick(), 'ran');

  const requests = s.adapter().calls;
  assert.equal(requests.length, 10);
  for (const [i, request] of requests.entries()) {
    const names = request.tools.map(tool => tool.name);
    assert.deepEqual(names.filter(name => name.startsWith('curiosity_')), [], `${i}: ${names.join()}`);
    const system = `${request.system.frozen}\n${request.system.dynamic}`;
    assert.ok(!system.includes(MARK), `${i}: CURIOSITY.md`);
    assert.doesNotMatch(system, /curiosity/iu, `${i}: system`);
  }
  const review = requests.at(-1)!;
  assert.match(String(review.messages.at(-1)?.content), /\[Review\]/u);
  assert.doesNotMatch(String(review.messages.at(-1)?.content), /curiosity/iu, '振り返りの文');
  for (const kind of ['chat', 'task', 'review', 'agent'] as const) {
    assert.deepEqual(s.app.tools.forRun(kind).map(tool => tool.name).filter(name => name.startsWith('curiosity_')), [], kind);
  }
});

test('7-4c 好奇心の道具を名前で呼んでも registry が断り、好奇心の行は増えも変わりもしない（会話とタスク）', async t => {
  const s = await setup(t);
  const item = s.app.curiosity.add({ topic: 'Kept topic', source: 'user' });
  const tries = [call('curiosity_add', { topic: 'New topic' }), call('curiosity_list', {}), call('curiosity_update', { id: item.id, status: 'done', result: 'x' })];
  s.adapter().scripts = [...tries, reply('ok')];
  await s.send(uuid(1), { text: 'hi', permissionMode: 'auto' });
  const id = await s.task({ title: 'Try curiosity' });
  s.adapter().scripts = [...tries, call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const rows = (s.app.db.prepare("SELECT tool, decision, decided_by, ok, conversation_id FROM tool_calls WHERE tool LIKE 'curiosity_%' ORDER BY rowid").all() as Array<Record<string, unknown>>).map(r => [r.tool, r.decision, r.decided_by, r.ok]);
  assert.deepEqual(rows, [...CURIOSITY_TOOLS, ...CURIOSITY_TOOLS].map(name => [name, 'deny', 'registry', 0]));
  assert.equal(s.items(), 1);
  assert.deepEqual({ ...s.app.curiosity.get(item.id)! }, { ...item });
  assert.ok(s.app.tasks.get(id));
});

test('7-4c 止めても残すもの: 道具の登録・表と列・CURIOSITY.md のひな形・設定の鍵 curiosityPerDay', async t => {
  const s = await setup(t);
  const names = builtinTools().map(tool => tool.name);
  for (const name of CURIOSITY_TOOLS) assert.ok(names.includes(name), name);
  for (const tool of builtinTools().filter(def => CURIOSITY_TOOLS.includes(def.name))) assert.deepEqual([...tool.allowedIn], [], tool.name);
  const columns = (table: string) => (s.app.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(r => r.name);
  assert.ok(columns('curiosity_items').includes('topic'));
  assert.ok(columns('tasks').includes('curiosity_id'));
  assert.ok(existsSync(join(s.app.paths.templates, 'CURIOSITY.md')));
  assert.equal(defaultConfig().worker.curiosityPerDay, 2);
  assert.equal(typeof s.app.config().worker.curiosityPerDay, 'number');
});
