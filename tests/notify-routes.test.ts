import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';

// 外の送り先（webhook）の管理 API。URL・token は .env にだけ書き、応答・ログ・設定・DB・お知らせのどこにも出さない。
// 環境変数の名前はサーバーが決める（クライアントからは受け取らない）

const URL1 = 'https://hooks.example.com/services/T000/Zk3qP9xW7mB2vN8c';
const URL2 = 'https://hooks.example.com/services/T000/Rt6yH4nJ8vC1xA9s';
const TOKEN = 'Qm5dK2wE7hB4tY1nLp9';
const ENV_URL = 'BEAT_NOTIFY_PHONE_URL_SECRET';
const ENV_TOKEN = 'BEAT_NOTIFY_PHONE_TOKEN';

type Sent = { url: string; body: string; headers: Record<string, string> };

async function start(t: Parameters<typeof startApp>[0], options: { status?: () => number; configure?: (c: any) => void; env?: Record<string, string | undefined> } = {}) {
  const sent: Sent[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? ''), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(null, { status: options.status?.() ?? 204 });
  }) as typeof fetch;
  const s = await startApp(t, { env: options.env ?? {}, fetch: fetchFake, ...(options.configure ? { configure: options.configure } : {}) });
  const create = (body: unknown) => s.json('/api/notify/channels', 'POST', body);
  return { ...s, sent, create, env: (s.app.env as Record<string, string | undefined>) };
}

test('T-16 作る: .env に 2 行、設定には名前だけ。応答に値は出ない。クライアントが名前を渡しても無視する', async t => {
  const s = await start(t);
  const res = await s.create({ id: 'phone', url: URL1, token: TOKEN, urlEnv: 'PATH', tokenEnv: 'NODE_OPTIONS', kinds: ['task_failed'] });
  assert.equal(res.status, 201);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `${ENV_URL}=${URL1}\n${ENV_TOKEN}=${TOKEN}\n`);
  const channel = s.app.config().notify.channels[0]!;
  assert.deepEqual([channel.id, channel.urlEnv, channel.tokenEnv, channel.kinds], ['phone', ENV_URL, ENV_TOKEN, ['task_failed']]);
  assert.equal(s.env[ENV_URL], URL1, '起動し直さなくても効く');
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /Zk3qP9|Qm5dK2|hooks\.example/u);
  assert.equal(res.body.channels[0].urlSet, true);
  assert.equal(res.body.channels[0].tokenSet, true);
  assert.equal((await s.json('/api/notify/channels', 'GET')).body.limits.maxChannels, 4);
});

test('T-16 値の検査: http の LAN・ユーザー名つき・空白つき・空は 400。同じ ID は 409。上限は 409', async t => {
  const s = await start(t, { configure: c => { c.notify = { channels: [], limits: { maxChannels: 1 } }; } });
  for (const url of ['http://192.168.1.2/hook', 'https://user:pw@hooks.example.com/x', ` ${URL1}`, '']) {
    assert.equal((await s.create({ id: 'phone', url })).status, 400, url);
  }
  assert.equal((await s.create({ id: 'Bad_ID', url: URL1 })).status, 400);
  assert.equal(existsSync(s.paths.env), false, '断ったものは .env に書かない');
  assert.equal((await s.create({ id: 'phone', url: 'http://127.0.0.1:8080/hook' })).status, 201, 'ループバックの http は通る');
  assert.equal((await s.create({ id: 'phone', url: URL1 })).status, 409);
  const second = await s.create({ id: 'other', url: URL1 });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'http.notify_channel_limit');
});

