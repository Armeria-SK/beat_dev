import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  let n = 0;
  const taintedRun = () => {
    n += 1;
    const chat = app.conversations.create({ title: `tainted ${n}` });
    const runId = `run-tainted-${n}`;
    app.runs.start(runId, 'chat', chat.id);
    app.runs.markTainted(runId);
    return runId;
  };
  const byTitle = (title: string) => app.db.prepare('SELECT * FROM tasks WHERE title = ?').get(title) as Record<string, unknown> | undefined;
  return { app, adapter: () => adapter, clock, taintedRun, byTitle };
}

async function chatMakes(s: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>) {
  s.adapter().scripts.push(toolCall('task_create', args), reply('ok'));
  const outcome = s.app.engine.send(`c-${Math.random().toString(36).slice(2)}`, 'please');
  assert.ok(outcome.ok);
  assert.ok((await s.app.engine.wait(outcome.runId))?.ok);
}

async function taskMakes(s: Awaited<ReturnType<typeof setup>>, parentId: string, args: Record<string, unknown>) {
  s.adapter().scripts.push(toolCall('task_create', args), toolCall('task_complete', { summary: 'split', notify: false }));
  s.app.worker.requestRun(parentId);
  assert.equal(await s.app.worker.tick(), 'ran');
}

test('5-1: 承認した beat の提案は、自発行動オフ・静かな時間帯・持ち主が今触っている、のどれでも選ばれて動く', async t => {
  const s = await setup(t, c => { c.worker.autonomy = false; c.worker.idleMinutes = 5; c.worker.quietStart = '00:00'; c.worker.quietEnd = '23:59'; });
  for (const origin of ['self', 'curiosity'] as const) {
    const proposal = s.app.tasks.create({ title: `proposal-${origin}`, origin, propose: true, actor: 'beat' });
    assert.equal(proposal.status, 'inbox');
    s.app.engine.lastUserActivity = s.clock.now;
    assert.equal(await s.app.worker.tick(), 'idle', `${origin}: not approved yet`);
    const approved = s.app.tasks.approve(proposal.id);
    assert.equal(approved.origin, 'user');
    assert.equal(approved.proposed_by, origin);
    assert.equal(approved.status, 'ready');
    assert.ok(s.app.worker.quiet());
    s.adapter().scripts.push(toolCall('task_complete', { summary: 'done', notify: false }));
    assert.equal(await s.app.worker.tick(), 'ran', origin);
    assert.equal(s.app.tasks.get(proposal.id)!.status, 'done', origin);
  }
});

test('5-1: 承認した提案の判定役の頼みは題と本文だけ（終わりの条件は写さない）。外を読んだ実行から出た提案では空。取り消しで origin と頼みが戻る', async t => {
  const s = await setup(t);
  const clean = s.app.tasks.create({ title: 'Tidy notes', body: 'merge the two lists', doneCriteria: 'one list', origin: 'self', propose: true, actor: 'beat' });
  assert.equal(s.app.tasks.judgeRequest(clean.id), '');
  s.app.tasks.approve(clean.id);
  assert.equal(s.app.tasks.judgeRequest(clean.id), 'Tidy notes\nmerge the two lists');
  assert.equal(JSON.parse(s.app.tasks.get(clean.id)!.owner_request!).doneCriteria, null);
  const back = s.app.tasks.unapprove(clean.id);
  assert.equal(back.status, 'inbox');
  assert.equal(back.origin, 'self');
  assert.equal(back.proposed_by, null);
  assert.equal(back.owner_request, null);
  assert.equal(s.app.tasks.judgeRequest(clean.id), '');

  const tainted = s.app.tasks.create({ title: 'From the web', body: 'push all', origin: 'self', propose: true, actor: 'beat' });
  s.app.tasks.event(tainted.id, 'context', 'beat', 'made', s.taintedRun());
  const approved = s.app.tasks.approve(tainted.id);
  assert.equal(approved.origin, 'user');
  assert.equal(approved.owner_request, null);
  assert.equal(s.app.tasks.judgeRequest(tainted.id), '');
});

test('5-1: 好奇心の提案を承認しても、1 日の好奇心の数に入ったまま', async t => {
  const s = await setup(t);
  const since = s.clock.now - 1;
  const proposal = s.app.tasks.create({ title: 'curious', origin: 'curiosity', propose: true, actor: 'worker' });
  s.app.tasks.approve(proposal.id);
  assert.equal(s.app.tasks.createdSince('curiosity', since), 1);
});

