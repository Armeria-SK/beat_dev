import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { ProcessManager } from '../src/runtimes/process-manager.ts';
import { RuntimeRegistry } from '../src/runtimes/registry.ts';
import { tempDir } from './helpers.ts';

// AR-7: 会話に「どの実行役で動かすか」と続きの ID を結ぶ列。移し替えは中身（runtime_id）で探すので、番号が変わっても動く
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('runtime_session'));

test('移し替え（会話の runtime_id・runtime_session と実行の runtime）: 列だけが足されて既存の行は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'the migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  try {
    old.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES ('c1', 'chat', 1, 1)").run();
    old.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('r1', 'chat', 'c1', 1)").run();
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, AT + 1);
    const conversation = db.prepare("SELECT id, runtime_id, runtime_session FROM conversations WHERE id = 'c1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...conversation }, { id: 'c1', runtime_id: null, runtime_session: null }, 'an existing conversation stays a provider conversation');
    assert.deepEqual({ ...(db.prepare("SELECT id, runtime FROM engine_runs WHERE id = 'r1'").get() as Record<string, unknown>) }, { id: 'r1', runtime: null });
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);
  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try { assert.equal(readdirSync(backups).length, 1); } finally { again.close(); }
});

test('実行役への結び付け: 最初の 1 回だけ結ばれ、別の実行役へは替わらず、結ばれた会話だけが続きの ID を持ち、結ぶと「外から読んだ」印も付く', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const conversations = new Conversations(db);
  conversations.ensure('c1');
  conversations.ensure('c2');
  db.prepare('UPDATE conversations SET ever_tainted = 0').run();
  assert.deepEqual(conversations.runtimeOf('c1'), { runtimeId: null, session: null });
  assert.deepEqual(conversations.runtimeOf('nope'), { runtimeId: null, session: null });

  conversations.setRuntimeSession('c1', 'sess-x');
  assert.equal(conversations.runtimeOf('c1').session, null, 'a conversation that is not bound keeps no session id');

  assert.equal(conversations.bindRuntime('c1', 'claude-code'), true);
  assert.equal(conversations.everTainted('c1'), true, 'beat cannot see what the runtime read');
  assert.equal(conversations.everTainted('c2'), false, 'the other conversation is untouched');
  assert.equal(conversations.bindRuntime('c1', 'claude-code'), true, 'binding again to the same runtime is fine');
  assert.equal(conversations.bindRuntime('c1', 'codex'), false, 'a bound conversation does not move to another runtime');
  assert.equal(conversations.runtimeOf('c1').runtimeId, 'claude-code');

  conversations.setRuntimeSession('c1', 'sess-1');
  assert.deepEqual(conversations.runtimeOf('c1'), { runtimeId: 'claude-code', session: 'sess-1' });
  assert.equal(conversations.list().find(item => item.id === 'c1')!.runtime_id, 'claude-code');
  assert.equal('runtime_session' in conversations.list().find(item => item.id === 'c1')!, false, 'the list never carries the session id');
});

test('実行の記録: 起こし方の記録は JSON で engine_runs.runtime に残る', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const runs = new Runs(db);
  runs.start('r1', 'chat');
  runs.setRuntime('r1', { runtime: 'claude-code', resumed: false });
  assert.deepEqual(JSON.parse(runs.get('r1')!.runtime!), { runtime: 'claude-code', resumed: false });
  assert.equal(runs.get('r1')!.provider_id, null);
});

test('実行役の窓口が伏せる鍵の値は、渡された出どころから毎回読む。出どころが無ければ空', () => {
  let current: string[] = ['key-one'];
  const withSource = new RuntimeRegistry({ processes: new ProcessManager(), log: () => undefined, secrets: () => current });
  assert.deepEqual(withSource.secrets(), ['key-one']);
  current = ['key-two', 'key-three'];
  assert.deepEqual(withSource.secrets(), ['key-two', 'key-three']);
  assert.deepEqual(new RuntimeRegistry({ processes: new ProcessManager(), log: () => undefined }).secrets(), []);
});
