import type { Conversation, JudgedCounts, MemoryEvent, MemoryItem, ReviewJob, RunRow, SkillVersion, ToolCallRow, ToolInfo } from '../api.ts';
import { lineDelta, type LineDelta } from '../../../src/shared/line-delta.ts';
import type { ToolPolicy } from '../../../src/tools/tool-policy.ts';
import { toolPolicyLoosened, type Access } from '../settings/access.ts';
import { maskTarget, toolRow } from './tool-row.ts';

export type Who = 'you' | 'beat';

export const whoOfActor = (actor: string): Who => (actor === 'user' ? 'you' : 'beat');
export const whoOfOrigin = (origin: string): Who => (origin === 'user' ? 'you' : 'beat');

export function latestEventByMemory(events: readonly MemoryEvent[]): Map<number, MemoryEvent> {
  const out = new Map<number, MemoryEvent>();
  for (const event of events) {
    const seen = out.get(event.memory_id);
    if (!seen || event.id > seen.id) out.set(event.memory_id, event);
  }
  return out;
}

export interface MemoryStamp { who: Who; edited: boolean; at: number }

export function memoryStamp(item: Pick<MemoryItem, 'origin' | 'created_at' | 'updated_at'>, last: MemoryEvent | undefined): MemoryStamp {
  if (last && last.action !== 'create') return { who: whoOfActor(last.actor), edited: true, at: last.created_at };
  return { who: whoOfOrigin(item.origin), edited: false, at: item.created_at };
}

export type VersionAction = 'undo' | 'restore' | 'delete' | null;

export interface MemoryVersion { event: MemoryEvent; who: Who; action: VersionAction }

export function memoryHistory(events: readonly MemoryEvent[], current: string): MemoryVersion[] {
  const sorted = [...events].sort((a, b) => b.id - a.id);
  return sorted.map((event, index) => {
    let action: VersionAction = null;
    if (index === 0) action = !event.undone_at && event.action !== 'restore' && event.action !== 'forget' ? 'undo' : null;
    else if (event.after !== null && event.after !== current) action = 'restore';
    return { event, who: whoOfActor(event.actor), action };
  });
}

export const undoDeletes = (version: Pick<MemoryVersion, 'action'> & { event: Pick<MemoryEvent, 'action'> }): boolean =>
  version.action === 'undo' && version.event.action === 'create';

export const ROW_LEAVE_MS = 220;

export interface SkillContent { description: string; body: string }

export interface SkillChange {
  key: string;
  version: SkillVersion | null;
  oldest: boolean;
  who: Who;
  auto: boolean;
  created: boolean;
  delta: LineDelta | null;
  action: VersionAction;
  target: SkillContent | null;
}

const sameContent = (a: SkillContent, b: SkillContent): boolean => a.body === b.body && a.description === b.description;
const isEmpty = (c: SkillContent): boolean => c.body === '' && c.description === '';

function actionFor(target: SkillContent, current: SkillContent, kind: 'undo' | 'restore'): VersionAction {
  if (isEmpty(target)) return 'delete';
  return sameContent(target, current) ? null : kind;
}

export function skillHistory(versions: readonly SkillVersion[], current: SkillContent): SkillChange[] {
  const rows: SkillChange[] = versions.map((version, index) => {
    const produced: SkillContent = index === 0 ? current : versions[index - 1]!;
    const target: SkillContent = index === 0 ? version : produced;
    return {
      key: version.id, version, oldest: false, who: version.who === 'you' ? 'you' : 'beat', auto: version.who === 'beat-auto',
      created: isEmpty(version), delta: lineDelta(version.body, produced.body),
      action: actionFor(target, current, index === 0 ? 'undo' : 'restore'), target,
    };
  });
  const last = versions.at(-1);
  if (last && !(versions.length === 1 && isEmpty(last))) {
    rows.push({
      key: `oldest:${last.id}`, version: null, oldest: true, who: 'beat', auto: last.who === 'beat-auto', created: isEmpty(last), delta: null,
      action: actionFor(last, current, 'restore'), target: last,
    });
  }
  return rows;
}

export type ToolChoice = { kind: 'save' } | { kind: 'confirm'; item: Access } | { kind: 'none' };

export function toolChoice(tool: Pick<ToolInfo, 'name' | 'policy' | 'configurable'>, to: ToolPolicy): ToolChoice {
  if (!tool.configurable || tool.policy === to) return { kind: 'none' };
  const item = toolPolicyLoosened(tool.name, tool.policy, to);
  return item ? { kind: 'confirm', item } : { kind: 'save' };
}

export function toolDecision(fresh: Pick<ToolInfo, 'name' | 'policy' | 'configurable'>, to: ToolPolicy, confirmed: Access | null): ToolChoice {
  const choice = toolChoice(fresh, to);
  if (choice.kind !== 'confirm' || !confirmed) return choice;
  const same = confirmed.kind === 'tool-policy-loosened' && choice.item.kind === 'tool-policy-loosened'
    && confirmed.tool === choice.item.tool && confirmed.from === choice.item.from && confirmed.to === choice.item.to;
  return same ? { kind: 'save' } : choice;
}

