import type { App } from '../app.ts';
import { PendingError } from '../pending/store.ts';
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
  router.add('GET', '/api/pending', ({ res, url }) => {
    const status = text(url, 'status') ?? 'waiting';
    if (status !== 'waiting' && status !== 'decided') throw domainProblem(400, 'invalid_field', new PendingError('invalid_status'));
    const before = text(url, 'before');
    const earlier = text(url, 'earlier') === '1';
    sendJson(res, 200, {
      items: app.pending.list({
        status, project: text(url, 'project'), task: text(url, 'task'), conversation: text(url, 'conversation'),
        ...(before !== undefined ? { before: idOf(before) } : earlier ? { until: today() } : { since: today() }),
      }),
    });
  });
  router.add('GET', '/api/pending/counts', ({ res }) => sendJson(res, 200, app.pending.counts(today())));
  router.add('POST', '/api/pending/:id/approve', ({ res, params }) => {
    const id = idOf(params[0]);
    let row;
    try { row = app.pending.claim(id); } catch (error) { pendingProblem(error); }
    app.replayPending(row);
    sendJson(res, 202, { item: app.pending.view(id) });
  });
  router.add('POST', '/api/pending/:id/reject', async ({ req, res, params }) => {
    const id = idOf(params[0]);
    const body = requireObject(await readJson(req));
    if (body.reason !== undefined && typeof body.reason !== 'string') throw domainProblem(400, 'invalid_field', new PendingError('invalid_reason'));
    try { sendJson(res, 200, { item: app.pending.reject(id, body.reason as string | undefined) }); } catch (error) { pendingProblem(error); }
  });
}
