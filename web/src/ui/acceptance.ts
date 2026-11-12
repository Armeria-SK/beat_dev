import type { Acceptance, AcceptanceCheck, AcceptanceItem, AcceptanceSource, NotDoingItem, PlanDoc } from '../api.ts';
import { t, type PlainKey } from '../i18n/index.ts';

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

const REASON = { not_found: 'ui.acc.reason.not_found', too_short: 'ui.acc.reason.too_short', not_next_reply: 'ui.acc.reason.not_next_reply', choice_unverified: 'ui.acc.reason.choice_unverified' } as const;

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

export const acceptanceMeta = (acc: Acceptance): string => (acc.draft ? t('ui.acc.draft') : t('ui.acc.version', acc.version));

export const showAcceptance = (acc: Acceptance | null): boolean =>
  acc !== null && (!acc.draft || shownItems(acc).length > 0 || acc.not_doing.length > 0);

export const outsideContent = (plan: PlanDoc | null, acc: Acceptance | null): boolean => plan?.tainted === true || acc?.tainted === true;