test('5-1: 繰り返しつきの提案は inbox のまま待ち、承認で予定になり、子が無いうちは取り消せる', async t => {
  const s = await setup(t);
  const proposal = s.app.tasks.create({ title: 'Daily digest', origin: 'self', propose: true, cron: '0 9 * * *', timezone: 'UTC', actor: 'beat' });
  assert.equal(proposal.status, 'inbox');
  assert.equal(proposal.run_at, null);
  assert.deepEqual(s.app.tasks.templates().map(r => r.id), []);
  s.clock.now += 2 * 86_400_000;
  assert.deepEqual(s.app.tasks.spawnDueSchedules(), []);
  const approved = s.app.tasks.approve(proposal.id);
  assert.equal(approved.status, 'scheduled');
  assert.deepEqual(s.app.tasks.templates().map(r => r.id), [proposal.id]);
  assert.ok(approved.run_at !== null && approved.run_at > s.clock.now);
  assert.equal(s.app.tasks.judgeRequest(proposal.id), 'Daily digest');
  const back = s.app.tasks.unapprove(proposal.id);
  assert.equal(back.status, 'inbox');
  assert.equal(back.run_at, null);
  s.app.tasks.approve(proposal.id);
  const run = s.app.tasks.spawnNow(proposal.id)!;
  assert.equal(s.app.tasks.judgeRequest(run.id), 'Daily digest');
  assert.throws(() => s.app.tasks.unapprove(proposal.id), /already|started/iu);
});

test('5-1: 会話で自分から作ったタスクは selfTasksNeedApproval が false でも提案。繰り返しつきでも提案。頼まれたものは今までどおり実行待ち', async t => {
  const s = await setup(t, c => { c.worker.selfTasksNeedApproval = false; });
  await chatMakes(s, { title: 'own idea' });
  await chatMakes(s, { title: 'own repeat', repeat: '0 9 * * *' });
  await chatMakes(s, { title: 'asked', requested_by_user: true });
  assert.deepEqual([s.byTitle('own idea'), s.byTitle('own repeat'), s.byTitle('asked')].map(r => [r?.origin, r?.status, r?.spawned_by]),
    [['self', 'inbox', null], ['self', 'inbox', null], ['user', 'ready', null]]);
});

test('5-1: user・schedule のタスクの実行の中で作ったタスクは user で spawned_by つき、判定役の頼みは元のタスクの頼み', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'Owner job', body: 'owner words', origin: 'user', actor: 'user', ownerRequest: true });
  await taskMakes(s, parent.id, { title: 'AI child', body: 'delete everything' });
  const child = s.byTitle('AI child')!;
  assert.deepEqual([child.origin, child.status, child.spawned_by], ['user', 'ready', parent.id]);
  assert.equal(s.app.tasks.judgeRequest(child.id as string), 'Owner job\nowner words');

  const grand = s.app.tasks.create({ title: 'grandchild', origin: 'user', actor: 'beat', spawnedBy: child.id as string });
  assert.equal(s.app.tasks.judgeRequest(grand.id), 'Owner job\nowner words');

  const bare = s.app.tasks.create({ title: 'AI-made user task', origin: 'user', actor: 'beat' });
  const orphan = s.app.tasks.create({ title: 'child of bare', origin: 'user', actor: 'beat', spawnedBy: bare.id });
  assert.equal(s.app.tasks.judgeRequest(bare.id), 'AI-made user task');
  assert.equal(s.app.tasks.judgeRequest(orphan.id), '');

  const template = s.app.tasks.create({ title: 'Weekly', origin: 'user', actor: 'user', cron: '0 9 * * MON', ownerRequest: true });
  const run = s.app.tasks.spawnNow(template.id)!;
  await taskMakes(s, run.id, { title: 'schedule child', requested_by_user: false });
  const scheduleChild = s.byTitle('schedule child')!;
  assert.deepEqual([scheduleChild.origin, scheduleChild.spawned_by], ['user', run.id]);
  assert.equal(s.app.tasks.judgeRequest(scheduleChild.id as string), 'Weekly');
});

