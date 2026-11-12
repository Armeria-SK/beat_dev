import type { Acceptance, AcceptanceCheck, AcceptanceItem, AcceptanceSource, Coverage, NotDoingItem, PlanDoc, Task, UnreferencedMessage } from '../api.ts';
import { t, type PlainKey } from '../i18n/index.ts';
import { apiDetail, type PlanState } from './plan.ts';
import { routeHash } from './routes.ts';

const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);

const byId = (a: { id: string }, b: { id: string }): number => {
  const x = idNumber(a.id);
  const y = idNumber(b.id);
  if (Number.isNaN(x) || Number.isNaN(y) || x === y) return a.id.localeCompare(b.id);
  return x - y;
};

export const shownItems = (acc: Acceptance): AcceptanceItem[] => acc.items.filter(i => i.removedIn === null).sort(byId);

export const shownNotDoing = (acc: Acceptance): NotDoingItem[] => [...acc.not_doing].sort(byId);

const SOURCE = { owner_words: 'ui.acc.source.words', owner_choice: 'ui.acc.source.choice', ai_added: 'ui.acc.source.ai', owner_edit: 'ui.acc.source.edit' } as const;

export const sourceLabel = (source: AcceptanceSource): (typeof SOURCE)[keyof typeof SOURCE] => SOURCE[source.kind];

const CHECK = { command: 'ui.acc.check.command', look: 'ui.acc.check.look', read: 'ui.acc.check.read' } as const;

export const checkLabel = (check: AcceptanceCheck): (typeof CHECK)[keyof typeof CHECK] => CHECK[check.kind];

export const stateLabel = (state: AcceptanceItem['state']): 'ui.acc.state.open' | null => (state === 'open' ? 'ui.acc.state.open' : null);

export type Detail = { label: PlainKey; text: string; mono?: true } | { label: PlainKey; note: PlainKey };

const CLAIMED = { owner_words: 'ui.acc.claimed.words', owner_choice: 'ui.acc.claimed.choice' } as const;

const REASON = { not_found: 'ui.acc.reason.not_found', too_short: 'ui.acc.reason.too_short', not_next_reply: 'ui.acc.reason.not_next_reply', choice_unverified: 'ui.acc.reason.choice_unverified', scan_budget: 'ui.acc.reason.scan_budget' } as const;

function sourceDetails(source: AcceptanceSource): Detail[] {
  if (source.kind === 'owner_edit') return [];
  const out: Detail[] = [];
  if (source.kind === 'ai_added' && source.claimed) {
    out.push({ label: 'ui.acc.detail.claimed', note: CLAIMED[source.claimed] });
    out.push({ label: 'ui.acc.detail.why', note: REASON[source.reason ?? 'not_found'] });
  }
  if ('quote' in source && source.quote) out.push({ label: 'ui.acc.detail.quote', text: source.quote });
  if (source.kind === 'owner_words' && source.context) out.push({ label: 'ui.acc.detail.context', text: source.context });
  if ('question' in source && source.question) out.push({ label: 'ui.acc.detail.question', text: source.question });
  if ('answer' in source && source.answer) out.push({ label: 'ui.acc.detail.answer', text: source.answer });
  return out;
}

function checkDetails(check: AcceptanceCheck): Detail[] {
  if (check.kind === 'command') return [{ label: 'ui.acc.detail.command', text: check.command, mono: true }];
  return [{ label: 'ui.acc.detail.check', note: check.kind === 'look' ? 'ui.acc.detail.look' : 'ui.acc.detail.read' }];
}

export const itemDetails = (entry: AcceptanceItem | NotDoingItem): Detail[] =>
  [...sourceDetails(entry.source), ...('check' in entry ? checkDetails(entry.check) : [])];

export const conversationLink = (source: AcceptanceSource): string | null =>
  (source.kind === 'owner_words' && source.conversationId ? routeHash({ view: 'chat', id: source.conversationId }) : null);

