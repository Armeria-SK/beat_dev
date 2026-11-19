import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { gateText, type GateMessageKey } from '../shared/messages/gate.ts';
import { plainBlock, plainLine } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { OWNER_FIX, type Task, type TaskStore } from '../tasks/store.ts';
import type { ToolContext, ToolRunResult } from '../tools/types.ts';
import { ACCEPTANCE_FILE, AcceptanceError, docOf, frozenHash, ITEM_ID, itemStatesOf, type AcceptanceDoc, type AcceptanceItem, type AcceptanceStore, type ItemMark, type ItemStates } from './acceptance.ts';
import { unbuilt } from './build.ts';
import { projectDir } from './store.ts';

export const GATE_LIMIT = 3;
const TAG = /^E-([1-9]\d{0,8})$/u;
const USABLE_TAGS = 20;
const TAIL_CHARS = 500;
const SHOWN_INPUT = 60;
const COPY_INPUT = 300;
const AGREEMENT_ITEMS = 40;
const AGREEMENT_NOT_DOING = 20;
const AGREEMENT_CHARS = 6000;

export class GateError extends LocalizedError<GateMessageKey> {
  constructor(code: GateMessageKey, params?: MessageParams) { super(gateText, code, params); }
}

export interface GateItemInput { id: string; evidence?: string | undefined; not_done?: string | undefined }

export type GateOutcome =
  | { kind: 'skip' }
  | { kind: 'pass'; text: string }
  | { kind: 'refuse'; text: string }
  | { kind: 'failed'; text: string; reason: string };

export interface LiveList { version: number; hash: string; doc: AcceptanceDoc; states: ItemStates; items: AcceptanceItem[] }

const clip = (text: string, max: number): string => plainLine(redactSecrets(plainLine(text, Infinity)), max);

export function ownedItems(task: Pick<Task, 'acceptance_items'>): string[] {
  if (task.acceptance_items === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(task.acceptance_items); } catch { return []; }
  return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && ITEM_ID.test(id)))] : [];
}

