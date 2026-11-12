import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../web/src/api.ts';
import type { FeedbackItem } from '../web/src/feedback.ts';
import { t } from '../web/src/i18n/index.ts';
import { sheetActions } from '../web/src/task-meta.ts';
import { answerTaskOp, runTaskOp, taskButtons, type TaskOpDeps } from '../web/src/ui/task-ops.ts';

// 新しい画面のタスクの操作（Kanban のカードとタスクの画面。steps/p1-ui.md の 1-4a）。
// 戻せる操作（承認 → unapprove、却下・取り消し → uncancel）のトーストにだけ Undo が付く。画面を持たない関数（web/src/ui/task-ops.ts）。

const TASK = { id: 't1', title: 'Tidy the notes' };

function harness(fail: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const toasts: FeedbackItem[] = [];
  const reply = async (name: string) => {
    calls.push(name);
    if (Object.hasOwn(fail, name.split(' ')[0]!)) throw fail[name.split(' ')[0]!];
    return { task: TASK } as never;
  };
  const deps: TaskOpDeps = {
    api: {
      taskAction: (id, action) => reply(`${action} ${id}`),
      unapproveTask: id => reply(`unapprove ${id}`),
      cancelTask: (id, reason = '') => reply(`cancel ${id}${reason ? ` reason=${reason}` : ''}`),
      answerTask: (id, text) => reply(`answer ${id} ${text}`),
      stop: runId => reply(`stop ${runId}`),
    },
    toast: item => { toasts.push(item); },
  };
  return { calls, toasts, deps };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('ui/task-ops: 承認のトーストには Undo が付き、押すと unapprove を呼ぶ', async () => {
  const h = harness();
  assert.equal(await runTaskOp('approve', TASK, {}, h.deps), true);
  assert.deepEqual(h.calls, ['approve t1']);
  assert.equal(h.toasts[0]!.title, t('ui.task.toast.approved'));
  assert.equal(h.toasts[0]!.body, 'Tidy the notes');
  assert.equal(h.toasts[0]!.action?.label, t('ui.toast.undo'));
  h.toasts[0]!.action!.run();
  await settle();
  assert.deepEqual(h.calls, ['approve t1', 'unapprove t1']);
  assert.equal(h.toasts.length, 1, '戻せたときは何も足さない');
});

test('ui/task-ops: 承認を戻せなかった（もう動き出した）ときは、サーバーの文つきで知らせる', async () => {
  const h = harness({ unapprove: new ApiError(409, { error: 'task', code: 'task.error.already_started', message: 'This task has already started' }) });
  await runTaskOp('approve', TASK, {}, h.deps);
  h.toasts[0]!.action!.run();
  await settle();
  assert.equal(h.toasts[1]!.title, t('ui.task.toast.undoFailed'));
  assert.equal(h.toasts[1]!.icon, 'alert');
  assert.match(h.toasts[1]!.body ?? '', /already started/u);
  assert.equal(h.toasts[1]!.action, undefined);
});

test('ui/task-ops: 却下は理由を付けて取り消し、トーストの Undo は uncancel。理由が空なら題を出す', async () => {
  const h = harness();
  assert.equal(await runTaskOp('reject', TASK, { reason: '  not now  ' }, h.deps), true);
  assert.deepEqual(h.calls, ['cancel t1 reason=not now']);
  assert.equal(h.toasts[0]!.title, t('ui.task.toast.rejected'));
  assert.equal(h.toasts[0]!.body, t('ui.task.toast.reason', 'not now'));
  h.toasts[0]!.action!.run();
  await settle();
  assert.deepEqual(h.calls.at(-1), 'uncancel t1');

  const plain = harness();
  await runTaskOp('reject', TASK, {}, plain.deps);
  assert.deepEqual(plain.calls, ['cancel t1']);
  assert.equal(plain.toasts[0]!.body, 'Tidy the notes');
});

test('ui/task-ops: 取り消しは Undo つき（uncancel）。完了・今すぐ実行・止める・戻すのトーストには Undo が無い（サーバーが戻せないため）', async () => {
  const h = harness();
  await runTaskOp('cancel', TASK, {}, h.deps);
  assert.equal(h.toasts[0]!.title, t('ui.task.toast.cancelled'));
  h.toasts[0]!.action!.run();
  await settle();
  assert.deepEqual(h.calls, ['cancel t1', 'uncancel t1']);

  for (const [op, call, title] of [
    ['done', 'done t1', 'ui.task.toast.done'], ['runNow', 'run-now t1', 'ui.task.toast.started'], ['retry', 'run-now t1', 'ui.task.toast.started'], ['restore', 'uncancel t1', 'ui.task.toast.restored'],
  ] as const) {
    const one = harness();
    assert.equal(await runTaskOp(op, TASK, {}, one.deps), true, op);
    assert.deepEqual(one.calls, [call]);
    assert.equal(one.toasts[0]!.title, t(title));
    assert.equal(one.toasts[0]!.action, undefined, op);
  }
  const next = harness();
  await runTaskOp('runNow', TASK, { busyWithOther: true }, next.deps);
  assert.equal(next.toasts[0]!.title, t('ui.task.toast.runNext'));

  const stop = harness();
  assert.equal(await runTaskOp('stop', TASK, {}, stop.deps), false, '実行の id が無ければ何もしない');
  assert.deepEqual(stop.calls, []);
  assert.equal(await runTaskOp('stop', TASK, { runId: 'run-9' }, stop.deps), true);
  assert.deepEqual(stop.calls, ['stop run-9']);
  assert.equal(stop.toasts[0]!.action, undefined);
});

test('ui/task-ops: 失敗したら理由のトーストを出して false を返す（成功のトーストは出さない）', async () => {
  const h = harness({ approve: new ApiError(409, { message: 'Already decided' }) });
  assert.equal(await runTaskOp('approve', TASK, {}, h.deps), false);
  assert.deepEqual(h.toasts.map(item => [item.title, item.icon, item.body]), [[t('ui.task.toast.failed'), 'alert', 'Already decided']]);
});

test('ui/task-ops: 取り消し・却下の前にタスクが終わっていた（409 http.already_finished）ら、「もう終わっていた」と知らせて読み直させる（true）', async () => {
  const gone = new ApiError(409, { error: 'task', code: 'http.already_finished', message: 'finished' });
  for (const op of ['cancel', 'reject'] as const) {
    const h = harness({ cancel: gone });
    assert.equal(await runTaskOp(op, TASK, {}, h.deps), true, op);
    assert.deepEqual(h.toasts.map(item => [item.title, item.body, item.action]), [[t('ui.task.toast.alreadyFinished'), 'Tidy the notes', undefined]]);
  }
  const other = harness({ cancel: new ApiError(409, { code: 'task.error.other', message: 'no' }) });
  assert.equal(await runTaskOp('cancel', TASK, {}, other.deps), false);
});

test('ui/task-ops: Mark done の前にタスクが終わっていた（409 http.already_finished）ときも、「もう終わっていた」と知らせて読み直させる（true）', async () => {
  const h = harness({ done: new ApiError(409, { error: 'task', code: 'http.already_finished', message: 'finished' }) });
  assert.equal(await runTaskOp('done', TASK, {}, h.deps), true);
  assert.deepEqual(h.toasts.map(item => [item.title, item.body]), [[t('ui.task.toast.alreadyFinished'), 'Tidy the notes']]);
});

test('ui/task-ops: 返事待ちのタスクに答える', async () => {
  const h = harness();
  assert.equal(await answerTaskOp(TASK, 'export.csv', h.deps), true);
  assert.deepEqual(h.calls, ['answer t1 export.csv']);
  assert.equal(h.toasts[0]!.title, t('ui.task.toast.answered'));
  const bad = harness({ answer: new Error('x') });
  assert.equal(await answerTaskOp(TASK, 'y', bad.deps), false);
  assert.equal(bad.toasts[0]!.icon, 'alert');
});

test('ui/task-ops: タスクの画面のボタン。提案は Approve と Reject、取り消したタスクには Restore、動いている実行にだけ Stop', () => {
  const ops = (status: Parameters<typeof sheetActions>[0], runningHere = false) => taskButtons(status, sheetActions(status), runningHere).map(b => `${b.op}${b.primary ? '*' : ''}`);
  assert.deepEqual(ops('inbox'), ['approve*', 'reject']);
  assert.deepEqual(ops('ready'), ['runNow*', 'done', 'cancel']);
  assert.deepEqual(ops('running'), ['done', 'cancel']);
  assert.deepEqual(ops('running', true), ['stop', 'done', 'cancel']);
  assert.deepEqual(ops('waiting'), ['done', 'cancel']);
  assert.deepEqual(ops('failed'), ['retry*']);
  assert.deepEqual(ops('done'), ['retry']);
  assert.deepEqual(ops('cancelled'), ['restore*', 'retry']);
});
