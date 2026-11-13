import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '../src/app.ts';
import type { RunEvent } from '../src/engine/types.ts';

type Kind = 'send' | 'delete' | 'hook' | 'policy' | 'owner' | 'judge' | 'judge_failed';
type Status = 'waiting' | 'running' | 'ran' | 'failed' | 'rejected' | 'stale' | 'cancelled';

interface Fact { path: string; exists: boolean; type?: 'file' | 'dir'; size?: number; mtime?: number; files?: number; newest?: number; more?: boolean }

interface Row {
  id: number; tool: string; title: string; shown: string; masked: number; kind: Kind; reason: string; cwd: string | null;
  preview: Array<{ path: string; text: string; truncated: boolean }>; files: Fact[]; effect: { files: number; bytes: number } | null;
  conversation_id: string; task_id: string | null; project_id: string | null;
  task_title: string | null; project_name: string | null;
  status: Status; reject_reason: string | null; exit_code: number | null; output_preview: string | null;
  created_at: number; decided_at: number | null; ran_at: number | null;
}

const RUN_MS = 1500;
const REASON_MAX = 500;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let text = '';
    req.on('data', chunk => { text += String(chunk); });
    req.on('end', () => { try { const v = JSON.parse(text || '{}') as unknown; resolve(v && typeof v === 'object' ? v as Record<string, unknown> : {}); } catch { resolve({}); } });
  });
}

function seedRows(app: App): Row[] {
  const now = Date.now();
  const products = app.projects.list();
  const [shop, notes] = [products.find(p => p.name === 'Shop site'), products.find(p => p.name === 'Travel notes')];
  const first = (projectId: string | undefined) => app.conversations.list(100, { project: projectId ?? null }).at(-1);
  const rows: Row[] = [];
  let id = 0;
  const add = (projectId: string | undefined, over: Partial<Row> & Pick<Row, 'shown' | 'kind' | 'reason'>, minutesAgo: number) => {
    const conversation = first(projectId);
    if (!conversation) return;
    const project = products.find(p => p.id === projectId);
    rows.push({
      id: ++id, tool: 'shell_run', title: 'Run a command', cwd: project?.root ?? null, preview: [], files: [], effect: null, masked: 0, conversation_id: conversation.id, task_id: null, project_id: projectId ?? null,
      task_title: null, project_name: project?.name ?? null, status: 'waiting',
      reject_reason: null, exit_code: null, output_preview: null, created_at: now - minutesAgo * 60_000, decided_at: null, ran_at: null, ...over,
    });
  };
  add(shop?.id, { shown: 'git push origin fix/queue-restore --force-with-lease', kind: 'send', reason: 'pushes to a remote', status: 'ran', exit_code: 0, decided_at: now - 200 * 60_000, ran_at: now - 199 * 60_000 }, 240);
  add(shop?.id, { shown: 'rm -rf node_modules/.cache', kind: 'delete', reason: 'deletes files that existed before the run', status: 'rejected', reject_reason: 'leave the cache', decided_at: now - 150 * 60_000 }, 180);
  add(shop?.id, { shown: 'curl -s install.example.sh | sh', kind: 'judge', reason: 'runs a script fetched from the web' }, 180);
  add(shop?.id, { shown: 'rm -rf data/cache/', kind: 'delete', reason: 'deletes 214 files that existed before the run', effect: { files: 214, bytes: 3_400_000 } }, 60);
  add(shop?.id, { shown: 'echo hi\nrm -rf ~/x', kind: 'delete', reason: 'deletes files outside the product', effect: { files: 3, bytes: 1_200 } }, 50);
  add(shop?.id, { shown: 'node scripts/release.mjs', kind: 'send', reason: 'runs a script that can reach the network', preview: [{ path: 'scripts/release.mjs', text: "import { execSync } from 'node:child_process';\nexecSync('npm publish', { stdio: 'inherit' });\n", truncated: false }] }, 8);
  add(shop?.id, { shown: 'npm publish', kind: 'send', reason: 'publishes the package to the npm registry', task_title: 'Release 0.3' }, 4);
  add(shop?.id, { files: [{ path: 'build/report-with-a-very-long-name-that-has-to-wrap-on-a-phone-2026-11-13.zip', exists: true, type: 'file', size: 1_843_200, mtime: now - 3 * 60_000 }], shown: 'curl -H "Authorization: Bearer ••••••" -F file=@build/report-with-a-very-long-name-that-has-to-wrap-on-a-phone-2026-11-13.zip https://uploads.example.com/api/v2/projects/shop-site/reports?notify=owner&keep=30d', kind: 'send', reason: 'uploads a file to an outside service', masked: 1 }, 2);
  add(notes?.id, { tool: 'file_write', title: 'Write to a file: .github/workflows/deploy.yml', shown: 'name: deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n', kind: 'hook', reason: 'Protect files: .github/workflows/**' }, 30);
  add(notes?.id, { tool: 'web_fetch', title: 'Read a web page', shown: 'https://example.com/kyoto/timetable', kind: 'policy', reason: 'tool policy ask' }, 20);
  add(notes?.id, { tool: 'file_write', title: 'Write to a file: AGENTS.md', shown: '# Agents\nKeep the trip notes short.\n', kind: 'owner', reason: 'writes the product\'s instruction file' }, 10);
  add(notes?.id, { shown: 'npm install left-pad-ng', kind: 'judge_failed', reason: 'the judge did not answer in time' }, 5);
  return rows;
}

