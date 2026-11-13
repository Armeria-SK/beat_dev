import type { ChecklistItem, TaskStatus } from '../api.ts';

export type AgentState = 'idle' | 'working' | 'waiting';

export interface Waiting {
  proposals: number;
  answers: number;
  drafts: number;
  pending: number;
}

export function countTasks(statuses: Iterable<TaskStatus>): { proposals: number; answers: number } {
  let proposals = 0;
  let answers = 0;
  for (const status of statuses) {
    if (status === 'inbox') proposals += 1;
    else if (status === 'waiting') answers += 1;
  }
  return { proposals, answers };
}

export const waitingTotal = (w: Waiting): number => w.proposals + w.answers + w.drafts + w.pending;

export const kanbanCount = (w: Pick<Waiting, 'proposals' | 'answers'>): number => w.proposals + w.answers;

export function agentState(w: Waiting, working: boolean): AgentState {
  if (waitingTotal(w) > 0) return 'waiting';
  return working ? 'working' : 'idle';
}

export type FootLine =
  | { kind: 'waiting'; n: number }
  | { kind: 'building'; step: number; total: number }
  | { kind: 'running'; title: string | null }
  | { kind: 'idle' };

export function checklistStep(items: readonly ChecklistItem[]): { step: number; total: number } | null {
  if (items.length === 0 || items.every(i => i.status === 'done')) return null;
  const doing = items.findIndex(i => i.status === 'in_progress');
  const step = doing >= 0 ? doing + 1 : Math.min(items.length, items.filter(i => i.status === 'done').length + 1);
  return { step, total: items.length };
}

export function footLine(w: Waiting, working: boolean, checklists: ReadonlyArray<readonly ChecklistItem[]>, runningTitle: string | null): FootLine {
  const n = waitingTotal(w);
  if (n > 0) return { kind: 'waiting', n };
  if (!working) return { kind: 'idle' };
  for (const items of checklists) {
    const at = checklistStep(items);
    if (at) return { kind: 'building', ...at };
  }
  return { kind: 'running', title: runningTitle };
}
