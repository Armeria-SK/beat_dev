import type { App } from '../app.ts';
import { PROJECT_ID } from '../projects/store.ts';
import type { JobView } from '../tools/shell/background.ts';
import { problem, readJson, requireObject, type Router, sendJson } from './http.ts';

// beat 6-4: 持ち主の Terminal の欄の口。製品ごとに見せ、無い番号・製品の違う番号は 404。止めるのは持ち主（by: 'owner'）だけ
const JOB_ID = /^bg-\d{1,9}$/u;
const TAIL_BYTES = 64 * 1024;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\b/u;

class NotFound extends Error {}

function projectOf(raw: unknown): string {
  if (typeof raw !== 'string' || !PROJECT_ID.test(raw)) throw problem(400, 'invalid_id', 'invalid_id');
  return raw;
}

export function registerBackgroundRoutes(router: Router, app: App): void {
  const ports = new Map<string, { port: number | null; scanned: number }>();

  const portOf = (job: JobView): number | null => {
    const seen = ports.get(job.id) ?? { port: null, scanned: 0 };
    if (seen.port === null) {
      const read = app.background.peek(job.id, seen.scanned);
      const found = read ? LOCAL_URL.exec(read.text) : null;
      seen.port = found ? Number(found[1]) : null;
      seen.scanned = read?.next ?? seen.scanned;
      ports.set(job.id, seen);
    }
    return seen.port;
  };

  const startedBy = (job: JobView) => {
    const task = job.taskId !== undefined ? app.tasks.get(job.taskId) : undefined;
    if (task) return { kind: 'task' as const, id: task.id, title: task.title };
    return { kind: 'conversation' as const, id: job.conversationId, title: app.conversations.get(job.conversationId)?.title ?? null };
  };

  const item = (job: JobView) => ({
    id: job.id, command: job.command, state: job.state, exitCode: job.exitCode,
    ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}),
    startedAt: job.startedAt, ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    orphaned: job.orphaned, tainted: job.tainted === true, spawnFailed: job.spawnError !== undefined,
    port: portOf(job), conversationId: job.conversationId, ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
    startedBy: startedBy(job),
  });

  const jobIn = (id: string | undefined, projectId: string): JobView => {
    const job = id !== undefined && JOB_ID.test(id) ? app.background.get(id) : undefined;
    if (!job || job.projectId !== projectId) throw new NotFound();
    return job;
  };

  const guard = async (res: Parameters<typeof sendJson>[0], work: () => Promise<void> | void): Promise<void> => {
    try { await work(); } catch (error) {
      if (error instanceof NotFound) { sendJson(res, 404, { error: 'not_found' }); return; }
      throw error;
    }
  };

  router.add('GET', '/api/background', ({ res, url }) => {
    const projectId = projectOf(url.searchParams.get('projectId'));
    for (const id of ports.keys()) if (!app.background.get(id)) ports.delete(id);
    const items = app.background.list({ projectId }).sort((a, b) => b.startedAt - a.startedAt).map(item);
    sendJson(res, 200, { items });
  });

  router.add('GET', '/api/background/:id/output', ({ res, url, params }) => guard(res, () => {
    const projectId = projectOf(url.searchParams.get('projectId'));
    const job = jobIn(params[0], projectId);
    const end = app.background.peek(job.id, Number.MAX_SAFE_INTEGER)?.next ?? 0;
    const raw = url.searchParams.get('from');
    const asked = raw !== null && /^\d{1,15}$/u.test(raw) ? Number(raw) : 0;
    const from = raw === null || end - asked > TAIL_BYTES ? Math.max(asked, end - TAIL_BYTES) : asked;
    const read = app.background.peek(job.id, from);
    if (!read) throw new NotFound();
    const before = raw === null ? from : Math.max(0, from - asked);
    sendJson(res, 200, { ...item(read), text: read.text, next: read.next, skipped: read.skipped + before });
  }));

  router.add('POST', '/api/background/:id/stop', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const projectId = projectOf(body.projectId);
    await guard(res, async () => {
      const job = jobIn(params[0], projectId);
      const stopped = job.state === 'running' ? await app.background.stop(job.id, 'owner') : job;
      if (!stopped) throw new NotFound();
      sendJson(res, 200, { item: item(stopped) });
    });
  });
}
