import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { pendingText, type PendingMessageKey } from '../shared/messages/pending.ts';
import { redactJsonValues, redactSecrets } from '../shared/redaction.ts';
import type { PreviewFile } from '../tools/approvals.ts';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { realish } from '../tools/hooks/scope.ts';
import type { Decision } from '../tools/hooks/shell-guard.ts';
import type { HeldValue, PreCheck, RunKind, ToolDef } from '../tools/types.ts';
import { identityOf } from '../projects/created.ts';
import { outsideRule, pushRule, storedCandidate, type RuleCandidate } from '../tools/approval-rules.ts';
import { boundFacts, destinationFacts, fileFacts, pushFacts, takeSnapshot, type PathFact, type Snapshot } from './snapshot.ts';

export type PendingKind = 'send' | 'delete' | 'hook' | 'policy' | 'owner' | 'judge' | 'judge_failed';
export type PendingStatus = 'waiting' | 'running' | 'ran' | 'failed' | 'rejected' | 'stale' | 'cancelled';

export class PendingError extends LocalizedError<PendingMessageKey> {
  constructor(code: PendingMessageKey, params?: MessageParams) { super(pendingText, code, params); }
}

export interface ParkInput {
  tool: string;
  input: unknown;
  cwd: string;
  workspace?: string | undefined;
  kind: PendingKind;
  reason: string;
  checks?: string[] | undefined;
  check?: PreCheck | undefined;
  bind?: string | undefined;
  preview?: PreviewFile[] | undefined;
  targets?: string[] | undefined;
  files?: string[] | undefined;
  places?: string[] | undefined;
  created?: string[] | undefined;
  filesMore?: boolean | undefined;
  pushes?: Array<{ dir: string | null; parsed?: boolean }> | undefined;
  runId: string;
  runKind: RunKind;
  conversationId: string;
  taskId?: string | null | undefined;
  projectId?: string | null | undefined;
  tainted?: boolean | undefined;
  outbound?: ParkedOutbound | undefined;
  rule?: RuleCandidate | undefined;
}

export interface ParkedOutbound { kind: string; reason?: string; targets: string[] }

export interface Recheck { decision: Decision; kinds: string[]; reasons: string[]; paths: string[] }

export interface PendingState {
  title?: string;
  parts?: PendingParts;
  snapshot?: Snapshot;
  preview?: PreviewFile[];
  recheck?: Recheck;
  cwdReal?: string | null;
  fetched?: boolean;
  outbound?: ParkedOutbound;
  sent?: PathFact[];
  destination?: string;
  workspace?: string;
  places?: string[];
  created?: CreatedMark[];
  filesMore?: true;
  pushes?: Array<{ dir: string | null; parsed?: boolean }>;
  pushed?: string;
  tips?: string[];
  rule?: RuleCandidate;
  rest?: RestingCard;
  held?: string[];
}

export interface RestingCard { shown: string; masked: number; parts: PendingParts; preview?: PreviewFile[] }

export interface CreatedMark { path: string; id: string; inside?: string; more?: true }

export interface PendingParts { body: string | null; cwd: string | null; extra: string | null }

const NO_PARTS: PendingParts = { body: null, cwd: null, extra: null };

export interface PendingEffect { files: number; bytes: number; more?: true }

export interface PendingRow {
  id: number; tool: string; input: string; shown: string; masked: number; cwd: string | null; kind: PendingKind; reason: string; checks: string;
  bind: string | null; state: string | null; files: string | null; run_id: string; run_kind: string; conversation_id: string; task_id: string | null;
  project_id: string | null; tainted: number; status: PendingStatus; reject_reason: string | null; exit_code: number | null; output_preview: string | null;
  full_ref: string | null; created_at: number; decided_at: number | null; ran_at: number | null;
}

export interface PendingView {
  id: number; tool: string; title: string | null; shown: string; parts: PendingParts; masked: number; held: string[]; oldPreview?: true; cwd: string | null; kind: PendingKind; reason: string; checks: string[];
  preview: PreviewFile[]; files: PathFact[]; effect: PendingEffect | null; fetched: boolean; run_kind: string; conversation_id: string; task_id: string | null; task_title: string | null;
  project_id: string | null; project_name: string | null; tainted: boolean; status: PendingStatus; reject_reason: string | null;
  exit_code: number | null; output_preview: string | null; created_at: number; decided_at: number | null; ran_at: number | null;
  rule: { shown: string; push?: true; outside?: true } | null;
}

export interface PendingChange { id: number; status: PendingStatus; projectId: string | null; conversationId: string; taskId: string | null }

export interface PendingFilter {
  status: 'waiting' | 'decided';
  project?: string | undefined;
  task?: string | undefined;
  conversation?: string | undefined;
  before?: number | undefined;
  since?: number | undefined;
  until?: number | undefined;
  limit?: number | undefined;
}

