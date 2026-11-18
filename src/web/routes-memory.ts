import type { App } from '../app.ts';
import { MemoryFileError, type MemoryFileEvent } from '../memory/files.ts';
import { domainProblem, problem, readJson, requireObject, requireString, type Router, sendJson } from './http.ts';

const STATUS: Partial<Record<MemoryFileError['code'], number>> = { 'memfile.bad_name': 404, 'memfile.no_version': 404, 'memfile.changed': 409, 'memfile.unchanged': 409 };

const eventWire = (e: MemoryFileEvent) => ({ id: e.id, action: e.action, actor: e.actor, summary: e.summary, tainted: e.tainted === 1, before: e.before, after: e.after, created_at: e.created_at });

// 製品の記憶のファイルの持ち主の口（beat 10-3）。書き込みはどれも、画面で見ていた版のハッシュ（baseHash）を取り、違えば断る。印を外せるのはここだけ
export function registerMemoryRoutes(router: Router, app: App): void {
  const project = (id: string) => {
    const row = app.projects.get(id);
    if (!row) throw problem(404, 'not_found', 'project_missing');
    return row;
  };
  const stored = <T>(work: () => T): T => {
    try { return work(); } catch (error) {
      if (error instanceof MemoryFileError) throw domainProblem(STATUS[error.code] ?? 400, 'memory', error);
      throw error;
    }
  };
  const baseOf = (body: Record<string, unknown>): string | null => {
    const value = body.baseHash;
    if (value !== null && (typeof value !== 'string' || value.length > 128)) throw problem(400, 'invalid_field', 'required', { field: 'baseHash', params: { field: 'baseHash' } });
    return value;
  };
  const changed = (projectId: string, name: string, action: 'create' | 'update' | 'forget' | 'restore' | 'reviewed', eventId: number) =>
    app.bus.publish({ type: 'memoryFile.changed', runId: '', conversationId: '', projectId, name, action, eventId });
  const owner = { actor: 'owner' as const, tainted: false };

  router.add('GET', '/api/projects/:id/memory', ({ res, params }) => {
    const p = project(params[0]!);
    sendJson(res, 200, { notes: app.memoryFiles.list(p.id), archived: p.archived_at !== null });
  });

  router.add('POST', '/api/projects/:id/memory', async ({ req, res, params }) => {
    const p = project(params[0]!);
    const body = requireObject(await readJson(req));
    const saved = stored(() => app.memoryFiles.save(p.id, { title: requireString(body, 'title')!, content: requireString(body, 'content')!, summary: requireString(body, 'summary', { optional: true }) ?? null }, owner));
    changed(p.id, saved.name, 'create', saved.eventId);
    sendJson(res, 201, stored(() => app.memoryFiles.read(p.id, saved.name)));
  });

  router.add('GET', '/api/projects/:id/memory/:name', ({ res, params }) => {
    const p = project(params[0]!);
    sendJson(res, 200, stored(() => app.memoryFiles.read(p.id, params[1]!)));
  });

  router.add('GET', '/api/projects/:id/memory/:name/history', ({ res, params }) => {
    const p = project(params[0]!);
    sendJson(res, 200, { events: stored(() => app.memoryFiles.history(p.id, params[1]!)).map(eventWire) });
  });

  router.add('PUT', '/api/projects/:id/memory/:name', async ({ req, res, params }) => {
    const p = project(params[0]!);
    const body = requireObject(await readJson(req));
    const baseHash = baseOf(body);
    const saved = stored(() => app.memoryFiles.update(p.id, params[1]!, { title: requireString(body, 'title', { optional: true }), content: requireString(body, 'content')!, summary: requireString(body, 'summary', { optional: true }) ?? null }, owner, baseHash));
    changed(p.id, saved.name, 'update', saved.eventId);
    sendJson(res, 200, stored(() => app.memoryFiles.read(p.id, saved.name)));
  });

  router.add('DELETE', '/api/projects/:id/memory/:name', ({ res, params, url }) => {
    const p = project(params[0]!);
    const baseHash = url.searchParams.get('baseHash');
    if (!baseHash) throw problem(400, 'invalid_field', 'required', { field: 'baseHash', params: { field: 'baseHash' } });
    const done = stored(() => app.memoryFiles.forget(p.id, params[1]!, null, owner, baseHash));
    changed(p.id, done.name, 'forget', done.eventId);
    sendJson(res, 200, { ok: true });
  });

  router.add('POST', '/api/projects/:id/memory/:name/restore', async ({ req, res, params }) => {
    const p = project(params[0]!);
    const body = requireObject(await readJson(req));
    const eventId = body.eventId;
    if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId < 1) throw problem(400, 'invalid_field', 'required', { field: 'eventId', params: { field: 'eventId' } });
    const done = stored(() => app.memoryFiles.restore(p.id, params[1]!, eventId, baseOf(body)));
    changed(p.id, done.name, 'restore', done.eventId);
    sendJson(res, 200, stored(() => app.memoryFiles.read(p.id, done.name)));
  });

  router.add('POST', '/api/projects/:id/memory/:name/reviewed', async ({ req, res, params }) => {
    const p = project(params[0]!);
    const body = requireObject(await readJson(req));
    const done = stored(() => app.memoryFiles.review(p.id, params[1]!, requireString(body, 'baseHash', { max: 128 })!));
    changed(p.id, done.name, 'reviewed', done.eventId);
    sendJson(res, 200, stored(() => app.memoryFiles.read(p.id, done.name)));
  });
}
