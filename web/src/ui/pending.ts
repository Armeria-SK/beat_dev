import type { Conversation, PendingAction, PendingCounts, PendingKind, Project } from '../api.ts';
import type { PlainKey } from '../i18n/index.ts';
import { latestConversation, sidebarOrder } from './products.ts';
import type { Route } from './routes.ts';

const KIND_LABEL = {
  send: 'ui.pending.kind.send', delete: 'ui.pending.kind.delete', judge: 'ui.pending.kind.judge', judge_failed: 'ui.pending.kind.judge',
  hook: 'ui.pending.kind.rule', policy: 'ui.pending.kind.rule', owner: 'ui.pending.kind.protected',
} as const satisfies Record<PendingKind, PlainKey>;

export const kindLabel = (kind: PendingKind): PlainKey => KIND_LABEL[kind];

export type KindTile = 'send' | 'delete' | 'unsure';

export const kindTile = (kind: PendingKind): KindTile => (kind === 'send' ? 'send' : kind === 'delete' ? 'delete' : 'unsure');

export function reasonLine(row: Pick<PendingAction, 'kind' | 'reason'>): { key: PlainKey } | { text: string } | null {
  if (row.kind === 'policy') return { key: 'ui.pending.reason.policy' };
  const text = row.reason.trim();
  return text ? { text } : null;
}

export const newestFirst = (rows: readonly PendingAction[]): PendingAction[] =>
  [...rows].sort((a, b) => b.created_at - a.created_at || b.id - a.id);

export const waitingOf = (rows: readonly PendingAction[], projectId: string | null): PendingAction[] =>
  newestFirst(rows.filter(r => r.status === 'waiting' && (projectId === null || r.project_id === projectId)));

const decidedAt = (row: PendingAction): number => row.decided_at ?? row.created_at;

export function mergeDecided(old: readonly PendingAction[], page: readonly PendingAction[]): PendingAction[] {
  const byId = new Map(old.map(r => [r.id, r]));
  for (const r of page) byId.set(r.id, r);
  return [...byId.values()].filter(r => r.status !== 'waiting').sort((a, b) => decidedAt(b) - decidedAt(a) || b.id - a.id);
}

const inProject = (projectId: string | null) => (r: PendingAction): boolean => projectId === null || r.project_id === projectId;

export function decidedShown(decided: readonly PendingAction[], waiting: readonly PendingAction[], local: readonly PendingAction[], projectId: string | null): PendingAction[] {
  const server = mergeDecided(waiting.filter(r => r.status === 'running' && inProject(projectId)(r)), decided);
  const known = new Set(server.map(r => r.id));
  return mergeDecided(local.filter(r => !known.has(r.id) && inProject(projectId)(r)), server);
}

export function waitingShown(waiting: readonly PendingAction[], held: readonly PendingAction[], gone: ReadonlySet<number>, projectId: string | null): PendingAction[] {
  const heldIds = new Set(held.map(r => r.id));
  return waitingOf([...waiting.filter(r => !heldIds.has(r.id)), ...held], projectId).filter(r => !gone.has(r.id));
}

const FINAL: ReadonlySet<PendingAction['status']> = new Set(['ran', 'failed', 'rejected', 'stale', 'cancelled']);

export function earlierQuery(shown: readonly PendingAction[]): { before: number } | { earlier: true } {
  const last = shown.findLast(r => FINAL.has(r.status) && r.decided_at !== null);
  return last ? { before: last.id } : { earlier: true };
}

export const effectFiles = (row: Pick<PendingAction, 'effect'>): { files: number; more: boolean } | null =>
  (row.effect && row.effect.files > 0 ? { files: row.effect.files, more: row.effect.more === true } : null);

const CONTENT_TOOLS: ReadonlySet<string> = new Set(['file_write', 'file_edit']);
const PLAIN_TOOLS: ReadonlySet<string> = new Set(['shell_run']);

export interface ActionView { title: string | null; inline: string | null; block: string | null; cwd: string | null; extra: string | null }

export function actionView(row: Pick<PendingAction, 'tool' | 'title' | 'shown' | 'parts'>): ActionView {
  const content = CONTENT_TOOLS.has(row.tool);
  const title = row.title?.trim() || null;
  if (!row.parts || (row.parts.body === null && row.parts.cwd === null && row.parts.extra === null)) {
    const text = row.shown || null;
    return { title: content ? title : null, inline: content ? null : text, block: content ? text : null, cwd: null, extra: null };
  }
  const body = row.parts.body || null;
  const cwd = row.parts.cwd || null;
  const extra = row.parts.extra || null;
  if (content) return { title, inline: null, block: body, cwd, extra };
  return { title: PLAIN_TOOLS.has(row.tool) && body ? null : title, inline: body, block: null, cwd, extra };
}

