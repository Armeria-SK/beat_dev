import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
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

test('5-1: 承認した提案の判定役の頼みは題と本文と終わりの条件。外を読んだ実行から出た提案では空。取り消しで origin と頼みが戻る', async t => {
  const s = await setup(t);
  const clean = s.app.tasks.create({ title: 'Tidy notes', body: 'merge the two lists', doneCriteria: 'one list', origin: 'self', propose: true, actor: 'beat' });
  assert.equal(s.app.tasks.judgeRequest(clean.id), '');
  s.app.tasks.approve(clean.id);
  assert.equal(s.app.tasks.judgeRequest(clean.id), 'Tidy notes\nmerge the two lists\none list');
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
  s.clock.now += 2 * 86_400_000;
  assert.deepEqual(s.app.tasks.spawnDueSchedules(), []);
  const approved = s.app.tasks.approve(proposal.id);
  assert.equal(approved.status, 'scheduled');
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