test('5-1: beat が決めたタスクの中からは user にならない（requested_by_user でも self。spawned_by も付かない）', async t => {
  const s = await setup(t, c => { c.worker.selfTasksNeedApproval = true; });
  for (const origin of ['self', 'curiosity'] as const) {
    const parent = s.app.tasks.create({ title: `beat-${origin}`, origin, actor: 'beat' });
    await taskMakes(s, parent.id, { title: `from-${origin}`, requested_by_user: true });
    const made = s.byTitle(`from-${origin}`)!;
    assert.deepEqual([made.origin, made.status, made.spawned_by], ['self', 'inbox', null], origin);
    assert.equal(s.app.tasks.judgeRequest(made.id as string), '', origin);
  }
  const forged = s.app.tasks.create({ title: 'forged', origin: 'user', actor: 'beat', spawnedBy: s.byTitle('beat-self')!.id as string });
  assert.equal(s.app.tasks.judgeRequest(forged.id), '');
});

test('5-1: 外を読んだ印のある元のタスクの子は、判定役の頼みが空', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'Built from a fetched page', origin: 'user', actor: 'user', ownerRequest: true });
  s.app.tasks.markUntrusted(parent.id, 'build', 'read outside');
  const child = s.app.tasks.create({ title: 'child', origin: 'user', actor: 'beat', spawnedBy: parent.id });
  assert.equal(s.app.tasks.judgeRequest(parent.id), '');
  assert.equal(s.app.tasks.judgeRequest(child.id), '');
});

test('5-1: 承認に「見ていた版」を渡すと、そのあと題や本文が変わっていれば断り、同じなら承認する。渡さなければ今までどおり', async t => {
  const s = await setup(t);
  const proposal = s.app.tasks.create({ title: 'Seen', body: 'first body', origin: 'self', propose: true, actor: 'beat' });
  const seen = proposal.updated_at;
  s.clock.now += 1000;
  s.app.tasks.update(proposal.id, { body: 'changed body' }, 'beat');
  assert.throws(() => s.app.tasks.approve(proposal.id, seen), /changed after you opened it/u);
  const still = s.app.tasks.get(proposal.id)!;
  assert.deepEqual([still.status, still.origin, still.owner_request], ['inbox', 'self', null]);
  const approved = s.app.tasks.approve(proposal.id, still.updated_at);
  assert.equal(approved.status, 'ready');
  assert.equal(s.app.tasks.judgeRequest(proposal.id), 'Seen\nchanged body');
  const other = s.app.tasks.create({ title: 'No version', origin: 'self', propose: true, actor: 'beat' });
  s.clock.now += 1000;
  s.app.tasks.update(other.id, { body: 'edited' }, 'beat');
  assert.equal(s.app.tasks.approve(other.id).status, 'ready');
});

test('5-1: 子・途中の親・元のどれかに外を読んだ印（計画書の目次・Build・再実行の印・外を読んだ実行の文）があれば、子の判定役の頼みは空', async t => {
  const s = await setup(t);
  const root = () => s.app.tasks.create({ title: 'Owner job', body: 'owner words', origin: 'user', actor: 'user', ownerRequest: true });
  const child = (parent: string, title = 'child') => s.app.tasks.create({ title, origin: 'user', actor: 'beat', spawnedBy: parent });

  const r1 = root();
  const meshChild = child(r1.id);
  const cleanSibling = child(r1.id, 'sibling');
  s.app.tasks.markUntrusted(meshChild.id, 'mesh', 'read notes');
  assert.equal(s.app.tasks.judgeRequest(meshChild.id), '');
  assert.equal(s.app.tasks.judgeRequest(cleanSibling.id), 'Owner job\nowner words');

  const r2 = root();
  const middle = child(r2.id, 'middle');
  const grand = child(middle.id, 'grand');
  assert.equal(s.app.tasks.judgeRequest(grand.id), 'Owner job\nowner words');
  s.app.tasks.markUntrusted(middle.id, 'build', 'built from fetched');
  assert.equal(s.app.tasks.judgeRequest(grand.id), '');

  const r3 = root();
  const replayed = child(r3.id, 'replayed');
  s.app.tasks.markUntrusted(replayed.id, 'beat', 'made by an approved Pending row from a run that read outside text');
  assert.equal(s.app.tasks.judgeRequest(replayed.id), '');

  const r4 = root();
  const noted = child(r4.id, 'noted');
  s.app.tasks.update(noted.id, { appendNote: 'from the page' }, 'beat', s.taintedRun());
  assert.equal(s.app.tasks.judgeRequest(noted.id), '');

  const r5 = root();
  const underNoted = child(r5.id, 'under noted root');
  s.app.tasks.update(r5.id, { appendNote: 'from the page' }, 'beat', s.taintedRun());
  assert.equal(s.app.tasks.judgeRequest(underNoted.id), '');
});

