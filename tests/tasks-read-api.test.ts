import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEDULE_MIN_SLOT_MS, SCHEDULE_PLANNED_LIMIT, SCHEDULE_PLANNED_TOTAL, SCHEDULE_RAN_LIMIT } from '../src/tasks/store.ts';
import { DAY, HOUR, MIN, taskApp, toolCall } from './helpers/task-app.ts';

test('GET /api/tasks: 止めたひな形は、終わったタスクが 60 件たまっても repeating に残る（最後の実行の状態と結果の 1 行つき）', async t => {
  const s = await taskApp(t);
  const paused = s.userTask('Morning summary', { cron: '0 9 * * *', timezone: 'Asia/Tokyo' });
  const child = s.app.tasks.spawnNow(paused.id)!;
  s.app.tasks.finish(child.id, 'done', 'Summarized 3 items\nsecond line', 'clive');
  s.app.tasks.finish(paused.id, 'cancelled', null, 'user');
  const fresh = s.userTask('Weekly report', { cron: '0 17 * * FRI', timezone: 'Asia/Tokyo' });
  for (let i = 0; i < 60; i++) {
    s.clock.now += 1000;
    s.app.tasks.finish(s.userTask(`one-off ${i}`).id, 'done', null, 'user');
  }
  const list = (await s.api('/api/tasks')).body;
  assert.equal(list.finished.length, 50);
  assert.ok(!list.finished.some((x: any) => x.id === paused.id), '終わったタスクの 50 件からは押し出されている');
  assert.deepEqual(list.repeating.map((x: any) => x.id), [paused.id, fresh.id]);
  assert.equal(list.repeating[0].status, 'cancelled');
  assert.equal(list.repeating[0].cron_text, 'Every day at 09:00');
  assert.deepEqual(list.repeating[0].last_run, { id: child.id, status: 'done', summary: 'Summarized 3 items', at: child.created_at });
  assert.equal(list.repeating[1].last_run, null);
  assert.ok(!list.repeating.some((x: any) => x.id === child.id), '毎回の実行はひな形ではない');
  assert.equal(list.active.length, 1, '今までの active はそのまま');
});

test('GET /api/tasks: ひな形の最後の実行は、いちばんあとに作った実行（作った順で選ぶ。時計が戻っても変わらない）', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Morning summary', { cron: '0 9 * * *', timezone: 'UTC' });
  const first = s.app.tasks.spawnNow(template.id)!;
  s.app.tasks.finish(first.id, 'done', 'first', 'clive');
  s.clock.now -= HOUR;
  const second = s.app.tasks.spawnNow(template.id)!;
  s.app.tasks.finish(second.id, 'failed', 'second', 'worker');
  const list = (await s.api('/api/tasks')).body;
  assert.deepEqual(list.repeating[0].last_run, { id: second.id, status: 'failed', summary: 'second', at: s.clock.now });
});

test('終わったタスクのページ送り: 同じミリ秒に終わった 3 つをまたいでも重ならず抜けない。ひな形は数えず、出さない', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Paused schedule', { cron: '0 9 * * *', timezone: 'UTC' });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) { s.clock.now += 1000; const task = s.userTask(`early ${i}`); s.app.tasks.finish(task.id, 'done', null, 'user'); ids.push(task.id); }
  s.clock.now += 1000;
  const same = [s.userTask('same a'), s.userTask('same b'), s.userTask('same c')];
  for (const task of same) { s.app.tasks.finish(task.id, 'failed', 'x', 'worker'); ids.push(task.id); }
  for (let i = 0; i < 2; i++) { s.clock.now += 1000; const task = s.userTask(`late ${i}`); s.app.tasks.finish(task.id, 'cancelled', null, 'user'); ids.push(task.id); }
  s.clock.now += 1000;
  s.app.tasks.finish(template.id, 'cancelled', null, 'user');
  s.userTask('still active');

  assert.equal((await s.api('/api/tasks')).body.finishedTotal, 7, 'ひな形と動いているタスクは数えない');
  const seen: string[] = [];
  let path = '/api/tasks/finished?limit=2';
  for (let page = 0; page < 10; page++) {
    const res = await s.api(path);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 7);
    assert.ok(res.body.tasks.length <= 2);
    seen.push(...res.body.tasks.map((x: any) => x.id));
    if (!res.body.next) break;
    path = `/api/tasks/finished?limit=2&beforeT=${res.body.next.beforeT}&beforeId=${res.body.next.beforeId}`;
  }
  assert.equal(seen.length, 7, '重なりも抜けも無い');
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.ok(!seen.includes(template.id), 'ひな形はページに出ない');
  const sameIds = same.map(x => x.id).sort().reverse();
  assert.deepEqual(seen.filter(id => sameIds.includes(id)), sameIds, '同じ時刻のものは id の大きい順');

  assert.equal((await s.api('/api/tasks/finished')).body.tasks.length, 7, '既定は 20 件まで');
  assert.equal((await s.api('/api/tasks/finished?beforeT=5')).status, 400, 'beforeId が無い');
  assert.equal((await s.api('/api/tasks/finished?beforeId=x')).status, 400, 'beforeT が無い');
  const bad = await s.api('/api/tasks/finished?beforeT=abc&beforeId=x');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'http.bad_cursor');
});

