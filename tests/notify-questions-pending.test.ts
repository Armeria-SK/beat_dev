import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig, defaultConfig } from '../src/config/store.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { DEFAULT_NOTIFY_KINDS, NOTIFICATION_KINDS } from '../src/config/schema.ts';
import { NotifyChannels } from '../src/notify/channels.ts';
import type { NotificationKind, NotifyEvent } from '../src/notify/notifications.ts';
import { actionOf, arrangeNotifications, BLOCKING_QUESTION_KEY, isPinned } from '../src/shared/notification-list.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import type { KV } from '../src/db/kv.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { startApp } from './app-setup.ts';
import type { Script } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: Parameters<typeof startApp>[0]) {
  const s = await startApp(t);
  const project = (name: string) => {
    const root = join(s.paths.data, 'work', name);
    mkdirSync(root, { recursive: true });
    return s.app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand: null });
  };
  const rows = (kind: string) => s.app.db.prepare('SELECT * FROM notifications WHERE kind = ? ORDER BY id').all(kind) as Array<{ id: number; project_id: string | null; read_at: number | null; link: string | null; title: string; body: string | null; dedup_key: string | null }>;
  const sse: Array<Record<string, unknown>> = [];
  s.app.bus.subscribe(entry => { if (entry.event.type === 'notification') sse.push(entry.event.notification as unknown as Record<string, unknown>); });
  return { ...s, project, rows, sse };
}

test('5-4-s 質問ができると question_new が製品つきで 1 つ出て、答えると既読になる。同じ質問で 2 つ出ない', async t => {
  const s = await setup(t);
  const p = s.project('uploader');
  const q = s.app.questions.add({ projectId: p.id, question: 'How many retries?', options: ['3', '5'], chosen: 0 });
  const first = s.rows('question_new');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.project_id, p.id);
  assert.equal(first[0]!.read_at, null);
  assert.equal(first[0]!.link, `#/questions/${p.id}`);
  assert.equal(first[0]!.body, 'How many retries?');
  const event = s.sse.find(n => n.kind === 'question_new')!;
  assert.equal(event.project_id, p.id);
  assert.equal(event.action, 'questions');
  s.app.questions.answer(q.id, { choice: 1 });
  s.app.questions.answer(q.id, { choice: 1 });
  const after = s.rows('question_new');
  assert.equal(after.length, 1, '同じ質問で 2 つ出ない');
  assert.notEqual(after[0]!.read_at, null, '答えたら既読');
  const res = await s.json('/api/notifications', 'GET');
  const listed = (res.body.notifications as Array<{ kind: string; project_id: string | null; action: string | null }>).find(n => n.kind === 'question_new')!;
  assert.equal(listed.project_id, p.id, '一覧の口も、持っている製品の欄を返す');
  assert.equal(listed.action, 'questions');
});

test('5-4-s 急ぐ（blocking）質問の知らせだけ、未読のあいだ先頭に固定される', async t => {
  const s = await setup(t);
  const p = s.project('pinned');
  const task = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: p.id });
  const blocking = s.app.questions.add({ projectId: p.id, taskId: task.id, question: 'Which database?', options: ['sqlite', 'postgres'], blocking: true });
  s.app.questions.add({ projectId: p.id, question: 'Light or dark?', options: ['light', 'dark'], chosen: 0 });
  for (let i = 0; i < 60; i++) s.app.notifications.notify({ kind: 'info', title: `info ${i}` });
  const list = s.app.notifications.list();
  assert.equal(list[0]!.kind, 'question_new');
  assert.equal(list[0]!.body, 'Which database?');
  assert.equal(list[0]!.title, 'I have a question: Build', '急ぐ質問の題は、前の task_waiting と同じくタスクの題を持つ');
  assert.equal(list.find(n => n.body === 'Light or dark?'), undefined);
  assert.equal(s.rows('question_new').find(r => r.body === 'Light or dark?')!.title, 'Question recorded');
  assert.equal(list.filter(n => n.kind === 'question_new').length, 1, '急がない質問は件数の上限で押し出される');
  assert.ok(list[0]!.dedup_key?.startsWith(BLOCKING_QUESTION_KEY));
  s.app.questions.answer(blocking.id, { choice: 0 });
  assert.ok(!s.app.notifications.list().some(n => n.kind === 'question_new'), '答えたら固定が外れる');
});