export function toolCounts(tools: readonly Pick<ToolInfo, 'policy'>[]): Record<ToolPolicy, number> {
  const out: Record<ToolPolicy, number> = { allow: 0, ask: 0, block: 0 };
  for (const tool of tools) out[tool.policy] += 1;
  return out;
}

export type LogKind = 'run' | 'tool' | 'review';
export type LogFilter = 'all' | LogKind;
export const LOG_FILTERS: readonly LogFilter[] = ['all', 'run', 'tool', 'review'];
export type LogResult = 'running' | 'queued' | 'ok' | 'failed' | 'stopped' | 'fallback' | 'parked';

export interface LogRow {
  key: string;
  kind: LogKind;
  at: number;
  what: string;
  model: string | null;
  durationMs: number | null;
  tokens: number | null;
  result: LogResult;
  run?: RunRow;
  call?: ToolCallRow;
  job?: ReviewJob;
}

export function runResult(run: Pick<RunRow, 'ok' | 'error_kind' | 'flags'>): LogResult {
  if (run.ok === null) return 'running';
  if (run.ok === 0) return run.error_kind === 'cancelled' ? 'stopped' : 'failed';
  return run.flags.includes('fallback') ? 'fallback' : 'ok';
}

export function callResult(call: Pick<ToolCallRow, 'ok' | 'decided_by' | 'decision' | 'approval_id'>): LogResult {
  if (call.decided_by === 'pending' && call.decision === 'ask' && call.approval_id?.startsWith('pending:')) return 'parked';
  return call.ok === null ? 'running' : call.ok === 1 ? 'ok' : 'failed';
}

export function judgedLine(judged: JudgedCounts): { allowed: number; parked: number; notRun: number } | null {
  const parked = (judged.parked.judge ?? 0) + (judged.parked.judge_failed ?? 0);
  return judged.allowed + parked + judged.notParked > 0 ? { allowed: judged.allowed, parked, notRun: judged.notParked } : null;
}

export function jobResult(status: ReviewJob['status']): LogResult {
  return status === 'pending' ? 'queued' : status === 'running' ? 'running' : status === 'done' ? 'ok' : 'failed';
}

export interface LogInput {
  runs: readonly RunRow[];
  calls: readonly ToolCallRow[];
  jobs: readonly ReviewJob[];
  runLabel: (kind: string) => string;
  titleOf: (conversationId: string) => string | null;
}

export function logRows({ runs, calls, jobs, runLabel, titleOf }: LogInput): LogRow[] {
  const models = new Map(runs.map(run => [run.id, run.model_id]));
  const rows: LogRow[] = [];
  for (const run of runs) {
    const title = run.conversation_id ? titleOf(run.conversation_id) : null;
    const tokens = run.input_tokens === null && run.output_tokens === null ? null : (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
    rows.push({
      key: `run:${run.id}`, kind: 'run', at: run.started_at, what: title ? `${runLabel(run.kind)} · ${title}` : runLabel(run.kind),
      model: run.model_id, durationMs: run.duration_ms, tokens, result: runResult(run), run,
    });
  }
  for (const call of calls) {
    const target = toolRow(call.tool, call.input, null).target;
    rows.push({
      key: `tool:${call.id}`, kind: 'tool', at: call.created_at, what: target ? `${call.tool} · ${target}` : call.tool,
      model: null, durationMs: call.duration_ms, tokens: null, result: callResult(call), call,
    });
  }
  for (const job of jobs) {
    const note = job.note ? maskTarget(job.note).replace(/\s+/gu, ' ').trim() : '';
    rows.push({
      key: `review:${job.id}`, kind: 'review', at: job.created_at, what: note ? `${job.triggerLabel} · ${note}` : job.triggerLabel,
      model: job.run_id ? models.get(job.run_id) ?? null : null,
      durationMs: job.finished_at !== null && job.status !== 'pending' ? job.finished_at - job.created_at : null, tokens: null, result: jobResult(job.status), job,
    });
  }
  return rows.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
}

export const filterLog = (rows: readonly LogRow[], filter: LogFilter): LogRow[] => (filter === 'all' ? [...rows] : rows.filter(row => row.kind === filter));

export interface LogTotals { run: number; tool: number; review: number }

export function logFooter(rows: readonly LogRow[], filter: LogFilter, totals: LogTotals, dayStart: number): { shown: number; total: number } {
  const shown = filterLog(rows, filter).filter(row => row.at >= dayStart).length;
  const total = filter === 'all' ? totals.run + totals.tool + totals.review : totals[filter];
  return { shown, total: Math.max(total, shown) };
}

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const tokensText = (n: number | null): string => (n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const archivedNothing = (items: readonly unknown[] | null, loadedFor: string, query: string): boolean =>
  items !== null && items.length === 0 && loadedFor.trim() === '' && query === '';

export function archivedLine(conversation: Pick<Conversation, 'message_count' | 'archived_at'>): { messages: number | null; archivedAt: number | null } {
  return { messages: typeof conversation.message_count === 'number' ? conversation.message_count : null, archivedAt: conversation.archived_at ?? null };
}