export const acceptanceMeta = (acc: Acceptance): string => (acc.draft ? t('ui.acc.draft') : t('ui.acc.version', acc.version));

export const showAcceptance = (acc: Acceptance | null): boolean =>
  acc !== null && (!acc.draft || shownItems(acc).length > 0 || acc.not_doing.length > 0);

export const outsideContent = (plan: PlanDoc | null, acc: Acceptance | null): boolean => plan?.tainted === true || acc?.tainted === true;

export type BuildAction = { kind: 'build'; label: 'ui.plan.build' | 'ui.plan.start'; disabled: boolean } | { kind: 'building' };

const ACTIVE: ReadonlySet<Task['status']> = new Set(['ready', 'running', 'waiting']);

export function buildAction(i: { state: PlanState; mode: 'read' | 'edit'; acc: Acceptance | null; task: Task | null; isGit: boolean }): BuildAction | null {
  if (!i.acc) return null;
  if (i.acc.frozen) return i.task && ACTIVE.has(i.task.status) ? { kind: 'building' } : null;
  if (i.mode === 'edit' || (i.state !== 'ready' && i.state !== 'writing')) return null;
  return { kind: 'build', label: i.isGit ? 'ui.plan.build' : 'ui.plan.start', disabled: i.state === 'writing' };
}

export const buildRequest = (doc: PlanDoc | null, acc: Acceptance): { planHash: string; acceptanceHash: string | null } | null =>
  (doc?.hash ? { planHash: doc.hash, acceptanceHash: acc.hash } : null);

export const changedAfterBuild = (doc: PlanDoc | null, acc: Acceptance | null): boolean =>
  Boolean(acc?.frozen && doc?.hash && acc.frozen.plan_hash !== doc.hash);

export type BuildFailure = { kind: 'changed' } | { kind: 'running' } | { kind: 'failed'; detail: string | null };

export function buildFailure(error: unknown): BuildFailure {
  const code = (error as { body?: { code?: unknown } } | null)?.body?.code;
  if (code === 'build.changed') return { kind: 'changed' };
  if (code === 'build.running') return { kind: 'running' };
  return { kind: 'failed', detail: apiDetail(error) };
}

type CountKey = 'ui.cov.words' | 'ui.cov.answers' | 'ui.cov.ai' | 'ui.cov.byHand' | 'ui.cov.edited';

export function coverageCounts(c: Coverage): Array<[CountKey, number]> {
  const out: Array<[CountKey, number]> = [['ui.cov.words', c.owner_words], ['ui.cov.answers', c.owner_choice], ['ui.cov.ai', c.ai_added], ['ui.cov.byHand', c.by_hand]];
  if (c.owner_edit > 0) out.push(['ui.cov.edited', c.owner_edit]);
  return out;
}

export interface CoverageGroups {
  words: Array<{ quote: string; item: AcceptanceItem }>;
  answers: Array<{ question: string; answer: string; item: AcceptanceItem }>;
  ai: AcceptanceItem[];
  edited: AcceptanceItem[];
}

export function coverageGroups(acc: Acceptance): CoverageGroups {
  const g: CoverageGroups = { words: [], answers: [], ai: [], edited: [] };
  for (const item of shownItems(acc)) {
    const s = item.source;
    if (s.kind === 'owner_words') g.words.push({ quote: s.quote, item });
    else if (s.kind === 'owner_choice') g.answers.push({ question: s.question, answer: s.answer, item });
    else if (s.kind === 'ai_added') g.ai.push(item);
    else g.edited.push(item);
  }
  return g;
}

export const unreferencedCursor = (loaded: readonly UnreferencedMessage[], total: number): number | null =>
  (loaded.length > 0 && loaded.length < total ? Math.min(...loaded.map(m => m.created_at)) : null);

export function mergeUnreferenced(loaded: readonly UnreferencedMessage[], page: readonly UnreferencedMessage[]): UnreferencedMessage[] {
  const seen = new Set(loaded.map(m => m.message_id));
  return [...loaded, ...page.filter(m => !seen.has(m.message_id))];
}
