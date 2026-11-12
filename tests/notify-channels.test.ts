import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { KV } from '../src/db/kv.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildPayload, NOTIFY_MAX_PAYLOAD_BYTES, NotifyChannels } from '../src/notify/channels.ts';
import type { NotificationKind, NotifyEvent, NotifyInput } from '../src/notify/notifications.ts';

const URL_ENV = 'CLIVE_NOTIFY_PHONE_URL_SECRET';
const TOKEN_ENV = 'CLIVE_NOTIFY_PHONE_TOKEN';
const SECRET_URL = 'https://hooks.example.com/services/T000/SECRETPATH';
const SECRET_TOKEN = 'tok-abc-123';

type Call = { url: string; init: RequestInit };

function config(over: { channel?: Record<string, unknown>; channels?: unknown[]; notify?: Record<string, unknown> } = {}): AppConfig {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, unknown>;
  const channels = over.channels ?? [{ id: 'phone', kind: 'webhook', urlEnv: URL_ENV, tokenEnv: TOKEN_ENV, ...over.channel }];
  raw.notify = { channels, ...over.notify };
  return parseConfig(raw);
}

function ev(kind: NotificationKind, over: Partial<NotifyEvent> = {}): NotifyEvent {
  return { id: 1, kind, title: 'タイトル', body: '本文です', link: '#/tasks/7', dedup_key: null, read_at: null, created_at: Date.UTC(2026, 10, 8, 0, 0, 0), local_only: 0, ...over };
}

function setup(cfg: AppConfig, responses: Array<number | Error | (() => Response)> = [204], env: Record<string, string | undefined> = { [URL_ENV]: SECRET_URL, [TOKEN_ENV]: SECRET_TOKEN }, nowMs = () => 1_000_000) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const alerts: NotifyInput[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : new Response(null, { status: r });
  }) as typeof fetch;
  const db = openDatabase(':memory:', MIGRATIONS);
  const kv = new KV(db, nowMs);
  const channels = new NotifyChannels({ config: () => cfg, env, fetch: fetchFake, now: nowMs, log: line => logs.push(line), kv, alert: input => alerts.push(input), sleep: async ms => { sleeps.push(ms); } });
  return { channels, calls, logs, alerts, sleeps, kv };
}

test('T-01 送り先が無ければ fetch は 0 回', async () => {
  const s = setup(parseConfig(JSON.parse(JSON.stringify(defaultConfig()))));
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.channels.status(), []);
});

test('T-06 無効・種類にない・noForward は送らない。既定の 4 種は送る', async () => {
  const off = setup(config({ channel: { enabled: false } }));
  await off.channels.deliver(ev('task_failed'));
  assert.equal(off.calls.length, 0);
  const s = setup(config());
  await s.channels.deliver(ev('task_done'));
  await s.channels.deliver(ev('info'));
  assert.equal(s.calls.length, 0, 'task_done と info は既定では送らない');
  await s.channels.deliver({ ...ev('health_alert'), noForward: true });
  assert.equal(s.calls.length, 0);
  for (const kind of ['task_waiting', 'task_failed', 'approval_needed', 'health_alert'] as const) await s.channels.deliver(ev(kind));
  assert.equal(s.calls.length, 4);
  const wide = setup(config({ channel: { kinds: ['task_done'] } }));
  await wide.channels.deliver(ev('task_done'));
  assert.equal(wide.calls.length, 1);
});

test('T-07 中身はキーの順が固定。リンクは publicBaseUrl があり # / で始まるときだけ', async () => {
  const s = setup(config({ notify: { publicBaseUrl: 'https://clive.example.ts.net/' } }));
  await s.channels.deliver(ev('task_failed'));
  const body = s.calls[0]!.init.body as string;
  assert.equal(body, '{"source":"clive","version":1,"kind":"task_failed","title":"タイトル","link":"https://clive.example.ts.net/#/tasks/7","createdAt":"2026-11-08T00:00:00.000Z"}');
  const none = config();
  assert.ok(!buildPayload(none, none.notify.channels[0]!, ev('task_failed')).includes('"link"'), 'publicBaseUrl が空ならリンクなし');
  const withBase = config({ notify: { publicBaseUrl: 'https://clive.example.ts.net' } });
  assert.ok(!buildPayload(withBase, withBase.notify.channels[0]!, ev('task_failed', { link: 'https://evil.example/' })).includes('"link"'), '# / で始まらないリンクは載せない');
  assert.ok(!buildPayload(withBase, withBase.notify.channels[0]!, ev('task_failed', { link: null })).includes('"link"'));
});

test('T-07 本文は includeBody のときだけ（1000 文字まで）', async () => {
  const off = config();
  assert.ok(!buildPayload(off, off.notify.channels[0]!, ev('task_failed')).includes('"body"'));
  const on = config({ channel: { includeBody: true } });
  const json = JSON.parse(buildPayload(on, on.notify.channels[0]!, ev('task_failed', { body: 'あ'.repeat(5000) }))) as { body: string };
  assert.equal(json.body.length, 1000);
  assert.deepEqual(Object.keys(JSON.parse(buildPayload(on, on.notify.channels[0]!, ev('task_failed')))), ['source', 'version', 'kind', 'title', 'body', 'createdAt']);
});

