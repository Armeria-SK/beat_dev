import type { ChecklistItem, Message, ToolGate } from '../api.ts';
import { replyTurns } from '../chat-logic.ts';
import { formatDateTime, formatDateTimeSmart, timezoneLabel } from '../i18n/index.ts';
import type { LiveDraft, RunNotice } from './live-state.ts';
import type { ToolResult } from './tool-row.ts';

export interface ToolItem {
  key: string;
  name: string;
  input: string;
  result: ToolResult | null;
  gate?: ToolGate | undefined;
  running?: { startedAt: number | null; checking: boolean; helperTools: number | null; helperConversation: string | null } | undefined;
}

export type NoticeWeight = 'quiet' | 'warn' | 'fail';

export type ThreadItem =
  | { kind: 'owner'; key: string; text: string; attachments: string[]; at: number }
  | { kind: 'reply'; key: string; text: string; copyText: string | null; at: number; stamped: boolean }
  | { kind: 'tools'; key: string; rows: ToolItem[] }
  | { kind: 'live'; key: string; text: string; since: number | null }
  | { kind: 'notice'; key: string; weight: NoticeWeight; notices: RunNotice[] }
  | { kind: 'plan'; key: string };

export interface ThreadInput {
  messages: readonly Message[];
  draft?: LiveDraft | undefined;
  notices?: readonly RunNotice[];
}

export function noticeWeight(notice: RunNotice): NoticeWeight {
  switch (notice.kind) {
    case 'error': return 'fail';
    case 'switch': case 'warning': case 'denied': return 'warn';
    default: return 'quiet';
  }
}

export function noticeRows(notices: readonly RunNotice[]): Array<{ weight: NoticeWeight; notices: RunNotice[] }> {
  const rows: Array<{ weight: NoticeWeight; notices: RunNotice[] }> = [];
  const error = notices.find(n => n.kind === 'error');
  for (const notice of notices) {
    if (notice.kind === 'error') continue;
    const weight = noticeWeight(notice);
    const last = rows.at(-1);
    if (weight === 'quiet' && last?.weight === 'quiet') last.notices.push(notice);
    else rows.push({ weight, notices: [notice] });
  }
  if (error) rows.push({ weight: 'fail', notices: [error] });
  return rows;
}

const hiddenReply = (m: Message): boolean => m.role === 'assistant' && !m.text.trim() && Boolean(m.toolCalls?.length);