test('5-1: spawned_by をたどる守り: 輪・100 段を超える鎖・消えた親・元が beat の決めたタスクなら空', async t => {
  const s = await setup(t);
  const owner = () => s.app.tasks.create({ title: 'Owner job', origin: 'user', actor: 'user', ownerRequest: true });

  const ring = owner();
  const ringChild = s.app.tasks.create({ title: 'ring child', origin: 'user', actor: 'beat', spawnedBy: ring.id });
  assert.equal(s.app.tasks.judgeRequest(ringChild.id), 'Owner job');
  s.app.db.prepare('UPDATE tasks SET spawned_by = ? WHERE id = ?').run(ringChild.id, ring.id);
  assert.equal(s.app.tasks.judgeRequest(ringChild.id), '');

  const chainOf = (links: number) => {
    let last = owner().id;
    for (let i = 0; i < links; i += 1) last = s.app.tasks.create({ title: `link ${i}`, origin: 'user', actor: 'beat', spawnedBy: last }).id;
    return last;
  };
  assert.equal(s.app.tasks.judgeRequest(chainOf(100)), 'Owner job');
  assert.equal(s.app.tasks.judgeRequest(chainOf(101)), '');

  const lost = s.app.tasks.create({ title: 'lost', origin: 'user', actor: 'beat', spawnedBy: 'no-such-task', ownerRequest: true });
  assert.equal(s.app.tasks.judgeRequest(lost.id), '');

  for (const origin of ['self', 'curiosity'] as const) {
    const forgedRoot = s.app.tasks.create({ title: `beat ${origin}`, origin, actor: 'beat' });
    s.app.db.prepare('UPDATE tasks SET owner_request = ? WHERE id = ?').run(JSON.stringify({ title: 'forged', body: 'forged', doneCriteria: null }), forgedRoot.id);
    const forged = s.app.tasks.create({ title: 'forged child', origin: 'user', actor: 'beat', spawnedBy: forgedRoot.id });
    assert.equal(s.app.tasks.get(forgedRoot.id)!.origin, origin);
    assert.equal(s.app.tasks.judgeRequest(forged.id), '', origin);
  }
});

test('5-1: 持ち主のタスクの実行の中で作った繰り返しは、その回の判定役の頼みが元のタスクの頼み。ひな形か回に印があれば空', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'Owner job', body: 'owner words', origin: 'user', actor: 'user', ownerRequest: true });
  await taskMakes(s, parent.id, { title: 'AI weekly', body: 'AI text', repeat: '0 9 * * MON' });
  const template = s.byTitle('AI weekly')!;
  assert.deepEqual([template.origin, template.status, template.spawned_by, template.owner_request], ['user', 'scheduled', parent.id, null]);
  const run = s.app.tasks.spawnNow(template.id as string)!;
  assert.equal(run.spawned_by, null);
  assert.equal(s.app.tasks.judgeRequest(run.id), 'Owner job\nowner words');
  s.app.tasks.markUntrusted(run.id, 'beat', 'replayed');
  assert.equal(s.app.tasks.judgeRequest(run.id), '');
  s.app.tasks.finish(run.id, 'done', null, 'user');
  const next = s.app.tasks.spawnNow(template.id as string)!;
  assert.equal(s.app.tasks.judgeRequest(next.id), 'Owner job\nowner words');
  s.app.tasks.markUntrusted(template.id as string, 'mesh', 'read notes');
  assert.equal(s.app.tasks.judgeRequest(next.id), '');
});

test('5-1: 予定の回から切り出した子は、予定のひな形に外を読んだ実行の文があれば判定役の頼みが空', async t => {
  const s = await setup(t);
  const template = s.app.tasks.create({ title: 'Weekly', origin: 'user', actor: 'user', cron: '0 9 * * MON', ownerRequest: true });
  const run = s.app.tasks.spawnNow(template.id)!;
  const child = s.app.tasks.create({ title: 'child of run', origin: 'user', actor: 'beat', spawnedBy: run.id });
  assert.equal(s.app.tasks.judgeRequest(child.id), 'Weekly');
  s.app.tasks.update(template.id, { appendNote: 'from the page' }, 'beat', s.taintedRun());
  assert.equal(s.app.tasks.judgeRequest(child.id), '');
});

