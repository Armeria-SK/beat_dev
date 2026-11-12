import type { Approval, ChecklistItem, Message } from '../api.ts';
import { replyTurns } from '../chat-logic.ts';
import type { LiveDraft, RunNotice } from './live-state.ts';
import type { ToolResult } from './tool-row.ts';

export interface ToolItem {
  key: string;
  name: string;
  input: string;
  result: ToolResult | null;
  running?: { startedAt: number | null; checking: boolean; helperTools: number | null; helperConversation: string | null } | undefined;
  approval?: Approval | undefined;
}

export type NoticeWeight = 'quiet' | 'warn' | 'fail';

export type ThreadItem =
  | { kind: 'owner'; key: string; text: string; attachments: string[] }
  | { kind: 'reply'; key: string; text: string; copyText: string | null }
  | { kind: 'tools'; key: string; rows: ToolItem[] }
  | { kind: 'live'; key: string; text: string }
  | { kind: 'notice'; key: string; weight: NoticeWeight; notices: RunNotice[] };

export interface ThreadInput {
  messages: readonly Message[];
  draft?: LiveDraft | undefined;
  approvals?: readonly Approval[];
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

const toolKey = (callId: string | undefined): string | null => (callId ? `t-${callId}` : null);

const hiddenReply =(m: Message): boolean => m.role === 'assistant' && !m.text.trim() && Boolean(m.toolCalls?.length);

export function threadItems({ messages, draft, approvals = [], notices = [] }: ThreadInput): ThreadItem[] {
  const inputs = new Map<string, string>();
  for (const m of messages) for (const call of m.toolCalls ?? []) inputs.set(call.id, call.input);
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

  for (const m of visible) {
    const key = `m-${m.id}`;
    if (m.role === 'tool') {
      const rowKey = toolKey(m.toolCallId) ?? key;
      tools(rowKey).push({ key: rowKey, name: m.toolName ?? '', input: inputs.get(m.toolCallId ?? '') ?? '', result: { text: m.text, isError: Boolean(m.isError) } });
    } else if (m.role === 'user') {
      items.push({ kind: 'owner', key, text: m.text, attachments: (m.attachments ?? []).map(a => a.name) });
    } else {
      const turn = turns.get(m.id);
      items.push({ kind: 'reply', key, text: m.text, copyText: turn ? turn.copyText : m.text });
    }
  }

  const waiting = approvals;
  const saved = new Set(messages.map(m => m.toolCallId));
  for (const done of draft?.settled ?? []) {
    if (!saved.has(done.callId)) tools(`t-${done.callId}`).push({ key: `t-${done.callId}`, name: done.name, input: done.input, result: null });
  }
  if (draft) {
    if (draft.text) items.push({ kind: 'live', key: `live-${draft.runId}`, text: draft.text });
    else if (draft.activeTool && waiting.length === 0) {
      const rowKey = toolKey(draft.toolCallId) ?? `run-${draft.runId}-${draft.activeTool}`;
      tools(rowKey).push({
        key: rowKey, name: draft.activeTool, input: draft.activeInput ?? '', result: null,
        running: { startedAt: draft.toolStartedAt ?? null, checking: draft.autoChecking === true, helperTools: draft.agent?.toolCalls ?? null, helperConversation: draft.agent?.conversationId ?? null },
      });
    } else if (waiting.length === 0) items.push({ kind: 'live', key: `live-${draft.runId}`, text: '' });
  }
  for (const approval of waiting) {
    tools(`approval-${approval.id}`).push({ key: `approval-${approval.id}`, name: approval.tool, input: '', result: null, approval });
  }
  noticeRows(notices).forEach((row, i) => items.push({ kind: 'notice', key: `n-${row.notices[0]!.runId}-${i}`, ...row }));
  return items;
}

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
