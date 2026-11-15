import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { buildPayload } from '../src/notify/channels.ts';
import type { NotifyEvent } from '../src/notify/notifications.ts';
import { fakeModel, settled, startApp } from './app-setup.ts';
import { reply, type Script, testConfig, withLoad } from './helpers.ts';

const KEY = 'sk-ant-test-0000000000000000';
const GH = 'ghp_a1B2c3D4e5F6g7H8i9J0';
const BEARER = 'Bearer abc123.def456-ghi';
const PROVIDER_KEY = 'opaque-provider-key-7781';
const LEAK = /sk-ant-test|ghp_a1B2|abc123\.def456|opaque-provider-key/u;
const URL_ENV = 'BEAT_NOTIFY_PHONE_URL_SECRET';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function config(): AppConfig {
  const raw = testConfig() as unknown as Record<string, unknown>;
  raw.notify = { publicBaseUrl: 'https://beat.example.ts.net', channels: [{ id: 'phone', kind: 'webhook', urlEnv: URL_ENV, includeBody: true }] };
  return parseConfig(raw);
}

function ev(over: Partial<NotifyEvent>): NotifyEvent {
  return { id: 1, kind: 'info', title: 'Task finished', body: 'Renamed the draft folder', link: '#/tasks/7', dedup_key: null, read_at: null, project_id: null, action: null, created_at: Date.UTC(2026, 10, 14), ...over };
}

async function start(t: Parameters<typeof startApp>[0]) {
  const sent: string[] = [];
  const s = await startApp(t, {
    models: [fakeModel('m1')],
    configure: c => {
      c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 };
      c.notify = { publicBaseUrl: 'https://beat.example.ts.net', channels: [{ id: 'phone', kind: 'webhook', urlEnv: URL_ENV, kinds: ['task_done', 'info'], includeBody: true }] } as unknown as typeof c.notify;
    },
    env: { [URL_ENV]: 'https://hooks.example.test/in', FAKE_KEY: PROVIDER_KEY },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  const delivered = async () => { await new Promise(resolve => setTimeout(resolve, 100)); return sent.map(body => JSON.parse(body) as { kind: string; title: string; body?: string; link?: string }); };
  return { ...s, sent, delivered };
}

test('外の送り先の中身: 題と本文の鍵の形（sk-・ghp_・Bearer）と、渡した鍵そのものを伏せる。ふつうの題・本文・リンクは変えない', () => {
  const c = config();
  const channel = c.notify.channels[0]!;
  const plain = JSON.parse(buildPayload(c, channel, ev({}))) as Record<string, string>;
  assert.deepEqual([plain.title, plain.body, plain.link], ['Task finished', 'Renamed the draft folder', 'https://beat.example.ts.net/#/tasks/7']);
  const dirty = buildPayload(c, channel, ev({ title: `done ${GH}`, body: `key ${KEY} and Authorization: ${BEARER} and ${PROVIDER_KEY}`, link: `#/skills/draft/${KEY}` }), [PROVIDER_KEY]);
  assert.doesNotMatch(dirty, LEAK);
  const parsed = JSON.parse(dirty) as Record<string, string>;
  assert.match(parsed.title!, /^done \[REDACTED\]$/u);
  assert.match(parsed.body!, /^key \[REDACTED\] and /u);
  assert.equal(parsed.link, 'https://beat.example.ts.net/#/skills/draft/[REDACTED]');
});

test('外の送り先の中身: 伏せるのは長さを切る前（切れ目で鍵の頭だけが残らない）', () => {
  const c = config();
  const body = `${'x'.repeat(990)} ${KEY}`;
  const sent = buildPayload(c, c.notify.channels[0]!, ev({ body }));
  assert.doesNotMatch(sent, /sk-ant/u);
});

test('タスクの完了の知らせ: 題（タスクの題）と本文（まとめ）の鍵は、外の送り先へ伏せて出る', async t => {
  const s = await start(t);
  s.app.tasks.create({ title: `deploy with ${GH}`, origin: 'user', actor: 'user' });
  s.adapter().scripts = [call('task_complete', { summary: `used ${KEY}, header Authorization: ${BEARER}, provider ${PROVIDER_KEY}`, notify: true })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const done = (await s.delivered()).filter(p => p.kind === 'task_done');
  assert.equal(done.length, 1);
  assert.doesNotMatch(JSON.stringify(done), LEAK);
  assert.match(done[0]!.title, /\[REDACTED\]/u);
  assert.match(done[0]!.body!, /\[REDACTED\]/u);
  assert.match(done[0]!.link!, /^https:\/\/beat\.example\.ts\.net\/#\/tasks\//u);
});

test('notify_owner の知らせ: 題と本文の鍵は、外の送り先へ伏せて出る', async t => {
  const s = await start(t);
  const id = '00000000-0000-4000-8000-000000000001';
  s.app.conversations.create({ id, title: '会話' });
  s.adapter().scripts = [call('notify_owner', { title: `token ${GH}`, body: `the key is ${KEY} / Authorization: ${BEARER}` }), reply('知らせました')];
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '知らせて' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  const info = (await s.delivered()).filter(p => p.kind === 'info');
  assert.equal(info.length, 1);
  assert.doesNotMatch(JSON.stringify(info), LEAK);
  assert.match(info[0]!.title, /\[REDACTED\]/u);
  assert.match(info[0]!.body!, /\[REDACTED\]/u);
});

test('スキルの下書きの知らせ: 理由の鍵は、外の送り先へ伏せて出る。ふつうの下書きはそのまま', async t => {
  const s = await start(t);
  const draft = { description: 'd', body: 'b', change_summary: null, status: 'pending' as const, conversation_id: null, run_id: null, created_at: 0, decided_at: null, outside: 0 as const };
  s.app.skills.onDraft!({ ...draft, id: 7, name: 'deploy-notes', reason: `uses ${KEY} and ${GH} with Authorization: ${BEARER}` });
  s.app.skills.onDraft!({ ...draft, id: 8, name: 'weekly-report', reason: 'summarise every week' });
  const info = await s.delivered();
  assert.equal(info.length, 2);
  assert.doesNotMatch(JSON.stringify(info), LEAK);
  assert.match(info[0]!.body!, /\[REDACTED\]/u);
  assert.equal(info[1]!.body, 'summarise every week');
  assert.match(info[1]!.title, /weekly-report/u);
  assert.equal(info[1]!.link, 'https://beat.example.ts.net/#/skills/draft/weekly-report');
});

test('スキルの下書きの知らせ: 直す下書きの本文は change_summary で、その中の鍵も外の送り先へ伏せて出る', async t => {
  const s = await start(t);
  const draft = { description: 'd', body: 'b', reason: 'r', status: 'pending' as const, conversation_id: null, run_id: null, created_at: 0, decided_at: null, outside: 0 as const };
  s.app.skills.onDraft!({ ...draft, id: 9, name: 'deploy-notes', change_summary: `used ${KEY} → use ${GH}` });
  const info = await s.delivered();
  assert.equal(info.length, 1);
  assert.doesNotMatch(JSON.stringify(info), LEAK);
  assert.match(info[0]!.body!, /^used \[REDACTED\]/u);
});
