import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { reply } from './helpers.ts';
import { TASK_SOFT_REFERENCES, TaskError } from '../src/tasks/store.ts';
import { splitKey, taskPrompt } from '../src/tasks/worker.ts';
import { HOUR, MIN, taskApp, toolCall } from './helpers/task-app.ts';

type S = Awaited<ReturnType<typeof taskApp>>;
const DAILY_9 = { freq: 'daily', values: { time: '09:00' } };
const HOURLY_30 = { freq: 'hourly', values: { minute: '30' } };

function snapshot(s: S) {
  return JSON.stringify({
    tasks: s.app.db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    events: s.app.db.prepare('SELECT * FROM task_events ORDER BY id').all(),
    kv: s.app.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'task-%' ORDER BY key").all(),
  });
}

async function runOnce(s: S, tool: string, args: unknown): Promise<void> {
  s.adapter().scripts.push(toolCall(tool, args));
  assert.equal(await s.app.worker.tick(), 'ran');
}

// ── PATCH repeat ──

test('PATCH repeat: 予定のひな形は run_at が新しい決まりの次になり、経過に edited（決まりの文つき）が 1 行入る', async t => {
  const s = await taskApp(t);
  const template = (await s.api('/api/tasks', { title: 'Summary', repeat: DAILY_9 })).body.task;
  assert.equal(template.timezone, 'Asia/Tokyo');
  const child = s.app.tasks.spawnNow(template.id)!;
  const before = s.app.tasks.events(template.id).length;
  s.events.length = 0;

  const res = await s.api(`/api/tasks/${template.id}`, { repeat: HOURLY_30 }, 'PATCH');
  assert.equal(res.status, 200);
  assert.equal(res.body.task.cron, '30 * * * *');
  assert.equal(res.body.task.cron_text, 'Hourly at minute 30');
  assert.equal(res.body.task.status, 'scheduled');
  assert.equal(res.body.task.run_at, Date.parse('2026-11-04T20:30:00Z'));
  const added = s.app.tasks.events(template.id).slice(0, s.app.tasks.events(template.id).length - before);
  assert.deepEqual(added.map(e => [e.kind, e.actor, e.content]), [['edited', 'user', 'Repeat: 30 * * * *']]);
  assert.ok(s.events.some(e => e.type === 'task.changed' && e.task.id === template.id && e.task.cron === '30 * * * *'));
  assert.equal(s.app.tasks.get(child.id)!.status, 'ready', '動いている回はそのまま');

  const both = await s.api(`/api/tasks/${template.id}`, { title: 'Summary 2', repeat: DAILY_9 }, 'PATCH');
  assert.equal(both.body.task.title, 'Summary 2');
  assert.equal(both.body.task.cron, '0 9 * * *');
});

test('PATCH repeat: 止めているひな形と done で閉じたひな形は cron だけ変わり run_at が空になる。戻す / 開き直すと新しい決まりで次が出る', async t => {
  const s = await taskApp(t);
  const paused = (await s.api('/api/tasks', { title: 'Paused', repeat: DAILY_9 })).body.task;
  const closed = (await s.api('/api/tasks', { title: 'Closed', repeat: DAILY_9 })).body.task;
  assert.equal((await s.api(`/api/tasks/${paused.id}/cancel`, {})).status, 200);
  assert.equal((await s.api(`/api/tasks/${closed.id}/done`, {})).status, 200);

  for (const [id, status] of [[paused.id, 'cancelled'], [closed.id, 'done']] as const) {
    const res = await s.api(`/api/tasks/${id}`, { repeat: HOURLY_30 }, 'PATCH');
    assert.equal(res.status, 200, '409 にはしない');
    assert.equal(res.body.task.status, status);
    assert.equal(res.body.task.cron, '30 * * * *');
    assert.equal(res.body.task.run_at, null);
  }
  const restored = await s.api(`/api/tasks/${paused.id}/uncancel`, {});
  assert.equal(restored.body.task.status, 'scheduled');
  assert.equal(restored.body.task.run_at, Date.parse('2026-11-04T20:30:00Z'));
  const reopened = s.app.tasks.reopen(closed.id, 'user');
  assert.equal(reopened.status, 'scheduled');
  assert.equal(reopened.run_at, Date.parse('2026-11-04T20:30:00Z'));
});