test('5-4-s Pending に積むと approval_needed が製品つき・行き先 pending で出て、決めると既読になる', async t => {
  const s = await setup(t);
  const p = s.project('parked');
  const task = s.app.tasks.create({ title: 'Ship it', origin: 'user', actor: 'user', projectId: p.id });
  const conversation = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(task.id, 30 * 60_000, conversation.id));
  const parked = await s.app.pending.park({ tool: 'file_write', input: { path: 'x', content: 'y' }, cwd: s.app.paths.data, kind: 'judge', reason: 'r', check: { decision: 'ask', reasons: ['r'] }, runId: 'r', runKind: 'task', conversationId: conversation.id, taskId: task.id });
  const rows = s.rows('approval_needed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.project_id, p.id);
  assert.equal(rows[0]!.link, `#/pending/${p.id}`);
  assert.equal(s.sse.find(n => n.kind === 'approval_needed')!.action, 'pending');
  const res = await s.json('/api/notifications', 'GET');
  const listed = (res.body.notifications as Array<{ kind: string; project_id: string | null; action: string | null }>).find(n => n.kind === 'approval_needed')!;
  assert.equal(listed.project_id, p.id);
  assert.equal(listed.action, 'pending');
  s.app.pending.reject(parked.id);
  assert.notEqual(s.rows('approval_needed')[0]!.read_at, null, '決めたら既読');
});

test('5-4-s タスクの終わり・失敗は持っている製品の欄を一覧で返し、行き先は kanban / retry', async t => {
  const s = await setup(t);
  const p = s.project('done');
  s.app.notifications.notify({ kind: 'task_done', title: 'done', link: '#/tasks/none', projectId: p.id });
  s.app.notifications.notify({ kind: 'task_failed', title: 'failed', link: '#/tasks/none', projectId: p.id });
  const res = await s.json('/api/notifications', 'GET');
  const list = res.body.notifications as Array<{ kind: string; project_id: string | null; action: string | null }>;
  assert.deepEqual(list.map(n => [n.kind, n.project_id, n.action]).sort(), [['task_done', p.id, 'kanban'], ['task_failed', p.id, 'retry']]);
});

test('5-4-s 古い行（project_id が NULL）で一覧が落ちず、リンクから製品を読む', async t => {
  const s = await setup(t);
  const p = s.project('legacy');
  const task = s.app.tasks.create({ title: 'Old', origin: 'user', actor: 'user', projectId: p.id });
  s.app.db.prepare('INSERT INTO notifications (kind, title, link, created_at, project_id) VALUES (?, ?, ?, ?, NULL)').run('task_done', 'old', `#/tasks/${task.id}`, 1);
  s.app.db.prepare('INSERT INTO notifications (kind, title, link, created_at, project_id) VALUES (?, ?, ?, ?, NULL)').run('info', 'older', null, 1);
  s.app.db.prepare('INSERT INTO notifications (kind, title, link, created_at, project_id) VALUES (?, ?, ?, ?, NULL)').run('some_future_kind', 'unknown', null, 1);
  const res = await s.json('/api/notifications', 'GET');
  assert.equal(res.status, 200);
  const list = res.body.notifications as Array<{ title: string; project_id: string | null; action: string | null }>;
  assert.deepEqual(list.map(n => [n.title, n.project_id, n.action]), [['unknown', null, null], ['older', null, null], ['old', p.id, 'kanban']]);
});

