import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MISS_RATIO, missReason, openReadOnly, type MissReason } from '../token-report.ts';

// ブラウザの確かめの物差し（plans/beat/steps/browser-rethink/PLAN.md の P0）。物差しの会話 1 つの数を DB とアプリの記録から集める。DB は読むだけ。
// 本体 = 会話がこの会話そのものの実行。子の担当（parent_run_id でたどれる実行）は本体に足さず、children に別に出す。

const USAGE = 'usage: node scripts/browser-bench/collect.ts --db <beat.db> --conversation <id> [--events <events.jsonl>]';
export const PRELOAD = (name: string): boolean => name.startsWith('browser_') || ['pending_withdraw', 'deviation_add', 'image_view'].includes(name);

export const ITEMS = ['submit', 'list', 'plus10', 'date_button', 'mark_ordered', 'logout'] as const;
export type Item = typeof ITEMS[number];

interface CallRow { run_id: string; seq: number; purpose: string; model: string; input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; output_tokens: number | null; removed: number; tools_hash: string; frozen_hash: string; dynamic_hash: string; started_at: number }
export interface Volume { calls: number; input: number; read: number; write: number; fresh: number; output: number }

const emptyVolume = (): Volume => ({ calls: 0, input: 0, read: 0, write: 0, fresh: 0, output: 0 });
function add(v: Volume, c: CallRow): void {
  const input = c.input_tokens ?? 0;
  const read = c.cache_read_tokens ?? 0;
  const write = c.cache_write_tokens ?? 0;
  v.calls++; v.input += input; v.read += read; v.write += write; v.fresh += Math.max(0, input - read - write); v.output += c.output_tokens ?? 0;
}