test('T-16 秘密の欄: PUT は { set: true } だけ返す。URL は消せない。token は消せる', async t => {
  const s = await start(t);
  await s.create({ id: 'phone', url: URL1 });
  const put = await s.json('/api/notify/channels/phone/secrets/url', 'PUT', { value: URL2, name: 'PATH' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { set: true });
  assert.equal(s.env[ENV_URL], URL2);
  assert.equal((await s.json('/api/notify/channels/phone/secrets/url', 'PUT', { value: 'http://10.0.0.5/x' })).status, 400);
  assert.equal(s.env[ENV_URL], URL2, '断った値で上書きしない');
  assert.equal((await s.json('/api/notify/channels/phone/secrets/url', 'DELETE')).status, 409);
  const token = await s.json('/api/notify/channels/phone/secrets/token', 'PUT', { value: TOKEN });
  assert.deepEqual(token.body, { set: true });
  assert.equal(s.app.config().notify.channels[0]!.tokenEnv, ENV_TOKEN, '設定に名前が足される');
  const del = await s.json('/api/notify/channels/phone/secrets/token', 'DELETE');
  assert.deepEqual(del.body, { set: false });
  assert.equal(s.app.config().notify.channels[0]!.tokenEnv, undefined);
  assert.doesNotMatch(readFileSync(s.paths.env, 'utf8'), /TOKEN/u);
  assert.equal(s.env[ENV_TOKEN], undefined);
  assert.equal((await s.json('/api/notify/channels/nope/secrets/url', 'PUT', { value: URL1 })).status, 404);
});

test('T-16 プロバイダの鍵の変数と重なる名前は 409（.env を書かない）', async t => {
  const s = await start(t, { configure: c => { c.providers[0].apiKeyEnv = ENV_URL; } });
  const res = await s.create({ id: 'phone', url: URL1 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'http.notify_env_conflict');
  assert.equal(existsSync(s.paths.env), false);
});

test('T-17 設定の反映が失敗したら、.env に書いた分を消し戻す（元の中身は残る）', async t => {
  const s = await start(t);
  const original = '# 私の設定\nOTHER_SETTING=1\n';
  writeFileSync(s.paths.env, original);
  t.mock.method(s.app, 'applyConfig', async () => { throw new Error('反映に失敗'); });
  const res = await s.create({ id: 'phone', url: URL1, token: TOKEN });
  assert.equal(res.status, 500);
  assert.equal(readFileSync(s.paths.env, 'utf8'), original);
  assert.equal(s.env[ENV_URL], undefined);
  assert.equal(s.env[ENV_TOKEN], undefined);
  assert.equal(s.app.config().notify.channels.length, 0);
});

test('T-18 削除: 自動の名前の秘密と kv が消える。持ち主が自分で書いた名前は残る', async t => {
  const s = await start(t, {
    status: () => 500,
    env: { MY_OWN_HOOK_SECRET: URL2 },
    configure: c => { c.notify = { channels: [{ id: 'mine', kind: 'webhook', urlEnv: 'MY_OWN_HOOK_SECRET' }], limits: { retries: 0 } }; },
  });
  writeFileSync(s.paths.env, `MY_OWN_HOOK_SECRET=${URL2}\n`);
  await s.create({ id: 'phone', url: URL1, token: TOKEN });
  await s.json('/api/notify/channels/phone/test', 'POST');
  await s.json('/api/notify/channels/mine/test', 'POST');
  assert.ok(s.app.kv.get('notify:channel:phone'), '前提: 失敗の記録がある');
  assert.equal((await s.json('/api/notify/channels/phone', 'DELETE')).status, 200);
  assert.equal(s.app.kv.get('notify:channel:phone'), undefined);
  assert.equal(s.env[ENV_URL], undefined);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `MY_OWN_HOOK_SECRET=${URL2}\n`);
  assert.equal((await s.json('/api/notify/channels/mine', 'DELETE')).status, 200);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `MY_OWN_HOOK_SECRET=${URL2}\n`, '持ち主の名前は残す');
  assert.equal(s.app.config().notify.channels.length, 0);
  assert.equal((await s.json('/api/notify/channels/phone', 'DELETE')).status, 404);
});