export function liveList(db: DatabaseSync, projectId: string | null): LiveList | undefined {
  if (!projectId) return undefined;
  const row = db.prepare('SELECT version, hash, content, item_states FROM acceptance_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as { version: number; hash: string; content: string; item_states: string | null } | undefined;
  const doc = row && docOf(row.content);
  if (!row || !doc) return undefined;
  const items = doc.items.filter(entry => entry !== null && typeof entry === 'object' && entry.removedIn === null && typeof entry.id === 'string' && ITEM_ID.test(entry.id));
  return { version: row.version, hash: row.hash, doc, states: itemStatesOf(row.item_states), items };
}

const stateOf = (list: LiveList, id: string): 'open' | 'met' | 'unverified' => (Object.hasOwn(list.states, id) ? list.states[id]!.state : 'open');

export function itemSummary(db: DatabaseSync, task: Task): { owned: number; met: number; remaining: string[] } | undefined {
  const owned = ownedItems(task);
  if (!owned.length) return undefined;
  const list = liveList(db, task.project_id);
  if (!list) return { owned: owned.length, met: 0, remaining: owned };
  const changed = list.items.some(entry => entry.changedIn !== null && owned.includes(entry.id));
  const since = changed ? new Map((db.prepare('SELECT version, created_at FROM acceptance_versions WHERE project_id = ?').all(task.project_id) as Array<{ version: number; created_at: number }>).map(row => [row.version, row.created_at])) : new Map<number, number>();
  const handedOver = (entry: AcceptanceItem): boolean => entry.changedIn !== null && (since.get(entry.changedIn) ?? 0) > task.created_at && list.states[entry.id]?.taskId !== task.id;
  const live = owned.filter(id => list.items.some(entry => entry.id === id && !handedOver(entry)));
  const remaining = live.filter(id => stateOf(list, id) !== 'met');
  return { owned: live.length, met: live.length - remaining.length, remaining };
}

export function settleAwaiting(db: DatabaseSync, tasks: TaskStore, projectId: string | null): void {
  if (!projectId) return;
  for (const task of tasks.awaitingIn(projectId)) {
    if ((itemSummary(db, task)?.remaining.length ?? 0) === 0) tasks.setCheckState(task.id, 'checked');
  }
}

export function workAgreement(db: DatabaseSync, task: Task, language: Language): string | undefined {
  const owned = ownedItems(task);
  const list = liveList(db, task.project_id);
  if (!owned.length || !list) return undefined;
  const tainted = (list.doc.taintedRuns?.length ?? 0) > 0;
  const kindOf = (entry: AcceptanceItem): string => (entry.check?.kind === 'command' ? 'command' : entry.check?.kind === 'look' ? 'look' : 'read');
  const wanted: string[] = [];
  const notDoing: string[] = [];
  for (const id of owned) {
    const entry = list.items.find(item => item.id === id);
    if (!entry) continue;
    const result = clip(String(entry.result ?? ''), 300);
    if (tainted) wanted.push(gateText(language, stateOf(list, id) === 'met' ? 'agreement_bare_met' : 'agreement_bare', { id, kind: kindOf(entry) }));
    else if (stateOf(list, id) === 'met') wanted.push(gateText(language, 'agreement_met', { id, result }));
    else if (entry.check?.kind === 'command') wanted.push(gateText(language, 'agreement_command', { id, result, command: clip(entry.check.command, 200) }));
    else wanted.push(gateText(language, 'agreement_other', { id, result, kind: kindOf(entry) }));
  }
  if (!tainted) {
    for (const entry of list.doc.notDoing) {
      if (entry && typeof entry.text === 'string') notDoing.push(gateText(language, 'agreement_not_doing', { text: clip(entry.text, 200) }));
    }
  }
  const picked = [...wanted.slice(0, AGREEMENT_ITEMS), ...notDoing.slice(0, AGREEMENT_NOT_DOING)];
  const lines = [gateText(language, 'agreement_head'), ...(tainted ? [gateText(language, 'agreement_tainted')] : [])];
  let size = 0;
  let shown = 0;
  for (const line of picked) {
    if (size + line.length > AGREEMENT_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    shown += 1;
  }
  const left = wanted.length + notDoing.length - shown;
  if (left > 0) lines.push(gateText(language, 'agreement_more', { count: left }));
  lines.push(gateText(language, 'agreement_rules'));
  return lines.join('\n');
}

function listIntegrity(acceptance: AcceptanceStore, projectsDir: string, projectId: string, version: number): boolean {
  if (acceptance.verifyFrozen(projectId) === 'ok') return true;
  let file: AcceptanceDoc | undefined;
  try {
    const path = join(projectDir(projectsDir, projectId), ACCEPTANCE_FILE);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
    file = docOf(readFileSync(path, 'utf8'));
    if (!file || file.version >= version || acceptance.version(projectId, file.version)?.hash !== frozenHash(file)) return false;
  } catch { return false; }
  acceptance.repair(projectId);
  return acceptance.verifyFrozen(projectId) === 'ok';
}

interface TagRow { tool: string; input: string; ok: number | null; decision: string; created_at: number }

function lookupTag(db: DatabaseSync, conversationId: string, tag: string, since: number): { copy: Record<string, unknown> } | { why: GateMessageKey } {
  const match = TAG.exec(tag);
  if (!match) return { why: 'tag_format' };
  const row = db.prepare("SELECT tool, input, ok, decision, created_at FROM tool_calls WHERE conversation_id = ? AND evidence_no = ? AND tool NOT LIKE 'task\\_%' ESCAPE '\\' AND tool != 'tool_search'").get(conversationId, Number(match[1])) as TagRow | undefined;
  if (!row) return { why: 'tag_unknown' };
  if (row.ok !== 1) return { why: 'tag_failed' };
  if (row.decision !== 'allow') return { why: 'tag_not_run' };
  if (row.created_at < since) return { why: 'tag_old' };
  return { copy: { tag, tool: row.tool, input: clip(row.input, COPY_INPUT), ok: true, at: row.created_at } };
}

function usableTags(db: DatabaseSync, conversationId: string, language: Language): string {
  const rows = db.prepare("SELECT evidence_no, tool, input FROM tool_calls WHERE conversation_id = ? AND evidence_no IS NOT NULL AND ok = 1 AND decision = 'allow' AND tool NOT LIKE 'task\\_%' ESCAPE '\\' AND tool != 'tool_search' ORDER BY evidence_no DESC LIMIT ?")
    .all(conversationId, USABLE_TAGS) as Array<{ evidence_no: number; tool: string; input: string }>;
  if (!rows.length) return gateText(language, 'tags_none');
  return [gateText(language, 'tags_head'), ...rows.map(row => gateText(language, 'tag_line', { tag: `E-${row.evidence_no}`, tool: row.tool, input: clip(row.input, SHOWN_INPUT) }))].join('\n');
}

function unowned(acceptance: AcceptanceStore, tasks: TaskStore, projectId: string, list: LiveList, owned: readonly string[]): string[] {
  const doc: AcceptanceDoc = { ...list.doc, items: list.doc.items.map(entry => ({ ...entry, state: stateOf(list, entry.id) })) };
  return unbuilt({ acceptance, tasks }, projectId, doc).filter(id => owned.includes(id));
}

function changedAt(acceptance: AcceptanceStore, projectId: string): (entry: AcceptanceItem) => number {
  const since = new Map(acceptance.versions(projectId).map(row => [row.version, row.created_at]));
  const first = Math.min(...since.keys());
  return entry => since.get(entry.changedIn ?? first) ?? 0;
}

const outcomeOf = (run: ToolRunResult): 'met' | 'held' | 'failed' =>
  run.decision === 'allow' && !run.output.isError ? 'met' : run.decidedBy === 'pending' || run.gate?.by === 'pending' ? 'held' : 'failed';

const tailOf = (text: string): string => {
  const clean = plainBlock(redactSecrets(plainBlock(text.replace(/\n\[E-\d+\]$/u, ''), Infinity)), Infinity).trimEnd();
  return clean.length > TAIL_CHARS ? `…${clean.slice(-TAIL_CHARS)}` : clean;
};

export async function runGate(ctx: ToolContext, task: Task, input: readonly GateItemInput[] | undefined, language: Language): Promise<GateOutcome> {
  const acceptance = ctx.services?.acceptance;
  const tasks = ctx.services?.tasks;
  const db = ctx.services?.db;
  const projectId = task.project_id;
  const owned = ownedItems(task);
  if (!acceptance || !tasks || !db || !projectId || !owned.length) return { kind: 'skip' };
  const list = liveList(db, projectId);
  if (!list) return { kind: 'skip' };
  const t = (key: GateMessageKey, params?: MessageParams) => gateText(language, key, params);
  const streak = tasks.gateStreak(task.id);
  const conversationId = task.conversation_id ?? ctx.conversationId;

  const mine = list.items.filter(entry => owned.includes(entry.id));
  const family = new Set(tasks.family(task.id));
  const ran = new Set<string>();
  const settled = (id: string): boolean => {
    const state = list.states[id];
    if (!state) return false;
    if (state.state === 'met') return true;
    if (!family.has(state.taskId)) return false;
    return state.state === 'unverified' || state.evidence.some(entry => entry !== null && typeof entry === 'object' && 'notDone' in entry);
  };

  const refuse = (problems: string[], marks: ItemMark[], free: readonly string[]): GateOutcome => {
    const attempt = streak.refused + 1;
    if (attempt >= GATE_LIMIT) {
      const left = mine.filter(entry => !settled(entry.id) && !marks.some(mark => mark.id === entry.id));
      const closing: ItemMark[] = [...marks, ...left.map(entry => ({ id: entry.id, state: 'unverified' as const, evidence: [{ closed: t('closed_note', { limit: GATE_LIMIT }), at: Date.now() }] }))];
      if (closing.length) acceptance.markItems(projectId, { version: list.version, taskId: task.id, items: closing });
      tasks.event(task.id, 'gate_closed', 'beat', t('refused_event', { detail: problems.join(' ').slice(0, 500) }), ctx.runId);
      settleAwaiting(db, tasks, projectId);
      return { kind: 'pass', text: [t('closed', { limit: GATE_LIMIT, ids: left.map(entry => entry.id).join(', ') || '-' }), ...(free.length ? [t('unowned_left', { ids: free.join(', ') })] : [])].join('\n') };
    }
    if (marks.length) acceptance.markItems(projectId, { version: list.version, taskId: task.id, items: marks });
    tasks.event(task.id, 'gate_refused', 'beat', t('refused_event', { detail: problems.join(' ').slice(0, 500) }), ctx.runId);
    return { kind: 'refuse', text: [t('refused', { attempt, limit: GATE_LIMIT }), ...problems, usableTags(db, conversationId, language)].join('\n') };
  };

  if (!listIntegrity(acceptance, ctx.paths.projects, projectId, list.version)) {
    tasks.event(task.id, 'gate_list_changed', 'beat', t('list_changed_event', { version: list.version }), ctx.runId);
    ctx.log(`[WARN] acceptance.json of product ${projectId} did not match the fixed version ${list.version} at task_complete of task ${task.id}`);
    if (!db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'gate_list_notified' LIMIT 1").get(task.id)) {
      try {
        ctx.services?.notify?.({ kind: 'health_alert', title: t('list_changed_title'), body: t('list_changed_body', { title: clip(task.title, 200), version: list.version }), link: `#/tasks/${task.id}`, dedupKey: `gate-list:${task.id}` });
        tasks.event(task.id, 'gate_list_notified', 'beat', null, ctx.runId);
      } catch (error) {
        ctx.log(`[WARN] could not tell the owner that acceptance.json of product ${projectId} changed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { kind: 'refuse', text: t('list_changed', { version: list.version }) };
  }

  const tainted = (list.doc.taintedRuns?.length ?? 0) > 0;
  const marks: ItemMark[] = [];
  const save = (items: ItemMark[]): boolean => {
    if (!items.length) return true;
    try { acceptance.markItems(projectId, { version: list.version, taskId: task.id, items }); return true; } catch (error) {
      if (error instanceof AcceptanceError && error.code === 'stale') return false;
      throw error;
    }
  };
  const failures: string[] = [];
  const failedIds: string[] = [];
  const lines: string[] = [];
  for (const entry of mine) {
    if (entry.check?.kind !== 'command') continue;
    const state = stateOf(list, entry.id);
    if (state === 'met' || state === 'unverified' && settled(entry.id)) continue;
    const command = entry.check.command;
    const shown = clip(command, COPY_INPUT);
    const run: ToolRunResult = ctx.runTool ? await ctx.runTool('shell_run', { command }) : { output: { content: 'shell_run is not available', isError: true }, decision: 'deny', decidedBy: 'run_tool' };
    if (ctx.signal.aborted || ctx.stopSignal?.aborted) {
      save(marks);
      return { kind: 'refuse', text: t('stopped') };
    }
    ran.add(entry.id);
    const result = outcomeOf(run);
    const at = Date.now();
    if (result === 'met') {
      marks.push({ id: entry.id, state: 'met', evidence: [{ tool: 'shell_run', command: shown, ok: true, at }] });
      lines.push(t('state_met', { id: entry.id }));
    } else if (result === 'held') {
      marks.push({ id: entry.id, state: 'unverified', evidence: [{ tool: 'shell_run', command: shown, held: 'pending', ...(run.gate?.by === 'pending' ? { pending: run.gate.id } : {}), at }] });
      lines.push(t('state_held', { id: entry.id }));
    } else {
      const tail = tailOf(tainted && command ? run.output.content.split(command).join(t('command_hidden')) : run.output.content);
      marks.push({ id: entry.id, state: 'open', evidence: [{ tool: 'shell_run', command: shown, ok: false, output: tail, at }] });
      failedIds.push(entry.id);
      failures.push(t('command_failed', { id: entry.id, outcome: run.decision === 'allow' ? 'it exited with an error' : `${run.decision} by ${run.decidedBy}`, command: tainted ? t('command_hidden') : shown }), ...(tail ? [t('command_output', { tail })] : []));
    }
  }

  const since = changedAt(acceptance, projectId);
  const given = new Map<string, GateItemInput>();
  for (const entry of input ?? []) if (entry && typeof entry.id === 'string' && !given.has(entry.id)) given.set(entry.id, entry);
  const missing: string[] = [];
  const badTags: string[] = [];
  for (const entry of mine) {
    if (entry.check?.kind === 'command') {
      if (ran.has(entry.id)) continue;
      if (stateOf(list, entry.id) === 'met') lines.push(t('state_met_before', { id: entry.id }));
      else if (stateOf(list, entry.id) === 'unverified') lines.push(t('state_unverified', { id: entry.id }));
      continue;
    }
    const wanted = given.get(entry.id);
    if (stateOf(list, entry.id) === 'met') { lines.push(t('state_met_before', { id: entry.id })); continue; }
    if (wanted?.evidence !== undefined) {
      const found = lookupTag(db, conversationId, wanted.evidence.trim(), since(entry));
      if ('copy' in found) {
        marks.push({ id: entry.id, state: 'unverified', evidence: [found.copy] });
        lines.push(t('state_unverified', { id: entry.id }));
        continue;
      }
      badTags.push(t('bad_tag', { id: entry.id, tag: clip(wanted.evidence, 20), why: t(found.why) }));
      missing.push(entry.id);
      continue;
    }
    if (typeof wanted?.not_done === 'string' && wanted.not_done.trim()) {
      const reason = clip(wanted.not_done, TAIL_CHARS);
      marks.push({ id: entry.id, state: 'open', evidence: [{ notDone: reason, at: Date.now() }] });
      lines.push(t('state_open', { id: entry.id, reason }));
      continue;
    }
    if (settled(entry.id)) { lines.push(stateOf(list, entry.id) === 'unverified' ? t('state_unverified', { id: entry.id }) : t('state_open', { id: entry.id, reason: '-' })); continue; }
    missing.push(entry.id);
  }

  if (failedIds.length) {
    if (!save(marks)) return { kind: 'refuse', text: t('list_moved') };
    const attempt = streak.itemFailed + 1;
    tasks.event(task.id, 'item_check_failed', 'beat', [t('item_failed_event', { attempt, limit: GATE_LIMIT, ids: failedIds.join(', ') }), ...failures].join('\n').slice(0, 1500), ctx.runId);
    settleAwaiting(db, tasks, projectId);
    if (attempt >= GATE_LIMIT) return { kind: 'failed', text: [t('gave_up', { limit: GATE_LIMIT }), ...failures].join('\n'), reason: t('gave_up_reason', { ids: failedIds.join(', '), limit: GATE_LIMIT }) };
    return { kind: 'refuse', text: [t('command_streak', { attempt, limit: GATE_LIMIT }), ...failures, ...(missing.length ? [t('missing', { ids: missing.join(', '), first: missing[0]! }), ...badTags] : [])].join('\n') };
  }

  const problems: string[] = [];
  if (missing.length) problems.push(t('missing', { ids: missing.join(', '), first: missing[0]! }), ...badTags);
  const free = task.spawned_by === null ? unowned(acceptance, tasks, projectId, list, owned).filter(id => !marks.some(mark => mark.id === id && mark.state !== 'open')) : [];
  if (free.length) problems.push(t('unowned', { ids: free.join(', ') }));
  if (problems.length) {
    try { return refuse(problems, marks, free); } catch (error) {
      if (error instanceof AcceptanceError && error.code === 'stale') return { kind: 'refuse', text: t('list_moved') };
      throw error;
    }
  }
  if (!save(marks)) return { kind: 'refuse', text: t('list_moved') };
  tasks.event(task.id, 'gate_passed', 'beat', null, ctx.runId);
  settleAwaiting(db, tasks, projectId);
  return { kind: 'pass', text: [t('summary_head'), ...lines].join('\n') };
}

export interface OwnerCheckDeps { db: DatabaseSync; tasks: TaskStore; acceptance: AcceptanceStore; language: Language }
export type OwnerResult = 'checked' | 'insufficient';

export function ownerDecide(d: OwnerCheckDeps, task: Task, itemIds: readonly string[] | 'all', decision: { result: OwnerResult; note?: string | undefined; version: number }): { checked: string[]; fix?: Task } {
  if (task.status !== 'done' || task.check_state !== 'awaiting' || !task.project_id) throw new GateError('not_awaiting');
  const projectId = task.project_id;
  const remaining = itemSummary(d.db, task)?.remaining ?? [];
  const ids = itemIds === 'all' ? remaining : [...itemIds];
  const stray = ids.find(id => !remaining.includes(id));
  if (stray !== undefined) throw new GateError('not_remaining', { id: stray.slice(0, 20) });
  const note = decision.note === undefined ? '' : clip(decision.note, 1000);
  const record = (id: string, fix?: string) => d.tasks.event(task.id, 'owner_check', 'user', JSON.stringify({ item: id, result: decision.result, ...(note ? { note } : {}), ...(fix ? { fix } : {}) }));
  if (decision.result === 'checked') {
    for (const id of ids) {
      d.acceptance.ownerCheck(projectId, { taskId: task.id, itemId: id, version: decision.version });
      record(id);
    }
    settleAwaiting(d.db, d.tasks, projectId);
    return { checked: ids };
  }
  const list = liveList(d.db, projectId);
  if (!list || list.version !== decision.version) throw new AcceptanceError('stale', { version: list?.version ?? 0 });
  const id = ids[0]!;
  const entry = list.items.find(item => item.id === id)!;
  const open = (d.db.prepare("SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.acceptance_items = ? AND t.status IN ('ready', 'running', 'waiting') AND EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind = ?) ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1").get(projectId, JSON.stringify([id]), OWNER_FIX) as { id: string } | undefined);
  const existing = open ? d.tasks.get(open.id) : undefined;
  if (existing) {
    const updated = note ? d.tasks.update(existing.id, { appendNote: gateText(d.language, 'fix_note', { note }) }, 'user') : existing;
    record(id, existing.id);
    return { checked: [], fix: updated };
  }
  const untrusted = (list.doc.taintedRuns?.length ?? 0) > 0;
  const result = clip(String(entry.result ?? ''), 300);
  const fix = d.tasks.create({
    title: gateText(d.language, 'fix_title', { id, result: clip(result, 150) }).slice(0, 200),
    body: [gateText(d.language, 'fix_body', { id, result }), ...(note ? [gateText(d.language, 'fix_note', { note })] : [])].join('\n'),
    // 題に受け入れの結果（AI が書いた文）が入るので、持ち主の書いた文には数えない（9-1b の D-7）
    origin: 'user', actor: 'user', projectId, acceptanceItems: [id], ownerRequest: !untrusted, ownerAiText: true,
  });
  d.tasks.event(fix.id, OWNER_FIX, 'user', JSON.stringify({ task: task.id, item: id }));
  if (untrusted) d.tasks.markUntrusted(fix.id, 'build', gateText(d.language, 'fix_untrusted'));
  record(id, fix.id);
  return { checked: [], fix };
}