export interface PendingCounts {
  waiting: number;
  byProject: Record<string, number>;
  acceptanceChanges: Record<string, number>;
  judgedToday: { allowed: number; parked: number };
}

export interface JudgedCounts { allowed: number; parked: Record<string, number>; notParked: number; ruled: Record<string, number> }

export interface FinishInput { status: 'ran' | 'failed' | 'stale' | 'cancelled'; exitCode?: number | undefined; output?: string | undefined; fullRef?: string | undefined; fetched?: boolean | undefined; reason?: string | undefined }

const OUTPUT_TAIL = 2000;
const REASON_MAX = 500;
const LIST_MAX = 200;
const MARK = '[REDACTED]';
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Format characters (Cf, e.g. U+200B, U+FEFF) and the control characters that are not whitespace (Cc except \t \n \v \f \r). Not (?!\s): \s holds U+FEFF
const INVISIBLE = /[\p{Cf}\x00-\x08\x0E-\x1F\x7F-\x9F]/gu;

const marks = (text: string): number => text.split(MARK).length - 1;

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

// mark: the held-value marker of the row's tool. It runs after the shape redaction and before the cut, so a value that straddles the tail's edge is already a mark when the text is cut
export function outputTail(text: string, mark: Mark = same => same): string {
  const marked = mark(redactSecrets(text));
  return marked.length > OUTPUT_TAIL ? marked.slice(-OUTPUT_TAIL) : marked;
}

// Marks every held value before the cut, for the same reason as outputTail. It marks three times: on the raw text, so a value that itself holds a line break
// (a multi-line key) is found; after only the invisible characters (Cf and the non-whitespace controls, e.g. U+200B, NUL) are stripped, so a multi-line value split by one of them is
// found with its line breaks still in place; and after the whole control-character strip, so a value the strip joins back is marked too
export function cleanReason(text: string | undefined, mark: Mark = same => same): string | null {
  if (text === undefined) return null;
  const cleaned = mark(mark(mark(text).replace(INVISIBLE, '')).replace(CONTROL, '')).trim().slice(0, REASON_MAX);
  return cleaned || null;
}

const unique = (items: readonly string[]): string[] => [...new Set(items)].sort();

export const closedByBeat = (row: Pick<PendingRow, 'status' | 'reject_reason'>): boolean => row.status === 'stale' && row.reject_reason !== null;

// J-5: the row offers "don't ask again in this product" only when a code-built shape was stored at park time, the run had a product, and it is still waiting.
// Whether the run had read outside text does not matter (AP-1, Q1): a rule applies the same either way
export function rememberable(row: Pick<PendingRow, 'project_id' | 'status' | 'tool' | 'run_kind'>, state: Pick<PendingState, 'rule' | 'held'>): boolean {
  const rule = storedCandidate(state.rule);
  return rule !== undefined && rule.tool === row.tool && row.project_id !== null && row.status === 'waiting' && !state.held?.length
    && !((row.tool === 'task_create' || row.tool === 'task_update') && row.run_kind !== 'chat');
}

const ruleView = (rule: RuleCandidate): { shown: string; push?: true; outside?: true } => ({ shown: rule.shown, ...(pushRule(rule) ? { push: true as const } : {}), ...(outsideRule(rule) ? { outside: true as const } : {}) });

export function storedRule(row: Pick<PendingRow, 'state'>): RuleCandidate | undefined {
  return storedCandidate(parseJson<PendingState>(row.state, {}).rule);
}

const realOf = (path: string): string => { try { return realish(path); } catch { return path; } };

export function recheckOf(check: PreCheck, mask: (text: string) => string = text => text): Recheck {
  return {
    decision: check.decision,
    kinds: unique(check.askKinds ?? []),
    reasons: unique(check.reasons.map(r => redactSecrets(mask(r)))),
    paths: unique((check.paths ?? []).map(p => redactSecrets(`${p.path ?? p.input}|${p.path ? realOf(p.path) : ''}|${p.verdict}|${p.mode ?? ''}`))),
  };
}

const NO_CHECKS: Recheck = { decision: 'allow', kinds: [], reasons: [], paths: [] };

export function newChecks(before: Recheck | undefined, now: PreCheck, mask?: (text: string) => string): string[] {
  const was = before ?? NO_CHECKS;
  const is = recheckOf(now, mask);
  const fresh = [
    ...is.reasons.filter(r => !was.reasons.includes(r)),
    ...is.kinds.filter(k => !was.kinds.includes(k)).map(k => `ask: ${k}`),
    ...is.paths.filter(p => !was.paths.includes(p)),
  ];
  if (!fresh.length && was.decision === 'allow' && is.decision !== 'allow') fresh.push(`ask: ${is.reasons.join('; ')}`);
  return fresh;
}

export function parkedOutbound(outbound: ParkedOutbound, mask: (text: string) => string = text => text): ParkedOutbound {
  return { kind: outbound.kind, ...(outbound.reason !== undefined ? { reason: redactSecrets(mask(outbound.reason)) } : {}), targets: [...new Set(outbound.targets.map(t => redactSecrets(mask(t))))].sort() };
}