test('中身が大きすぎれば本文を外す（8KB 以内）', () => {
  const on = config({ channel: { includeBody: true } });
  const json = buildPayload(on, on.notify.channels[0]!, ev('task_failed', { title: 'a'.repeat(200), body: '\u0001'.repeat(1000) }));
  assert.ok(Buffer.byteLength(json) <= NOTIFY_MAX_PAYLOAD_BYTES);
});

test('T-08 local_only の通知は、題が決まった文になり、本文は送らない（includeBody でも）', async () => {
  const s = setup(config({ channel: { includeBody: true, kinds: ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'health_alert', 'info'] } }));
  for (const kind of ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'health_alert', 'info'] as const) {
    await s.channels.deliver(ev(kind, { title: '秘密の題 PRIVATE', body: '秘密の本文 PRIVATE', local_only: 1 }));
  }
  assert.equal(s.calls.length, 6);
  for (const call of s.calls) {
    const sent = call.init.body as string;
    assert.doesNotMatch(sent, /PRIVATE/u);
    assert.ok(!sent.includes('"body"'));
    assert.match(sent, /"title":"Clive: [^"]*work on a local model/u);
  }
});

test('local_only の通知は、publicBaseUrl があってもリンクを送らない（リンクに手元の会話の名前が入りうる）。そうでない通知は送る', async () => {
  const s = setup(config({ channel: { kinds: ['info', 'task_failed'] }, notify: { publicBaseUrl: 'https://clive.example.ts.net' } }));
  await s.channels.deliver(ev('info', { title: 'x', link: '#/skills/draft/secret-name-PRIVATE', local_only: 1 }));
  await s.channels.deliver(ev('task_failed', { link: '#/tasks/7' }));
  assert.equal(s.calls.length, 2);
  const [local, normal] = s.calls.map(c => c.init.body as string);
  assert.doesNotMatch(local!, /PRIVATE|"link"/u);
  assert.match(normal!, /"link":"https:\/\/clive\.example\.ts\.net\/#\/tasks\/7"/u);
});

