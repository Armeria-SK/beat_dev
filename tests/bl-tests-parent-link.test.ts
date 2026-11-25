import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { growthStats } from '../src/growth/stats.ts';
import { PendingStore, type PendingRow } from '../src/pending/store.ts';
import { parentOf } from '../src/pending/replay.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

// backlog 389: 子のエージェントが親の実行につながる印は 2 か所にある（実行の記録 engine_runs.parent_run_id と、会話 conversations.parent_run_id）。
// 読む側は「どちらか 1 つあれば親が分かる」と作ってあるが、これまでの試験は 2 か所に同時に置いていたので、片方を外しても赤くならなかった。1 か所ずつ置く

const NOV = Date.parse('2026-11-14T03:00:00Z');

// --- 成長の数（growthStats）: 子の担当が読んだスキルは、親の実行のタスクの数に入る ---

async function growthSetup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.timezone = 'UTC';
  writeFileSync(paths.config, JSON.stringify(config));
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => NOV, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const root = join(dir, 'shop');
  mkdirSync(root, { recursive: true });
  const project = app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null });
  return { app, project };
}

type Growth = Awaited<ReturnType<typeof growthSetup>>;

// 失敗したタスク（会話 conv）の実行 run を作り、その子の担当が読んだスキルを 1 回記録する。link は、子の担当と親をつなぐ印を 2 か所のどちらに置くか
function parentTaskWithChild(s: Growth, name: string, link: 'run' | 'conversation' | 'none'): void {
  const db = s.app.db;
  const conv = `conv-parent-${name}`;
  const parentRun = `run-parent-${name}`;
  const childConv = `agent-${name}`;
  const childRun = `run-agent-${name}`;
  const task = s.app.tasks.create({ title: `Parent of ${name}`, origin: 'user', actor: 'user', projectId: s.project.id });
  db.prepare("UPDATE tasks SET conversation_id = ?, status = 'failed' WHERE id = ?").run(conv, task.id);
  db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES (?, ?, ?, ?)').run(parentRun, 'task', conv, NOV);
  db.prepare("INSERT INTO conversations (id, kind, parent_run_id, created_at, last_message_at) VALUES (?, 'task', ?, ?, ?)").run(childConv, link === 'conversation' ? parentRun : null, NOV, NOV);
  db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, parent_run_id, started_at) VALUES (?, ?, ?, ?, ?)').run(childRun, 'agent', childConv, link === 'run' ? parentRun : null, NOV);
  db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, ?, ?, 'skill_view', ?, 'allow', 'policy', 1, ?)")
    .run(`tc-${name}`, childRun, childConv, JSON.stringify({ name }), NOV);
}

const skills = (s: Growth) => growthStats(s.app.db, { timezone: 'UTC', project: s.project.id, month: '2026-11' }).buckets[0]!.skills;

test('G-1: 子の担当が読んだスキルは、親とのつながりが「実行の記録」だけにあっても、親のタスクの数に入る', async t => {
  const s = await growthSetup(t);
  parentTaskWithChild(s, 'via-run', 'run');
  assert.deepEqual(skills(s), [{ name: 'via-run', uses: 1, taskUses: 1, chatUses: 0, tasks: 1, done: 0, failed: 1, cancelled: 0, unfinished: 0 }]);
});

test('G-1: 子の担当が読んだスキルは、親とのつながりが「会話」だけにあっても、親のタスクの数に入る', async t => {
  const s = await growthSetup(t);
  parentTaskWithChild(s, 'via-conversation', 'conversation');
  assert.deepEqual(skills(s), [{ name: 'via-conversation', uses: 1, taskUses: 1, chatUses: 0, tasks: 1, done: 0, failed: 1, cancelled: 0, unfinished: 0 }]);
});