test('PATCH repeat: ひな形でないタスクは 409、読めない決まりは 400、repeat と when を一緒に送ると 400、ひな形への when は 409。断ったときは何も変わらない', async t => {
  const s = await taskApp(t);
  const template = (await s.api('/api/tasks', { title: 'Summary', repeat: DAILY_9 })).body.task;
  const plain = s.userTask('Plain', { runAt: s.clock.now + HOUR });
  const child = s.app.tasks.spawnNow(template.id)!;
  const before = snapshot(s);

  for (const id of [plain.id, child.id]) {
    const res = await s.api(`/api/tasks/${id}`, { title: 'changed?', repeat: HOURLY_30 }, 'PATCH');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'task.error.not_template');
  }
  const unreadable = await s.api(`/api/tasks/${template.id}`, { repeat: { freq: 'weekly', values: { day: 'X', time: '09:00' } } }, 'PATCH');
  assert.equal(unreadable.status, 400);
  assert.equal(unreadable.body.code, 'http.bad_repeat');
  for (const id of [template.id, plain.id]) {
    const res = await s.api(`/api/tasks/${id}`, { repeat: HOURLY_30, when: '2026-11-06T09:00:00+09:00' }, 'PATCH');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'http.repeat_with_when');
  }
  assert.equal((await s.api(`/api/tasks/${template.id}`, { repeat: HOURLY_30, when: null }, 'PATCH')).status, 400);
  for (const when of ['2026-11-06T09:00:00+09:00', null]) {
    const res = await s.api(`/api/tasks/${template.id}`, { title: 'changed?', when }, 'PATCH');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'task.error.template_when');
  }
  assert.throws(() => s.app.tasks.setSchedule(template.id, 'not a cron', 'Asia/Tokyo', 'user'), (e: unknown) => e instanceof TaskError && e.code === 'error.bad_cron');
  assert.equal(snapshot(s), before);

  s.app.tasks.setSchedule = () => { throw new TaskError('error.bad_cron', { cron: 'x' }); };
  const noNext = await s.api(`/api/tasks/${template.id}`, { repeat: HOURLY_30 }, 'PATCH');
  assert.equal(noNext.status, 400, '次の実行が出せない決まりは 400');
  assert.equal(noNext.body.code, 'task.error.bad_cron');
  assert.equal((await s.api(`/api/tasks/${plain.id}`, { when: '2026-11-06T09:00:00+09:00' }, 'PATCH')).status, 200, 'ひな形でないタスクの when は今までどおり');
});

// ── DELETE ──