test('T-09 token があれば Authorization: Bearer。無ければ付けない', async () => {
  const s = setup(config());
  await s.channels.deliver(ev('task_failed'));
  const headers = s.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SECRET_TOKEN}`);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(s.calls[0]!.url, SECRET_URL);
  assert.equal(s.calls[0]!.init.method, 'POST');
  assert.equal(s.calls[0]!.init.redirect, 'manual');
  const noToken = setup(config({ channel: { tokenEnv: undefined } }));
  await noToken.channels.deliver(ev('task_failed'));
  assert.equal((noToken.calls[0]!.init.headers as Record<string, string>).Authorization, undefined);
});

test('T-10 やり直し: 503 は 2 回、retries:0 は 1 回、400 は 1 回、302 は redirect で 1 回', async () => {
  const a = setup(config(), [503, 204]);
  await a.channels.deliver(ev('task_failed'));
  assert.equal(a.calls.length, 2);
  assert.deepEqual(a.sleeps, [2000]);
  assert.equal(a.channels.status()[0]!.fails, 0);
  const b = setup(config({ notify: { limits: { retries: 0 } } }), [503]);
  await b.channels.deliver(ev('task_failed'));
  assert.equal(b.calls.length, 1);
  assert.equal(b.channels.status()[0]!.reason, 'http_503');
  const c = setup(config(), [400, 204]);
  await c.channels.deliver(ev('task_failed'));
  assert.equal(c.calls.length, 1);
  assert.equal(c.channels.status()[0]!.reason, 'http_400');
  const d = setup(config(), [302, 204]);
  await d.channels.deliver(ev('task_failed'));
  assert.equal(d.calls.length, 1);
  assert.equal(d.channels.status()[0]!.reason, 'redirect');
  const e = setup(config(), [429, 429, 429]);
  await e.channels.deliver(ev('task_failed'));
  assert.equal(e.calls.length, 2, '1 回だけやり直す（既定）');
  const f = setup(config({ notify: { limits: { retries: 2 } } }), [500, 500, 500, 500]);
  await f.channels.deliver(ev('task_failed'));
  assert.equal(f.calls.length, 3);
});

test('T-10 時間切れは timeout でやり直し、timeoutMs が AbortSignal.timeout に渡る', async (t: TestContext) => {
  const seen: number[] = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { seen.push(ms); return original(ms); });
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const s = setup(config({ notify: { limits: { timeoutMs: 2500 } } }), [timeout, timeout]);
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.calls.length, 2);
  assert.deepEqual(seen, [2500, 2500]);
  assert.equal(s.channels.status()[0]!.reason, 'timeout');
  const n = setup(config(), [new Error(`connect ECONNREFUSED ${SECRET_URL}`)]);
  await n.channels.deliver(ev('task_failed'));
  assert.equal(n.channels.status()[0]!.reason, 'network');
});

test('T-11 URL・token・応答の本文は、ログ・kv・status に出ない', async () => {
  const s = setup(config(), [() => new Response('echo ' + SECRET_URL + SECRET_TOKEN, { status: 500 }), new Error(`boom ${SECRET_URL} ${SECRET_TOKEN}`)]);
  await s.channels.deliver(ev('task_failed'));
  const all = JSON.stringify([s.logs, s.alerts, s.channels.status(), s.kv.get('notify:channel:phone')]);
  assert.doesNotMatch(all, /SECRETPATH|tok-abc|hooks\.example/u);
  assert.match(s.logs.join('\n'), /\[WARN\] Could not send to notification destination "phone"/u);
});

test('T-12 failsBeforeAlert 回続けて失敗すると health_alert が 1 件。外へ送らない印つき。成功で 0 に戻る', async () => {
  const s = setup(config({ notify: { limits: { retries: 0, failsBeforeAlert: 3 } } }), [500, 500, 500, 500, 204]);
  await s.channels.deliver(ev('task_failed'));
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.alerts.length, 0);
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.alerts.length, 1);
  const alert = s.alerts[0]!;
  assert.equal(alert.kind, 'health_alert');
  assert.equal(alert.noForward, true);
  assert.equal(alert.dedupKey, 'notify-channel-fail:phone');
  assert.equal(alert.link, '#/settings');
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.channels.status()[0]!.fails, 4);
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.channels.status()[0]!.fails, 0);
  assert.ok(s.channels.status()[0]!.lastOkAt);
});

test('T-13 内蔵の道具名の一覧は固定（通知の送り先は道具を増やさない）', async () => {
  const { builtinTools } = await import('../src/app.ts');
  assert.deepEqual(builtinTools().map(t => t.name), ['task_complete', 'task_checkpoint', 'ask_user', 'memory_save', 'history_search', 'web_search', 'web_fetch', 'file_read', 'file_list', 'file_write', 'file_edit', 'shell_run', 'plan_write', 'plan_read', 'task_create', 'task_list', 'task_update', 'memory_update', 'memory_forget', 'memory_search', 'history_read', 'skill_view', 'skill_draft', 'curiosity_add', 'curiosity_list', 'curiosity_update', 'file_search', 'calculate', 'date_calc', 'checklist_write', 'notify_owner', 'doc_read', 'table_write', 'image_view', 'web_download', 'agent_run', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_close', 'browser_click', 'browser_type']);
});
test('T-14 1 時間の上限を越えた分は送らず、info が 1 件', async () => {
  const s = setup(config({ notify: { limits: { maxSendsPerHour: 2 } } }), [204]);
  for (let i = 0; i < 5; i++) await s.channels.deliver(ev('task_failed'));
  assert.equal(s.calls.length, 2);
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0]!.kind, 'info');
  assert.equal(s.alerts[0]!.noForward, true);
});

test('T-14 次の時間には送れる', async () => {
  let now = 1_000_000;
  const s = setup(config({ notify: { limits: { maxSendsPerHour: 1 } } }), [204], undefined, () => now);
  await s.channels.deliver(ev('task_failed'));
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.calls.length, 1);
  now += 3_600_000;
  await s.channels.deliver(ev('task_failed'));
  assert.equal(s.calls.length, 2);
});

test('T-15 env_missing・bad_url は送らず記録。loopback の http は送れる', async () => {
  const missing = setup(config(), [204], {});
  await missing.channels.deliver(ev('task_failed'));
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.channels.status()[0]!.reason, 'env_missing');
  const bad = setup(config(), [204], { [URL_ENV]: 'http://192.168.1.2/' });
  await bad.channels.deliver(ev('task_failed'));
  assert.equal(bad.calls.length, 0);
  assert.equal(bad.channels.status()[0]!.reason, 'bad_url');
  const ok = setup(config(), [204], { [URL_ENV]: 'http://127.0.0.1:8080/' });
  await ok.channels.deliver(ev('task_failed'));
  assert.equal(ok.calls.length, 1);
});

test('status は設定の有無だけを返す（値は返さない）', () => {
  const s = setup(config());
  const [status] = s.channels.status();
  assert.equal(status!.urlSet, true);
  assert.equal(status!.tokenSet, true);
  assert.equal(status!.urlEnv, URL_ENV);
  assert.doesNotMatch(JSON.stringify(status), /SECRETPATH|tok-abc/u);
});

test('T-19 test は無効なチャネルにも決まった文を送り、上限に数えない。知らない id は undefined', async () => {
  const s = setup(config({ channel: { enabled: false }, notify: { limits: { maxSendsPerHour: 1 } } }));
  assert.deepEqual(await s.channels.test('phone'), { ok: true });
  assert.deepEqual(await s.channels.test('phone'), { ok: true });
  assert.match(s.calls[0]!.init.body as string, /This is a test notification from Clive/u);
  assert.equal(await s.channels.test('nope'), undefined);
  const fail = setup(config(), [500, 500]);
  assert.deepEqual(await fail.channels.test('phone'), { ok: false, reason: 'http_500' });
});