import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { McpConnect } from '../src/mcp/manager.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, type Script, testConfig, withLoad, notSearch, offered } from './helpers.ts';

type Started = Awaited<ReturnType<typeof startApp>>;

const WORD = 'xyzzyquux';
const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const complete = call('task_complete', { summary: 'できた', notify: false });

function twoProviders(background: string[], more: (c: ReturnType<typeof testConfig>) => void = () => {}) {
  return {
    models: [fakeModel('loc'), fakeModel('loc2'), fakeModel('ext1', { provider: 'ext' }), fakeModel('ext2', { provider: 'ext' })],
    configure: (c: ReturnType<typeof testConfig>) => {
      c.providers.push({ id: 'ext', kind: 'openai_compatible', baseUrl: 'https://models.example.test/v1', maxParallel: 1, timeoutMs: 10_000 });
      c.routing = { chat: ['loc', 'loc2', 'ext1', 'ext2'], background, retriesPerModel: 0 };
      more(c);
    },
  };
}

function chatWith(s: Started, id: string, modelId: string | null, text: string): void {
  s.app.conversations.create({ id, title: `会話 ${id.slice(-2)}` });
  if (modelId) s.app.conversations.setChoice(id, { modelId });
  s.app.conversations.append(id, { role: 'user', content: text });
}

async function runIn(s: Started, id: string, modelId: string | null, scripts: Script[], adapterId: 'fake' | 'ext' = 'fake'): Promise<string> {
  if (!s.app.conversations.get(id)) s.app.conversations.create({ id, title: '会話' });
  if (modelId) s.app.conversations.setChoice(id, { modelId });
  s.adapters.get(adapterId)!.scripts = scripts;
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'お願い' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  await s.app.engine.wait(sent.body.runId);
  return s.app.conversations.messages(id).find(notSearch)?.text ?? '';
}

const taskRows = (s: Started) => s.app.tasks.list({ statuses: ['inbox', 'ready', 'running', 'waiting', 'scheduled', 'done', 'failed', 'cancelled'] });
const marks = (s: Started) => (s.app.db.prepare('SELECT local_only FROM tasks').all() as Array<{ local_only: number }>).map(r => r.local_only);

test('4-1 タスク: この PC のモデルを選んだ会話から作ったタスクは、裏方の順番どおり、ほかのモデルでも動く', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2']));
  await runIn(s, uuid(1), 'loc', [call('task_create', { title: 'この PC の会話のタスク', requested_by_user: true }), reply('作りました')]);
  assert.deepEqual(marks(s), [0]);
  s.adapter().calls.length = 0;
  s.adapters.get('ext')!.scripts = [complete];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.adapters.get('ext')!.calls.map(c => c.model.id), ['ext1']);
  assert.equal(s.adapter().calls.length, 0);
  assert.equal(taskRows(s).find(task => task.title === 'この PC の会話のタスク')!.status, 'done');
});

test('4-1 タスク: 前の印（tasks.local_only = 1）が残っているタスクも、裏方の順番どおりに動く。この PC のモデルが無くても待たない', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'ext2']));
  const task = s.app.tasks.create({ title: '前の印つき', origin: 'user', actor: 'user' });
  s.app.db.prepare('UPDATE tasks SET local_only = 1 WHERE id = ?').run(task.id);
  s.adapters.get('ext')!.scripts = [complete];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.adapters.get('ext')!.calls.map(c => c.model.id), ['ext1']);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('4-1 タスク: 会話の task_update・繰り返しの予定から作る実行・タスクが作る子のタスクに、印を付けない', async t => {
  const s = await startApp(t, twoProviders(['loc2']));
  const mine = s.app.tasks.create({ title: '前からあるタスク', origin: 'user', actor: 'user' });
  await runIn(s, uuid(1), 'loc', [call('task_update', { id: mine.id.slice(0, 8), priority: 1 }), call('file_list', {}), reply('ここまでやりました')]);
  assert.match(s.app.tasks.get(mine.id)!.body, /ここまでやりました/u);
  await runIn(s, uuid(2), 'loc', [call('task_create', { title: '毎朝', repeat: '0 9 * * *', requested_by_user: true }), reply('作りました')]);
  assert.ok(s.app.tasks.spawnNow(taskRows(s).find(task => task.title === '毎朝')!.id));
  assert.deepEqual(marks(s), [0, 0, 0]);
});

test('4-1 振り返り: この PC のモデルを選んだ会話も、消えたモデルを選んだ会話も、裏方の順番どおりに振り返る', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2']));
  chatWith(s, uuid(1), 'loc', 'この PC のモデルで話した内容');
  chatWith(s, uuid(2), 'removed-model', '消えたモデルで話した内容');
  s.adapters.get('ext')!.scripts = [reply('変更なし'), reply('変更なし')];
  s.app.reviews.enqueue('manual', `manual:${uuid(1)}`, { conversationId: uuid(1) });
  s.app.reviews.enqueue('manual', `manual:${uuid(2)}`, { conversationId: uuid(2) });
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'ran');
  const ext = s.adapters.get('ext')!.calls;
  assert.deepEqual(ext.map(c => c.model.id), ['ext1', 'ext1']);
  assert.equal(s.adapter().calls.length, 0);
  assert.match(ext.map(c => String(c.messages.at(-1)?.content)).join('\n'), /この PC のモデルで話した内容[\s\S]*消えたモデルで話した内容|消えたモデルで話した内容[\s\S]*この PC のモデルで話した内容/u);
  assert.deepEqual(s.app.reviews.list().map(j => j.status), ['done', 'done']);
});