test('手書きの環境変数名（自動の名前でない）を指す送り先には、画面から秘密を書かない（共有の変数を上書きしない）', async t => {
  const s = await start(t, {
    env: { MY_OWN_HOOK_SECRET: URL2 },
    configure: c => { c.notify = { channels: [{ id: 'mine', kind: 'webhook', urlEnv: 'MY_OWN_HOOK_SECRET', tokenEnv: 'GITHUB_TOKEN' }], limits: { retries: 0 } }; },
  });
  writeFileSync(s.paths.env, `MY_OWN_HOOK_SECRET=${URL2}\nGITHUB_TOKEN=keep\n`);
  assert.equal((await s.json('/api/notify/channels/mine/secrets/url', 'PUT', { value: URL1 })).status, 409);
  assert.equal((await s.json('/api/notify/channels/mine/secrets/token', 'PUT', { value: TOKEN })).status, 409);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `MY_OWN_HOOK_SECRET=${URL2}\nGITHUB_TOKEN=keep\n`, '.env は変わらない');
});

test('T-19 test は決まった文を送る。Origin の確かめを通らない要求は断る', async t => {
  const s = await start(t);
  await s.create({ id: 'phone', url: URL1, token: TOKEN });
  const res = await s.json('/api/notify/channels/phone/test', 'POST');
  assert.deepEqual(res.body, { ok: true });
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!.body, /This is a test notification from beat/u);
  assert.equal(s.sent[0]!.url, URL1);
  assert.equal((await s.json('/api/notify/channels/nope/test', 'POST')).status, 404);
  const calls: Array<[string, string, Record<string, string>]> = [
    ['POST', '/api/notify/channels/phone/test', {}],
    ['POST', '/api/notify/channels/phone/test', { Origin: 'https://evil.example' }],
    ['POST', '/api/notify/channels', { Origin: 'https://evil.example' }],
    ['PUT', '/api/notify/channels/phone/secrets/url', { Origin: 'https://evil.example' }],
    ['DELETE', '/api/notify/channels/phone', { Origin: 'https://evil.example' }],
    ['PATCH', '/api/notify', { Origin: 'https://evil.example' }],
  ];
  for (const [method, path, headers] of calls) {
    const r = await fetch(`${s.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(headers)}`);
  }
  assert.equal(s.sent.length, 1, '断った要求は送らない');
  assert.equal(s.app.config().notify.channels.length, 1);
});

test('PATCH: チャネルの enabled / kinds / includeBody、notify の publicBaseUrl / limits。範囲外は 400', async t => {
  const s = await start(t);
  await s.create({ id: 'phone', url: URL1 });
  const p = await s.json('/api/notify/channels/phone', 'PATCH', { enabled: false, includeBody: true, kinds: ['info'] });
  assert.equal(p.status, 200);
  const c = s.app.config().notify.channels[0]!;
  assert.deepEqual([c.enabled, c.includeBody, c.kinds], [false, true, ['info']]);
  assert.equal((await s.json('/api/notify/channels/phone', 'PATCH', { kinds: ['nope'] })).status, 400);
  assert.equal((await s.json('/api/notify/channels/phone', 'PATCH', { enabled: 'yes' })).status, 400);
  assert.equal((await s.json('/api/notify', 'PATCH', { publicBaseUrl: 'https://beat.example.ts.net', limits: { maxSendsPerHour: 10 } })).status, 200);
  assert.equal(s.app.config().notify.publicBaseUrl, 'https://beat.example.ts.net');
  assert.equal(s.app.config().notify.limits.maxSendsPerHour, 10);
  assert.equal(s.app.config().notify.limits.timeoutMs, 5000, '触れていない上限は変わらない');
  assert.equal((await s.json('/api/notify', 'PATCH', { limits: { maxSendsPerHour: 999 } })).status, 400);
  assert.equal((await s.json('/api/notify', 'PATCH', { publicBaseUrl: 'http://192.168.1.2/' })).status, 400);
  assert.equal(s.app.config().notify.limits.maxSendsPerHour, 10, '断ったものは反映されない');
});

