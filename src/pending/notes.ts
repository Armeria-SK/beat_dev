import { neutralizeFence } from '../shared/fence.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { closedByBeat, type PendingRow, type PendingView } from './store.ts';

export type NoteHead = 'ran' | 'failed' | 'stale' | 'rejected';

export interface PendingNote { head: NoteHead; text: string; event: string; fetched: boolean }

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const TITLE_MAX = 200;

export function pendingNote(row: PendingRow, view: PendingView): PendingNote | undefined {
  if (row.status === 'waiting' || row.status === 'running' || row.status === 'cancelled' || closedByBeat(row)) return undefined;
  const head: NoteHead = row.status === 'ran' ? 'ran' : row.status === 'failed' ? 'failed' : row.status === 'stale' ? 'stale' : 'rejected';
  const title = (view.title ?? row.tool).replace(CONTROL, ' ').slice(0, TITLE_MAX);
  const tool = row.tool.replace(CONTROL, ' ').slice(0, TITLE_MAX);
  const code = row.exit_code === null ? '-' : String(row.exit_code);
  const event = head === 'rejected' && row.reject_reason
    ? pendingText('en', 'event_rejected_reason', { id: row.id, tool, code, reason: row.reject_reason })
    : pendingText('en', `event_${head}`, { id: row.id, tool, code });
  const lines = [pendingText('en', `note_${head}`, { id: row.id, tool, code })];
  if (head === 'rejected' && row.reject_reason) lines.push(pendingText('en', 'note_reason', { reason: row.reject_reason }));
  const output = head === 'rejected' ? null : row.output_preview;
  lines.push(pendingText('en', 'note_output'), '<<<', neutralizeFence(output ? `${title}\n\n${output}` : title), '>>>');
  return { head, text: lines.join('\n'), event, fetched: (head === 'ran' || head === 'failed') && view.fetched };
}

export function closedEvent(row: PendingRow): string | undefined {
  return closedByBeat(row) ? pendingText('en', 'event_closed', { id: row.id, tool: row.tool.replace(CONTROL, ' ').slice(0, TITLE_MAX) }) : undefined;
}
