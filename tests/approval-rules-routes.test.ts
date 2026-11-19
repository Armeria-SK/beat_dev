import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { addRule, type RuleCandidate } from '../src/tools/approval-rules.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { startApp } from './app-setup.ts';

const fake: ToolDef<{ text: string }> = {
  name: 'fake_rule', description: 'x', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task'],
  summarize: input => ({ title: 'Fake', body: input.text }), execute: async () => ({ content: 'done', exitCode: 0 }),
};

const HELD = 'heldvalue-9f8e7d6c5b4a';
const held: Array<{ source: string; value: string }> = [];
const holder: ToolDef<{ text: string }> = { ...fake, name: 'fake_held', held: () => held };

const CANDIDATE: RuleCandidate = { kind: 'policy', tool: 'fake_rule', base: '{"name":"fake_rule","v":1}', keys: ['policy.tool'], shown: 'Use tool fake_rule' };

async function setup(t: Parameters<typeof startApp>[0]) {
  const s = await startApp(t, { tools: [...builtinTools(), fake, holder] });
  const root = join(s.paths.workspace, 'shop');
  mkdirSync(root, { recursive: true });
  const project = s.app.projects.create({ name: 'Shop', root, rootKey: rootKeyOf(root), checkCommand: null });
  const conversation = s.app.conversations.create({ title: 'c' });
  const park = (over: { rule?: RuleCandidate | undefined; tainted?: boolean; projectId?: string | null; tool?: string; runKind?: 'chat' | 'task' } = {}) => s.app.pending.park({
    tool: over.tool ?? 'fake_rule', input: { text: 'hi' }, cwd: root, kind: 'policy', reason: 'Ask', runId: 'run-1', runKind: over.runKind ?? 'chat', conversationId: conversation.id,
    projectId: over.projectId === undefined ? project.id : over.projectId, tainted: over.tainted ?? false, ...('rule' in over ? { rule: over.rule } : { rule: { ...CANDIDATE, tool: over.tool ?? 'fake_rule' } }),
  });
  const rules = async () => (await s.json('/api/approval-rules', 'GET')).body.items as Array<{ id: number; project_id: string; project_name: string; kind: string; tool: string; shown: string; archived: boolean }>;
  return { ...s, project, park, rules };
}