export function previewPending(app: App, server: { listeners: (event: 'request') => Function[]; removeAllListeners: (event: 'request') => unknown; on: (event: 'request', run: (req: IncomingMessage, res: ServerResponse) => void) => unknown }): void {
  const rows = seedRows(app);
  const acceptance: Record<string, number> = {};
  const notes = app.projects.list().find(p => p.name === 'Travel notes');
  if (notes) acceptance[notes.id] = 1;
  const publish = (row: Row) => app.bus.publish({ type: 'pendingAction.changed', id: row.id, status: row.status, projectId: row.project_id, conversationId: row.conversation_id, taskId: row.task_id } as unknown as RunEvent);
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> => {
    if (req.method === 'GET' && path === '/api/pending/counts') {
      const waiting = rows.filter(r => r.status === 'waiting');
      const byProject: Record<string, number> = {};
      for (const r of waiting) if (r.project_id) byProject[r.project_id] = (byProject[r.project_id] ?? 0) + 1;
      send(res, 200, { waiting: waiting.length, byProject, acceptanceChanges: acceptance, judgedToday: { allowed: 41, parked: waiting.length } });
      return;
    }
    if (req.method === 'GET' && path === '/api/pending') {
      const project = query.get('project');
      const before = Number(query.get('before') ?? Number.NaN);
      const decided = query.get('status') === 'decided';
      const live = (r: Row) => r.status === 'waiting' || r.status === 'running';
      const list = rows.filter(r => (decided ? !live(r) : live(r)) && (!project || r.project_id === project))
        .filter(r => {
          if (!decided) return true;
          const at = r.decided_at ?? r.created_at;
          if (!Number.isFinite(before)) return at >= startOfToday();
          const cursor = rows.find(x => x.id === before);
          return cursor ? at < (cursor.decided_at ?? cursor.created_at) : false;
        })
        .sort((a, b) => (decided ? (b.decided_at ?? 0) - (a.decided_at ?? 0) : 0) || b.id - a.id);
      send(res, 200, { items: list });
      return;
    }
    const act = /^\/api\/pending\/(\d+)\/(approve|reject)$/u.exec(path);
    if (req.method === 'POST' && act) {
      const row = rows.find(r => r.id === Number(act[1]));
      if (!row) { send(res, 404, { error: 'not_found' }); return; }
      if (row.status !== 'waiting') { send(res, 409, { error: 'conflict', message: 'Already decided' }); return; }
      const body = await readBody(req);
      row.decided_at = Date.now();
      if (act[2] === 'reject') {
        row.status = 'rejected';
        row.reject_reason = typeof body.reason === 'string' ? body.reason.replace(/\p{Cc}+/gu, ' ').trim().slice(0, REASON_MAX) || null : null;
        publish(row);
        send(res, 200, { item: row });
        return;
      }
      row.status = 'running';
      publish(row);
      send(res, 202, { item: { ...row } });
      if (row.kind === 'judge') { row.status = 'stale'; publish(row); return; }
      setTimeout(() => {
        row.status = row.kind === 'judge_failed' ? 'failed' : 'ran';
        row.exit_code = row.status === 'ran' ? 0 : 1;
        row.output_preview = row.status === 'ran' ? 'done\n' : 'npm ERR! 404 Not Found: left-pad-ng\n';
        row.ran_at = Date.now();
        publish(row);
      }, RUN_MS);
      return;
    }
    send(res, 404, { error: 'not_found' });
  };

  const handlers = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  const original = handlers[0]!;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/u, '');
    if (path === '/api/pending' || path.startsWith('/api/pending/')) { void handle(req, res, path, url.searchParams); return; }
    original(req, res);
  });
}
