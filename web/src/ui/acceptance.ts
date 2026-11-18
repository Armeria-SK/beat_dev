import type {
  Acceptance, AcceptanceChange, AcceptanceCheck, AcceptanceEdit, AcceptanceItem, AcceptanceSource, AcceptanceVersion, AcceptanceVersionDetail, Coverage, ModelChoice, NotDoingItem, OwnerOp, PlanDoc, Task, UnreferencedMessage,
} from '../api.ts';
import { sendChoiceOf } from '../chat-logic.ts';
import { t, type PlainKey } from '../i18n/index.ts';
import { apiDetail, type PlanState } from './plan.ts';
import { sendOptions } from './product-nav.ts';
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

const SOURCE = {
  owner_words: 'ui.acc.source.words', owner_choice: 'ui.acc.source.choice', owner_answer: 'ui.acc.source.choice', ai_added: 'ui.acc.source.ai', owner_edit: 'ui.acc.source.edit',
} as const;

export const sourceLabel = (source: AcceptanceSource): (typeof SOURCE)[keyof typeof SOURCE] | 'ui.acc.source.other' =>
  (Object.hasOwn(SOURCE, source.kind) ? SOURCE[source.kind] : 'ui.acc.source.other');

const CHECK = { command: 'ui.acc.check.command', look: 'ui.acc.check.look', read: 'ui.acc.check.read' } as const;

export const checkLabel = (check: AcceptanceCheck): (typeof CHECK)[keyof typeof CHECK] => CHECK[check.kind];

const STATE = { open: 'ui.acc.state.open', met: 'ui.acc.state.met', unverified: 'ui.acc.state.unverified' } as const;

export const stateLabel = (state: AcceptanceItem['state']): (typeof STATE)[keyof typeof STATE] => (Object.hasOwn(STATE, state) ? STATE[state] : STATE.open);

export const stateTone = (state: AcceptanceItem['state']): 'ok' | 'waiting' | undefined => (state === 'met' ? 'ok' : state === 'unverified' ? 'waiting' : undefined);

export interface EvidenceLine { text: string; output?: string }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

const INPUT_SHOWN = 80;
const TARGET = /\x22(path|command|url|query|pattern|name)\x22\s*:\s*\x22((?:[^\x22\\]|\\u[0-9a-fA-F]{4}|\\[^u])*)(\\u[0-9a-fA-F]{0,3}|\\)?(\x22|$)/u;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const cut = (value: string, more = false): string => {
  const chars = Array.from(value.replace(/\s+/gu, ' ').replace(HIDDEN, '').trim());
  if (chars.length > (more ? INPUT_SHOWN - 1 : INPUT_SHOWN)) return `${chars.slice(0, INPUT_SHOWN - 1).join('')}…`;
  return more ? `${chars.join('')}…` : chars.join('');
};

function inputSummary(input: string): string {
  const match = TARGET.exec(input);
  if (!match) return cut(input);
  let value: string;
  try { value = JSON.parse(`"${match[2]}"`) as string; } catch { value = match[2]!; }
  return cut(value, match[4] === '');
}

export function evidenceLines(evidence: readonly unknown[], { short = false }: { short?: boolean } = {}): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const notDone = text(e.notDone);
    const closed = text(e.closed);
    const command = text(e.command);
    if (notDone) out.push({ text: t('ui.ev.notDone', notDone) });
    else if (closed) out.push({ text: closed });
    else if (command) {
      const line = e.held === 'pending' ? t('ui.ev.held', command) : t(e.ok === true ? 'ui.ev.passed' : 'ui.ev.failed', command);
      const output = text(e.output);
      out.push(output ? { text: line, output } : { text: line });
    } else if (text(e.tag) && text(e.tool)) out.push({ text: [e.tag, e.tool, short && text(e.input) ? inputSummary(text(e.input)!) : text(e.input)].filter(Boolean).join(' · ') });
  }
  return out;
}