// アプリの記録で、受け入れ 6 項目の操作が実際に起きたか。数えるのはブラウザから来た頼み（src = browser）だけ
export function appRecord(lines: readonly string[]): Record<Item, boolean> & { adminLoginFailed: number; notBrowser: number; parseErrors: number } {
  let parseErrors = 0;
  const all = lines.filter(line => line.trim()).flatMap(line => {
    try { return [JSON.parse(line) as { kind: string; src?: string; added?: number[]; ok?: boolean }]; } catch { parseErrors++; return []; }
  });
  const events = all.filter(e => e.src === 'browser');
  return {
    submit: events.some(e => e.kind === 'submit'),
    list: events.some(e => e.kind === 'list_view' && (e.added ?? []).length > 0),
    plus10: events.some(e => e.kind === 'plus10'),
    date_button: events.some(e => e.kind === 'date_button'),
    mark_ordered: events.some(e => e.kind === 'mark_ordered'),
    logout: events.some(e => e.kind === 'logout'),
    adminLoginFailed: events.filter(e => e.kind === 'admin_login' && e.ok === false).length,
    notBrowser: all.filter(e => e.kind !== 'start' && e.src !== 'browser').length,
    parseErrors,
  };
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export function collectFrom(db: DatabaseSync, conversationId: string, eventLines: readonly string[] = []) {
  let parseErrors = 0;
  const parse = <T>(text: string): T | undefined => { try { return JSON.parse(text) as T; } catch { parseErrors++; return undefined; } };

  const mainRuns = (db.prepare('SELECT id, kind FROM engine_runs WHERE conversation_id = ? ORDER BY started_at, rowid').all(conversationId) as Array<{ id: string; kind: string }>);
  const mainIds = mainRuns.map(r => r.id);
  const childIds: string[] = [];
  for (let frontier = mainIds; frontier.length;) {
    const next = (db.prepare(`SELECT id FROM engine_runs WHERE parent_run_id IN (${placeholders(frontier.length)})`).all(...frontier) as Array<{ id: string }>).map(r => r.id);
    childIds.push(...next);
    frontier = next;
  }
  const callsOf = (ids: readonly string[]): CallRow[] => ids.length ? db.prepare(`
    SELECT run_id, seq, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, removed, tools_hash, frozen_hash, dynamic_hash, started_at
    FROM model_calls WHERE run_id IN (${placeholders(ids.length)}) ORDER BY started_at, run_id, seq`).all(...ids) as unknown as CallRow[] : [];

  const mainCalls = callsOf(mainIds);
  const body = mainCalls.filter(c => c.purpose !== 'compact');
  const volume = emptyVolume();
  const compactVolume = emptyVolume();
  for (const c of mainCalls) add(c.purpose === 'compact' ? compactVolume : volume, c);
  const misses: Partial<Record<MissReason, { count: number; lostTokens: number }>> = {};
  body.forEach((row, i) => {
    const prev = body[i - 1];
    if (!prev || row.cache_read_tokens === null) return;
    const expected = prev.cache_write_tokens !== null ? (prev.cache_read_tokens ?? 0) + prev.cache_write_tokens : prev.input_tokens ?? 0;
    if (expected <= 0 || row.cache_read_tokens >= expected * MISS_RATIO) return;
    const reason = missReason(prev, row);
    const m = misses[reason] ?? { count: 0, lostTokens: 0 };
    m.count++; m.lostTokens += expected - row.cache_read_tokens;
    misses[reason] = m;
  });
  const childVolume = emptyVolume();
  for (const c of callsOf(childIds)) if (c.purpose !== 'compact') add(childVolume, c);

  const toolRows = (ids: readonly string[]) => ids.length
    ? db.prepare(`SELECT tool, decision, decided_by FROM tool_calls WHERE run_id IN (${placeholders(ids.length)}) ORDER BY created_at, rowid`).all(...ids) as Array<{ tool: string; decision: string; decided_by: string }>
    : [];
  const tools = toolRows(mainIds);
  const childBrowser = toolRows(childIds).filter(t => t.tool.startsWith('browser_')).length;
  const byTool: Record<string, number> = {};
  for (const t of tools) byTool[t.tool] = (byTool[t.tool] ?? 0) + 1;
  const browser = tools.filter(t => t.tool.startsWith('browser_'));

  // 道具の入力と tool_search の結果は、DB の会話の発言（切っていない形）から読む。tool_calls.input は見せる用に切ってあるので使わない
  const messages = (mainIds.length ? db.prepare(`SELECT role, parts FROM messages WHERE run_id IN (${placeholders(mainIds.length)}) AND role IN ('assistant', 'tool') ORDER BY id`).all(...mainIds) : []) as Array<{ role: string; parts: string }>;
  let actSteps = 0;
  const loads: string[][] = [];
  let toolSearchResults = 0;
  for (const m of messages) {
    const parts = parse<{ toolCalls?: Array<{ name: string; arguments?: { steps?: unknown[] } }>; name?: string; content?: string }>(m.parts);
    if (!parts) continue;
    if (m.role === 'assistant') {
      for (const call of parts.toolCalls ?? []) if (call.name === 'browser_act') actSteps += Array.isArray(call.arguments?.steps) ? call.arguments.steps.length : 0;
      continue;
    }
    if (parts.name !== 'tool_search') continue;
    toolSearchResults++;
    const names = [...(parts.content ?? '').matchAll(/^## (\S+)$/gmu)].map(x => x[1]!);
    if (names.length) loads.push(names);
  }

  const pending = db.prepare('SELECT tool, kind, status FROM pending_actions WHERE conversation_id = ? ORDER BY id').all(conversationId) as Array<{ tool: string; kind: string; status: string }>;
  const judge = mainIds.length
    ? db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input FROM judge_calls WHERE run_id IN (${placeholders(mainIds.length)})`).get(...mainIds) as { calls: number; input: number }
    : { calls: 0, input: 0 };
  const tasksStarted = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE created_in_conversation = ?').get(conversationId) as { n: number }).n;
  const lastAssistant = (db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant' AND text != '' ORDER BY id DESC LIMIT 1").get(conversationId) as { text: string } | undefined)?.text ?? '';
  const first = body[0];
  const app = appRecord(eventLines);

  return {
    conversationId,
    runs: mainRuns.map(r => ({ runId: r.id, kind: r.kind, turn: body.filter(c => c.run_id === r.id && c.purpose === 'turn').length, discarded: body.filter(c => c.run_id === r.id && c.purpose === 'discarded').length })),
    a_roundTrips: body.length,
    b_browserCalls: browser.length, b_actSteps: actSteps,
    c_input: volume.input,
    d_cacheWrite: volume.write,
    firstCall: first ? { read: first.cache_read_tokens, write: first.cache_write_tokens, input: first.input_tokens } : null,
    volume,
    e_toolsMisses: misses.tools ?? { count: 0, lostTokens: 0 },
    e_preloadLoads: loads.filter(names => names.some(PRELOAD)).length,
    e_otherLoads: loads.filter(names => !names.some(PRELOAD)).length,
    toolSearchCalls: byTool.tool_search ?? 0, toolSearchResults, toolSearchLoads: loads,
    misses,
    g_pending: pending.length, pending,
    asks: tools.filter(t => t.decision !== 'allow').map(t => `${t.tool}:${t.decision}:${t.decided_by}`),
    askOwner: byTool.ask_owner ?? 0,
    judge,
    compactVolume,
    children: { runs: childIds.length, volume: childVolume, browserCalls: childBrowser },
    tasks: { started: tasksStarted, taskCreateCalls: byTool.task_create ?? 0 },
    byTool,
    browserSequence: browser.map(t => `${t.tool.replace('browser_', '')}${t.decision === 'allow' ? '' : `(${t.decision})`}`).join(' '),
    app,
    parseErrors: parseErrors + app.parseErrors,
    finalAnswer: lastAssistant,
  };
}

export function collect(dbPath: string, conversationId: string, eventsPath?: string) {
  const db = openReadOnly(dbPath);
  try {
    const lines = eventsPath && existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split(/\r?\n/u) : [];
    return collectFrom(db, conversationId, lines);
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { db: { type: 'string' }, conversation: { type: 'string' }, events: { type: 'string' } } });
  if (!values.db || !values.conversation) throw new Error(USAGE);
  process.stdout.write(`${JSON.stringify(collect(resolve(values.db), values.conversation, values.events && resolve(values.events)), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