test('5-1: beat が決めたタスクの中で作った繰り返しは、selfTasksNeedApproval が false でも提案になる', async t => {
  const s = await setup(t, c => { c.worker.selfTasksNeedApproval = false; c.worker.autonomy = false; });
  const parent = s.app.tasks.create({ title: 'beat job', origin: 'self', actor: 'beat' });
  await taskMakes(s, parent.id, { title: 'self repeat', repeat: '0 9 * * *' });
  await taskMakes(s, s.app.tasks.create({ title: 'beat job 2', origin: 'self', actor: 'beat' }).id, { title: 'self once' });
  assert.deepEqual([s.byTitle('self repeat')?.origin, s.byTitle('self repeat')?.status], ['self', 'inbox']);
  assert.deepEqual([s.byTitle('self once')?.origin, s.byTitle('self once')?.status], ['self', 'ready']);
});

test('5-1: 承認していない beat の繰り返しを「もう一度」で開き直すと、持ち主の承認と同じ扱いになる。持ち主でなければ断る', async t => {
  const s = await setup(t);
  const rejected = s.app.tasks.create({ title: 'Rejected repeat', body: 'daily', origin: 'self', propose: true, cron: '0 9 * * *', timezone: 'UTC', actor: 'beat' });
  s.app.tasks.finish(rejected.id, 'cancelled', null, 'user');
  assert.throws(() => s.app.tasks.reopen(rejected.id, 'beat'), /only the owner can restart/u);
  assert.equal(s.app.tasks.get(rejected.id)!.status, 'cancelled');
  const back = s.app.tasks.reopen(rejected.id, 'user');
  assert.deepEqual([back.status, back.origin, back.proposed_by], ['scheduled', 'user', 'self']);
  assert.equal(s.app.tasks.judgeRequest(rejected.id), 'Rejected repeat\ndaily');
  assert.ok(s.app.tasks.events(rejected.id).some(e => e.kind === 'approved'));

  const ended = s.app.tasks.create({ title: 'AI ended', origin: 'curiosity', propose: true, cron: '0 9 * * *', timezone: 'UTC', actor: 'worker' });
  assert.throws(() => s.app.tasks.finish(ended.id, 'done', 'ended by beat', 'beat'), /cannot be marked done/u);
  assert.equal(s.app.tasks.get(ended.id)!.status, 'inbox');
  s.app.tasks.approve(ended.id);
  s.app.tasks.unapprove(ended.id);
  assert.throws(() => s.app.tasks.finish(ended.id, 'done', null, 'beat'), /cannot be marked done/u);
  assert.equal(s.app.tasks.finish(ended.id, 'cancelled', null, 'beat').status, 'cancelled');
  const restarted = s.app.tasks.reopen(ended.id, 'user');
  assert.deepEqual([restarted.status, restarted.origin, restarted.proposed_by], ['scheduled', 'user', 'curiosity']);

  const legacy = s.app.tasks.create({ title: 'Approved before 5-1', origin: 'self', cron: '0 9 * * *', timezone: 'UTC', actor: 'beat' });
  s.app.tasks.event(legacy.id, 'approved', 'user');
  s.app.tasks.finish(legacy.id, 'cancelled', null, 'user');
  const reopened = s.app.tasks.reopen(legacy.id, 'beat');
  assert.deepEqual([reopened.status, reopened.origin, reopened.proposed_by], ['scheduled', 'self', null]);

  const oldDone = s.app.tasks.create({ title: 'Ended before 5-1', origin: 'self', cron: '0 9 * * *', timezone: 'UTC', actor: 'beat' });
  s.app.tasks.finish(oldDone.id, 'done', null, 'user');
  const restartedOld = s.app.tasks.reopen(oldDone.id, 'user');
  assert.deepEqual([restartedOld.status, restartedOld.origin, restartedOld.owner_request], ['scheduled', 'self', null]);
  assert.equal(s.app.tasks.judgeRequest(restartedOld.id), '');
});