test('DELETE: ひな形と経過と kv が消え、過去の実行は parent_id が空で残る。task.deleted が出て、ワーカーは落ちない', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Morning summary', { cron: '0 9 * * *', timezone: 'UTC' });
  const other = s.userTask('Other schedule', { cron: '0 10 * * *', timezone: 'UTC' });
  const runs = [0, 1].map(() => { const child = s.app.tasks.spawnNow(template.id)!; s.app.tasks.finish(child.id, 'done', 'ok', 'clive'); return child; });
  s.app.tasks.update(template.id, { appendNote: 'a note' }, 'user');
  s.app.kv.setJson(splitKey(template.id), 2);
  s.app.kv.setJson(`task-idle:${template.id}`, 1);
  s.app.kv.setJson(splitKey(other.id), 5);
  s.app.notifications.notify({ kind: 'info', title: 'About the schedule', body: '', link: `#/tasks/${template.id}`, dedupKey: `split:${template.id}` });
  const templateEvents = s.count('task_events', 'task_id = ?', template.id);
  assert.ok(templateEvents >= 2);
  const before = { tasks: s.count('tasks'), events: s.count('task_events'), childEvents: s.count('task_events', 'task_id IN (?, ?)', runs[0]!.id, runs[1]!.id) };
  s.clock.now = Date.parse('2026-11-05T09:00:30Z');
  s.events.length = 0;

  const res = await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: { id: template.id, events: templateEvents, keptRuns: 2 } });
  assert.equal(s.count('tasks'), before.tasks - 1);
  assert.equal(s.count('task_events'), before.events - templateEvents);
  assert.equal(s.count('task_events', 'task_id = ?', template.id), 0);
  assert.equal(s.count('task_events', 'task_id IN (?, ?)', runs[0]!.id, runs[1]!.id), before.childEvents, '過去の実行の経過は残る');
  for (const run of runs) {
    const kept = s.app.tasks.get(run.id)!;
    assert.equal(kept.parent_id, null);
    assert.equal(kept.status, 'done');
  }
  assert.equal(s.count('kv', "key LIKE 'task-%'"), 1);
  assert.equal(s.app.kv.getJson(splitKey(other.id)), 5, 'ほかのタスクの kv は残る');
  assert.equal(s.count('notifications', 'link = ?', `#/tasks/${template.id}`), 1, '通知は文字として残る');
  assert.deepEqual(s.events.filter(e => e.type === 'task.deleted'), [{ type: 'task.deleted', id: template.id }]);
  assert.ok(!s.events.some(e => e.type === 'task.changed'), '残した実行に task.changed は出さない');
  assert.ok(s.logs.some(line => line === `[INFO] Deleted task "Morning summary" (${template.id})`));
  assert.equal((await s.api(`/api/tasks/${template.id}`)).status, 404);
  assert.equal((await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE')).status, 404);
  const list = (await s.api('/api/tasks')).body;
  assert.deepEqual(list.repeating.map((x: any) => x.id), [other.id]);

  assert.equal(await s.app.worker.tick(), 'idle', '消したひな形の過ぎた回で起きても、何も作らず落ちない');
  assert.equal(s.adapter().calls.length, 0);
  assert.equal(s.count('tasks'), before.tasks - 1);
});

test('DELETE: 消したことのログの行は、題の制御文字・行の区切り・向きを変える文字を空白にし、" と \\ を逃がす（行を偽れない）', async t => {
  const s = await taskApp(t);
  const hidden = [0x85, 0x2028, 0x2029, 0x202e, 0x2066, 0x200f, 0x61c].map(code => String.fromCodePoint(code));
  const title = `a${hidden.join('x')}h\r\ni" (fake-id)\\`;
  const task = s.userTask(title, { cron: '0 9 * * *', timezone: 'UTC' });
  assert.equal((await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual(s.logs.filter(line => line.includes('Deleted task')), [`[INFO] Deleted task "a x x x x x x h i\\" (fake-id)\\\\" (${task.id})`]);
  const widthless = s.userTask(`p${[0x200b, 0xfeff, 0xad, 0x2060].map(code => String.fromCodePoint(code)).join('q')}r`, { cron: '0 9 * * *', timezone: 'UTC' });
  assert.equal((await s.api(`/api/tasks/${widthless.id}`, undefined, 'DELETE')).status, 200);
  assert.equal(s.logs.filter(line => line.includes('Deleted task')).at(-1), `[INFO] Deleted task "p q q q r" (${widthless.id})`, '幅のない文字も落とす');
});

test('DELETE: まだ始まっていない回（実行待ち）だけなら、止めたひな形も消せて、その回は取り消して残る（戻せる）', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Weather', { cron: '*/2 * * * *', timezone: 'UTC' });
  const queued = s.app.tasks.spawnNow(template.id)!;
  s.app.tasks.finish(template.id, 'cancelled', null, 'user');
  const res = await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE');
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted.keptRuns, 1);
  const kept = s.app.tasks.get(queued.id)!;
  assert.deepEqual([kept.status, kept.parent_id, kept.cancelled_from], ['cancelled', null, 'ready']);
  assert.ok(s.events.some(e => e.type === 'task.changed' && e.task.id === queued.id && e.task.status === 'cancelled'), 'ボードから実行待ちの回が消える');
  assert.equal(await s.app.worker.tick(), 'idle', '取り消した回は動かない');
  assert.equal(s.adapter().calls.length, 0);
  assert.equal(s.app.tasks.uncancel(queued.id, 'user').status, 'ready');
});

