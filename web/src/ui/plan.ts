import type { Conversation, PlanDoc } from '../api.ts';
import type { Route } from './routes.ts';
import { SCREEN_EDITS } from './unsaved.ts';

export type PlanState = 'loading' | 'failed' | 'empty' | 'writing' | 'ready';

export const PLAN_EDITS = `${SCREEN_EDITS}plan:`;

export function planState(doc: PlanDoc | null, failed: boolean): PlanState {
  if (!doc) return failed ? 'failed' : 'loading';
  if (doc.writing) return 'writing';
  return doc.content ? 'ready' : 'empty';
}

export interface ReviewSeen { hash: string | null; changed: boolean }

export const reviewSeen = (prev: ReviewSeen, hash: string | null): ReviewSeen =>
  (prev.hash === hash ? prev : { hash, changed: prev.hash !== null && hash !== null });

export type ReviewButton = 'hidden' | 'off' | 'on';

export function reviewButton(doc: PlanDoc | null, mode: 'read' | 'edit', busy: boolean): ReviewButton {
  if (!doc?.tainted || !doc.hash || mode !== 'read') return 'hidden';
  return doc.writing || busy ? 'off' : 'on';
}

export const canEdit = (state: PlanState): boolean => state === 'ready' || state === 'empty';

export const canSave = (state: PlanState, dirty: boolean, saving: boolean): boolean => canEdit(state) && dirty && !saving;

export interface PlanDraft { text: string; base: string | null; baseText: string; replaces?: true }

export const startDraft = (doc: PlanDoc | null): PlanDraft => ({ text: doc?.content ?? '', base: doc?.hash ?? null, baseText: doc?.content ?? '' });

export const planDirty = (draft: PlanDraft | null): boolean => draft !== null && draft.text !== draft.baseText;

export const followDoc = (draft: PlanDraft | null, doc: PlanDoc | null): PlanDraft | null =>
  (draft && doc && !planDirty(draft) && doc.hash !== draft.base ? startDraft(doc) : draft);

export const rebase = (draft: PlanDraft, doc: PlanDoc): PlanDraft => ({ text: draft.text, base: doc.hash, baseText: doc.content ?? '', replaces: true });

export type SaveOutcome = { kind: 'changed' } | { kind: 'failed'; detail: string | null };

export const typed = (draft: PlanDraft | null, doc: PlanDoc | null, text: string): PlanDraft => ({ ...(draft ?? startDraft(doc)), text });

export const apiDetail = (error: unknown): string | null =>
  (typeof (error as { status?: unknown } | null)?.status === 'number' && error instanceof Error ? error.message : null);

export function saveOutcome(error: unknown): SaveOutcome {
  if ((error as { status?: unknown } | null)?.status === 409) return { kind: 'changed' };
  return { kind: 'failed', detail: apiDetail(error) };
}

export function planStays(held: Route, next: Route, productOf: (conversationId: string) => string | null | undefined): string | null {
  const of = (route: Route, unknown: string | null): string | null => {
    if (route.view === 'productNew') return route.id;
    if (route.view !== 'chat') return null;
    const product = productOf(route.id);
    return product === undefined ? unknown : product;
  };
  const from = of(held, null);
  return from !== null && of(next, held.view === 'productNew' ? from : null) === from ? from : null;
}

const BY = { owner: 'ui.plan.byYou', ai: 'ui.plan.byAi', outside: 'ui.plan.byOutside' } as const;

export const editedBy = (doc: PlanDoc): (typeof BY)[keyof typeof BY] | null => (doc.updated_by ? BY[doc.updated_by] : null);

export const keptDraft = (stored: PlanDraft | undefined, dirty: boolean): PlanDraft | null => (dirty && stored !== undefined ? stored : null);

export const planDrafts = new Map<string, PlanDraft>();

export function runningIn(drafts: ReadonlyArray<{ conversationId: string }>, conversations: readonly Conversation[], productId: string): number {
  const mine = new Set(conversations.filter(c => c.project_id === productId).map(c => c.id));
  return drafts.filter(d => mine.has(d.conversationId)).length;
}
