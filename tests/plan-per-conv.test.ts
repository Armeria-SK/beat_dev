import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, builtinTools } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { Mesh } from '../src/mesh/index.ts';
import { resolvePaths } from '../src/paths.ts';
import { AcceptanceStore } from '../src/projects/acceptance.ts';
import { adoptLegacyPlans, type AdoptIo } from '../src/projects/plan-adopt.ts';
import { planConversationOf, PlanStore, type PlanMeta } from '../src/projects/plan.ts';
import { fakeModel, settled, startApp } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const A = 'cccccccc-0000-4000-8000-00000000000a';
const B = 'cccccccc-0000-4000-8000-00000000000b';
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const AI = (conversationId: string, runId = 'r1') => ({ by: 'ai' as const, tainted: false, conversationId, runId });
const OWNER = { by: 'owner' as const, tainted: false, conversationId: null, runId: null };

function fixture(t: { after: (fn: () => void) => void }, io?: AdoptIo) {
  const paths = resolvePaths(tempDir(t));
  for (const p of [P1, P2]) mkdirSync(join(paths.projects, p), { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1_000;
  const now = () => clock++;
  const kv = new KV(db, now);
  const plans = new PlanStore(kv, { projects: paths.projects, backups: paths.backups }, now);
  const chat = (id: string, project: string | null = P1, at = 0, extra: { kind?: string; source?: string | null; parentRun?: string | null } = {}) =>
    db.prepare('INSERT INTO conversations (id, kind, created_at, last_message_at, project_id, source_conversation_id, parent_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, extra.kind ?? 'chat', at, at, project, extra.source ?? null, extra.parentRun ?? null);
  const task = (id: string, conversation: string | null, createdIn: string | null, project = P1) =>
    db.prepare("INSERT INTO tasks (id, title, status, origin, conversation_id, created_in_conversation, project_id, created_at, updated_at) VALUES (?, 'T', 'ready', 'user', ?, ?, ?, 1, 1)").run(id, conversation, createdIn, project);
  const toolCall = (conversation: string, tool: string, at: number, ok = 1) =>
    db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, 'r', ?, ?, '', 'allow', 'policy', ?, ?)").run(`${conversation}-${tool}-${at}`, conversation, tool, ok, at);
  const legacy = (project: string) => join(paths.projects, project, 'plan.md');
  const own = (project: string, conversation: string) => join(paths.projects, project, 'conversation-plans', `${conversation}.md`);
  const logs: string[] = [];
  const adopt = (with_io: AdoptIo | undefined = io) => adoptLegacyPlans({ kv, projectsDir: paths.projects, backupsDir: paths.backups, log: line => logs.push(line), now, ...(with_io ? { io: with_io } : {}) });
  const legacyBackups = (project: string) => {
    const dir = join(paths.backups, 'mesh', project);
    return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('plan-legacy-')) : [];
  };
  return { paths, db, kv, plans, chat, task, toolCall, legacy, own, logs, adopt, legacyBackups };
}

const seedLegacy = (f: ReturnType<typeof fixture>, project: string, content: string | Buffer, meta?: Partial<PlanMeta>) => {
  writeFileSync(f.legacy(project), content);
  if (meta) f.kv.setJson(`plan:${project}`, { hash: sha(content), updatedAt: 5, by: 'ai', tainted: false, conversationId: null, runId: 'r0', ...meta });
};

test('plan-per-conv: conversations A and B of one product keep separate plans, backups, outside marks and taint', t => {
  const f = fixture(t);
  f.chat(A);
  f.chat(B);
  f.plans.write(P1, A, '# Plan A', AI(A));
  f.plans.write(P1, A, '# Plan A2', AI(A, 'r2'));
  assert.equal(f.plans.view(P1, B).content, null, 'B starts empty');
  f.plans.write(P1, B, '# Plan B', { ...AI(B), tainted: true });
  assert.equal(f.plans.view(P1, A).content, '# Plan A2');
  assert.equal(f.plans.view(P1, A).tainted, false, 'taint of B does not reach A');
  assert.equal(f.plans.view(P1, B).tainted, true);
  assert.deepEqual(readdirSync(join(f.paths.backups, 'mesh', P1, 'plans')), [A], 'writing B makes no backup of A, and B had no earlier version');
  writeFileSync(f.own(P1, B), '# edited by hand');
  assert.equal(f.plans.view(P1, B).updated_by, 'outside');
  assert.equal(f.plans.view(P1, A).updated_by, 'ai');
  assert.deepEqual(readdirSync(join(f.paths.projects, P1, 'conversation-plans')).sort(), [`${A}.md`, `${B}.md`].sort());
  assert.equal(f.kv.getJson<PlanMeta>(`plan:${P1}:${A}`)?.hash, sha('# Plan A2'));
});

test('plan-per-conv: a plan is written only for a chat conversation of the same product; the conversation id must be a lower-case UUID', t => {
  const f = fixture(t);
  f.chat(A, P2);
  f.chat(B, P1, 0, { kind: 'task' });
  const refused = (e: Error & { code?: string }) => e.code === 'unknown_conversation';
  assert.throws(() => f.plans.write(P1, A, 'x', AI(A)), refused, 'other product');
  assert.throws(() => f.plans.write(P1, B, 'x', AI(B)), refused, 'not a chat');
  assert.throws(() => f.plans.write(P1, '../x', 'x', OWNER), refused);
  assert.throws(() => f.plans.write(P1, A.toUpperCase(), 'x', OWNER), refused);
  assert.throws(() => f.plans.review(P1, A, sha('x')), refused);
  assert.deepEqual(f.plans.view(P1, null), { content: null, hash: null, updated_at: null, updated_by: null, tainted: false });
  assert.equal(existsSync(join(f.paths.projects, P1, 'conversation-plans')), false);
});

test('plan-per-conv: planConversationOf follows child agents, reviews, Build tasks and their child tasks back to the chat, and stops at 8 steps', t => {
  const f = fixture(t);
  f.chat(A);
  f.chat(B, P2);
  const child = 'dddddddd-0000-4000-8000-000000000001';
  const review = 'dddddddd-0000-4000-8000-000000000002';
  const buildRun = 'dddddddd-0000-4000-8000-000000000003';
  const subRun = 'dddddddd-0000-4000-8000-000000000004';
  const subAgent = 'dddddddd-0000-4000-8000-000000000005';
  const loose = 'dddddddd-0000-4000-8000-000000000006';
  f.chat(child, P1, 0, { kind: 'task', source: A, parentRun: 'run-1' });
  f.chat(review, P1, 0, { kind: 'task', source: A });
  f.chat(buildRun, P1, 0, { kind: 'task' });
  f.task('build', buildRun, A);
  f.chat(subRun, P1, 0, { kind: 'task' });
  f.task('sub', subRun, buildRun);
  f.chat(subAgent, P1, 0, { kind: 'task', source: subRun, parentRun: 'run-2' });
  f.chat(loose, P1, 0, { kind: 'task' });
  f.task('kanban', loose, null);
  const of = (id: string | null, project = P1) => planConversationOf(f.db, id, project);
  assert.equal(of(A), A);
  assert.equal(of(child), A);
  assert.equal(of(review), A);
  assert.equal(of(buildRun), A);
  assert.equal(of(subRun), A);
  assert.equal(of(subAgent), A);
  assert.equal(of(loose), null, 'a task made outside a conversation has no plan');
  assert.equal(of(B), null, 'a chat of another product');
  assert.equal(of(null), null);
  assert.equal(of('missing'), null);
  const chain = Array.from({ length: 9 }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`);
  chain.forEach((id, i) => f.chat(id, P1, 0, { kind: 'task', source: i + 1 < chain.length ? chain[i + 1]! : A }));
  assert.equal(of(chain[1]!), A, '8 steps reach the chat');
  assert.equal(of(chain[0]!), null, 'more than 8 steps stop');
  f.db.prepare('UPDATE conversations SET source_conversation_id = ? WHERE id = ?').run(child, child);
  assert.equal(of(child), null, 'a loop stops');
});

test('plan-per-conv: has() counts a not yet moved plan.md and any conversation plan; builtHash stays through an outside edit and a rewrite', t => {
  const f = fixture(t);
  f.chat(A);
  assert.equal(f.plans.has(P1), false);
  writeFileSync(f.legacy(P1), '# old');
  assert.equal(f.plans.has(P1), true, 'R8: before the move, the old plan.md still counts');
  renameSync(f.legacy(P1), join(f.paths.projects, P1, 'gone.txt'));
  f.plans.write(P1, A, '# Plan', AI(A));
  assert.equal(f.plans.has(P1), true);
  f.plans.markBuilt(P1, A, sha('# Plan'));
  writeFileSync(f.own(P1, A), '# Plan by hand');
  f.plans.write(P1, A, '# Plan again', OWNER);
  assert.equal(f.plans.builtHash(P1, A), sha('# Plan'));
  assert.equal(f.plans.builtHash(P1, 'cccccccc-0000-4000-8000-0000000000ff'), null);
});

test('plan-per-conv adopt: the old plan goes byte for byte to the conversation in its record, the old file moves to the backups, the old record moves to the new key', t => {
  const f = fixture(t);
  f.chat(A, P1, 10);
  f.chat(B, P1, 20);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Plan\r\nstep\u0001 one\r\n end', 'utf8')]);
  seedLegacy(f, P1, bytes, { conversationId: A });
  const meta = f.kv.getJson<PlanMeta>(`plan:${P1}`)!;
  const result = f.adopt();
  assert.deepEqual(result.map(r => [r.projectId, r.conversationId, r.plan]), [[P1, A, 'moved']]);
  assert.ok(readFileSync(f.own(P1, A)).equals(bytes), 'CRLF, BOM and control characters are copied as they are');
  assert.equal(existsSync(f.legacy(P1)), false);
  const [backup] = f.legacyBackups(P1);
  assert.ok(backup, 'the old plan.md is kept in the backups');
  assert.equal(sha(readFileSync(join(f.paths.backups, 'mesh', P1, backup!))), sha(bytes));
  assert.equal(f.kv.get(`plan:${P1}`), undefined);
  assert.deepEqual(f.kv.getJson(`plan:${P1}:${A}`), meta);
  assert.equal(f.kv.get(`plan-adopt:${P1}`), undefined);
  assert.equal(f.plans.view(P1, A).updated_by, 'ai', 'the record still matches the bytes');
  assert.equal(f.plans.view(P1, B).content, null);
  const again = f.adopt();
  assert.deepEqual(again, [], 'a second start changes nothing');
  assert.ok(readFileSync(f.own(P1, A)).equals(bytes));
  assert.equal(f.legacyBackups(P1).length, 1);
});

test('plan-per-conv adopt: without a recorded conversation it picks the newest plan_write of the product, then the newest chat; a writer that was a child agent maps to its chat; archived products move too', t => {
  const f = fixture(t);
  f.chat(A, P1, 10);
  f.chat(B, P1, 30);
  f.toolCall(A, 'plan_write', 50);
  f.toolCall(B, 'plan_write', 60, 0);
  seedLegacy(f, P1, '# one');
  const other = 'cccccccc-0000-4000-8000-0000000000c2';
  const child = 'dddddddd-0000-4000-8000-0000000000c3';
  f.chat(other, P2, 5);
  f.chat(child, P2, 6, { kind: 'task', source: other, parentRun: 'run' });
  seedLegacy(f, P2, '# two', { conversationId: child });
  f.db.prepare("INSERT INTO projects (id, name, root, root_key, created_at, updated_at, archived_at) VALUES (?, 'p2', 'x', 'x', 1, 1, 9)").run(P2);
  f.adopt();
  assert.equal(readFileSync(f.own(P1, A), 'utf8'), '# one', 'the conversation whose plan_write succeeded, not the failed one');
  assert.equal(readFileSync(f.own(P2, other), 'utf8'), '# two');

  const g = fixture(t);
  g.chat(A, P1, 10);
  g.chat(B, P1, 30);
  seedLegacy(g, P1, '# three');
  g.adopt();
  assert.equal(readFileSync(g.own(P1, B), 'utf8'), '# three', 'the newest chat of the product');
});

test('plan-per-conv adopt: a product without conversations is left alone and moved once its first conversation exists', t => {
  const f = fixture(t);
  seedLegacy(f, P1, '# lonely');
  assert.deepEqual(f.adopt().map(r => [r.conversationId, r.plan]), [[null, 'kept']]);
  assert.equal(readFileSync(f.legacy(P1), 'utf8'), '# lonely');
  assert.equal(f.plans.has(P1), true);
  assert.equal(f.kv.get(`plan-adopt:${P1}`), undefined);
  f.chat(A);
  f.adopt();
  assert.equal(readFileSync(f.own(P1, A), 'utf8'), '# lonely');
});

test('plan-per-conv adopt (R3): when the chosen conversation already wrote its own plan, nothing is copied over it and the old plan goes to the backups', t => {
  const f = fixture(t);
  f.chat(A);
  seedLegacy(f, P1, '# old shared plan');
  f.plans.write(P1, A, '# my own plan', AI(A));
  f.adopt();
  assert.equal(readFileSync(f.own(P1, A), 'utf8'), '# my own plan');
  assert.equal(existsSync(f.legacy(P1)), false);
  assert.equal(readFileSync(join(f.paths.backups, 'mesh', P1, f.legacyBackups(P1)[0]!), 'utf8'), '# old shared plan');
  assert.ok(f.logs.some(line => /already has its own plan/u.test(line)), f.logs.join('\n'));
  assert.equal(f.kv.get(`plan:${P1}`), undefined);
});

test('plan-per-conv adopt (R4): the target is recorded first and kept on the next start, even when a newer conversation appears meanwhile', t => {
  let failMove = true;
  const f = fixture(t, {
    renameSync: (from, to) => {
      if (failMove && to.includes('plan-legacy-')) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      renameSync(from, to);
    },
  });
  f.chat(A, P1, 10);
  seedLegacy(f, P1, '# keep me', { conversationId: A });
  f.adopt();
  assert.equal(readFileSync(f.own(P1, A), 'utf8'), '# keep me', 'the copy is in place');
  assert.equal(readFileSync(f.legacy(P1), 'utf8'), '# keep me', 'EXDEV: the old file stays');
  assert.deepEqual(f.kv.getJson(`plan-adopt:${P1}`), { conversationId: A });
  assert.ok(f.logs.some(line => /Could not move the old plan/u.test(line)));
  f.kv.delete(`plan:${P1}:${A}`);
  f.kv.setJson(`plan:${P1}`, { hash: sha('# keep me'), updatedAt: 5, by: 'ai', tainted: false, conversationId: null, runId: 'r0' });
  f.chat(B, P1, 99);
  f.toolCall(B, 'plan_write', 100);
  failMove = false;
  f.adopt();
  assert.equal(existsSync(f.own(P1, B)), false, 'the recorded target wins over the newer conversation');
  assert.equal(existsSync(f.legacy(P1)), false);
  assert.equal(f.kv.get(`plan-adopt:${P1}`), undefined);
  assert.equal(f.kv.getJson<PlanMeta>(`plan:${P1}:${A}`)?.hash, sha('# keep me'), 'the record is copied on the resumed start');
});

test('plan-per-conv adopt: the old record is copied to the conversation before the old file moves to the backups, so a stop between the two keeps it', t => {
  const seen: unknown[] = [];
  const f = fixture(t, {
    renameSync: (from, to) => {
      if (to.includes('plan-legacy-')) seen.push(f.kv.getJson<PlanMeta>(`plan:${P1}:${A}`)?.by);
      renameSync(from, to);
    },
  });
  f.chat(A, P1, 10);
  seedLegacy(f, P1, '# owner reviewed', { conversationId: A, by: 'owner', tainted: true });
  f.adopt();
  assert.deepEqual(seen, ['owner']);
  assert.equal(f.plans.view(P1, A).tainted, true, 'the taint mark survives the move');
});

test('plan-per-conv adopt: a crash after the move (only the new body and the old record left) is finished; one failing product does not stop the others', t => {
  const f = fixture(t);
  f.chat(A, P1);
  mkdirSync(join(f.paths.projects, P1, 'conversation-plans'), { recursive: true });
  writeFileSync(f.own(P1, A), '# moved');
  writeFileSync(join(f.paths.projects, P1, 'conversation-plans', `${A}.md.tmp-abc123`), 'half');
  f.kv.setJson(`plan:${P1}`, { hash: 'x' });
  f.kv.setJson(`plan-adopt:${P1}`, { conversationId: A });
  const B2 = 'cccccccc-0000-4000-8000-0000000000b2';
  f.chat(B2, P2);
  seedLegacy(f, P2, '# second');
  writeFileSync(join(f.paths.projects, P2, 'conversation-plans'), 'not a folder');
  const P3 = 'aaaaaaaa-0000-4000-8000-0000000000a3';
  mkdirSync(join(f.paths.projects, P3), { recursive: true });
  f.chat('cccccccc-0000-4000-8000-0000000000b3', P3);
  seedLegacy(f, P3, '# third');
  f.adopt();
  assert.equal(f.kv.get(`plan:${P1}`), undefined);
  assert.equal(f.kv.get(`plan-adopt:${P1}`), undefined);
  assert.deepEqual(readdirSync(join(f.paths.projects, P1, 'conversation-plans')), [`${A}.md`], 'left-over temp files are removed');
  assert.ok(f.logs.some(line => line.includes(P2) && /Could not move the plan/u.test(line)), f.logs.join('\n'));
  assert.equal(readFileSync(f.legacy(P2), 'utf8'), '# second', 'the failing product keeps its plan.md');
  assert.equal(readFileSync(f.own(P3, 'cccccccc-0000-4000-8000-0000000000b3'), 'utf8'), '# third', 'the next product still moves');
});

test('plan-per-conv adopt (R5): after the move a fresh Mesh rewrites INDEX.md and STATE.md without a plan.md line', t => {
  const f = fixture(t);
  f.chat(A);
  seedLegacy(f, P1, '# Plan heading', { conversationId: A });
  const dir = join(f.paths.projects, P1);
  writeFileSync(join(dir, 'STATE.md'), '# STATE\n\n## Status (kept by beat)\n- running tasks: none\n- acceptance: not written yet\n- plan.md: updated 2026-11-01\n\n## Notes (mesh_state_set)\n');
  writeFileSync(join(dir, 'INDEX.md'), '# Mesh\n- plan.md — Plan heading (updated 2026-11-01)\n');
  f.adopt();
  const mesh = new Mesh({ projectsDir: f.paths.projects, backupsDir: f.paths.backups, plans: f.plans, acceptance: new AcceptanceStore(f.db, f.paths.projects), timezone: () => 'UTC' });
  mesh.persist(P1);
  assert.doesNotMatch(readFileSync(join(dir, 'STATE.md'), 'utf8'), /plan\.md/u);
  assert.doesNotMatch(readFileSync(join(dir, 'INDEX.md'), 'utf8'), /plan\.md/u);
  assert.match(mesh.indexBody(P1, 1000, A), /^- plan\.md — \(AI note\) Plan heading/mu, 'the conversation still sees its plan in its own index');
  assert.match(mesh.indexBody(P1, 1000, null), /^- plan\.md — not written yet$/mu);
});

test('plan-per-conv: deleting a conversation deletes its plan, its record and its backups; the other conversation keeps its plan', async t => {
  const s = await startApp(t);
  const made = s.app.projects.create({ name: 'shop', root: tempDir(t), rootKey: 'shop-key', checkCommand: null });
  const a = s.app.conversations.create({ projectId: made.id }).id;
  const b = s.app.conversations.create({ projectId: made.id }).id;
  s.app.plans.write(made.id, a, '# A', AI(a));
  s.app.plans.write(made.id, a, '# A2', OWNER);
  s.app.plans.write(made.id, b, '# B', AI(b));
  s.app.plans.markBuilt(made.id, a, sha('# A2'));
  const draftOf = (conversation: string) => join(s.paths.projects, made.id, 'conversation-plans', `${conversation}.acceptance.json`);
  writeFileSync(draftOf(a), '{"draft":"A"}');
  writeFileSync(draftOf(b), '{"draft":"B"}');
  const frozen = join(s.paths.projects, made.id, 'acceptance.json');
  writeFileSync(frozen, '{"frozen":true}');
  assert.ok(existsSync(join(s.paths.backups, 'mesh', made.id, 'plans', a)));
  const deleted = await s.json(`/api/conversations/${a}`, 'DELETE');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.files.failed, []);
  assert.equal(existsSync(join(s.paths.projects, made.id, 'conversation-plans', `${a}.md`)), false);
  assert.equal(existsSync(join(s.paths.backups, 'mesh', made.id, 'plans', a)), false);
  assert.equal(s.app.kv.get(`plan:${made.id}:${a}`), undefined);
  assert.equal(s.app.kv.get(`plan-built:${made.id}:${a}`), undefined);
  assert.equal(s.app.plans.view(made.id, b).content, '# B');
  assert.equal(existsSync(draftOf(a)), false, 'the draft list of A goes with A');
  assert.equal(readFileSync(draftOf(b), 'utf8'), '{"draft":"B"}', 'the draft list of B stays');
  assert.equal(readFileSync(frozen, 'utf8'), '{"frozen":true}', 'the locked list of the product stays');
});

function meshFixture(t: { after: (fn: () => void) => void }) {
  const f = fixture(t);
  f.chat(A, P1, 1);
  f.chat(B, P1, 2);
  const mesh = new Mesh({ projectsDir: f.paths.projects, backupsDir: f.paths.backups, plans: f.plans, acceptance: new AcceptanceStore(f.db, f.paths.projects), timezone: () => 'UTC' });
  return { ...f, mesh };
}

test('plan-per-conv mesh: the plan of A is in the index, search and plan.md of A only; B sees "not written yet" and its own plan; the index cache is per conversation', t => {
  const f = meshFixture(t);
  f.plans.write(P1, A, '# Alpha plan\nsecret-alpha-step\n', AI(A));
  const before = f.mesh.builds;
  const indexA = f.mesh.indexBody(P1, 1000, A);
  const indexB = f.mesh.indexBody(P1, 1000, B);
  assert.match(indexA, /^- plan\.md — \(AI note\) Alpha plan/mu);
  assert.match(indexB, /^- plan\.md — not written yet$/mu);
  assert.equal(f.mesh.builds, before + 2, 'one index per conversation');
  assert.equal(f.mesh.indexBody(P1, 1000, A), indexA);
  assert.equal(f.mesh.builds, before + 2);
  assert.match(f.mesh.read(P1, { file: 'plan.md' }, 4000, 'en', A).content, /secret-alpha-step/u);
  assert.throws(() => f.mesh.read(P1, { file: 'plan.md' }, 4000, 'en', B), /not found|No file/iu);
  assert.match(f.mesh.search(P1, { query: 'secret-alpha-step' }, 4000, 'en', A).content, /plan\.md:2/u);
  assert.doesNotMatch(f.mesh.search(P1, { query: 'secret-alpha-step' }, 4000, 'en', B).content, /secret-alpha-step/u);
  f.plans.write(P1, B, '# Beta plan\n', AI(B));
  assert.match(f.mesh.indexBody(P1, 1000, B), /^- plan\.md — \(AI note\) Beta plan/mu);
  assert.match(f.mesh.indexBody(P1, 1000, A), /Alpha plan/u, 'B writing does not change what A sees');
  assert.doesNotMatch(f.mesh.indexBody(P1, 1000, A), /conversation-plans/u);
});

test('plan-per-conv mesh: a hand edit of the conversation plan file rebuilds the index of that conversation', t => {
  const f = meshFixture(t);
  f.plans.write(P1, A, '# Clean heading\n', AI(A));
  assert.match(f.mesh.indexBody(P1, 1000, A), /^- plan\.md — \(AI note\) Clean heading/mu);
  const before = f.mesh.builds;
  const file = f.own(P1, A);
  writeFileSync(file, '# Outside heading from editor\n');
  utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const after = f.mesh.indexBody(P1, 1000, A);
  assert.equal(f.mesh.builds, before + 1, 'rebuilt');
  assert.doesNotMatch(after, /AI note|Clean heading|Outside heading/u);
  assert.match(after, /^- plan\.md \(updated /mu);
});

test('plan-per-conv mesh (R1): conversation-plans/ is never read by path, in any spelling, by mesh_read or by mesh_search with file', t => {
  const f = meshFixture(t);
  f.plans.write(P1, A, '# Alpha\nsecret-alpha-step\n', { ...AI(A), tainted: true });
  symlinkSync(join(f.paths.projects, P1, 'conversation-plans'), join(f.paths.projects, P1, 'a-link'), 'junction');
  for (const path of [`conversation-plans/${A}.md`, `Conversation-Plans/${A}.md`, `CONVERSATION-PLANS\\${A}.md`, `conversation-plans\\${A}.md`, `./conversation-plans/${A}.md`, `a-link/${A}.md`, `a-link\\${A}.md`, `conversation-plans/${A.toUpperCase()}.md`, 'conversation-plans']) {
    for (const as of [B, A, null]) {
      assert.throws(() => f.mesh.read(P1, { file: path }, 4000, 'en', as), (e: Error) => !/secret-alpha-step/u.test(e.message), `${path} as ${as}`);
      assert.throws(() => f.mesh.search(P1, { query: 'secret', file: path }, 4000, 'en', as), (e: Error) => !/secret-alpha-step/u.test(e.message), `search ${path} as ${as}`);
    }
  }
  assert.doesNotMatch(f.mesh.search(P1, { query: 'secret-alpha-step' }, 4000, 'en', B).content, /secret-alpha-step/u, 'not through the folder walk either, even through a junction');
  assert.doesNotMatch(f.mesh.indexBody(P1, 1000, B), /a-link|cccccccc/u, 'the junction alias is not listed in the index');
  assert.equal(f.mesh.read(P1, { file: 'plan.md' }, 4000, 'en', A).fetched, true, 'A still reads its own plan by name, with its mark');
});

const callTool = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

test('plan-per-conv Build: it needs a chat conversation of the product, uses that conversation\'s plan, records built_hash there only, and the Build task reads that plan with mesh_read("plan.md")', async t => {
  const products = realpathSync.native(tempDir(t));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  mkdirSync(join(products, 'shop'));
  const shop = (await s.json('/api/projects', 'POST', { root: join(products, 'shop') })).body.project as { id: string };
  const a = s.app.conversations.create({ projectId: shop.id }).id;
  const b = s.app.conversations.create({ projectId: shop.id }).id;
  const put = async (conversationId: string, content: string) => (await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content, baseHash: null, conversationId })).body.plan as { hash: string };
  const planA = await put(a, '# Plan A\nalpha-only-step');
  const planB = await put(b, '# Plan B\nbeta-only-step');
  const acceptanceHash = (await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance.hash;
  const noConversation = await s.json(`/api/projects/${shop.id}/build`, 'POST', { planHash: planA.hash, acceptanceHash });
  assert.deepEqual([noConversation.status, noConversation.body.code], [400, 'plan.unknown_conversation']);
  const crossed = await s.json(`/api/projects/${shop.id}/build`, 'POST', { planHash: planA.hash, acceptanceHash, conversationId: b });
  assert.deepEqual([crossed.status, crossed.body.code], [409, 'build.changed'], 'B cannot build with the plan of A');
  const built = await s.json(`/api/projects/${shop.id}/build`, 'POST', { planHash: planA.hash, acceptanceHash, conversationId: a });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.task.created_in_conversation, a);
  const read = async (conversationId: string) => (await s.json(`/api/projects/${shop.id}/plan?conversationId=${conversationId}`, 'GET')).body.plan as { built_hash: string | null };
  assert.equal((await read(a)).built_hash, planA.hash);
  assert.equal((await read(b)).built_hash, null, 'the Build of A does not mark B');
  assert.equal((await s.json(`/api/projects/${shop.id}/plan`, 'GET')).status, 400);
  assert.notEqual(planB.hash, planA.hash);
  s.adapter().scripts = [callTool('mesh_read', { file: 'plan.md' }), reply('done')];
  assert.equal(await s.app.worker.tick(), 'ran');
  const result = s.adapter().calls.at(-1)!.messages.map(m => JSON.stringify(m)).join('\n');
  assert.match(result, /alpha-only-step/u, 'the Build task reads the plan of the conversation it was built from');
  assert.doesNotMatch(result, /beta-only-step/u);
});

test('plan-per-conv P2b: before the first Build each conversation has its own draft acceptance list; the Build of B locks B\'s draft as v1 and A then sees that version; coverage still counts the owner speech of every conversation', async t => {
  const products = realpathSync.native(tempDir(t));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  mkdirSync(join(products, 'shop'));
  const shop = (await s.json('/api/projects', 'POST', { root: join(products, 'shop') })).body.project as { id: string };
  const a = s.app.conversations.create({ projectId: shop.id }).id;
  const b = s.app.conversations.create({ projectId: shop.id }).id;
  const send = async (id: string, text: string) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text, projectId: shop.id });
    if (sent.status === 202 && sent.body.runId) await settled(s.app, sent.body.runId);
  };
  const write = (result: string) => [callTool('acceptance_write', { items: [{ result, source: 'ai_added', check: 'look' }] }), reply('ok')];
  const list = async (id?: string) => (await s.json(`/api/projects/${shop.id}/acceptance${id ? `?conversationId=${id}` : ''}`, 'GET')).body;
  s.adapter().scripts = write('Alpha result');
  await send(a, 'Alpha speech from the owner');
  s.adapter().scripts = write('Beta result');
  await send(b, 'Beta speech from the owner');
  const results = async (id?: string) => (await list(id)).acceptance.items.map((i: { result: string }) => i.result);
  assert.deepEqual(await results(a), ['Alpha result'], 'the write of B does not replace the draft of A');
  assert.deepEqual(await results(b), ['Beta result'], 'B does not see the draft of A');
  assert.deepEqual(await results(), [], 'without a conversation no draft is shown');
  assert.equal(existsSync(join(s.paths.projects, shop.id, 'acceptance.json')), false);
  const coverage = (await list(b)).coverage as { unreferenced: Array<{ text: string; conversation_id: string }> };
  assert.ok(coverage.unreferenced.some(m => m.conversation_id === a && /Alpha speech/u.test(m.text)), 'coverage stays per product');

  const planB = (await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: '# Plan B', baseHash: null, conversationId: b })).body.plan as { hash: string };
  const built = await s.json(`/api/projects/${shop.id}/build`, 'POST', { planHash: planB.hash, acceptanceHash: (await list(b)).acceptance.hash, conversationId: b });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  const seenByA = (await list(a)).acceptance;
  assert.deepEqual([seenByA.version, seenByA.draft, seenByA.items.map((i: { result: string }) => i.result)], [1, false, ['Beta result']], 'after the Build there is one list per product');
  assert.deepEqual(await results(), ['Beta result']);
  s.adapter().scripts = write('Alpha again');
  await send(a, 'rewrite');
  assert.deepEqual(await results(a), ['Beta result'], 'after the Build a draft write is refused');
});

test('plan-per-conv P2b adopt: an old draft acceptance.json (version 0, never locked) goes byte for byte to the chosen conversation; a locked list stays in the product folder', t => {
  const f = fixture(t);
  f.chat(A, P1, 10);
  f.chat(B, P2, 10);
  const draftBytes = Buffer.from('{"schema":1,"version":0,"language":null,"items":[],"notDoing":[]}\r\n', 'utf8');
  writeFileSync(join(f.paths.projects, P1, 'acceptance.json'), draftBytes);
  const locked = '{"schema":1,"version":1,"language":null,"items":[],"notDoing":[]}';
  writeFileSync(join(f.paths.projects, P2, 'acceptance.json'), locked);
  f.db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, created_at) VALUES (?, 1, 'h', ?, 'build', 1)").run(P2, locked);
  const result = f.adopt();
  assert.deepEqual(result.map(r => [r.projectId, r.conversationId, r.draft]), [[P1, A, 'moved']]);
  assert.ok(readFileSync(join(f.paths.projects, P1, 'conversation-plans', `${A}.acceptance.json`)).equals(draftBytes));
  assert.equal(existsSync(join(f.paths.projects, P1, 'acceptance.json')), false);
  const backup = readdirSync(join(f.paths.backups, 'mesh', P1)).find(name => name.startsWith('acceptance-legacy-'));
  assert.ok(backup && readFileSync(join(f.paths.backups, 'mesh', P1, backup)).equals(draftBytes));
  assert.equal(readFileSync(join(f.paths.projects, P2, 'acceptance.json'), 'utf8'), locked);
  assert.equal(existsSync(join(f.paths.projects, P2, 'conversation-plans')), false);
});

test('plan-per-conv adopt (R5): on start beat also rewrites INDEX.md of archived products', t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const open = () => new App({ paths, log: () => undefined, workerTimers: false });
  const first = open();
  const made = first.projects.create({ name: 'old', root: tempDir(t), rootKey: 'old-key', checkCommand: null });
  const chat = first.conversations.create({ projectId: made.id }).id;
  first.projects.update(made.id, { archived: true });
  first.close();
  const dir = join(paths.projects, made.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), '# Old heading');
  writeFileSync(join(dir, 'INDEX.md'), '# Mesh\n- plan.md — Old heading (updated 2026-11-01)\n');
  open().close();
  assert.equal(readFileSync(join(dir, 'conversation-plans', `${chat}.md`), 'utf8'), '# Old heading');
  assert.doesNotMatch(readFileSync(join(dir, 'INDEX.md'), 'utf8'), /plan\.md|Old heading/u);
});