test('DELETE: 実行中・返事待ちの回があるひな形は 409（run_open）で何も変えない。その回を取り消せば消せる', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Busy', { cron: '0 9 * * *', timezone: 'UTC' });
  const child = s.app.tasks.spawnNow(template.id)!;
  assert.ok(s.app.tasks.claim(child.id, 60_000, s.app.conversations.create({ kind: 'task', title: 'Busy' }).id));
  const waiting = s.userTask('Asks', { cron: '0 10 * * *', timezone: 'UTC' });
  const asking = s.app.tasks.spawnNow(waiting.id)!;
  s.app.tasks.setWaiting(asking.id, 'question', 'Which city?');
  const blocked = await s.api(`/api/tasks/${waiting.id}`, undefined, 'DELETE');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'task.error.run_open']);
  const before = snapshot(s);
  const res = await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'task.error.run_open');
  assert.equal(snapshot(s), before);
  assert.equal((await s.api(`/api/tasks/${child.id}`, undefined, 'DELETE')).body.code, 'task.error.not_deletable', '毎回の実行は消せない');

  s.app.tasks.finish(child.id, 'cancelled', null, 'user');
  s.app.tasks.finish(template.id, 'cancelled', null, 'user');
  assert.equal((await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE')).status, 200);
  assert.equal(s.app.tasks.get(child.id)!.parent_id, null);
  assert.equal(s.app.tasks.uncancel(child.id, 'user').status, 'ready', '残った実行は、ふつうのタスクとして戻せる');
});

test('DELETE: 区切りで ready に戻り未来の run_at を持つタスク（会話あり）は 409', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Check the build', { runAt: s.clock.now });
  await runOnce(s, 'task_checkpoint', { tried: 'built', result: 'waiting', next_action: 'look', resume_after_minutes: 30 });
  const rested = s.app.tasks.get(task.id)!;
  assert.deepEqual([rested.status, rested.attempts, rested.run_at, rested.conversation_id !== null], ['ready', 0, s.clock.now + 30 * MIN, true]);
  const before = snapshot(s);
  const res = await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'task.error.not_deletable');
  assert.equal(snapshot(s), before);

  // 使えるモデルが無くて待ちに戻ったタスク: 会話は結び付いたが、経過に実行の印は無い（worker の #run は、始められなかった実行に印を書かない）
  const waited = s.userTask('Waited for a model', { runAt: s.clock.now });
  assert.ok(s.app.tasks.claim(waited.id, 60_000, s.app.conversations.create({ kind: 'task', title: 'Waited' }).id));
  s.app.tasks.setReady(waited.id, { runAt: s.clock.now + 10 * MIN, reason: 'Waiting because no model is available' });
  assert.equal(s.count('task_events', 'task_id = ? AND run_id IS NOT NULL', waited.id), 0);
  const second = await s.api(`/api/tasks/${waited.id}`, undefined, 'DELETE');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'task.error.not_deletable');
  assert.ok(s.app.tasks.get(waited.id));
});

test('DELETE: reopen のあと when で未来に置き直したタスクは 409', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Fetch prices', { runAt: s.clock.now });
  await runOnce(s, 'task_complete', { summary: 'done', notify: false });
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  s.app.tasks.reopen(task.id, 'user');
  const moved = await s.api(`/api/tasks/${task.id}`, { when: '2026-11-20T09:00:00+09:00' }, 'PATCH');
  assert.deepEqual([moved.body.task.status, moved.body.task.attempts, moved.body.task.run_at > s.clock.now], ['ready', 0, true]);
  const res = await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'task.error.not_deletable');
  assert.ok(s.app.tasks.get(task.id));
});

test('DELETE: 会話が無く経過に実行の印も無い時刻指定のタスクは（時刻を過ぎていても）消せる。時刻指定でない・提案・終わったタスクは 409', async t => {
  const s = await taskApp(t);
  const future = s.userTask('Later', { runAt: s.clock.now + HOUR });
  const overdue = s.userTask('Overdue', { runAt: s.clock.now - HOUR });
  const now = s.userTask('Right now');
  const proposal = s.userTask('Proposed', { propose: true, runAt: s.clock.now + HOUR });
  const done = s.userTask('Done', { runAt: s.clock.now + HOUR });
  s.app.tasks.finish(done.id, 'done', null, 'user');
  const marked = s.userTask('Has a run mark', { runAt: s.clock.now + HOUR });
  s.app.tasks.event(marked.id, 'run', 'worker', null, 'run-1');

  for (const task of [now, proposal, done, marked]) {
    const res = await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE');
    assert.equal(res.status, 409, task.title);
    assert.equal(res.body.code, 'task.error.not_deletable');
    assert.ok(s.app.tasks.get(task.id), task.title);
  }
  for (const task of [future, overdue]) {
    const res = await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE');
    assert.equal(res.status, 200, task.title);
    assert.deepEqual(res.body.deleted, { id: task.id, events: 1, keptRuns: 0 });
    assert.equal(s.app.tasks.get(task.id), undefined);
  }
});