test('GET /api/schedule: 止めたひな形のこれからの回は出さず、範囲の外は出さず、8 日を超える幅は 400', async t => {
  const s = await taskApp(t);
  const from = s.clock.now;
  const daily = s.userTask('Daily', { cron: '0 9 * * *', timezone: 'UTC' });
  const paused = s.userTask('Paused', { cron: '0 10 * * *', timezone: 'UTC' });
  s.app.tasks.finish(paused.id, 'cancelled', null, 'user');
  const timed = s.userTask('Return the book', { runAt: from + 3 * HOUR });
  s.userTask('Far away', { runAt: from + 3 * DAY });
  s.userTask('Right now');

  const res = await s.api(`/api/schedule?from=${from}&to=${from + 2 * DAY}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.slots.map((x: any) => [x.taskId, x.start, x.state]), [
    [timed.id, from + 3 * HOUR, 'planned'],
    [daily.id, Date.parse('2026-11-05T09:00:00Z'), 'planned'],
    [daily.id, Date.parse('2026-11-06T09:00:00Z'), 'planned'],
  ]);
  assert.ok(res.body.slots.every((x: any) => x.length === SCHEDULE_MIN_SLOT_MS), '動いた回が無ければ、決まった最小の長さ');
  assert.deepEqual(res.body.templates, [{ taskId: daily.id, title: 'Daily', cron_text: 'Every day at 09:00', truncated: false }]);
  assert.ok(!res.body.slots.some((x: any) => x.taskId === paused.id));

  const tooWide = await s.api(`/api/schedule?from=${from}&to=${from + 8 * DAY + 1}`);
  assert.equal(tooWide.status, 400);
  assert.equal(tooWide.body.code, 'http.bad_range');
  assert.equal((await s.api(`/api/schedule?from=${from}&to=${from + 8 * DAY}`)).status, 200, 'ちょうど 8 日は通る');
  assert.equal((await s.api(`/api/schedule?from=${from}&to=${from}`)).status, 400);
  assert.equal((await s.api(`/api/schedule?from=${from}`)).status, 400);
  assert.equal((await s.api(`/api/schedule?from=x&to=${from}`)).status, 400);
});

test('GET /api/schedule: 毎分の決まりのひな形は 200 個で止まり、truncated が付く', async t => {
  const s = await taskApp(t);
  const from = s.clock.now;
  const minute = s.userTask('Every minute', { cron: '*/1 * * * *', timezone: 'UTC' });
  const hourly = s.userTask('Hourly', { cron: '0 * * * *', timezone: 'UTC' });
  const res = await s.api(`/api/schedule?from=${from}&to=${from + 8 * DAY}`);
  const mine = res.body.slots.filter((x: any) => x.taskId === minute.id);
  assert.equal(mine.length, SCHEDULE_PLANNED_LIMIT);
  assert.equal(mine[0].start, from + MIN);
  assert.equal(mine.at(-1).start, from + SCHEDULE_PLANNED_LIMIT * MIN);
  assert.deepEqual(res.body.templates.map((x: any) => [x.taskId, x.truncated]), [[minute.id, true], [hourly.id, false]]);
  assert.equal(res.body.slots.filter((x: any) => x.taskId === hourly.id).length, 8 * 24 - 1, '今の時刻ちょうどの回と、範囲の終わりちょうどの回は入らない');
});

test('GET /api/schedule: これからの回は全部のひな形を合わせて 2,000 個まで。ひな形が 10 個を超えると 1 つあたりの上限が等しく下がり、truncated が付く', async t => {
  const s = await taskApp(t);
  const from = s.clock.now;
  const ids = Array.from({ length: 10 }, (_, i) => s.userTask(`Every minute ${i}`, { cron: '*/1 * * * *', timezone: 'UTC' }).id);
  const countOf = (body: any, id: string) => body.slots.filter((x: any) => x.taskId === id).length;
  const ten = (await s.api(`/api/schedule?from=${from}&to=${from + DAY}`)).body;
  assert.deepEqual(ids.map(id => countOf(ten, id)), ids.map(() => SCHEDULE_PLANNED_LIMIT), '10 個までは今までどおり 1 つ 200 個');

  ids.push(s.userTask('Every minute 10', { cron: '*/1 * * * *', timezone: 'UTC' }).id);
  const daily = s.userTask('Daily', { cron: '0 9 * * *', timezone: 'UTC' });
  const each = Math.floor(SCHEDULE_PLANNED_TOTAL / 12);
  const twelve = (await s.api(`/api/schedule?from=${from}&to=${from + DAY}`)).body;
  assert.deepEqual(ids.map(id => countOf(twelve, id)), ids.map(() => each));
  assert.equal(countOf(twelve, daily.id), 1, '上限に届かないひな形はそのまま');
  assert.ok(twelve.slots.filter((x: any) => x.state === 'planned').length <= SCHEDULE_PLANNED_TOTAL);
  assert.deepEqual(twelve.templates.map((x: any) => x.truncated), [...ids.map(() => true), false]);
  assert.equal(twelve.slots.filter((x: any) => x.taskId === ids[11 - 1]).at(-1).start, from + each * MIN, '近い回から残す');
});

test('GET /api/schedule: 動いた回は新しい方から 2,000 個まで。あふれたら ranTruncated が付く', async t => {
  const s = await taskApp(t);
  const from = s.clock.now - HOUR;
  const task = s.userTask('Busy');
  const conversation = s.app.conversations.create({ kind: 'task', title: 'Busy' }).id;
  s.app.db.prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(conversation, task.id);
  const insert = s.app.db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, ended_at) VALUES (?, 'task', ?, ?, ?)");
  for (let i = 0; i <= SCHEDULE_RAN_LIMIT; i++) insert.run(`run-${i}`, conversation, from + i * 1000, from + i * 1000 + 500);

  const over = (await s.api(`/api/schedule?from=${from}&to=${from + DAY}`)).body;
  const past = over.slots.filter((x: any) => x.state === 'past');
  assert.equal(past.length, SCHEDULE_RAN_LIMIT);
  assert.equal(over.ranTruncated, true);
  assert.deepEqual([past[0].start, past.at(-1).start], [from + 1000, from + SCHEDULE_RAN_LIMIT * 1000], 'いちばん古い 1 つが落ちる');

  s.app.db.prepare("DELETE FROM engine_runs WHERE id = 'run-5'").run();
  const exact = (await s.api(`/api/schedule?from=${from}&to=${from + DAY}`)).body;
  assert.equal(exact.slots.filter((x: any) => x.state === 'past').length, SCHEDULE_RAN_LIMIT);
  assert.equal(exact.ranTruncated, false, 'ちょうど 2,000 個は切れていない');
});

test('GET /api/schedule: 時刻指定のタスクは近い方から 200 個まで', async t => {
  const s = await taskApp(t);
  const from = s.clock.now;
  for (let i = 0; i <= SCHEDULE_PLANNED_LIMIT; i++) s.userTask(`Timed ${i}`, { runAt: from + (i + 1) * MIN });
  const res = (await s.api(`/api/schedule?from=${from}&to=${from + DAY}`)).body;
  assert.equal(res.slots.length, SCHEDULE_PLANNED_LIMIT);
  assert.deepEqual([res.slots[0].start, res.slots.at(-1).start], [from + MIN, from + SCHEDULE_PLANNED_LIMIT * MIN], 'いちばん遠い 1 つが落ちる');
  assert.ok(res.slots.every((x: any) => x.state === 'planned' && x.runTaskId === x.taskId));
});

test('GET /api/schedule: 動いた回の時刻は engine_runs の始まりと終わりと同じ。動いている回は live', async t => {
  const s = await taskApp(t);
  const from = s.clock.now - HOUR;
  const template = s.userTask('Daily', { cron: '0 9 * * *', timezone: 'UTC' });
  const child = s.app.tasks.spawnNow(template.id)!;
  s.adapter().scripts.push(async function* () {
    s.clock.now += 90_000;
    yield* toolCall('task_complete', { summary: 'ok', notify: false })({} as never);
  });
  assert.equal(await s.app.worker.tick(), 'ran');
  const run = s.app.db.prepare("SELECT started_at, ended_at FROM engine_runs WHERE kind = 'task'").get() as { started_at: number; ended_at: number };
  assert.equal(run.ended_at - run.started_at, 90_000);

  const live = s.userTask('Live one', { runAt: s.clock.now });
  const conversation = s.app.conversations.create({ kind: 'task', title: 'Live one' }).id;
  assert.ok(s.app.tasks.claim(live.id, 60_000, conversation));
  s.app.runs.start('run-live', 'task', conversation);
  s.clock.now += 30_000;

  const res = await s.api(`/api/schedule?from=${from}&to=${from + 2 * DAY}`);
  const past = res.body.slots.filter((x: any) => x.state === 'past');
  assert.deepEqual(past, [{ taskId: template.id, runTaskId: child.id, title: 'Daily', start: run.started_at, length: 90_000, state: 'past' }]);
  assert.deepEqual(res.body.slots.filter((x: any) => x.state === 'live'), [{ taskId: live.id, runTaskId: live.id, title: 'Live one', start: s.clock.now - 30_000, length: 30_000, state: 'live' }]);
  const planned = res.body.slots.filter((x: any) => x.state === 'planned');
  assert.ok(planned.length > 0 && planned.every((x: any) => x.taskId === template.id && x.length === 90_000), 'これからの回の長さは、最後の実行の長さ');
  assert.equal(res.body.ranTruncated, false);

  const later = await s.api(`/api/schedule?from=${s.clock.now + DAY}&to=${s.clock.now + 2 * DAY}`);
  assert.ok(!later.body.slots.some((x: any) => x.state === 'past'), '範囲の外の動いた回は出さない');
});
