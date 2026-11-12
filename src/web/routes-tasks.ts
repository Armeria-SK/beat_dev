import type { IncomingMessage } from 'node:http';
import type { App } from '../app.ts';
import { transaction } from '../db/database.ts';
import { AVATAR_SHAPES } from '../config/schema.ts';
import { ConfigError } from '../config/store.ts';
import { parseCron } from '../tasks/schedule.ts';
import { SCHEDULE_MAX_RANGE_MS, TaskError, taskView, type Task } from '../tasks/store.ts';
import { splitKey } from '../tasks/worker.ts';
import { languageOf } from '../shared/language.ts';
import { approvalShownIn, approvalWire } from '../tools/approvals.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { configProblem, domainProblem, problem, readJson, requireObject, requireString, sendJson, type Router } from './http.ts';

const MOTIONS = ['auto', 'none', 'float', 'sway', 'pulse'] as const;

function taskProblem(error: unknown): never {
  if (error instanceof TaskError) throw domainProblem(409, 'task', error);
  throw error;
}

function priorityOf(body: Record<string, unknown>): number | undefined {
  if (body.priority === undefined) return undefined;
  if (body.priority !== 1 && body.priority !== 2 && body.priority !== 3) {
    throw problem(400, 'invalid_field', 'bad_priority', { field: 'priority' });
  }
  return body.priority;
}

function doneCriteriaOf(body: Record<string, unknown>): string | null | undefined {
  if (body.doneCriteria === undefined) return undefined;
  if (body.doneCriteria === null || (typeof body.doneCriteria === 'string' && !body.doneCriteria.trim())) return null;
  return requireString(body, 'doneCriteria', { max: 500 })!.trim();
}

function whenOf(body: Record<string, unknown>): number | null | undefined {
  if (body.when === undefined) return undefined;
  if (body.when === null || body.when === '') return null;
  const ms = typeof body.when === 'string' ? Date.parse(body.when) : Number.NaN;
  if (!Number.isFinite(ms)) throw problem(400, 'invalid_field', 'bad_when', { field: 'when' });
  return ms;
}

function cronOf(body: Record<string, unknown>): string | undefined {
  if (body.repeat === undefined || body.repeat === null) return undefined;
  const repeat = requireObject(body.repeat);
  const freq = typeof repeat.freq === 'string' ? repeat.freq : '';
  const values = repeat.values && typeof repeat.values === 'object' ? Object.fromEntries(Object.entries(repeat.values).map(([k, v]) => [k, String(v)])) : {};
  const cron = parseCron(freq, values);
  if (!cron) throw problem(400, 'invalid_field', 'bad_repeat', { field: 'repeat' });
  return cron;
}