export function realCwd(cwd: string): string | null {
  try { return realpathSync.native(cwd); } catch { return null; }
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function render(tool: ToolDef, input: unknown, exact: readonly string[] = []): { title: string; shown: string; raw: string; parts: PendingParts } {
  const mask = (text: string): string => redactSecrets(tool.redact ? tool.redact(text) : text, exact);
  let summary: { title: string; body: string; cwd?: string } | undefined;
  try { summary = tool.summarize?.(input as never, 'en'); } catch { summary = undefined; }
  const title = summary?.title ?? tool.name;
  const masked = redactJsonValues(input);
  const keyOf = (value: string | undefined): string | undefined => plain(input) && plain(masked) && value !== undefined
    ? Object.keys(input).find(k => input[k] === value && masked[k] !== MARK)
    : undefined;
  const bodyKey = keyOf(summary?.body);
  const cwdKey = keyOf(summary?.cwd);
  const raw: string[] = [title];
  const shown: string[] = [mask(title)];
  const parts: PendingParts = { ...NO_PARTS };
  if (summary?.cwd !== undefined) {
    raw.push(pendingText('en', 'cwd_line', { path: summary.cwd }));
    shown.push(pendingText('en', 'cwd_line', { path: cwdKey !== undefined ? mask(summary.cwd) : MARK }));
  }
  if (summary && bodyKey !== undefined && plain(input) && plain(masked)) {
    raw.push(summary.body);
    shown.push(mask(summary.body));
    parts.body = mask(summary.body);
    parts.cwd = summary.cwd === undefined ? null : cwdKey !== undefined ? mask(summary.cwd) : MARK;
    const rest = Object.keys(input).filter(k => k !== bodyKey && k !== cwdKey);
    if (rest.length) {
      raw.push(JSON.stringify(Object.fromEntries(rest.map(k => [k, input[k]])), null, 2));
      parts.extra = mask(JSON.stringify(Object.fromEntries(rest.map(k => [k, masked[k]])), null, 2));
      shown.push(parts.extra);
    }
  } else {
    raw.push(JSON.stringify(input, null, 2));
    parts.body = mask(JSON.stringify(masked, null, 2));
    shown.push(parts.body);
  }
  return { title: mask(title), shown: shown.join('\n'), raw: raw.join('\n'), parts };
}

export const heldMark = (source: string): string => `[BEAT-SECRET: ${source}]`;
const HELD_MIN = 8;
const STRADDLE_MIN = 4;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

type Mark = (text: string, cut?: boolean) => string;

function heldMarker(held: readonly HeldValue[]): { mark: Mark; sources: string[] } {
  const sources: string[] = [];
  const kept = held.filter(h => h.value.trim().length >= HELD_MIN);
  const forms = kept.flatMap(h => [h.value, JSON.stringify(h.value).slice(1, -1)].map(form => ({ form, source: h.source })))
    .filter((f, i, all) => all.findIndex(g => g.form === f.form) === i).sort((x, y) => y.form.length - x.form.length);
  const pattern = forms.length ? new RegExp(forms.map(f => `(${f.form.trim().split(/\s+/u).map(part => part.replace(REGEX_SPECIAL, '\\$&')).join('\\s+')})`).join('|'), 'gu') : undefined;
  const mark: Mark = (text, cut = false) => {
    let out = pattern ? text.replace(pattern, (...m: unknown[]) => { const source = forms[m.slice(1, forms.length + 1).findIndex(g => g !== undefined)]!.source; sources.push(source); return heldMark(source); }) : text;
    if (cut) {
      let best: { size: number; source: string } | undefined;
      for (const h of kept) {
        for (let size = Math.min(h.value.length - 1, out.length); size >= STRADDLE_MIN && size > (best?.size ?? 0); size -= 1) {
          if (out.endsWith(h.value.slice(0, size))) { best = { size, source: h.source }; break; }
        }
      }
      if (best) { out = out.slice(0, -best.size) + heldMark(best.source); sources.push(best.source); }
    }
    return out;
  };
  return { mark, sources };
}

// J-5: whether any of the texts carries a value beat holds (a key of a provider or an MCP server), in the forms the card marks
export function carriesHeld(texts: readonly string[], held: readonly HeldValue[]): boolean {
  const marker = heldMarker(held);
  for (const text of texts) marker.mark(text);
  return marker.sources.length > 0;
}

function approvalCard(tool: ToolDef, input: unknown, title: string, mark: Mark): { shown: string; parts: PendingParts } {
  let summary: { title: string; body: string; cwd?: string } | undefined;
  try { summary = tool.summarize?.(input as never, 'en'); } catch { summary = undefined; }
  const keyOf = (value: string | undefined): string | undefined => plain(input) && value !== undefined ? Object.keys(input).find(k => input[k] === value) : undefined;
  const bodyKey = keyOf(summary?.body);
  const cwdKey = keyOf(summary?.cwd);
  const parts: PendingParts = { ...NO_PARTS };
  const lines: string[] = [title];
  const cwd = summary?.cwd === undefined ? null : mark(summary.cwd);
  if (cwd !== null) lines.push(pendingText('en', 'cwd_line', { path: cwd }));
  if (summary && bodyKey !== undefined && plain(input)) {
    parts.body = mark(summary.body);
    parts.cwd = cwd;
    const rest = Object.keys(input).filter(k => k !== bodyKey && k !== cwdKey);
    if (rest.length) parts.extra = mark(JSON.stringify(Object.fromEntries(rest.map(k => [k, input[k]])), null, 2));
  } else {
    parts.body = mark(JSON.stringify(input, null, 2));
  }
  lines.push(...[parts.body, parts.extra].filter((v): v is string => v !== null));
  return { shown: lines.join('\n'), parts };
}

// A source goes into the mark and into the stored JSON, so quotes, backslashes and control characters are dropped from it
const cleanSources = (held: readonly HeldValue[]): HeldValue[] => held.map(h => ({ ...h, source: h.source.replace(/["\\\p{Cc}]/gu, '') }));

// The settled row keeps the card it had before it was raw (rest), with every value beat holds marked, also where the pattern redaction does not see a key (a reason, a check, the parked outbound)
function settled(row: PendingRow, state: PendingState | null, held: readonly HeldValue[]): { shown: string; masked: number; state: string | null; reason: string; checks: string } {
  const marker = heldMarker(cleanSources(held));
  const out = settledRaw(row, state);
  return { shown: marker.mark(out.shown), masked: out.masked, state: out.state === null ? null : marker.mark(out.state), reason: marker.mark(row.reason), checks: marker.mark(row.checks) };
}

function settledRaw(row: PendingRow, state: PendingState | null): { shown: string; masked: number; state: string | null } {
  if (!state?.rest) { if (state) delete state.rule; return { shown: row.shown, masked: row.masked, state: state === null ? null : JSON.stringify(state) }; }
  const { rest, ...others } = state;
  delete others.preview;
  delete others.held;
  delete others.rule;
  return { shown: rest.shown, masked: rest.masked, state: JSON.stringify({ ...others, parts: rest.parts, ...(rest.preview ? { preview: rest.preview } : {}) }) };
}

function effectOf(snapshot: Snapshot | undefined): PendingEffect | null {
  if (!snapshot) return null;
  let files = 0;
  let bytes = 0;
  let more = false;
  for (const fact of snapshot.paths) {
    if (fact.more || fact.unverifiable) more = true;
    if (!fact.exists) continue;
    files += fact.files ?? 1;
    bytes += fact.size ?? 0;
  }
  return { files, bytes, ...(more ? { more: true as const } : {}) };
}

export interface PendingStoreOptions {
  tools: { get(name: string): ToolDef | undefined; list?(): ToolDef[] };
  dataDir: string;
  now?: (() => number) | undefined;
  onChange?: ((change: PendingChange) => void) | undefined;
  held?: (() => readonly HeldValue[]) | undefined;
}

export class PendingStore {
  readonly #db: DatabaseSync;
  readonly #o: PendingStoreOptions;

  constructor(db: DatabaseSync, options: PendingStoreOptions) { this.#db = db; this.#o = options; }

  // Every value beat holds: the providers' keys, every registered tool's (each MCP server's env and header keys) and the tool's own, once each. A key of one server in another tool's call is marked too
  #allHeld(tool?: ToolDef): HeldValue[] {
    const of = (t: ToolDef): readonly HeldValue[] => { try { return t.held?.() ?? []; } catch { return []; } };
    const seen = new Map<string, HeldValue>();
    for (const h of [...(this.#o.held?.() ?? []), ...(this.#o.tools.list?.() ?? []).flatMap(of), ...(tool ? of(tool) : [])]) if (!seen.has(h.value)) seen.set(h.value, h);
    return [...seen.values()];
  }

  #held(tool: ToolDef): HeldValue[] { return this.#allHeld(tool); }

  // The values the card hides for this tool, for the rule lookup in the pipeline (same source as the card)
  heldFor(tool: ToolDef): HeldValue[] { return this.#held(tool); }

  #heldOf(name: string): HeldValue[] { return this.#allHeld(this.#o.tools.get(name)); }

  // The marker for the text a settled row keeps besides its card (the output tail, the stale reason): the same values and the same sources as `settled`
  #markerOf(name: string): Mark { return heldMarker(cleanSources(this.#heldOf(name))).mark; }

  // Settings lists a rule learned before its value became held with the value marked (the stored row keeps it)
  markHeld(text: string): string { return heldMarker(this.#allHeld()).mark(text); }

  // rememberable, checked again against the values held now (a key added after the row was parked): the approve route and the row view use this
  rememberableNow(row: PendingRow, state: PendingState = parseJson<PendingState>(row.state, {})): boolean {
    if (!rememberable(row, state)) return false;
    const tool = this.#o.tools.get(row.tool);
    const rule = storedCandidate(state.rule)!;
    return tool !== undefined && !carriesHeld([row.input, rule.base, rule.shown], this.#held(tool));
  }

  #now(): number { return this.#o.now?.() ?? Date.now(); }

  #changed(row: PendingRow): void {
    const change: PendingChange = { id: row.id, status: row.status, projectId: row.project_id, conversationId: row.conversation_id, taskId: row.task_id };
    try { this.#o.onChange?.(change); } catch { }
  }

  async park(input: ParkInput): Promise<PendingView> {
    const tool = this.#o.tools.get(input.tool);
    if (!tool) throw new PendingError('unknown_tool', { tool: input.tool });
    if (tool.replayable === false) throw new PendingError('not_replayable', { tool: input.tool });
    if (tool.preCheck && !input.check) throw new PendingError('check_required', { tool: input.tool });
    if (input.taskId) {
      const same = this.#db.prepare(`SELECT * FROM pending_actions WHERE task_id = ? AND status = 'waiting' AND tool = ? AND input = ? AND cwd = ? AND bind IS ? ORDER BY id LIMIT 1`)
        .get(input.taskId, input.tool, JSON.stringify(input.input), input.cwd, input.bind ?? input.check?.bind ?? null) as PendingRow | undefined;
      if (same) return this.#view(same);
    }
    const toolMask = (text: string): string => (tool.redact ? tool.redact(text) : text);
    const heldNow = this.#held(tool);
    const { title, shown, raw, parts } = render(tool, input.input, heldNow.map(h => h.value).filter(v => v.trim().length >= HELD_MIN));
    const restMasked = Math.max(0, marks(shown) - marks(raw));
    const marker = heldMarker(heldNow);
    const hide = heldMarker(heldNow).mark;
    const card = approvalCard(tool, input.input, title, marker.mark);
    const targets = (input.targets ?? []).map(t => resolve(input.cwd, t));
    const files = (input.files ?? []).map(f => resolve(input.cwd, f));
    const places = [...new Set((input.places ?? []).map(p => resolve(input.cwd, p)))];
    const created = (input.created ?? []).flatMap((path): CreatedMark[] => {
      const id = identityOf(path);
      if (!id) return [];
      const fact = boundFacts([path])[0]!;
      return [{ path, id, ...(fact.type === 'dir' ? { inside: fact.hash ?? '', ...(fact.more ? { more: true as const } : {}) } : {}) }];
    });
    const outward = (kind: string | undefined): boolean => kind === 'send' || kind === 'delete';
    const leaves = outward(input.kind) || outward(input.outbound?.kind);
    const pushes = input.pushes?.length ? input.pushes : leaves && inspectRepo(input.cwd).found ? [{ dir: input.cwd }] : [];
    const pushState = pushes.length ? await pushFacts(pushes, this.#o.dataDir) : undefined;
    const preview = input.preview ?? input.check?.preview;
    const bind = input.bind ?? input.check?.bind;
    const cardPreview = preview?.map(({ rest: _rest, ...p }) => ({ ...p, text: marker.mark(p.text, p.truncated) }));
    const masked = marker.sources.length;
    const state: PendingState = {
      title,
      parts: card.parts,
      ...(masked ? { held: [...new Set(marker.sources)].sort() } : {}),
      cwdReal: realCwd(input.cwd),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...(places.length ? { places } : {}),
      ...(created.length ? { created } : {}),
      ...(input.filesMore ? { filesMore: true as const } : {}),
      ...(pushState ? { pushes, pushed: pushState.fingerprint, ...(pushState.tips ? { tips: pushState.tips } : {}) } : {}),
      ...(input.check ? { recheck: recheckOf(input.check, toolMask) } : {}),
      ...(input.kind === 'delete' ? { snapshot: await takeSnapshot(input.cwd, targets, this.#o.dataDir) } : {}),
      ...(cardPreview?.length ? { preview: cardPreview } : {}),
      ...(input.outbound ? { outbound: parkedOutbound(input.outbound, toolMask) } : {}),
      ...(files.length ? { sent: boundFacts(files) } : {}),
      ...(input.rule && input.projectId && masked === 0 && !carriesHeld([input.rule.base, input.rule.shown, ...(input.check?.ruleShape?.words ?? [])], heldNow) ? { rule: input.rule } : {}),
      ...(input.kind === 'send' || pushes.length ? { destination: destinationFacts(input.cwd, places) } : {}),
      rest: { shown, masked: restMasked, parts, ...(preview?.length ? { preview: preview.map(({ rest: kept, chars: _chars, ...p }) => ({ ...p, ...(kept ?? {}), text: redactSecrets(toolMask(kept?.text ?? p.text), this.#held(tool).map(h => h.value)) })) } : {}) },
    };
    const result = this.#db.prepare(`INSERT INTO pending_actions (tool, input, shown, masked, cwd, kind, reason, checks, bind, state, files, run_id, run_kind, conversation_id, task_id, project_id, tainted, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(
      input.tool, JSON.stringify(input.input), card.shown, masked, input.cwd, input.kind, hide(redactSecrets(toolMask(input.reason))), JSON.stringify((input.checks ?? []).map(c => hide(redactSecrets(toolMask(c))))),
      bind ?? null, JSON.stringify(state), files.length ? JSON.stringify(files) : null,
      input.runId, input.runKind, input.conversationId, input.taskId ?? null, input.projectId ?? null, input.tainted ? 1 : 0, this.#now(),
    );
    const row = this.row(Number(result.lastInsertRowid))!;
    this.#changed(row);
    return this.#view(row);
  }

  row(id: number): PendingRow | undefined {
    return this.#db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as PendingRow | undefined;
  }

  view(id: number): PendingView | undefined {
    const row = this.row(id);
    return row ? this.#view(row) : undefined;
  }

  #view(row: PendingRow): PendingView {
    const state = parseJson<PendingState>(row.state, {});
    const card = row.status === 'waiting' && !state.rest ? this.#rebuilt(row, state) : undefined;
    const task = row.task_id ? this.#db.prepare('SELECT title FROM tasks WHERE id = ?').get(row.task_id) as { title: string } | undefined : undefined;
    const project = row.project_id ? this.#db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string } | undefined : undefined;
    return {
      id: row.id, tool: row.tool, title: state.title ?? null, shown: card?.shown ?? row.shown, parts: card?.parts ?? state.parts ?? { ...NO_PARTS }, masked: card?.masked ?? row.masked, held: card?.held ?? state.held ?? [], cwd: row.cwd, kind: row.kind, reason: row.reason, checks: parseJson<string[]>(row.checks, []),
      preview: state.preview ?? [], ...(row.status === 'waiting' && !state.rest && state.preview?.length ? { oldPreview: true as const } : {}), files: fileFacts(parseJson<string[]>(row.files, [])),
      effect: row.kind === 'delete' ? effectOf(state.snapshot) : null, fetched: state.fetched === true,
      run_kind: row.run_kind, conversation_id: row.conversation_id,
      task_id: row.task_id, task_title: task?.title ?? null, project_id: row.project_id, project_name: project?.name ?? null, tainted: row.tainted === 1,
      status: row.status, reject_reason: row.reject_reason, exit_code: row.exit_code, output_preview: row.output_preview,
      created_at: row.created_at, decided_at: row.decided_at, ran_at: row.ran_at,
      rule: this.rememberableNow(row, state) ? ruleView(storedCandidate(state.rule)!) : null,
    };
  }

  // 前の版で積んだ待ちの行（伏せた形で保存してあり state.rest が無い）は、生の入力から札を作り直す。保存した形は変えない
  #rebuilt(row: PendingRow, state: PendingState): { shown: string; parts: PendingParts; masked: number; held: string[] } | undefined {
    const tool = this.#o.tools.get(row.tool);
    if (!tool || row.input === '') return undefined;
    let input: unknown;
    try { input = JSON.parse(row.input); } catch { return undefined; }
    const marker = heldMarker(this.#held(tool));
    const card = approvalCard(tool, input, state.title ?? tool.name, marker.mark);
    return { ...card, masked: marker.sources.length, held: [...new Set(marker.sources)].sort() };
  }

  list(filter: PendingFilter): PendingView[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status === 'waiting') where.push("status IN ('waiting', 'running')");
    else {
      where.push("status NOT IN ('waiting', 'running')");
      if (filter.before !== undefined) {
        const cursor = this.#db.prepare("SELECT decided_at FROM pending_actions WHERE id = ? AND status NOT IN ('waiting', 'running') AND decided_at IS NOT NULL").get(filter.before) as { decided_at: number } | undefined;
        if (!cursor) return [];
        where.push('(decided_at < ? OR (decided_at = ? AND id < ?))');
        args.push(cursor.decided_at, cursor.decided_at, filter.before);
      } else if (filter.until !== undefined) { where.push('decided_at < ?'); args.push(filter.until); }
      else if (filter.since !== undefined) { where.push('decided_at >= ?'); args.push(filter.since); }
    }
    if (filter.project !== undefined) { where.push('project_id = ?'); args.push(filter.project); }
    if (filter.task !== undefined) { where.push('task_id = ?'); args.push(filter.task); }
    if (filter.conversation !== undefined) { where.push('conversation_id = ?'); args.push(filter.conversation); }
    const limit = Math.min(Math.max(1, filter.limit ?? LIST_MAX), LIST_MAX);
    const order = filter.status === 'waiting' ? 'id DESC' : 'decided_at DESC, id DESC';
    const rows = this.#db.prepare(`SELECT * FROM pending_actions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`).all(...args) as unknown as PendingRow[];
    return rows.map(row => this.#view(row));
  }

  waitingAround(conversationId: string | null, taskId: string | null): PendingRow[] {
    return this.#db.prepare(`SELECT * FROM pending_actions WHERE status = 'waiting' AND (task_id = ? OR conversation_id = ?
      OR conversation_id IN (SELECT c.id FROM conversations c JOIN engine_runs r ON c.parent_run_id = r.id WHERE r.conversation_id = ?)
      OR run_id IN (SELECT child.id FROM engine_runs child JOIN engine_runs r ON child.parent_run_id = r.id WHERE r.conversation_id = ?))`).all(taskId, conversationId, conversationId, conversationId) as unknown as PendingRow[];
  }

  counts(since: number): PendingCounts {
    const waiting = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'waiting'").get() as { n: number }).n);
    const byProject: Record<string, number> = {};
    for (const r of this.#db.prepare("SELECT project_id AS id, COUNT(*) AS n FROM pending_actions WHERE status = 'waiting' AND project_id IS NOT NULL GROUP BY project_id").all() as Array<{ id: string; n: number }>) byProject[r.id] = Number(r.n);
    const acceptanceChanges: Record<string, number> = {};
    for (const r of this.#db.prepare("SELECT project_id AS id, COUNT(*) AS n FROM acceptance_changes WHERE status = 'pending' GROUP BY project_id").all() as Array<{ id: string; n: number }>) acceptanceChanges[r.id] = Number(r.n);
    const allowed = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by IN ('auto-mode', 'judge-reuse') AND decision = 'allow' AND created_at >= ?").get(since) as { n: number }).n);
    const parked = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind IN ('judge', 'judge_failed') AND created_at >= ?").get(since) as { n: number }).n);
    return { waiting, byProject, acceptanceChanges, judgedToday: { allowed, parked } };
  }

  judged(since: number, project?: string | null): JudgedCounts {
    const callProject = "(SELECT pc.project_id FROM conversations pc WHERE pc.id = tool_calls.conversation_id)";
    const callWhere = project === undefined ? '' : project === null ? ` AND ${callProject} IS NULL` : ` AND ${callProject} = ?`;
    const parkWhere = project === undefined ? '' : project === null ? ' AND project_id IS NULL' : ' AND project_id = ?';
    const args = project ? [since, project] : [since];
    const allowed = Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by IN ('auto-mode', 'judge-reuse') AND decision = 'allow' AND created_at >= ?${callWhere}`).get(...args) as { n: number }).n);
    const notParked = Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'not-parked' AND created_at >= ?${callWhere}`).get(...args) as { n: number }).n);
    const parked: Record<string, number> = {};
    for (const r of this.#db.prepare(`SELECT kind, COUNT(*) AS n FROM pending_actions WHERE created_at >= ?${parkWhere} GROUP BY kind`).all(...args) as Array<{ kind: string; n: number }>) parked[r.kind] = Number(r.n);
    const ruled: Record<string, number> = {};
    for (const r of this.#db.prepare(`SELECT COALESCE((SELECT ar.kind FROM approval_rules ar WHERE 'rule:' || ar.id = tool_calls.approval_id), 'removed') AS kind, COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-rule' AND decision = 'allow' AND created_at >= ?${callWhere} GROUP BY 1`).all(...args) as Array<{ kind: string; n: number }>) ruled[r.kind] = Number(r.n);
    return { allowed, parked, notParked, ruled };
  }

  #require(id: number): PendingRow {
    const row = this.row(id);
    if (!row) throw new PendingError('not_found', { id });
    return row;
  }

  claim(id: number): PendingRow {
    const before = this.#require(id);
    const now = this.#now();
    const taken = this.#db.prepare("UPDATE pending_actions SET status = 'running', decided_at = ? WHERE id = ? AND status = 'waiting'").run(now, id);
    if (Number(taken.changes) !== 1) throw new PendingError('not_waiting', { id, status: this.row(id)?.status ?? before.status });
    const row = this.row(id)!;
    this.#changed(row);
    return row;
  }

  finish(id: number, result: FinishInput): PendingView | undefined {
    const now = this.#now();
    const current = this.row(id);
    if (!current || current.status !== 'running') return current ? this.#view(current) : undefined;
    const erased = current.input === '';
    const state = parseJson<PendingState | null>(current.state, null);
    const nextState = state && result.fetched !== undefined ? { ...state, fetched: result.fetched } : state;
    const rest = settled(current, nextState, this.#heldOf(current.tool));
    const changed = this.#db.prepare(`UPDATE pending_actions SET status = ?, exit_code = ?, output_preview = ?, full_ref = ?, reject_reason = COALESCE(?, reject_reason), ran_at = ?, decided_at = COALESCE(decided_at, ?), input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ?
      WHERE id = ? AND status = 'running'`).run(
      result.status, result.exitCode ?? null, erased || result.output === undefined ? null : outputTail(result.output, this.#markerOf(current.tool)), erased ? null : result.fullRef ?? null,
      result.reason === undefined ? null : cleanReason(result.reason, this.#markerOf(current.tool)),
      result.status === 'ran' || result.status === 'failed' ? now : null, now, rest.shown, rest.masked, rest.state, rest.reason, rest.checks, id,
    );
    if (Number(changed.changes) !== 1) return this.view(id);
    const row = this.row(id)!;
    this.#changed(row);
    return this.#view(row);
  }

  reject(id: number, reason?: string): PendingView {
    const before = this.#require(id);
    const rest = settled(before, parseJson<PendingState | null>(before.state, null), this.#heldOf(before.tool));
    const changed = this.#db.prepare(`UPDATE pending_actions SET status = 'rejected', reject_reason = ?, decided_at = ?, input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ? WHERE id = ? AND status = 'waiting'`)
      .run(cleanReason(reason), this.#now(), rest.shown, rest.masked, rest.state, rest.reason, rest.checks, id);
    if (Number(changed.changes) !== 1) throw new PendingError('not_waiting', { id, status: this.row(id)?.status ?? before.status });
    const row = this.row(id)!;
    this.#changed(row);
    return this.#view(row);
  }

  cancelConversations(ids: readonly string[]): number {
    let count = 0;
    for (const id of ids) {
      const rows = this.#db.prepare("SELECT * FROM pending_actions WHERE conversation_id = ? AND status = 'waiting'").all(id) as unknown as PendingRow[];
      for (const row of rows) {
        const rest = settled(row, parseJson<PendingState | null>(row.state, null), this.#heldOf(row.tool));
        const changed = this.#db.prepare(`UPDATE pending_actions SET status = 'cancelled', decided_at = ?, input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ? WHERE id = ? AND status = 'waiting'`)
          .run(this.#now(), rest.shown, rest.masked, rest.state, rest.reason, rest.checks, row.id);
        if (Number(changed.changes) === 1) { count += 1; this.#changed(this.row(row.id)!); }
      }
    }
    return count;
  }

  withdraw(id: number, reason: string): boolean {
    const row = this.row(id);
    if (!row || row.status !== 'waiting') return false;
    const rest = settled(row, parseJson<PendingState | null>(row.state, null), this.#heldOf(row.tool));
    const changed = this.#db.prepare(`UPDATE pending_actions SET status = 'cancelled', reject_reason = ?, decided_at = ?, input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ? WHERE id = ? AND status = 'waiting'`)
      .run(cleanReason(reason), this.#now(), rest.shown, rest.masked, rest.state, rest.reason, rest.checks, id);
    if (Number(changed.changes) !== 1) return false;
    this.#changed(this.row(id)!);
    return true;
  }

  closeStale(id: number, reason: string): boolean {
    const row = this.row(id);
    if (!row || row.status !== 'waiting') return false;
    const rest = settled(row, parseJson<PendingState | null>(row.state, null), this.#heldOf(row.tool));
    const mark = this.#markerOf(row.tool);
    const changed = this.#db.prepare(`UPDATE pending_actions SET status = 'stale', output_preview = ?, reject_reason = ?, decided_at = ?, input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ? WHERE id = ? AND status = 'waiting'`)
      .run(outputTail(reason, mark), cleanReason(reason, mark) ?? 'stale', this.#now(), rest.shown, rest.masked, rest.state, rest.reason, rest.checks, id);
    if (Number(changed.changes) !== 1) return false;
    this.#changed(this.row(id)!);
    return true;
  }

  withdrawTask(taskId: string, reason: string): number {
    const rows = this.#db.prepare("SELECT id FROM pending_actions WHERE task_id = ? AND status = 'waiting' ORDER BY id").all(taskId) as Array<{ id: number }>;
    return rows.filter(row => this.withdraw(Number(row.id), reason)).length;
  }

  cancelProject(projectId: string, reason: string): number {
    const rows = this.#db.prepare("SELECT id FROM pending_actions WHERE project_id = ? AND status = 'waiting' ORDER BY id").all(projectId) as Array<{ id: number }>;
    return rows.filter(row => this.withdraw(Number(row.id), reason)).length;
  }

  closeInterrupted(): number {
    let closed = 0;
    for (const row of this.#db.prepare("SELECT * FROM pending_actions WHERE status = 'running'").all() as unknown as PendingRow[]) {
      const rest = settled(row, parseJson<PendingState | null>(row.state, null), this.#heldOf(row.tool));
      const result = this.#db.prepare(`UPDATE pending_actions SET status = 'failed', output_preview = CASE WHEN input = '' THEN NULL ELSE ? END, ran_at = ?, input = '', shown = ?, masked = ?, state = ?, reason = ?, checks = ? WHERE id = ? AND status = 'running'`)
        .run(pendingText('en', 'interrupted'), this.#now(), rest.shown, rest.masked, rest.state, rest.reason, rest.checks, row.id);
      closed += Number(result.changes);
    }
    return closed;
  }
}