export function extraShown(title: string | null | undefined, extra: string | null): string | null {
  if (extra === null || !title) return extra;
  let parsed: unknown;
  try { parsed = JSON.parse(extra); } catch { return extra; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return extra;
  const path = (parsed as Record<string, unknown>).path;
  if (typeof path !== 'string' || !path || !title.endsWith(path) || !/\s$/u.test(title.slice(0, -path.length))) return extra;
  const rest = Object.entries(parsed).filter(([key]) => key !== 'path');
  return rest.length ? JSON.stringify(Object.fromEntries(rest), null, 2) : null;
}

export function decidedText(view: ActionView): { title: string | null; code: string | null; cwd: string | null; erased?: true } {
  const line = { title: view.title, code: view.inline ?? (view.title ? null : view.block), cwd: view.cwd };
  return line.title === null && line.code === null ? { ...line, erased: true } : line;
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function byteSize(bytes: number): { value: string; unit: (typeof UNITS)[number] } {
  let step = 0;
  while (step < UNITS.length - 1 && bytes >= 1024 ** (step + 1)) step += 1;
  return { value: step === 0 ? String(bytes) : (bytes / 1024 ** step).toFixed(1), unit: UNITS[step]! };
}

export type FileFact =
  | { path: string; kind: 'file'; bytes: number; at: number | null }
  | { path: string; kind: 'dir'; files: number; more: boolean; at: number | null }
  | { path: string; kind: 'missing' };

export const fileFacts = (row: Pick<PendingAction, 'files'>): FileFact[] => row.files.map((f): FileFact => {
  if (!f.exists) return { path: f.path, kind: 'missing' };
  if (f.type === 'dir') return { path: f.path, kind: 'dir', files: f.files ?? 0, more: f.more === true, at: f.newest ?? f.mtime ?? null };
  return { path: f.path, kind: 'file', bytes: f.size ?? 0, at: f.mtime ?? null };
});

export const fromTitle = (row: Pick<PendingAction, 'task_title' | 'conversation_id'>, titles: ReadonlyMap<string, string | null>): string | null =>
  row.task_title || titles.get(row.conversation_id) || null;

export type Outcome =
  | { kind: 'running'; at: number }
  | { kind: 'ran'; at: number; exit: number | null }
  | { kind: 'failed'; at: number; detail: string }
  | { kind: 'stale'; at: number }
  | { kind: 'rejected'; at: number; reason: string | null }
  | { kind: 'cancelled'; at: number };

const lastLine = (text: string | null): string => text?.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';

export function outcomeOf(row: PendingAction): Outcome | null {
  const at = decidedAt(row);
  switch (row.status) {
    case 'waiting': return null;
    case 'running': return { kind: 'running', at };
    case 'ran': return { kind: 'ran', at: row.ran_at ?? at, exit: row.exit_code };
    case 'failed': return { kind: 'failed', at, detail: lastLine(row.output_preview) };
    case 'stale': return { kind: 'stale', at };
    case 'rejected': return { kind: 'rejected', at, reason: row.reject_reason?.trim() || null };
    case 'cancelled': return { kind: 'cancelled', at };
  }
}

export const REASON_MAX = 500;

export const cleanReason = (text: string): string => text.replace(/[\p{Cc}]+/gu, ' ').replace(/ {2,}/gu, ' ').trim().slice(0, REASON_MAX);

export const pendingFor = (counts: PendingCounts, projectId: string): number => (counts.byProject[projectId] ?? 0) + (counts.acceptanceChanges[projectId] ?? 0);

export const pendingTotal = (counts: PendingCounts, projects: readonly Project[]): number => counts.waiting + acceptanceRows(counts, projects, null).reduce((sum, r) => sum + r.n, 0);

export function withPendingCounts(projects: Project[], counts: PendingCounts | null): Project[] {
  if (!counts) return projects;
  return projects.map(p => ({ ...p, waiting: { ...p.waiting, pending: pendingFor(counts, p.id) } }));
}

export function sessionCounts(rows: readonly PendingAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.status === 'waiting') counts.set(r.conversation_id, (counts.get(r.conversation_id) ?? 0) + 1);
  return counts;
}

export function taskCounts(rows: readonly PendingAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.status === 'waiting' && r.task_id) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
  return counts;
}

export interface AcceptanceRow { projectId: string; name: string; n: number }

export function acceptanceRows(counts: PendingCounts | null, projects: readonly Project[], projectId: string | null): AcceptanceRow[] {
  if (!counts) return [];
  return sidebarOrder(projects)
    .filter(p => projectId === null || p.id === projectId)
    .map(p => ({ projectId: p.id, name: p.name, n: counts.acceptanceChanges[p.id] ?? 0 }))
    .filter(r => r.n > 0);
}

export function paneTarget(projectId: string, conversations: readonly Conversation[]): Route {
  const latest = latestConversation(conversations, projectId);
  return latest ? { view: 'chat', id: latest.id } : { view: 'productNew', id: projectId };
}