test('T-11 URL・token は、応答・設定・お知らせ・ログ・DB のどこにも出ない（.env のほか）', async t => {
  const s = await start(t, { status: () => 500 });
  const created = await s.create({ id: 'phone', url: URL1, token: TOKEN });
  const tested = await s.json('/api/notify/channels/phone/test', 'POST');
  const seen = [JSON.stringify(created.body), JSON.stringify(tested.body)];
  for (const path of ['/api/notify/channels', '/api/settings', '/api/notifications', '/api/health', '/api/events']) {
    if (path === '/api/events') continue;
    seen.push(await (await s.api(path)).text());
  }
  seen.push(s.logs.join('\n'), JSON.stringify(s.app.notifications.list(200)));
  const tables = (s.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name);
  for (const table of tables) { try { seen.push(JSON.stringify(s.app.db.prepare(`SELECT * FROM "${table}"`).all())); } catch { /* 仮想表など */ } }
  for (const text of seen) assert.doesNotMatch(text, /Zk3qP9xW7mB2vN8c|Qm5dK2wE7hB4tY1nLp9/u);
});
test('配線: お知らせが作られると送り先へ届く（題はそのまま）。送り先の失敗の警告は外へ送らない', async t => {
  const s = await start(t, {
    status: () => 500,
    configure: c => { c.notify = { channels: [{ id: 'phone', kind: 'webhook', urlEnv: ENV_URL, kinds: ['task_failed', 'health_alert'] }], limits: { retries: 0, failsBeforeAlert: 2 } }; },
    env: { [ENV_URL]: URL1 },
  });
  s.app.notifications.notify({ kind: 'task_failed', title: '1 つ目の題' });
  s.app.notifications.notify({ kind: 'task_failed', title: '公開の題' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[0]!.body, /1 つ目の題/u);
  assert.match(s.sent[1]!.body, /公開の題/u);
  // 2 回続けて失敗したので、health_alert が 1 件できるが、それは外へ送られない（送り先がまた失敗する連鎖にしない）
  const alerts = s.app.notifications.list(50).filter(n => n.kind === 'health_alert');
  assert.equal(alerts.length, 1);
  assert.equal(s.sent.length, 2);
});

test('A3: 画面で既読にする（POST /api/notifications/read）と notification.read が流れ、別のタブのベルの数が合う', async t => {
  const s = await start(t);
  const seen: Array<{ type: string; ids?: number[]; unread?: number }> = [];
  s.app.bus.subscribe(e => { if (e.event.type === 'notification.read') seen.push(e.event); });
  const a = s.app.notifications.notify({ kind: 'info', title: 'a' })!;
  const b = s.app.notifications.notify({ kind: 'info', title: 'b' })!;
  s.app.notifications.notify({ kind: 'info', title: 'c' });
  // 渡した id だけ: ids はそのまま、unread は既読にしたあとの今の数
  assert.equal((await s.json('/api/notifications/read', 'POST', { ids: [a.id, b.id] })).body.unread, 1);
  assert.deepEqual(seen, [{ type: 'notification.read', ids: [a.id, b.id], unread: 1 }]);
  // ids を渡さない（全部）: ids は空の配列
  assert.equal((await s.json('/api/notifications/read', 'POST', {})).body.unread, 0);
  assert.deepEqual(seen[1], { type: 'notification.read', ids: [], unread: 0 });
  assert.equal(seen.length, 2);
});

test('A3: 断った呼び出し（ids の形が悪い）は何も流さない。Notifications.markRead そのものは流さない（起動の掃除から直に呼ぶ道がある）', async t => {
  const s = await start(t);
  const seen: string[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event.type); });
  const n = s.app.notifications.notify({ kind: 'info', title: 'a' })!;
  seen.length = 0;
  assert.equal((await s.json('/api/notifications/read', 'POST', { ids: ['x'] })).status, 400);
  s.app.notifications.markRead([n.id]);
  assert.deepEqual(seen, []);
});