test('5-4-s 起動の掃除: もう答えた質問の未読の知らせは既読にし、まだ Open の質問のものは残す', async t => {
  const s = await setup(t);
  const open = s.app.questions.add({ question: 'Still open?', options: ['a', 'b'], chosen: 0 });
  const gone = s.app.questions.add({ question: 'Answered?', options: ['a', 'b'], chosen: 0 });
  s.app.db.prepare("UPDATE questions SET status = 'answered' WHERE id = ?").run(gone.id);
  s.app.settleStaleNotifications();
  const rows = s.rows('question_new');
  assert.equal(rows.find(r => r.dedup_key === `question:${open.id}`)!.read_at, null);
  assert.notEqual(rows.find(r => r.body === 'Answered?')!.read_at, null);
});

test('5-4-s 行き先は種類から決まり、知らない種類は null', () => {
  assert.equal(actionOf('approval_needed'), 'pending');
  assert.equal(actionOf('question_new'), 'questions');
  assert.equal(actionOf('task_waiting'), null);
  assert.equal(actionOf('task_done'), 'kanban');
  assert.equal(actionOf('task_failed'), 'retry');
  assert.equal(actionOf('info'), null);
  assert.equal(actionOf('health_alert'), null);
  assert.equal(actionOf('toString'), null);
  assert.ok(isPinned({ id: 1, kind: 'question_new', read_at: null, dedup_key: `${BLOCKING_QUESTION_KEY}1` }));
  assert.ok(!isPinned({ id: 1, kind: 'question_new', read_at: null, dedup_key: 'question:1' }));
  assert.ok(!isPinned({ id: 1, kind: 'question_new', read_at: 5, dedup_key: `${BLOCKING_QUESTION_KEY}1` }));
  assert.deepEqual(arrangeNotifications([{ id: 2, kind: 'info', read_at: null }, { id: 1, kind: 'question_new', read_at: null, dedup_key: `${BLOCKING_QUESTION_KEY}1` }], 1).map(n => n.id), [1, 2]);
});

const URL_ENV = 'BEAT_NOTIFY_PHONE_URL_SECRET';
const memoryKv = (): KV => { const m = new Map<string, unknown>(); return { getJson: (k: string) => m.get(k), setJson: (k: string, v: unknown) => { m.set(k, v); } } as unknown as KV; };
function channelConfig(kinds?: readonly string[]): AppConfig {
  const raw = JSON.parse(JSON.stringify(defaultConfig()));
  raw.notify = { channels: [{ id: 'phone', kind: 'webhook', urlEnv: URL_ENV, includeBody: true, ...(kinds ? { kinds } : {}) }] };
  return parseConfig(raw);
}
function channels(config: AppConfig) {
  const sent: string[] = [];
  const c = new NotifyChannels({
    config: () => config, env: { [URL_ENV]: 'https://hooks.example.com/x' }, now: () => 1_000, log: () => {}, kv: memoryKv(), alert: () => {},
    fetch: async (_url, init) => { sent.push(String(init?.body)); return new Response(null, { status: 204 }); },
    secrets: () => [],
  });
  return { c, sent };
}
const ev = (kind: NotificationKind, over: Partial<NotifyEvent> = {}): NotifyEvent => ({ id: 1, kind, title: 'Question recorded', body: 'b', link: '#/questions', dedup_key: null, read_at: null, created_at: 0, project_id: null, action: actionOf(kind), ...over });

test('5-4-s 外の送り先: 新しい種類 question_new は既定では送らず、kinds に足せば送る。題・本文は伏せる', async () => {
  assert.ok((NOTIFICATION_KINDS as readonly string[]).includes('question_new'));
  assert.ok(!(DEFAULT_NOTIFY_KINDS as readonly string[]).includes('question_new'));
  const byDefault = channels(channelConfig());
  await byDefault.c.deliver(ev('question_new'));
  assert.equal(byDefault.sent.length, 0, '既定の kinds では送らない');
  const added = channels(channelConfig([...DEFAULT_NOTIFY_KINDS, 'question_new']));
  const key = 'sk-ant-test-0000000000000000';
  await added.c.deliver(ev('question_new', { title: `T ${key}`, body: `B ${key}` }));
  assert.equal(added.sent.length, 1);
  assert.ok(!added.sent[0]!.includes(key), added.sent[0]);
  assert.equal(JSON.parse(added.sent[0]!).kind, 'question_new');
  const all = channels(channelConfig(NOTIFICATION_KINDS));
  await all.c.deliver(ev('info'));
  assert.equal(all.sent.length, 1, '7 つ全部を kinds に書ける');
});

