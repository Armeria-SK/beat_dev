import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Notifications, type Notification } from '../src/notify/notifications.ts';
import { tempDir } from './helpers.ts';

function make(log: string[] = []) {
  const db = openDatabase(':memory:', MIGRATIONS);
  return { db, notifications: new Notifications(db, () => 1_000, line => log.push(line)) };
}

test('T-04 聞き手は複数付けられ、1 本が throw しても残りが呼ばれ、[ERROR] が出る', () => {
  const logs: string[] = [];
  const { notifications } = make(logs);
  const seen: string[] = [];
  notifications.listen(() => { throw new Error('boom'); });
  notifications.listen(n => seen.push(n.title));
  const n = notifications.notify({ kind: 'info', title: 'A' });
  assert.ok(n, '通知は作られる');
  assert.deepEqual(seen, ['A']);
  assert.equal(logs.filter(l => l.startsWith('[ERROR]')).length, 1);
  assert.match(logs.join('\n'), /boom/);
});

test('T-05 重ねない（dedup）で undefined になったとき、聞き手は呼ばれない', () => {
  const { notifications } = make();
  let calls = 0;
  notifications.listen(() => { calls++; });
  assert.ok(notifications.notify({ kind: 'info', title: 'A', dedupKey: 'k' }));
  assert.equal(notifications.notify({ kind: 'info', title: 'A', dedupKey: 'k' }), undefined);
  assert.equal(calls, 1);
});

test('noForward は聞き手にだけ渡る（DB には残らず、返り値にも無い）。列 local_only は残るが、新しい行はいつも 0', () => {
  const { db, notifications } = make();
  const heard: Array<Notification & { noForward?: true }> = [];
  notifications.listen(n => heard.push(n));
  notifications.notify({ kind: 'info', title: 'L' });
  const plain = notifications.notify({ kind: 'info', title: 'P' })!;
  const quiet = notifications.notify({ kind: 'health_alert', title: 'Q', noForward: true })!;
  assert.deepEqual((db.prepare('SELECT local_only FROM notifications ORDER BY id').all() as Array<{ local_only: number }>).map(r => r.local_only), [0, 0, 0]);
  assert.equal(plain.title, 'P');
  assert.equal('noForward' in quiet, false, '返り値（行）には noForward を載せない');
  assert.deepEqual(heard.map(h => h.noForward === true), [false, false, true]);
  const columns = (db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>).map(c => c.name);
  assert.ok(columns.includes('local_only'));
  assert.ok(!columns.includes('no_forward'));
});

test('T-21a 移し替え 19 のあと、前からある通知は local_only = 0', t => {
  assert.ok(MIGRATIONS.length >= 19);
  const path = join(tempDir(t), 'beat.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 18));
  before.prepare("INSERT INTO notifications (kind, title, created_at) VALUES ('info', '前から', 1)").run();
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  const row = db.prepare('SELECT local_only FROM notifications').get() as { local_only: number };
  assert.equal(row.local_only, 0);
  db.close();
});