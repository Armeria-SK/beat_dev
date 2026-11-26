import type { App } from '../app.ts';
import { transaction } from '../db/database.ts';
import { parentOf } from '../pending/replay.ts';
import { PendingError, storedRule, type PendingRow, type PendingView } from '../pending/store.ts';
import { addRule } from '../tools/approval-rules.ts';
import { startOfDayIn } from '../tasks/schedule.ts';
import { domainProblem, readJson, requireObject, type Router, sendJson } from './http.ts';

function idOf(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(id) || id < 1) throw domainProblem(400, 'invalid_id', new PendingError('invalid_id'));
  return id;
}

function pendingProblem(error: unknown): never {
  if (error instanceof PendingError) throw domainProblem(error.code === 'not_found' ? 404 : 409, error.code === 'not_found' ? 'not_found' : 'conflict', error);
  throw error;
}

export function registerPendingRoutes(router: Router, app: App): void {
  const today = (): number => {
    try { return startOfDayIn(app.config().timezone, app.now()); } catch { return startOfDayIn('UTC', app.now()); }
  };
  const text = (url: URL, name: string): string | undefined => {
    const value = url.searchParams.get(name);
    return value === null || value === '' ? undefined : value.slice(0, 200);
  };
  // The "from" of a child agent's row is the parent's conversation: the child's own title is a line the model wrote. Without a parent or a parent title it stays the child's
  const titleOf = (item: PendingView): string | null => {
    const own = app.conversations.get(item.conversation_id)?.title ?? null;
    if (item.run_kind !== 'agent') return own;
    const row = app.pending.row(item.id);
    const parent = row ? parentOf(app.db, row) : undefined;
    return (parent ? app.conversations.get(parent.conversationId)?.title : undefined) || own;
  };
  router.add('GET', '/api/pending', ({ res, url }) => {
    const status = text(url, 'status') ?? 'waiting';
    if (status !== 'waiting' && status !== 'decided') throw domainProblem(400, 'invalid_field', new PendingError('invalid_status'));
    const before = text(url, 'before');
    const earlier = text(url, 'earlier') === '1';
    const items = app.pending.list({
      status, project: text(url, 'project'), task: text(url, 'task'), conversation: text(url, 'conversation'),
      ...(before !== undefined ? { before: idOf(before) } : earlier ? { until: today() } : { since: today() }),
    });
    sendJson(res, 200, {
      items: items.map(item => ({
        ...item,
        conversation_title: titleOf(item),
        project_archived: item.project_id !== null && (app.projects.get(item.project_id)?.archived_at ?? null) !== null,
      })),
    });
  });
  router.add('GET', '/api/pending/counts', ({ res }) => sendJson(res, 200, app.pending.counts(today())));
  router.add('POST', '/api/pending/:id/approve', async ({ req, res, params }) => {
    const id = idOf(params[0]);
    const body = req.headers['content-type'] === undefined ? {} : requireObject(await readJson(req));
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw domainProblem(400, 'invalid_field', new PendingError('invalid_remember'));
    if (body.reply !== undefined && typeof body.reply !== 'boolean') throw domainProblem(400, 'invalid_field', new PendingError('invalid_reply'));
    if (body.reply === true && body.remember === true) throw domainProblem(400, 'invalid_field', new PendingError('invalid_reply'));
    let row: PendingRow;
    try {
      if (body.reply === true) {
        const before = app.pending.view(id);
        if (!before) throw new PendingError('not_found', { id });
        if (before.status !== 'waiting') throw new PendingError('not_waiting', { id, status: before.status });
        if (!before.runtime?.reply) throw new PendingError('reply_unavailable', { id });
      }
      row = body.remember === true ? transaction(app.db, () => {
        const before = app.pending.row(id);
        if (!before) throw new PendingError('not_found', { id });
        if (before.status !== 'waiting') throw new PendingError('not_waiting', { id, status: before.status });
        const rule = storedRule(before);
        if (!rule || !before.project_id || !app.pending.rememberableNow(before)) throw new PendingError('not_rememberable', { id });
        addRule(app.db, { projectId: before.project_id, candidate: rule, fromPending: id, now: app.now() });
        return app.pending.claim(id);
      }) : app.pending.claim(id);
    } catch (error) { pendingProblem(error); }
    app.replayPending(row, { reply: body.reply === true });
    sendJson(res, 202, { item: app.pending.view(id) });
  });
  router.add('POST', '/api/pending/:id/reject', async ({ req, res, params }) => {
    const id = idOf(params[0]);
    const body = requireObject(await readJson(req));
    if (body.reason !== undefined && typeof body.reason !== 'string') throw domainProblem(400, 'invalid_field', new PendingError('invalid_reason'));
    try { sendJson(res, 200, { item: app.pending.reject(id, body.reason as string | undefined) }); } catch (error) { pendingProblem(error); }
  });
}