test('J-5 口: remember の Approve で候補どおりの決まりが 1 つ。本文の形や別の欄は使わず、2 回目は 409 で増えない。一覧と消す', async t => {
  const s = await setup(t);
  const row = await s.park();
  assert.deepEqual(row.rule, { shown: CANDIDATE.shown });
  const res = await s.json(`/api/pending/${row.id}/approve`, 'POST', { remember: true, kind: 'judge', tool: 'shell_run', base: '{"cmd":["rm"]}', keys: ['x'], shown: 'everything', projectId: 'other' });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const list = await s.rules();
  assert.deepEqual(list.map(r => [r.project_id, r.project_name, r.kind, r.tool, r.shown, r.archived]), [[s.project.id, 'Shop', 'policy', 'fake_rule', CANDIDATE.shown, false]]);
  const stored = s.app.db.prepare('SELECT base, keys, from_pending FROM approval_rules').get() as { base: string; keys: string; from_pending: number };
  assert.deepEqual([stored.base, JSON.parse(stored.keys), stored.from_pending], [CANDIDATE.base, CANDIDATE.keys, row.id]);
  const twice = await s.json(`/api/pending/${row.id}/approve`, 'POST', { remember: true });
  assert.equal(twice.status, 409);
  assert.match(JSON.stringify(twice.body), /no longer waiting|not_waiting/u, 'a decided row says it is no longer waiting');
  const same = await s.park();
  assert.equal((await s.json(`/api/pending/${same.id}/approve`, 'POST', { remember: true })).status, 202);
  assert.equal((await s.rules()).length, 1, 'the same shape is not added twice');

  const removed = await s.json(`/api/approval-rules/${list[0]!.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(await s.rules(), []);
  assert.equal((await s.json(`/api/approval-rules/${list[0]!.id}`, 'DELETE')).status, 404);
  const bad = await s.json('/api/approval-rules/abc', 'DELETE');
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /rule id/u);
});

test('J-5 口: 候補の無い行・製品の無い行・タスクの実行の task_create の行は 409 で、行は待ちのまま、決まりは増えない。本文なしの Approve は今までどおり。AP-1（Q1）で反転: 外を読んだ行は 202 で決まりが 1 つ', async t => {
  const s = await setup(t);
  const rows = [await s.park({ rule: undefined }), await s.park({ projectId: null }), await s.park({ tool: 'task_create', runKind: 'task' })];
  for (const row of rows) {
    assert.equal(row.rule, null, `row ${row.id} offers no choice`);
    const res = await s.json(`/api/pending/${row.id}/approve`, 'POST', { remember: true });
    assert.equal(res.status, 409, `row ${row.id}`);
    assert.equal(s.app.pending.row(row.id)!.status, 'waiting');
  }
  assert.deepEqual(await s.rules(), []);
  assert.equal((await s.json(`/api/pending/${rows[0]!.id}/approve`, 'POST', { remember: 'yes' })).status, 400);
  const plain = await s.api(`/api/pending/${rows[0]!.id}/approve`, { method: 'POST' });
  assert.equal(plain.status, 202, 'no body: approve as before');
  assert.deepEqual(await s.rules(), []);
  const tainted = await s.park({ tainted: true });
  assert.deepEqual(tainted.rule, { shown: CANDIDATE.shown }, 'a row from a run that read outside text offers the choice');
  assert.equal((await s.json(`/api/pending/${tainted.id}/approve`, 'POST', { remember: true })).status, 202);
  assert.equal((await s.rules()).length, 1);
});

test('J-5 口: Origin の無い書き込みは今までどおり断る（決まりも足さない・消さない）', async t => {
  const s = await setup(t);
  const row = await s.park();
  const noOrigin = await fetch(`${s.origin}/api/pending/${row.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"remember":true}' });
  assert.equal(noOrigin.status, 403);
  const foreign = await fetch(`${s.origin}/api/pending/${row.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"remember":true}' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await s.rules(), []);
  assert.equal(s.app.pending.row(row.id)!.status, 'waiting');
  assert.equal((await s.json(`/api/pending/${row.id}/approve`, 'POST', { remember: true })).status, 202);
  const id = (await s.rules())[0]!.id;
  const del = await fetch(`${s.origin}/api/approval-rules/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 403);
  assert.equal((await s.rules()).length, 1);
});

test('J-5 口（預かった秘密）: 積んだあとで道具の預かった値が行の入力に入った行は、remember を送られても 409 で決まりは増えず、行は待ちのまま。本文なしの Approve は通る', async t => {
  const s = await setup(t);
  held.length = 0;
  t.after(() => { held.length = 0; });
  const row = await s.app.pending.park({ tool: 'fake_held', input: { text: `use ${HELD}` }, cwd: s.project.root, kind: 'policy', reason: 'Ask', runId: 'run-1', runKind: 'chat', conversationId: s.app.conversations.create({ title: 'c' }).id, projectId: s.project.id, tainted: false, rule: { ...CANDIDATE, tool: 'fake_held' } });
  assert.ok(row.rule, 'control: offered while the value is not held');
  held.push({ source: 'fake key', value: HELD });
  const res = await s.json(`/api/pending/${row.id}/approve`, 'POST', { remember: true });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal((await s.rules()).length, 0);
  assert.equal(s.app.pending.row(row.id)!.status, 'waiting');
  assert.equal((await s.json(`/api/pending/${row.id}/approve`, 'POST', {})).status, 202);
});

test('J-5 一覧（預かった秘密）: 預かる前に覚えた決まりの見せる 1 行は、一覧では預かった値を印に替える（保存した行はそのまま）', async t => {
  const s = await setup(t);
  held.length = 0;
  t.after(() => { held.length = 0; });
  addRule(s.app.db, { projectId: s.project.id, candidate: { kind: 'policy', tool: 'fake_rule', base: '{"name":"fake_rule","v":1}', keys: ['policy.tool'], shown: `Run exactly: node build.js ${HELD}` }, fromPending: 1, now: 1 });
  assert.ok((await s.rules())[0]!.shown.includes(HELD), 'control: not held yet');
  held.push({ source: 'fake key', value: HELD });
  const shown = (await s.rules())[0]!.shown;
  assert.equal(shown, 'Run exactly: node build.js [BEAT-SECRET: fake key]');
  assert.ok((s.app.db.prepare('SELECT shown FROM approval_rules').get() as { shown: string }).shown.includes(HELD), 'residual: the stored row keeps it');
});