export function threadItems({ messages, draft, notices = [] }: ThreadInput): ThreadItem[] {
  const pending = new Map<string, string[]>();
  const seen = new Map<string, number>();
  const rowKeyOf = (callId: string): string => {
    const n = seen.get(callId) ?? 0;
    seen.set(callId, n + 1);
    return n === 0 ? `t-${callId}` : `t-${callId}-${n}`;
  };
  const visible = messages.filter(m => !hiddenReply(m));
  const turns = replyTurns(visible, draft?.runId ?? null);
  const items: ThreadItem[] = [];
  const tools = (key: string): ToolItem[] => {
    const last = items.at(-1);
    if (last?.kind === 'tools') return last.rows;
    const group: ThreadItem = { kind: 'tools', key, rows: [] };
    items.push(group);
    return group.rows;
  };

  const planRuns = new Set(messages.filter(m => m.role === 'tool' && m.toolName === 'plan_write' && !m.isError && m.runId && m.runId !== draft?.runId).map(m => m.runId!));
  const lastOfRun = new Map<string, number>();
  for (const m of visible) if (m.runId && planRuns.has(m.runId)) lastOfRun.set(m.runId, m.id);

  for (const m of messages) {
    if (m.toolCalls?.length) {
      const calls = new Map<string, string[]>();
      for (const call of m.toolCalls) calls.set(call.id, [...(calls.get(call.id) ?? []), call.input]);
      for (const [id, queue] of calls) pending.set(id, queue);
    }
    if (hiddenReply(m)) continue;
    const key = `m-${m.id}`;
    if (m.role === 'tool') {
      const rowKey = m.toolCallId ? rowKeyOf(m.toolCallId) : key;
      const input = m.toolCallId ? pending.get(m.toolCallId)?.shift() : undefined;
      tools(rowKey).push({ key: rowKey, name: m.toolName ?? '', input: input ?? '', result: { text: m.text, isError: Boolean(m.isError) }, ...(m.gate ? { gate: m.gate } : {}) });
    } else if (m.role === 'user') {
      items.push({ kind: 'owner', key, text: m.text, attachments: (m.attachments ?? []).map(a => a.name), at: m.createdAt });
    } else {
      const turn = turns.get(m.id);
      items.push({ kind: 'reply', key, text: m.text, copyText: turn ? turn.copyText : m.text, at: m.createdAt, stamped: turn ? turn.copyText !== null : true });
    }
    if (m.runId && lastOfRun.get(m.runId) === m.id) items.push({ kind: 'plan', key: `plan-${m.runId}` });
  }

  const settled = draft?.settled ?? [];
  const savedRun = draft ? messages.filter(m => m.role === 'tool' && m.runId === draft.runId) : [];
  const savedIdsInRun = new Set(savedRun.map(m => m.toolCallId));
  const firstSettled = (draft?.settledCount ?? settled.length) - settled.length;
  settled.forEach((done, i) => {
    if (savedIdsInRun.has(done.callId) && firstSettled + i < savedRun.length) return;
    const rowKey = rowKeyOf(done.callId);
    tools(rowKey).push({ key: rowKey, name: done.name, input: done.input, result: null, ...(done.gate ? { gate: done.gate } : {}) });
  });
  if (draft) {
    if (draft.text) items.push({ kind: 'live', key: `live-${draft.runId}`, text: draft.text, since: null });
    else if (draft.activeTool) {
      const rowKey = draft.toolCallId ? rowKeyOf(draft.toolCallId) : `run-${draft.runId}-${draft.activeTool}`;
      tools(rowKey).push({
        key: rowKey, name: draft.activeTool, input: draft.activeInput ?? '', result: null,
        running: { startedAt: draft.toolStartedAt ?? null, checking: draft.autoChecking === true, helperTools: draft.agent?.toolCalls ?? null, helperConversation: draft.agent?.conversationId ?? null },
      });
    } else items.push({ kind: 'live', key: `live-${draft.runId}`, text: '', since: draft.waitingSince ?? null });
  }
  noticeRows(notices).forEach((row, i) => items.push({ kind: 'notice', key: `n-${row.notices[0]!.runId}-${i}`, ...row }));
  return items;
}

export interface MessageStamp { text: string; title: string }

export function messageStamp(at: number, now: number): MessageStamp | null {
  if (!at) return null;
  const full = formatDateTime(at, 'full');
  const sameYear = full.slice(0, 4) === formatDateTime(now, 'full').slice(0, 4);
  return { text: sameYear ? formatDateTimeSmart(at, now) : full, title: `${full} ${timezoneLabel(undefined, at)}` };
}

export const replyMeta = (name: string | null | undefined, stamp: MessageStamp | null): string => [name?.trim(), stamp?.text].filter(Boolean).join(' · ');

export function thinkingSeconds(since: number | null, now: number): number | null {
  if (!since) return null;
  const seconds = Math.floor((now - since) / 1000);
  return seconds >= 1 ? seconds : null;
}

export const threadGutter = (el: { offsetWidth: number; clientWidth: number }): number => Math.max(0, (el.offsetWidth - el.clientWidth) / 2);

export const RISE_MS = 600;
export const isRising = (firstSeenAt: number | undefined, now: number): boolean => firstSeenAt === undefined || now - firstSeenAt < RISE_MS;

export const CHECKLIST_MAX = 8;

export interface ChecklistShape { total: number; done: number; doneHidden: number; rows: ChecklistItem[] }

export function checklistShape(items: readonly ChecklistItem[]): ChecklistShape {
  const done = items.filter(i => i.status === 'done').length;
  if (items.length <= CHECKLIST_MAX) return { total: items.length, done, doneHidden: 0, rows: [...items] };
  return { total: items.length, done, doneHidden: done, rows: items.filter(i => i.status !== 'done') };
}

export function contextMeter(ratio: number | null | undefined): { value: number; high: boolean } | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio) || ratio < 0) return null;
  const value = Math.min(100, Math.round(ratio * 100));
  return { value, high: value >= 85 };
}
