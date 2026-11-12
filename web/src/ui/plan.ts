import type { Conversation, PlanDoc } from '../api.ts';
import { SCREEN_EDITS } from './unsaved.ts';

export type PlanState = 'loading' | 'failed' | 'empty' | 'writing' | 'ready';

export const PLAN_EDITS = `${SCREEN_EDITS}plan:`;

export function planState(doc: PlanDoc | null, failed: boolean): PlanState {
  if (!doc) return failed ? 'failed' : 'loading';
  if (doc.writing) return 'writing';
  return doc.content ? 'ready' : 'empty';
}

export const canEdit = (state: PlanState): boolean => state === 'ready' || state === 'empty';

export const canSave = (state: PlanState, dirty: boolean, saving: boolean): boolean => canEdit(state) && dirty && !saving;

export const planDirty = (draft: string | null, doc: PlanDoc | null): boolean => draft !== null && draft !== (doc?.content ?? '');

export const saveOutcome = (error: unknown): 'changed' | 'failed' =>
  ((error as { status?: unknown } | null)?.status === 409 ? 'changed' : 'failed');

const BY = { owner: 'ui.plan.byYou', ai: 'ui.plan.byAi', outside: 'ui.plan.byOutside' } as const;

export const editedBy = (doc: PlanDoc): (typeof BY)[keyof typeof BY] | null => (doc.updated_by ? BY[doc.updated_by] : null);

export interface PlanDraft { text: string; base: string | null }

export const keptDraft = (stored: PlanDraft | undefined, dirty: boolean): PlanDraft | null => (dirty && stored !== undefined ? stored : null);

export const planDrafts = new Map<string, PlanDraft>();

export function runningIn(drafts: ReadonlyArray<{ conversationId: string }>, conversations: readonly Conversation[], productId: string): number {
  const mine = new Set(conversations.filter(c => c.project_id === productId).map(c => c.id));
  return drafts.filter(d => mine.has(d.conversationId)).length;
}