test('DELETE: やわらかい参照の表のどれかに行があると 409', async t => {
  const s = await taskApp(t);
  const insert: Record<(typeof TASK_SOFT_REFERENCES)[number]['table'], (id: string) => void> = {
    curiosity_items: id => { s.app.db.prepare('INSERT INTO curiosity_items (topic, task_id, created_at, updated_at) VALUES (?, ?, 1, 1)').run('topic', id); },
    memory_jobs: id => { s.app.db.prepare("INSERT INTO memory_jobs (trigger, dedup_key, task_id, created_at) VALUES ('task', ?, ?, 1)").run(`task:${id}`, id); },
    conversations: id => { s.app.db.prepare('UPDATE conversations SET source_task_id = ? WHERE id = ?').run(id, s.app.conversations.create({ kind: 'task', title: 'Review' }).id); },
  };
  assert.deepEqual(Object.keys(insert).sort(), TASK_SOFT_REFERENCES.map(r => r.table).sort());
  for (const ref of TASK_SOFT_REFERENCES) {
    for (const task of [s.userTask(`timed ${ref.table}`, { runAt: s.clock.now + HOUR }), s.userTask(`template ${ref.table}`, { cron: '0 9 * * *', timezone: 'UTC' })]) {
      insert[ref.table](task.id);
      const res = await s.api(`/api/tasks/${task.id}`, undefined, 'DELETE');
      assert.equal(res.status, 409, task.title);
      assert.equal(res.body.code, 'task.error.still_referenced', '「繰り返しか…だけ消せる」ではなく、参照が残っているという別の断り');
      assert.match(res.body.message, /still refers to this task/u);
      assert.ok(s.app.tasks.get(task.id), task.title);
    }
  }
});

test('DELETE は 1 つのトランザクション: 途中で失敗したら、子の parent_id も経過も kv も元のまま', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Summary', { cron: '0 9 * * *', timezone: 'UTC' });
  const child = s.app.tasks.spawnNow(template.id)!;
  s.app.tasks.finish(child.id, 'done', 'ok', 'clive');
  s.app.kv.setJson(splitKey(template.id), 2);
  s.app.db.exec("CREATE TRIGGER test_block_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'blocked by the test'); END");
  const before = snapshot(s);
  s.events.length = 0;
  assert.throws(() => s.app.tasks.remove(template.id), /blocked by the test/u);
  assert.equal(snapshot(s), before);
  assert.equal(s.app.tasks.get(child.id)!.parent_id, template.id);
  assert.ok(!s.events.some(e => e.type === 'task.deleted'));
});

test('DELETE: ひな形に会話が結び付いていたら 409', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Summary', { cron: '0 9 * * *', timezone: 'UTC' });
  s.app.db.prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(s.app.conversations.create({ kind: 'task', title: 'Summary' }).id, template.id);
  const res = await s.api(`/api/tasks/${template.id}`, undefined, 'DELETE');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'task.error.not_deletable');
  assert.ok(s.app.tasks.get(template.id));
});

// ── モデルの道具（task_create / task_update）で作った・触ったタスク ──