const evidenceDetails = (item: AcceptanceItem): Detail[] =>
  evidenceLines(item.evidence ?? []).flatMap((line): Detail[] => [
    { label: 'ui.acc.detail.evidence', text: line.text },
    ...(line.output ? [{ label: 'ui.acc.detail.output', text: line.output, mono: true } as const] : []),
  ]);

export type Detail = { label: PlainKey; text: string; mono?: true } | { label: PlainKey; note: PlainKey };

const CLAIMED = { owner_words: 'ui.acc.claimed.words', owner_choice: 'ui.acc.claimed.choice' } as const;

const REASON = { not_found: 'ui.acc.reason.not_found', too_short: 'ui.acc.reason.too_short', not_next_reply: 'ui.acc.reason.not_next_reply', choice_unverified: 'ui.acc.reason.choice_unverified', scan_budget: 'ui.acc.reason.scan_budget' } as const;

function sourceDetails(source: AcceptanceSource, nested = false): Detail[] {
  if (source.kind === 'owner_edit') return [];
  const out: Detail[] = [];
  if (source.kind === 'ai_added' && source.claimed && Object.hasOwn(CLAIMED, source.claimed)) {
    out.push({ label: 'ui.acc.detail.claimed', note: CLAIMED[source.claimed] });
    out.push({ label: 'ui.acc.detail.why', note: REASON[source.reason && Object.hasOwn(REASON, source.reason) ? source.reason : 'not_found'] });
  }
  if (source.kind === 'owner_answer') {
    if (source.answer) out.push({ label: 'ui.acc.detail.answer', text: source.answer });
    if (source.was && !nested) out.push({ label: 'ui.acc.detail.was', note: sourceLabel(source.was) }, ...sourceDetails(source.was, true));
    return out;
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
  [...sourceDetails(entry.source), ...('check' in entry ? [...checkDetails(entry.check), ...evidenceDetails(entry)] : [])];

export const conversationLink = (source: AcceptanceSource): string | null =>
  (source.kind === 'owner_words' && source.conversationId ? routeHash({ view: 'chat', id: source.conversationId }) : null);

export const acceptanceMeta = (acc: Acceptance): string => (acc.draft ? t('ui.acc.draft') : t('ui.acc.version', acc.version));

export const showAcceptance = (acc: Acceptance | null): boolean =>
  acc !== null && (!acc.draft || shownItems(acc).length > 0 || acc.not_doing.length > 0);

export const outsideContent = (plan: PlanDoc | null, acc: Acceptance | null): boolean => plan?.tainted === true || acc?.tainted === true;

export type BuildAction = { kind: 'build'; label: 'ui.plan.build' | 'ui.plan.start'; disabled: boolean } | { kind: 'building' };

const ACTIVE: ReadonlySet<Task['status']> = new Set(['ready', 'running', 'waiting']);

export function buildAction(i: { state: PlanState; mode: 'read' | 'edit'; acc: Acceptance | null; task: Task | null; isGit: boolean; pending?: boolean }): BuildAction | null {
  if (!i.acc) return null;
  const active = i.task !== null && ACTIVE.has(i.task.status);
  if (active) return { kind: 'building' };
  if (i.acc.frozen && !buildLeft(i.acc)) return null;
  if (i.mode === 'edit' || (i.state !== 'ready' && i.state !== 'writing')) return null;
  return { kind: 'build', label: i.isGit ? 'ui.plan.build' : 'ui.plan.start', disabled: i.state === 'writing' || i.pending === true };
}

export const buildPill = (status: Task['status'] | undefined): { label: 'ui.plan.queued' | 'ui.plan.building' | 'ui.plan.waiting'; tone?: 'running' | 'waiting' } =>
  (status === 'running' ? { label: 'ui.plan.building', tone: 'running' } : status === 'waiting' ? { label: 'ui.plan.waiting', tone: 'waiting' } : { label: 'ui.plan.queued' });

export const watchedBuild = (sent: string | null, acc: Acceptance | null): string | null => acc?.open_build_task_id ?? sent;

const buildLeft = (acc: Acceptance): boolean => (acc.unbuilt?.length ?? 0) > 0;

export const beforeBuildShown = (i: { mode: 'read' | 'edit'; acc: Acceptance | null; coverage: Coverage | null; action: BuildAction | null }): boolean =>
  i.mode === 'read' && i.acc !== null && i.coverage !== null && i.action?.kind === 'build';

export type RevealStep = 'none' | 'wait' | 'scroll' | 'drop';

export function revealStep(i: { reveal: boolean; accLoaded: boolean; accFailed: boolean; state: PlanState; shown: boolean }): RevealStep {
  if (!i.reveal) return 'none';
  if (i.shown) return 'scroll';
  if (i.accFailed) return 'drop';
  return !i.accLoaded || i.state === 'loading' ? 'wait' : 'drop';
}

export const buildRequest = (doc: PlanDoc | null, acc: Acceptance): { planHash: string; acceptanceHash: string | null } | null =>
  (doc?.hash ? { planHash: doc.hash, acceptanceHash: acc.hash } : null);

export const changedAfterBuild = (doc: PlanDoc | null): boolean =>
  Boolean(doc?.built_hash && doc.hash && doc.built_hash !== doc.hash);

export type BuildFailure = { kind: 'changed' } | { kind: 'running' } | { kind: 'frozen'; detail: string | null } | { kind: 'failed'; detail: string | null };

export function buildFailure(error: unknown): BuildFailure {
  const code = (error as { body?: { code?: unknown } } | null)?.body?.code;
  if (code === 'build.changed') return { kind: 'changed' };
  if (code === 'build.running') return { kind: 'running' };
  if (code === 'build.frozen') return { kind: 'frozen', detail: apiDetail(error) };
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
    const s = item.source.kind === 'owner_answer' ? item.source.was : item.source;
    if (s?.kind === 'owner_words') g.words.push({ quote: s.quote, item });
    else if (s?.kind === 'owner_choice') g.answers.push({ question: s.question, answer: s.answer, item });
    else if (s?.kind === 'ai_added') g.ai.push(item);
    else if (s?.kind === 'owner_edit') g.edited.push(item);
  }
  return g;
}

export const unreferencedCursor = (loaded: readonly UnreferencedMessage[], total: number): number | null =>
  (loaded.length > 0 && loaded.length < total ? Math.min(...loaded.map(m => m.created_at)) : null);

export function mergeUnreferenced(loaded: readonly UnreferencedMessage[], page: readonly UnreferencedMessage[]): UnreferencedMessage[] {
  const seen = new Set(loaded.map(m => m.message_id));
  return [...loaded, ...page.filter(m => !seen.has(m.message_id))];
}

export const noticeAfterReload = (notice: BuildFailure | null, acc: Acceptance): BuildFailure | null =>
  (acc.frozen && !buildLeft(acc) ? null : notice);

export interface Paging { list: UnreferencedMessage[]; generation: number; exhausted: boolean }

export const startPaging = (list: readonly UnreferencedMessage[], generation: number): Paging => ({ list: [...list], generation, exhausted: false });

export const pagingCursor = (p: Paging, total: number): number | null => (p.exhausted ? null : unreferencedCursor(p.list, total));

export const addPage = (p: Paging, generation: number, page: readonly UnreferencedMessage[]): Paging =>
  (generation !== p.generation ? p : { ...p, list: mergeUnreferenced(p.list, page), exhausted: page.length === 0 });

export type DiffKind = 'added' | 'changed' | 'removed';

export interface DiffRow { kind: DiffKind; id: string | null; result: string; before: string | null; source: AcceptanceSource | null; check: AcceptanceCheck | null }

const DIFF = { added: 'ui.acc.diff.added', changed: 'ui.acc.diff.changed', removed: 'ui.acc.diff.removed' } as const;

export const diffLabel = (kind: DiffKind): (typeof DIFF)[DiffKind] => DIFF[kind];

export function proposalRows(acc: Acceptance, change: AcceptanceChange): DiffRow[] {
  const current = new Map(acc.items.map(i => [i.id, i]));
  return change.ops.map((op): DiffRow => {
    const source = op.source;
    if (op.op === 'add') return { kind: 'added', id: null, result: op.item.result, before: null, source, check: op.item.check };
    const was = current.get(op.id);
    if (op.op === 'remove') return { kind: 'removed', id: op.id, result: was?.result ?? op.id, before: null, source, check: was?.check ?? null };
    const result = op.item.result;
    return { kind: 'changed', id: op.id, result, before: was && was.result !== result ? was.result : null, source, check: op.item.check };
  });
}

export function versionItems(detail: AcceptanceVersionDetail): AcceptanceItem[] {
  const items = (detail.content as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items as AcceptanceItem[] : [];
}

export const proposalStale = (acc: Acceptance, change: AcceptanceChange): boolean => change.base_version !== acc.version;

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const fixedPart = (i: AcceptanceItem): string => stable({ result: i.result, check: i.check, source: i.source });

export function versionDiff(before: readonly AcceptanceItem[] | null, after: readonly AcceptanceItem[]): DiffRow[] {
  const live = (items: readonly AcceptanceItem[]) => new Map(items.filter(i => i.removedIn === null).map(i => [i.id, i]));
  const was = live(before ?? []);
  const now = live(after);
  const ids = [...new Set([...was.keys(), ...now.keys()])].map(id => ({ id })).sort(byId).map(x => x.id);
  const rows: DiffRow[] = [];
  for (const id of ids) {
    const a = was.get(id);
    const b = now.get(id);
    if (a && !b) rows.push({ kind: 'removed', id, result: a.result, before: null, source: null, check: a.check });
    else if (!a && b) rows.push({ kind: 'added', id, result: b.result, before: null, source: b.source, check: b.check });
    else if (a && b && fixedPart(a) !== fixedPart(b)) rows.push({ kind: 'changed', id, result: b.result, before: a.result !== b.result ? a.result : null, source: b.source, check: b.check });
  }
  return rows;
}

export const versionsShown = (list: readonly AcceptanceVersion[]): AcceptanceVersion[] => [...list].sort((a, b) => b.version - a.version);

export function previousVersion(list: readonly AcceptanceVersion[], version: number): number | null {
  const older = list.map(v => v.version).filter(n => n < version);
  return older.length > 0 ? Math.max(...older) : null;
}

const VERSION_SOURCE = { build: 'ui.acc.versions.build', change: 'ui.acc.versions.change', question: 'ui.acc.versions.question', proposal: 'ui.acc.versions.proposal' } as const;

export const versionSourceLabel = (source: string): (typeof VERSION_SOURCE)[keyof typeof VERSION_SOURCE] | null =>
  (Object.hasOwn(VERSION_SOURCE, source) ? VERSION_SOURCE[source as keyof typeof VERSION_SOURCE] : null);

export const RESULT_MAX = 300;
export const COMMAND_MAX = 1000;

export interface ItemForm { result: string; check: AcceptanceCheck['kind']; command: string }

export const itemForm = (item: AcceptanceItem | null): ItemForm => ({
  result: item?.result ?? '', check: item?.check.kind ?? 'look', command: item?.check.kind === 'command' ? item.check.command : '',
});

export type FormProblem = 'ui.acc.edit.empty' | 'ui.acc.edit.long' | 'ui.acc.edit.noCommand' | 'ui.acc.edit.longCommand';

export function formProblem(form: ItemForm): FormProblem | null {
  const result = form.result.trim();
  if (!result) return 'ui.acc.edit.empty';
  if (result.length > RESULT_MAX) return 'ui.acc.edit.long';
  if (form.check !== 'command') return null;
  const command = form.command.trim();
  if (!command) return 'ui.acc.edit.noCommand';
  return command.length > COMMAND_MAX ? 'ui.acc.edit.longCommand' : null;
}

const formCheck = (form: ItemForm): AcceptanceCheck => (form.check === 'command' ? { kind: 'command', command: form.command.trim() } : { kind: form.check });

export function editOp(form: ItemForm, item: AcceptanceItem | null): OwnerOp | null {
  const next = { result: form.result.trim(), check: formCheck(form) };
  if (!item) return { op: 'add', item: next };
  if (next.result === item.result && stable(next.check) === stable(item.check)) return null;
  return { op: 'change', id: item.id, item: next };
}

export const removeOp = (item: AcceptanceItem): OwnerOp => ({ op: 'remove', id: item.id });

export type EditBase = Pick<AcceptanceEdit, 'baseVersion' | 'baseHash'>;

export const editBase = (acc: Acceptance): EditBase => ({ baseVersion: acc.version, baseHash: acc.hash });

export const editRequest = (base: EditBase, op: OwnerOp): AcceptanceEdit => ({ ...base, ops: [op] });

export function editHint(acc: Acceptance, change: AcceptanceChange | null): string | null {
  const parts = [...(acc.draft ? [] : [t('ui.acc.edit.newVersion', acc.version + 1)]), ...(change ? [t('ui.acc.edit.discardsChange')] : [])];
  return parts.length > 0 ? parts.join(' · ') : null;
}

export type EditAccess = 'off' | 'locked' | 'on';

export function editAccess(i: { acc: Acceptance | null; state: PlanState; mode: 'read' | 'edit'; pending: boolean }): EditAccess {
  if (i.acc === null || i.mode !== 'read') return 'off';
  return i.state === 'writing' || i.pending ? 'locked' : 'on';
}

export const problemField = (problem: FormProblem): 'result' | 'command' =>
  (problem === 'ui.acc.edit.noCommand' || problem === 'ui.acc.edit.longCommand' ? 'command' : 'result');

export const approveDisabled = (acc: Acceptance, change: AcceptanceChange, busy: boolean): boolean => busy || proposalStale(acc, change);

export const loadedAcceptance = (r: { acceptance: Acceptance; coverage?: Coverage }): { acc: Acceptance; change: AcceptanceChange | null; coverage: Coverage | null } =>
  ({ acc: r.acceptance, change: r.acceptance.change ?? null, coverage: r.coverage ?? null });

export type DecisionFailure = { kind: 'stale' } | { kind: 'failed'; detail: string | null };

const RELOAD: ReadonlySet<unknown> = new Set(['acceptance.stale', 'acceptance.not_pending', 'acceptance.no_change']);

export const decisionFailure = (error: unknown): DecisionFailure =>
  (RELOAD.has((error as { body?: { code?: unknown } } | null)?.body?.code) ? { kind: 'stale' } : { kind: 'failed', detail: apiDetail(error) });

export const askAfterSave = (acc: Acceptance | null): boolean => acc?.frozen != null;

export const ASK_TEXT = 'I changed the plan. Check whether the acceptance items still match it, and propose any changes they need with acceptance_change.';

export function askSend(target: string | null, productId: string, newId: () => string): { id: string; text: string; choice: ModelChoice; options: { projectId?: string; generated: true } } {
  return {
    id: target ?? newId(),
    text: ASK_TEXT,
    choice: sendChoiceOf(target, { modelId: null, effort: null, permissionMode: 'plan' }, undefined, true),
    options: { ...sendOptions(target, productId, false), generated: true },
  };
}

type Scrollable = { scrollIntoView: (options: ScrollIntoViewOptions) => void };

export function revealSection(top: Scrollable | null, section: Scrollable & { focus: (options: FocusOptions) => void }): void {
  (top ?? section).scrollIntoView({ block: 'start' });
  section.focus({ preventScroll: true });
}

export const remainingItems = (task: Pick<Task, 'items'>, acc: Acceptance | null | undefined): Array<{ id: string; item: AcceptanceItem | null }> =>
  (task.items?.remaining ?? []).map(id => ({ id, item: acc?.items.find(i => i.id === id && i.removedIn === null) ?? null }));
