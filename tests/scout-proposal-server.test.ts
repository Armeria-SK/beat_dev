import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../src/config/store.ts';
import type { Proposal } from '../src/tasks/proposal.ts';
import { taskView, TaskError } from '../src/tasks/store.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { tempDir, testConfig } from './helpers.ts';

const PROPOSAL: Proposal = {
  kind: 'feature', why: 'Uploads restart from zero after a dropped connection. Resuming saves the owner minutes per file.',
  area: ['src/upload/'], size: 'M', goal: null, evidence: 'src/upload/send.ts has no offset handling', ledger: 'L-0007',
};

async function setup(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products] });
  const root = join(products, 'shop');
  mkdirSync(root, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { ...s, projectId: made.body.project.id as string };
}

const propose = (s: Awaited<ReturnType<typeof setup>>, over: Partial<Proposal> = {}) => s.app.tasks.create({
  title: 'Resume interrupted uploads', body: 'Resume from the last byte the server has.', origin: 'self', propose: true, projectId: s.projectId, proposal: { ...PROPOSAL, ...over }, actor: 'beat',
});

test('proposal rows: origin self + proposed_by NULL + proposal; approve makes it the owner\'s (origin user) so pickNext takes it with autonomy off; unapprove puts it back in inbox as self and keeps the proposal', async t => {
  const s = await setup(t);
  const made = propose(s);
  assert.deepEqual({ status: made.status, origin: made.origin, proposed_by: made.proposed_by }, { status: 'inbox', origin: 'self', proposed_by: null });
  assert.equal(s.app.config().worker.autonomy, false, 'precondition: Work on its own is off');

  const listed = await s.json(`/api/tasks?project=${s.projectId}`, 'GET');
  assert.equal(listed.status, 200);
  const card = listed.body.active.find((task: { id: string }) => task.id === made.id);
  assert.deepEqual(card.proposal, PROPOSAL, 'the API carries the parsed proposal, not the raw text');

  const approved = await s.json(`/api/tasks/${made.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual({ status: approved.body.task.status, origin: approved.body.task.origin, proposed_by: approved.body.task.proposed_by }, { status: 'ready', origin: 'user', proposed_by: 'self' });
  assert.deepEqual(approved.body.task.proposal, PROPOSAL, 'the proposal stays after approval');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, made.id, 'the worker picks the approved proposal without autonomy');

  const undone = await s.json(`/api/tasks/${made.id}/unapprove`, 'POST', {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual({ status: undone.body.task.status, origin: undone.body.task.origin, proposed_by: undone.body.task.proposed_by }, { status: 'inbox', origin: 'self', proposed_by: null });
  assert.deepEqual(undone.body.task.proposal, PROPOSAL, 'the proposal stays after unapproval');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false }), undefined, 'back in inbox: nothing to pick');

  assert.throws(() => s.app.db.prepare("UPDATE tasks SET origin = 'scout' WHERE id = ?").run(made.id), /CHECK/u, 'the origin CHECK is intact');
});

test('proposal rows: Reject (cancel with a reason) closes the card as rejected and keeps the proposal', async t => {
  const s = await setup(t);
  const made = propose(s, { kind: 'bug', size: 'S' });
  const rejected = await s.json(`/api/tasks/${made.id}/cancel`, 'POST', { reason: 'Not now' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.deepEqual({ status: rejected.body.task.status, cancelled_from: rejected.body.task.cancelled_from, origin: rejected.body.task.origin }, { status: 'cancelled', cancelled_from: 'inbox', origin: 'self' });
  assert.equal(rejected.body.task.proposal.kind, 'bug');
});

test('proposal shape: create refuses a wrong shape or a field over its limit; taskView reads a broken or wrong-shaped column as null; plain tasks have proposal null', async t => {
  const s = await setup(t);
  const bad: Array<[string, Partial<Record<keyof Proposal | 'extra', unknown>>]> = [
    ['kind', { kind: 'idea' }], ['why empty', { why: ' ' }], ['why long', { why: 'x'.repeat(401) }], ['area count', { area: Array.from({ length: 11 }, (_, i) => `a${i}`) }],
    ['area long', { area: ['x'.repeat(201)] }], ['area type', { area: 'src/' }], ['size', { size: 'XL' }], ['goal long', { goal: 'x'.repeat(201) }],
    ['evidence long', { evidence: 'x'.repeat(2001) }], ['extra', { extra: 1 }],
  ];
  for (const [label, over] of bad) assert.throws(() => propose(s, over as Partial<Proposal>), (e: unknown) => e instanceof TaskError && e.code === 'error.bad_proposal', label);
  const edge = propose(s, { why: 'x'.repeat(400), area: Array.from({ length: 10 }, () => 'y'.repeat(200)), goal: 'g'.repeat(200), evidence: 'e'.repeat(2000) });
  assert.equal(taskView(edge).proposal?.why.length, 400, 'the limits themselves are allowed');

  const plain = s.app.tasks.create({ title: 'Plain', origin: 'user', actor: 'user' });
  assert.equal(plain.proposal, null);
  assert.equal(taskView(plain).proposal, null);
  for (const raw of ['{not json', '[]', '"text"', JSON.stringify({ ...PROPOSAL, size: 'XL' }), JSON.stringify({ ...PROPOSAL, why: 'x'.repeat(401) }), JSON.stringify({ ...PROPOSAL, extra: true })]) {
    s.app.db.prepare('UPDATE tasks SET proposal = ? WHERE id = ?').run(raw, plain.id);
    assert.equal(taskView(s.app.tasks.get(plain.id)!).proposal, null, raw.slice(0, 40));
  }
  const res = await s.json(`/api/tasks/${plain.id}`, 'GET');
  assert.equal(res.body.task.proposal, null, 'the API never passes the raw column through');
});

test('PATCH /api/projects/:id scoutMode: off and research are saved; fix is refused until it arrives; other values are refused', async t => {
  const s = await setup(t);
  const patch = (body: unknown) => s.json(`/api/projects/${s.projectId}`, 'PATCH', body);
  const research = await patch({ scoutMode: 'research' });
  assert.equal(research.status, 200, JSON.stringify(research.body));
  assert.equal(research.body.project.scout_mode, 'research');
  assert.equal(s.app.projects.get(s.projectId)!.scout_mode, 'research');
  const kept = await patch({ name: 'Shop' });
  assert.equal(kept.body.project.scout_mode, 'research', 'a patch without scoutMode keeps it');
  const fix = await patch({ scoutMode: 'fix' });
  assert.equal(fix.status, 400);
  assert.equal(fix.body.code, 'project.scout_fix_later');
  for (const value of ['auto', 1, null, '']) {
    const r = await patch({ scoutMode: value });
    assert.equal(r.status, 400, String(value));
    assert.equal(r.body.code, 'project.bad_scout_mode');
  }
  assert.equal(s.app.projects.get(s.projectId)!.scout_mode, 'research', 'refused patches change nothing');
  const off = await patch({ scoutMode: 'off' });
  assert.equal(off.body.project.scout_mode, 'off');
});

test('config: routing.scout is optional and must name existing models; scout.cloudRunsPerHour defaults to 1 and stays within 0 to 60', () => {
  const base = () => { const c = testConfig(); c.models = [fakeModel('m1')]; c.routing = { chat: ['m1'], background: [], retriesPerModel: 0 }; c.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }]; return c as Record<string, any>; };
  const plain = parseConfig(base());
  assert.equal(plain.routing.scout, undefined, 'empty by default (= Off)');
  assert.equal(plain.scout, undefined, 'not written when not set');
  const set = base(); set.routing.scout = ['m1']; set.scout = {};
  const parsed = parseConfig(set);
  assert.deepEqual(parsed.routing.scout, ['m1']);
  assert.equal(parsed.scout?.cloudRunsPerHour, 1);
  const empty = base(); empty.routing.scout = [];
  assert.deepEqual(parseConfig(empty).routing.scout, []);
  const missing = base(); missing.routing.scout = ['nope'];
  assert.throws(() => parseConfig(missing), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path === 'routing.scout'));
  for (const n of [-1, 61, 1.5]) {
    const over = base(); over.scout = { cloudRunsPerHour: n };
    assert.throws(() => parseConfig(over), ConfigError, String(n));
  }
  for (const n of [0, 60]) { const ok = base(); ok.scout = { cloudRunsPerHour: n }; assert.equal(parseConfig(ok).scout?.cloudRunsPerHour, n); }
});