test('task_create の道具で作ったタスク（作ったときの context の行に会話の実行の印が付く）も、動いていなければ承認を戻せて、消せる', async t => {
  const s = await taskApp(t, config => { config.worker.selfTasksNeedApproval = true; });
  s.app.worker.setPaused(true);
  s.adapter().scripts.push(toolCall('task_create', { title: 'Tidy the notes' }), reply('Proposed.'));
  await s.chat('Anything to tidy?');
  s.adapter().scripts.push(toolCall('task_create', { title: 'Call the dentist', when: '2026-11-06T09:00:00+09:00', requested_by_user: true }), reply('Noted.'));
  await s.chat('Remind me to call the dentist');
  const byTitle = (title: string) => (s.app.db.prepare('SELECT id FROM tasks WHERE title = ?').get(title) as { id: string }).id;
  const proposal = s.app.tasks.get(byTitle('Tidy the notes'))!;
  const timed = s.app.tasks.get(byTitle('Call the dentist'))!;
  assert.deepEqual([proposal.status, timed.status, timed.run_at !== null, timed.conversation_id], ['inbox', 'ready', true, null]);
  for (const task of [proposal, timed]) {
    assert.equal(s.count('task_events', "task_id = ? AND kind = 'context' AND run_id IS NOT NULL", task.id), 1, '前提: 作ったときの行に実行の印がある');
  }

  assert.equal((await s.api(`/api/tasks/${proposal.id}/approve`, {})).body.task.status, 'ready');
  const undone = await s.api(`/api/tasks/${proposal.id}/unapprove`, {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.task.status, 'inbox');

  const removed = await s.api(`/api/tasks/${timed.id}`, undefined, 'DELETE');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(s.app.tasks.get(timed.id), undefined);

  // 動いたあとは、作ったときの行があっても今までどおり断る
  assert.equal((await s.api(`/api/tasks/${proposal.id}/approve`, {})).body.task.status, 'ready');
  s.app.tasks.event(proposal.id, 'run', 'worker', null, 'run-1');
  assert.equal((await s.api(`/api/tasks/${proposal.id}/unapprove`, {})).body.code, 'task.error.already_started');
});

test('task_update の道具でも、ひな形の開始の時刻（when）は動かせない', async t => {
  const s = await taskApp(t);
  const template = s.userTask('Morning summary', { cron: '0 9 * * *', timezone: 'UTC' });
  const before = snapshot(s);
  s.adapter().scripts.push(toolCall('task_update', { id: template.id.slice(0, 8), when: '2026-12-01T09:00:00+09:00' }), reply('Could not move it.'));
  await s.chat('Move the morning summary');
  assert.equal(snapshot(s), before);
  assert.equal(s.app.tasks.get(template.id)!.run_at, template.run_at);
  assert.throws(() => s.app.tasks.update(template.id, { runAt: null }, 'user'), (e: unknown) => e instanceof TaskError && e.code === 'error.template_when');
  assert.equal(s.app.tasks.update(template.id, { appendNote: 'a note' }, 'user').run_at, template.run_at, 'when のほかは今までどおり書ける');
});

// ── cancel を待っているあいだに変わったタスク ──

function heldCancel(s: S, id: string) {
  const url = new URL(`${s.origin}/api/tasks/${id}/cancel`);
  const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { Origin: s.origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
  const done = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req.on('error', reject);
    req.on('response', res => { let text = ''; res.on('data', c => { text += String(c); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) })); });
  });
  req.write('{"reason":');
  return { finish: () => { req.end('"too late"}'); return done; } };
}

test('cancel: 本文を待っているあいだに終わった・消えたタスクは、上書きせずに断る', async t => {
  const s = await taskApp(t);
  const finished = s.userTask('Finishes meanwhile');
  const deleted = s.userTask('Deleted meanwhile', { runAt: s.clock.now + HOUR });
  const held = [heldCancel(s, finished.id), heldCancel(s, deleted.id)];
  await new Promise(r => setTimeout(r, 100));
  s.app.tasks.finish(finished.id, 'done', 'Really finished', 'clive');
  s.app.tasks.remove(deleted.id);
  const [first, second] = [await held[0]!.finish(), await held[1]!.finish()];
  assert.equal(first.status, 409);
  assert.equal(first.body.code, 'http.already_finished');
  const kept = s.app.tasks.get(finished.id)!;
  assert.deepEqual([kept.status, kept.result_summary], ['done', 'Really finished']);
  assert.ok(!s.app.tasks.events(finished.id).some(e => e.kind === 'reason' || e.kind === 'cancelled'));
  assert.equal(second.status, 404);
  assert.equal(s.count('task_events', 'task_id = ?', deleted.id), 0, '消えたタスクの経過を書き足さない');
});

