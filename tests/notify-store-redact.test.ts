import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildPayload } from '../src/notify/channels.ts';
import { Notifications } from '../src/notify/notifications.ts';
import { testConfig } from './helpers.ts';

const KEY = 'sk-ant-test-0000000000000000';
const PROVIDER_KEY = 'opaque-provider-key-7781';

function config(): AppConfig {
  const raw = testConfig() as unknown as Record<string, unknown>;
  raw.notify = { publicBaseUrl: 'https://beat.example.ts.net', channels: [{ id: 'phone', kind: 'webhook', urlEnv: 'BEAT_NOTIFY_PHONE_URL_SECRET', includeBody: true }] };
  return parseConfig(raw);
}

function make(secrets: readonly string[] = []) {
  const db = openDatabase(':memory:', MIGRATIONS);
  return new Notifications(db, () => 1_000, () => {}, () => secrets);
}

test('通知の保存: 題の 200 文字の切れ目をまたぐ鍵は、切る前に伏せるので、頭の一部も残らず、webhook にも出ない', () => {
  const notifications = make();
  const n = notifications.notify({ kind: 'info', title: `${'a'.repeat(190)} ${KEY}`, body: `${'b'.repeat(1990)} ${KEY}` })!;
  assert.ok(!n.title.includes('sk-ant'), n.title.slice(-30));
  assert.ok(!n.body!.includes('sk-ant'), n.body!.slice(-30));
  assert.ok(n.title.length <= 200 && n.body!.length <= 2000);
  const cfg = config();
  assert.ok(!buildPayload(cfg, cfg.notify.channels[0]!, n).includes('sk-ant'));
});

test('通知の保存: 設定の鍵そのもの（形の決まりに当たらない鍵）も、切れ目をまたいで頭が残らない', () => {
  const notifications = make([PROVIDER_KEY]);
  const n = notifications.notify({ kind: 'info', title: `${'a'.repeat(190)} ${PROVIDER_KEY}`, body: `${'b'.repeat(1990)} ${PROVIDER_KEY}` })!;
  assert.ok(!n.title.includes('opaque'), n.title.slice(-30));
  assert.ok(!n.body!.includes('opaque'), n.body!.slice(-30));
});

test('通知の保存: 秘密の無い題と本文はそのまま、長さの上限も今までどおり', () => {
  const n = make().notify({ kind: 'info', title: 'Task finished', body: 'Renamed the draft folder' })!;
  assert.equal(n.title, 'Task finished');
  assert.equal(n.body, 'Renamed the draft folder');
  const long = make().notify({ kind: 'info', title: 'x'.repeat(300), body: 'y'.repeat(3000) })!;
  assert.equal(long.title.length, 200);
  assert.equal(long.body!.length, 2000);
});
