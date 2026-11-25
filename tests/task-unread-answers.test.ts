import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskApp, toolCall } from './helpers/task-app.ts';

// 頼みの文に入る経過は新しい順の 200 件まで。前の実行のあとに積まれた経過が 200 件を超えても、読まれていない答えは落とさない（K3）

const ANSWER = 'ANSWER-TEXT-9d41 use the blue option';

const times = (text: string, needle: string): number => text.split(needle).length - 1;

async function promptOf(s: Awaited<ReturnType<typeof taskApp>>): Promise<string> {
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'done' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  return JSON.stringify(s.adapter().calls[0]!.messages);
}

test('K3: an answer recorded before 250 more progress rows still reaches the next run, once', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Wait for the answer');
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-1');
  s.app.tasks.event(task.id, 'answer', 'user', ANSWER);
  for (let i = 0; i < 250; i += 1) s.app.tasks.event(task.id, 'progress', 'beat', `step ${i}`);
  assert.equal(s.app.tasks.events(task.id).some(e => e.kind === 'answer'), false, 'the answer is outside the 200-row window');
  const prompt = await promptOf(s);
  assert.equal(times(prompt, ANSWER), 1, 'the unread answer is in the prompt exactly once');
});

test('K3: an answer the previous run already read (a run row after it) is not added again', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Answered long ago');
  s.app.tasks.event(task.id, 'answer', 'user', ANSWER);
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-2');
  for (let i = 0; i < 250; i += 1) s.app.tasks.event(task.id, 'progress', 'beat', `step ${i}`);
  const prompt = await promptOf(s);
  assert.equal(times(prompt, ANSWER), 0, 'read by the run that followed it');
});

test('K3: an answer that went to a follow-up task (answer_moved row after it) is not added again', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Moved answer');
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-1');
  s.app.tasks.event(task.id, 'answer', 'user', ANSWER);
  s.app.tasks.event(task.id, 'answer_moved', 'beat', 'moved to the follow-up task');
  for (let i = 0; i < 250; i += 1) s.app.tasks.event(task.id, 'progress', 'beat', `step ${i}`);
  const prompt = await promptOf(s);
  assert.equal(times(prompt, ANSWER), 0);
});

test('K3: with few rows the prompt is what it was, and the same answer does not appear twice', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Few rows');
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-1');
  s.app.tasks.event(task.id, 'answer', 'user', ANSWER);
  for (let i = 0; i < 12; i += 1) s.app.tasks.event(task.id, 'progress', 'beat', `step ${i}`);
  const prompt = await promptOf(s);
  assert.equal(times(prompt, ANSWER), 1);
});

test('K3: exactly 200 rows with the answer inside the window: no extra copy', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Edge');
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-1');
  s.app.tasks.event(task.id, 'answer', 'user', ANSWER);
  const have = s.app.tasks.events(task.id).length;
  for (let i = 0; i < 200 - have; i += 1) s.app.tasks.event(task.id, 'progress', 'beat', `step ${i}`);
  const rows = s.app.tasks.events(task.id);
  assert.equal(rows.length, 200);
  assert.ok(rows.some(e => e.kind === 'run') && rows.some(e => e.kind === 'answer'), 'the run row is still in the window');
  const prompt = await promptOf(s);
  assert.equal(times(prompt, ANSWER), 1);
});

test('K3: answersSinceLastRun: only answers after the last run / answer_moved row, newest first, at most the limit', async t => {
  const s = await taskApp(t);
  const task = s.userTask('Store');
  const other = s.userTask('Other task');
  s.app.tasks.event(task.id, 'answer', 'user', 'before the run');
  s.app.tasks.event(task.id, 'run', 'worker', null, 'run-1');
  for (let i = 0; i < 25; i += 1) s.app.tasks.event(task.id, 'answer', 'user', `answer ${i}`);
  s.app.tasks.event(task.id, 'answer', 'user', null);
  s.app.tasks.event(other.id, 'answer', 'user', 'another task');
  const got = s.app.tasks.answersSinceLastRun(task.id, 20);
  assert.equal(got.length, 20, 'limit');
  assert.deepEqual(got.map(e => e.content).slice(0, 2), ['answer 24', 'answer 23'], 'newest first, rows without a text skipped');
  assert.equal(got.every(e => e.kind === 'answer' && e.task_id === task.id), true);
  assert.equal(s.app.tasks.answersSinceLastRun(task.id).length, 20, 'the default limit is 20');
  s.app.tasks.event(task.id, 'answer_moved', 'beat', 'moved');
  assert.deepEqual(s.app.tasks.answersSinceLastRun(task.id), [], 'an answer_moved row also ends what is unread');
  s.app.tasks.event(task.id, 'answer', 'user', 'after the move');
  assert.deepEqual(s.app.tasks.answersSinceLastRun(task.id).map(e => e.content), ['after the move']);
});