test('G-1: 親へのつながりがどちらにも無い子の会話が読んだスキルは、親のタスク・製品の数に入らない（製品の無い会話での使用に数える）', async t => {
  const s = await growthSetup(t);
  parentTaskWithChild(s, 'unlinked', 'none');
  assert.deepEqual(skills(s), [], '親の製品の数には入らない');
  const loose = growthStats(s.app.db, { timezone: 'UTC', project: null, month: '2026-11' }).buckets[0]!.skills;
  assert.deepEqual(loose, [{ name: 'unlinked', uses: 1, taskUses: 0, chatUses: 1, tasks: 0, done: 0, failed: 0, cancelled: 0, unfinished: 0 }]);
});

// --- 積んだ行の親の探し方（parentOf）と、親の会話のまわりで待っている行（waitingAround） ---

function plain(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('parent-conv', 'chat', 'Parent chat', 1, 1)").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('parent-run', 'chat', 'parent-conv', 1)").run();
  return { dir, db };
}

const agentRow = (runId: string, conversationId: string): PendingRow => ({ run_kind: 'agent', run_id: runId, conversation_id: conversationId }) as PendingRow;

test('parentOf: 子の担当の親は、つながりが「実行の記録」だけにあっても分かる', t => {
  const { db } = plain(t);
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('child-conv', 'task', 'Child job', 1, 1)").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, parent_run_id) VALUES ('child-run', 'agent', 'child-conv', 1, 'parent-run')").run();
  assert.deepEqual(parentOf(db, agentRow('child-run', 'child-conv')), { runId: 'parent-run', conversationId: 'parent-conv', kind: 'chat', title: 'Child job' });
});

test('parentOf: 子の担当の親は、つながりが「会話」だけにあっても分かる', t => {
  const { db } = plain(t);
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, parent_run_id) VALUES ('child-conv', 'task', 'Child job', 1, 1, 'parent-run')").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('child-run', 'agent', 'child-conv', 1)").run();
  assert.deepEqual(parentOf(db, agentRow('child-run', 'child-conv')), { runId: 'parent-run', conversationId: 'parent-conv', kind: 'chat', title: 'Child job' });
});

test('parentOf: どちらにもつながりが無い子の担当・子の担当でない行は、親なし', t => {
  const { db } = plain(t);
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('child-conv', 'task', 'Child job', 1, 1)").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('child-run', 'agent', 'child-conv', 1)").run();
  assert.equal(parentOf(db, agentRow('child-run', 'child-conv')), undefined);
  assert.equal(parentOf(db, { ...agentRow('child-run', 'child-conv'), run_kind: 'chat' } as PendingRow), undefined);
});

test('waitingAround: 親の会話のまわりで待っている行に、子の担当の行が入る。つながりが「会話」だけでも「実行の記録」だけでも入り、つながりの無い行は入らない', async t => {
  const { dir, db } = plain(t);
  const store = new PendingStore(db, { tools: new ToolRegistry().register(shellRun), dataDir: dir, now: () => 1_000_000 });
  const park = (runId: string, conversationId: string) => store.park({
    tool: 'shell_run', input: { command: 'npm test' }, cwd: dir, kind: 'send', reason: 'Sends data out', runId, runKind: 'agent', conversationId, check: { decision: 'ask', reasons: ['r'] },
  });
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, parent_run_id) VALUES ('conv-linked', 'task', 'by conversation', 1, 1, 'parent-run')").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('run-by-conv', 'agent', 'conv-linked', 1)").run();
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('conv-run-linked', 'task', 'by run', 1, 1)").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, parent_run_id) VALUES ('run-by-run', 'agent', 'conv-run-linked', 1, 'parent-run')").run();
  db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('conv-stranger', 'task', 'stranger', 1, 1)").run();
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('run-stranger', 'agent', 'conv-stranger', 1)").run();
  await park('run-by-conv', 'conv-linked');
  await park('run-by-run', 'conv-run-linked');
  await park('run-stranger', 'conv-stranger');
  const around = store.waitingAround('parent-conv', null).map(row => row.run_id).sort();
  assert.deepEqual(around, ['run-by-conv', 'run-by-run']);
});