// ── unapprove ──

test('unapprove: 承認でできた、動いていないタスクだけを inbox に戻す（経過に unapproved）', async t => {
  const s = await taskApp(t);
  const proposal = s.userTask('Tidy notes', { origin: 'self', propose: true });
  assert.equal((await s.api(`/api/tasks/${proposal.id}/approve`, {})).body.task.status, 'ready');
  const res = await s.api(`/api/tasks/${proposal.id}/unapprove`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.task.status, 'inbox');
  assert.deepEqual(s.app.tasks.events(proposal.id).map(e => [e.kind, e.actor]), [['unapproved', 'user'], ['approved', 'user'], ['created', 'user']]);
  const again = await s.api(`/api/tasks/${proposal.id}/unapprove`, {});
  assert.equal(again.status, 409, '提案に戻ったあとは、もう戻すものが無い');
  assert.equal(again.body.code, 'task.error.not_approved');
  assert.equal((await s.api(`/api/tasks/${proposal.id}/approve`, {})).body.task.status, 'ready');
  assert.equal((await s.api(`/api/tasks/${proposal.id}/unapprove`, {})).body.task.status, 'inbox', 'もう一度承認したものも戻せる');
});

test('unapprove: 持ち主が「今すぐ」「この時刻に」で作った ready のタスクは 409（not_approved）。承認のあとに経過の行が増えたタスクも 409', async t => {
  const s = await taskApp(t);
  s.app.worker.setPaused(true);
  const now = (await s.api('/api/tasks', { title: 'Right now' })).body.task;
  const timed = (await s.api('/api/tasks', { title: 'At a time', when: '2026-11-06T09:00:00+09:00' })).body.task;
  const edited = s.userTask('Edited after approval', { origin: 'self', propose: true });
  s.app.tasks.approve(edited.id);
  assert.equal((await s.api(`/api/tasks/${edited.id}`, { title: 'Edited' }, 'PATCH')).status, 200);
  const before = snapshot(s);
  for (const id of [now.id, timed.id, edited.id]) {
    assert.equal(s.app.tasks.get(id)!.status, 'ready');
    assert.equal(s.app.tasks.get(id)!.conversation_id, null);
    const res = await s.api(`/api/tasks/${id}/unapprove`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'task.error.not_approved');
  }
  assert.equal(snapshot(s), before);
});

test('unapprove: 動き出したタスクは 409（already_started）。区切りで ready に戻ったあとも', async t => {
  const s = await taskApp(t);
  const running = s.userTask('Running', { origin: 'self', propose: true });
  s.app.tasks.approve(running.id);
  assert.ok(s.app.tasks.claim(running.id, 60_000, s.app.conversations.create({ kind: 'task', title: 'Running' }).id));
  const first = await s.api(`/api/tasks/${running.id}/unapprove`, {});
  assert.equal(first.status, 409);
  assert.equal(first.body.code, 'task.error.already_started');
  s.app.tasks.setReady(running.id);
  const back = s.app.tasks.get(running.id)!;
  assert.deepEqual([back.status, s.app.tasks.events(running.id)[0]!.kind], ['ready', 'approved'], '状態も経過も、承認した直後と同じに見える');
  const second = await s.api(`/api/tasks/${running.id}/unapprove`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'task.error.already_started');
  assert.equal(s.app.tasks.get(running.id)!.status, 'ready');

  const marked = s.userTask('Has a run mark', { origin: 'self', propose: true });
  s.app.tasks.event(marked.id, 'run', 'worker', null, 'run-1');
  s.app.tasks.approve(marked.id);
  assert.equal((await s.api(`/api/tasks/${marked.id}/unapprove`, {})).body.code, 'task.error.already_started');
});

// ── cancel の理由 ──