export function registerTaskRoutes(router: Router, app: App): void {
  const view = (task: Task) => taskView(task, languageOf(app.config()));
  const getTask = (id: string): Task => {
    const task = app.tasks.get(id);
    if (!task) throw problem(404, 'not_found', 'task_missing');
    return task;
  };

  router.add('GET', '/api/tasks', ({ res }) => sendJson(res, 200, {
    active: app.tasks.list().map(view),
    finished: app.tasks.recentlyFinished().map(view),
    finishedTotal: app.tasks.finishedTotal(),
    repeating: app.tasks.templates().map(task => ({ ...view(task), last_run: task.last_run })),
  }));

  router.add('GET', '/api/tasks/finished', ({ res, url }) => {
    const beforeT = url.searchParams.get('beforeT');
    const beforeId = url.searchParams.get('beforeId');
    if ((beforeT === null) !== (beforeId === null) || (beforeT !== null && !/^\d{1,16}$/u.test(beforeT)) || beforeId === '') {
      throw problem(400, 'invalid_field', 'bad_cursor', { field: 'beforeT' });
    }
    const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit') ?? 20)) || 20, 1), 100);
    const page = app.tasks.finishedPage({ before: beforeT !== null && beforeId !== null ? { t: Number(beforeT), id: beforeId } : undefined, limit });
    sendJson(res, 200, { tasks: page.tasks.map(view), next: page.next ? { beforeT: page.next.t, beforeId: page.next.id } : null, total: app.tasks.finishedTotal() });
  });

  router.add('GET', '/api/schedule', ({ res, url }) => {
    const [from, to] = ['from', 'to'].map(name => { const raw = url.searchParams.get(name); return raw !== null && /^\d{1,16}$/u.test(raw) ? Number(raw) : Number.NaN; }) as [number, number];
    if (!(from < to) || to - from > SCHEDULE_MAX_RANGE_MS) {
      throw problem(400, 'invalid_field', 'bad_range', { field: 'from', params: { days: SCHEDULE_MAX_RANGE_MS / 86_400_000 } });
    }
    sendJson(res, 200, app.tasks.schedule(from, to));
  });

  router.add('POST', '/api/tasks', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { max: 200 })!;
    const text = requireString(body, 'body', { optional: true, max: 20_000 });
    const priority = priorityOf(body);
    const when = whenOf(body);
    const cron = cronOf(body);
    try {
      const task = app.tasks.create({
        title, body: text, priority, origin: 'user', actor: 'user',
        ...(when ? { runAt: when } : {}), ...(cron ? { cron, timezone: app.config().timezone } : {}),
      });
      // 「今すぐ」頼まれたものは、すぐに実行する（1時間の上限より先に）
      if (!when && !cron) app.worker.requestRun(task.id);
      sendJson(res, 201, { task: view(task) });
    } catch (error) { taskProblem(error); }
  });

  router.add('GET', '/api/tasks/:id', ({ res, params }) => {
    const task = getTask(params[0]!);
    const approvals = task.conversation_id ? app.approvals.pending().filter(a => approvalShownIn(a) === task.conversation_id).map(approvalWire) : [];
    const children = task.status === 'scheduled'
      ? app.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at DESC LIMIT 20').all(task.id) as unknown as Task[]
      : [];
    sendJson(res, 200, { task: view(task), events: app.tasks.events(task.id), approvals, runs: children.map(view) });
  });

  router.add('PATCH', '/api/tasks/:id', async ({ req, res, params }) => {
    const task = getTask(params[0]!);
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    const text = requireString(body, 'body', { optional: true, max: 20_000 });
    const nextAction = body.nextAction === null ? null : requireString(body, 'nextAction', { optional: true, max: 2000 });
    const doneCriteria = doneCriteriaOf(body);
    const priority = priorityOf(body);
    const when = whenOf(body);
    const cron = cronOf(body);
    if (cron !== undefined && when !== undefined) throw problem(400, 'invalid_field', 'repeat_with_when', { field: 'repeat' });
    const fields = {
      ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { body: text } : {}),
      ...(nextAction !== undefined ? { nextAction } : {}), ...(doneCriteria !== undefined ? { doneCriteria } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(when !== undefined ? { runAt: when } : {}),
    };
    try {
      const updated = transaction(app.db, () => {
        let next = cron !== undefined ? app.tasks.setSchedule(task.id, cron, app.config().timezone, 'user') : task;
        if (cron === undefined || Object.keys(fields).length) {
          next = app.tasks.update(task.id, fields, 'user');
          app.tasks.event(task.id, 'edited', 'user');
        }
        return next;
      });
      app.kv.delete(splitKey(task.id));
      sendJson(res, 200, { task: view(updated) });
    } catch (error) {
      if (error instanceof TaskError && error.code === 'error.bad_cron') throw domainProblem(400, 'task', error);
      taskProblem(error);
    }
  });

  router.add('DELETE', '/api/tasks/:id', ({ res, params }) => {
    const task = getTask(params[0]!);
    try {
      const removed = app.tasks.remove(task.id);
      sendJson(res, 200, { deleted: { id: removed.id, events: removed.events, keptRuns: removed.keptRuns } });
    } catch (error) { taskProblem(error); }
  });

  router.add('POST', '/api/tasks/:id/answer', async ({ req, res, params }) => {
    const task = getTask(params[0]!);
    const text = requireString(requireObject(await readJson(req)), 'text', { max: 20_000 })!;
    if (task.status !== 'waiting') throw problem(409, 'task', 'not_waiting');
    app.tasks.event(task.id, 'answer', 'user', taskText(languageOf(app.config()), 'event.answer', { question: task.waiting_text ?? '', text }));
    const updated = app.tasks.setReady(task.id, { actor: 'user' });
    app.kv.delete(splitKey(task.id));
    app.worker.requestRun(task.id);
    sendJson(res, 200, { task: view(updated) });
  });

  router.add('POST', '/api/tasks/:id/run-now', ({ res, params }) => {
    let task = getTask(params[0]!);
    try {
      if (task.status === 'running') throw new TaskError('error.running');
      if (task.status === 'waiting') throw new TaskError('error.waiting_answer');
      if (task.status === 'scheduled') {
        const child = app.tasks.spawnNow(task.id);
        if (!child) throw new TaskError('error.previous_unfinished');
        task = child;
      } else if (task.status === 'inbox') {
        task = app.tasks.approve(task.id);
      } else if (task.status !== 'ready' || task.attempts >= task.max_attempts) {
        // 取り消した予定のひな形は、予定に戻したうえで今回の実行を 1 つ作る（前の実行が残っていれば、予定も戻さずに断る）
        const template = task.cron !== null && task.parent_id === null;
        if (template && app.tasks.hasOpenRun(task.id)) throw new TaskError('error.previous_unfinished');
        task = app.tasks.reopen(task.id, 'user', taskText(languageOf(app.config()), 'event.run_now'));
        if (template) {
          const child = app.tasks.spawnNow(task.id);
          if (!child) throw new TaskError('error.previous_unfinished');
          task = child;
        }
      } else {
        task = app.tasks.update(task.id, { runAt: null }, 'user');
      }
      app.kv.delete(splitKey(task.id));
      app.worker.requestRun(task.id);
      sendJson(res, 202, { task: view(task) });
    } catch (error) { taskProblem(error); }
  });

  router.add('POST', '/api/tasks/:id/approve', ({ res, params }) => {
    try { sendJson(res, 200, { task: view(app.tasks.approve(getTask(params[0]!).id)) }); } catch (error) { taskProblem(error); }
  });

  router.add('POST', '/api/tasks/:id/unapprove', ({ res, params }) => {
    try { sendJson(res, 200, { task: view(app.tasks.unapprove(getTask(params[0]!).id)) }); } catch (error) { taskProblem(error); }
  });

  const cancelReasonOf = async (req: IncomingMessage): Promise<string | undefined> => {
    if (!/^application\/json\b/iu.test(req.headers['content-type'] ?? '')) return undefined;
    let body: Record<string, unknown>;
    try { body = requireObject(await readJson(req)); } catch { return undefined; }
    if (body.reason === undefined || body.reason === null || (typeof body.reason === 'string' && !body.reason.trim())) return undefined;
    return requireString(body, 'reason', { max: 2000 })!.trim();
  };

  const close = (status: 'cancelled' | 'done') => async ({ req, res, params }: { req: IncomingMessage; res: Parameters<typeof sendJson>[0]; params: string[] }) => {
    const reason = status === 'cancelled' ? await cancelReasonOf(req) : undefined;
    const task = getTask(params[0]!);
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      throw problem(409, 'task', 'already_finished');
    }
    let updated: Task;
    try {
      updated = app.tasks.finish(task.id, status, taskText(languageOf(app.config()), status === 'done' ? 'summary.done_from_ui' : 'summary.cancelled_from_ui'), 'user', undefined, reason);
    } finally {
      app.worker.stopTask(task.id);
      app.kv.delete(splitKey(task.id));
    }
    sendJson(res, 200, { task: view(updated) });
  };
  router.add('POST', '/api/tasks/:id/cancel', close('cancelled'));
  router.add('POST', '/api/tasks/:id/uncancel', ({ res, params }) => {
    const task = getTask(params[0]!);
    try {
      const restored = app.tasks.uncancel(task.id, 'user');
      app.kv.delete(splitKey(task.id));
      sendJson(res, 200, { task: view(restored) });
    } catch (error) { taskProblem(error); }
  });
  router.add('POST', '/api/tasks/:id/done', close('done'));

  // ── ワーカー ──
  router.add('GET', '/api/worker', ({ res }) => sendJson(res, 200, app.worker.status()));
  router.add('POST', '/api/worker', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') throw problem(400, 'invalid_field', 'bad_bool', { field: 'paused', params: { field: 'paused' } });
      app.worker.setPaused(body.paused);
    }
    if (body.autonomy !== undefined) {
      if (typeof body.autonomy !== 'boolean') throw problem(400, 'invalid_field', 'bad_bool', { field: 'autonomy', params: { field: 'autonomy' } });
      const config = app.config();
      if (config.worker.autonomy !== body.autonomy) await app.applyConfig({ ...config, worker: { ...config.worker, autonomy: body.autonomy } });
    }
    sendJson(res, 200, app.worker.status());
  });

  // ── 通知 ──
  router.add('GET', '/api/notifications', ({ res }) => sendJson(res, 200, { notifications: app.notifications.list(), unread: app.notifications.unread() }));
  router.add('POST', '/api/notifications/read', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    let ids: number[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || !body.ids.every(id => Number.isSafeInteger(id))) {
        throw problem(400, 'invalid_field', 'bad_ids', { field: 'ids' });
      }
      ids = body.ids as number[];
    }
    app.notifications.markRead(ids);
    sendJson(res, 200, { unread: app.notifications.unread() });
  });

  // ── プロフィール（名前と姿） ──
  router.add('GET', '/api/profile', ({ res }) => sendJson(res, 200, { ...app.config().profile, shapes: AVATAR_SHAPES, motions: MOTIONS }));
  router.add('PATCH', '/api/profile', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const config = app.config();
    const profile = { ...config.profile };
    const name = requireString(body, 'name', { optional: true, max: 40 });
    if (name !== undefined) {
      if (!name.trim()) throw problem(400, 'invalid_field', 'empty_name', { field: 'name' });
      profile.name = name.trim();
    }
    if (body.shape !== undefined) {
      if (!(AVATAR_SHAPES as readonly unknown[]).includes(body.shape)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'shape', params: { field: 'shape', values: AVATAR_SHAPES.join(' / ') } });
      profile.shape = body.shape as typeof profile.shape;
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(body.color)) throw problem(400, 'invalid_field', 'bad_color', { field: 'color' });
      profile.color = body.color;
    }
    if (body.motion !== undefined) {
      if (!(MOTIONS as readonly unknown[]).includes(body.motion)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'motion', params: { field: 'motion', values: MOTIONS.join(' / ') } });
      profile.motion = body.motion as typeof profile.motion;
    }
    try {
      const saved = await app.applyConfig({ ...config, profile });
      sendJson(res, 200, { ...saved.profile, shapes: AVATAR_SHAPES, motions: MOTIONS });
    } catch (error) {
      if (error instanceof ConfigError) throw configProblem(error);
      throw error;
    }
  });
}