test('5-4-s 外の送り先: 古い設定（approval_needed を kinds に持つ）は前と同じに送り、kinds に無い種類は送らない', async () => {
  const old = channels(channelConfig(['approval_needed']));
  await old.c.deliver(ev('approval_needed'));
  await old.c.deliver(ev('question_new'));
  await old.c.deliver(ev('task_done'));
  assert.equal(old.sent.length, 1);
  assert.equal(JSON.parse(old.sent[0]!).kind, 'approval_needed');
});

test('5-4-s タスクの実行で急ぐ質問を記録すると、未読の知らせは question_new の 1 つだけで先頭に固定され、既定の kinds の外の送り先にも届く', async t => {
  const sent: Array<{ kind: string; title: string }> = [];
  const s = await startApp(t, {
    configure: c => {
      c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 };
      c.memory.review = false;
      (c as { notify: unknown }).notify = { channels: [{ id: 'phone', kind: 'webhook', urlEnv: URL_ENV }], publicBaseUrl: '' };
    },
    env: { [URL_ENV]: 'https://hooks.example.com/x', FAKE_KEY: 'k' },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://hooks.example.com/')) { sent.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
      return fetch(url, init);
    }) as typeof fetch,
  });
  const root = join(s.paths.data, 'work', 'shop');
  mkdirSync(root, { recursive: true });
  const shop = s.app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null });
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user', projectId: shop.id });
  s.adapter().scripts.push(toolCall('question_add', { question: 'Which payment provider?', why: 'No safe default', options: ['A', 'B'], blocking: true }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
  const unread = s.app.db.prepare('SELECT kind, project_id FROM notifications WHERE read_at IS NULL').all() as Array<{ kind: string; project_id: string | null }>;
  assert.deepEqual(unread.map(n => n.kind), ['question_new'], '同じ質問で 2 つ出ない');
  assert.equal(unread[0]!.project_id, shop.id);
  for (let i = 0; i < 60; i++) s.app.notifications.notify({ kind: 'info', title: `info ${i}`, noForward: true });
  assert.equal(s.app.notifications.list()[0]!.kind, 'question_new', '先頭に固定');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(sent.map(p => p.kind), ['question_new'], '既定の kinds（task_waiting を持つ）の送り先に 1 通届く');
  assert.equal(sent[0]!.title, 'I have a question: Build the page');
});

test('5-4-s 急ぐ質問に /answer で答えて知らせを読んだあと、同じ文でまた急ぐ質問をすると、question_new が 1 つ未読で出る（task_waiting は出ない）', async t => {
  const s = await startApp(t, { configure: c => { c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; } });
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const text = 'Which payment provider?';
  s.adapter().scripts.push(toolCall('question_add', { question: text, why: 'No safe default', options: ['A', 'B'], blocking: true }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
  const answered = await s.json(`/api/tasks/${task.id}/answer`, 'POST', { text: 'A' });
  assert.equal(answered.status, 200);
  s.app.notifications.markRead();
  s.adapter().scripts.push(toolCall('question_add', { question: text, why: 'Still no safe default', options: ['A', 'B'], blocking: true }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
  const unread = s.app.db.prepare('SELECT kind FROM notifications WHERE read_at IS NULL').all() as Array<{ kind: string }>;
  assert.deepEqual(unread.map(n => n.kind), ['question_new']);
});

test('5-4-s 外の送り先: 急ぐ質問の question_new は task_waiting を持つ送り先にも届き、急がない質問は届かない', async () => {
  const waitingOnly = channels(channelConfig(['task_waiting']));
  await waitingOnly.c.deliver(ev('question_new', { dedup_key: `${BLOCKING_QUESTION_KEY}3` }));
  await waitingOnly.c.deliver(ev('question_new', { dedup_key: 'question:4' }));
  assert.equal(waitingOnly.sent.length, 1);
});