test('cancel: 終わりの知らせと聞き手は DB に書き終わってから動く。聞き手が失敗しても、取り消しと理由は残る', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Proposed', { origin: 'self', propose: true });
  const original = s.app.tasks.onChange;
  const inTransaction: boolean[] = [];
  s.app.tasks.onChange = changed => { inTransaction.push(s.app.db.isTransaction); original?.(changed); throw new Error('listener failed'); };
  s.app.kv.set(splitKey(task.id), '1');
  const stopped: string[] = [];
  const stopTask = s.app.worker.stopTask.bind(s.app.worker);
  s.app.worker.stopTask = id => { stopped.push(id); return stopTask(id); };
  const res = await s.api(`/api/tasks/${task.id}/cancel`, { reason: 'Not now' });
  assert.equal(res.status, 500);
  assert.deepEqual(stopped, [task.id], '聞き手が失敗しても、実行を止める');
  assert.equal(s.app.kv.get(splitKey(task.id)), undefined, '聞き手が失敗しても、kv を片付ける');
  assert.deepEqual(inTransaction, [false]);
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
  assert.deepEqual(s.app.tasks.events(task.id).map(e => e.kind), ['cancelled', 'reason', 'created']);
});

test('cancel の理由は、user の別の行（kind: reason）として経過に入る。理由なしは今までと同じ', async t => {
  const s = await taskApp(t);
  const withReason = s.userTask('Proposed', { origin: 'self', propose: true });
  const seenAtPublish: string[][] = [];
  s.app.bus.subscribe(e => { if (e.event.type === 'task.changed' && e.event.task.id === withReason.id) seenAtPublish.push(s.app.tasks.events(withReason.id).map(x => x.kind)); });  const res = await s.api(`/api/tasks/${withReason.id}/cancel`, { reason: '  Not this week.\nMaybe later.  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.status, 'cancelled');
  assert.equal(res.body.task.result_summary, 'Cancelled from the screen', '取り消しの要約には混ぜない');
  assert.deepEqual(s.app.tasks.events(withReason.id).slice(0, 2).map(e => [e.kind, e.actor, e.content]), [
    ['cancelled', 'user', 'Cancelled from the screen'],
    ['reason', 'user', 'Not this week.\nMaybe later.'],
  ]);
  assert.deepEqual(seenAtPublish[0], ['cancelled', 'reason', 'created'], '取り消しの知らせ（task.changed）が出た時点で、理由の行はもう書かれている');
  const restored = s.app.tasks.uncancel(withReason.id, 'user');
  assert.match(taskPrompt(restored, s.app.tasks.events(restored.id), 'Asia/Tokyo', 'en'), / reason for cancelling \(the user's own words\): Not this week\.\n  Maybe later\.\n/u, '戻すと、理由も次の実行のモデルに渡る');

  for (const body of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
    const task = s.userTask('No reason');
    const plain = body === undefined
      ? await s.api(`/api/tasks/${task.id}/cancel`, undefined, 'POST')
      : await s.api(`/api/tasks/${task.id}/cancel`, body);
    assert.equal(plain.status, 200);
    assert.deepEqual(s.app.tasks.events(task.id).map(e => e.kind), ['cancelled', 'created']);
  }

  for (const raw of ['{broken', '"just a string"', '[1]', '']) {
    const task = s.userTask('Garbage body');
    const res = await fetch(`${s.origin}/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { Origin: s.origin, 'Content-Type': 'application/json' }, body: raw });
    assert.equal(res.status, 200, `壊れた本文（${raw}）は「理由なし」として取り消す`);
    assert.deepEqual(s.app.tasks.events(task.id).map(e => e.kind), ['cancelled', 'created']);
  }

  const tooLong = s.userTask('Too long');
  const rejected = await s.api(`/api/tasks/${tooLong.id}/cancel`, { reason: 'x'.repeat(2001) });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'http.too_long');
  assert.equal(s.app.tasks.get(tooLong.id)!.status, 'ready', '断ったときは取り消さない');
  assert.equal((await s.api(`/api/tasks/${tooLong.id}/cancel`, { reason: 5 })).status, 400);
  assert.equal((await s.api(`/api/tasks/${tooLong.id}/cancel`, { reason: 'x'.repeat(2000) })).status, 200);
  const doneTask = s.userTask('Done one');
  assert.equal((await s.api(`/api/tasks/${doneTask.id}/done`, { reason: 'ignored' })).status, 200);
  assert.deepEqual(s.app.tasks.events(doneTask.id).map(e => e.kind), ['done', 'created'], 'done は理由を受けない');
});