test('4-1 履歴: ほかの提供元のモデルの実行からも、この PC のモデルを選んだ会話を検索でき、読める', async t => {
  const s = await startApp(t, twoProviders([]));
  chatWith(s, uuid(11), 'loc2', `この PC の会話 ${WORD} の話`);
  chatWith(s, uuid(12), null, `自動の会話 ${WORD} の話`);
  chatWith(s, uuid(13), 'removed-model', `消えたモデルの会話 ${WORD} の話`);
  const found = await runIn(s, uuid(20), 'ext1', [call('history_search', { query: WORD }), reply('おわり')], 'ext');
  assert.match(found, /この PC の会話/u);
  assert.match(found, /自動の会話/u);
  assert.match(found, /消えたモデルの会話/u);
  const read = await runIn(s, uuid(21), 'ext1', [call('history_read', { conversation_id: uuid(11) }), reply('おわり')], 'ext');
  assert.match(read, /この PC の会話/u);
});

test('4-1 MCP: 登録した道具は、会話で選んだモデルに関わらず同じ一覧で渡り、呼べば動く', async t => {
  const called: string[] = [];
  const connect: McpConnect = async () => ({
    caller: { callTool: async () => { called.push('echo'); return { content: [{ type: 'text', text: 'pong' }] }; } },
    list: async () => [{ name: 'echo', description: '文字を返す', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    close: async () => {},
    stderr: () => '',
  });
  const s = await startApp(t, { ...twoProviders([], c => { c.mcp = { servers: [{ id: 'srv', transport: 'stdio', command: ['node', 'x.mjs'], tools: { echo: { effect: 'read', sends: false } } }] } as unknown as typeof c.mcp; }), env: {}, mcpConnect: connect });
  await s.app.mcp.start();
  assert.ok(s.app.tools.get('mcp_srv_echo'));
  const local = await runIn(s, uuid(1), 'loc', [call('mcp_srv_echo', { text: 'a' }), reply('おわり')]);
  const outside = await runIn(s, uuid(2), 'ext1', [call('mcp_srv_echo', { text: 'a' }), reply('おわり')], 'ext');
  const names = (id: 'fake' | 'ext') => offered(s.adapters.get(id)!.calls[0]!).sort();
  assert.ok(names('fake').includes('mcp_srv_echo'));
  assert.deepEqual(names('fake'), names('ext'));
  assert.match(local, /pong/u);
  assert.equal(local, outside);
  assert.deepEqual(called, ['echo', 'echo']);
});

test('4-1 知らせ: この PC のモデルを選んだ会話から作ったタスクの知らせは、外の送り先へ題・本文・リンクのまま出る', async t => {
  const sent: string[] = [];
  const s = await startApp(t, {
    ...twoProviders(['loc2'], c => {
      c.notify = { publicBaseUrl: 'https://beat.example.ts.net', channels: [{ id: 'phone', kind: 'webhook', urlEnv: 'BEAT_NOTIFY_PHONE_URL_SECRET', kinds: ['task_done'], includeBody: true }] } as unknown as typeof c.notify;
    }),
    env: { BEAT_NOTIFY_PHONE_URL_SECRET: 'https://hooks.example.test/in' },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  await runIn(s, uuid(1), 'loc', [call('task_create', { title: 'この PC の会話のタスク', requested_by_user: true }), reply('作りました')]);
  s.adapter().scripts = [call('task_complete', { summary: '結果の本文', notify: true })];
  assert.equal(await s.app.worker.tick(), 'ran');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]!) as { title: string; body: string; link: string };
  assert.match(payload.title, /この PC の会話のタスク/u);
  assert.equal(payload.body, '結果の本文');
  assert.match(payload.link, /^https:\/\/beat\.example\.ts\.net\/#\/tasks\//u);
});

test('4-1 知らせ: スキルの下書きの知らせは、種類 info の外の送り先へ、ほかの知らせと同じに出る', async t => {
  const sent: string[] = [];
  const s = await startApp(t, {
    ...twoProviders([], c => {
      c.notify = { channels: [{ id: 'phone', kind: 'webhook', urlEnv: 'BEAT_NOTIFY_PHONE_URL_SECRET', kinds: ['info'], includeBody: true }] } as unknown as typeof c.notify;
    }),
    env: { BEAT_NOTIFY_PHONE_URL_SECRET: 'https://hooks.example.test/in' },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  s.app.skills.onDraft!({ id: 7, name: 'weekly-report', description: 'd', body: 'b', reason: '毎週まとめるため', change_summary: null, status: 'pending', conversation_id: null, run_id: null, created_at: 0, decided_at: null });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]!) as { kind: string; title: string; body: string };
  assert.equal(payload.kind, 'info');
  assert.match(payload.title, /weekly-report/u);
  assert.equal(payload.body, '毎週まとめるため');
});
