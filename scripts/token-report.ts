import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { toolText } from '../src/shared/messages/tools.ts';

// 量の報告（token-efficiency TE-0）。DB は読むだけ。量は model_calls から足す（engine_runs は要約の呼び出しを含まないので使わない）。
// 重みつきの量 = 読み×0.1 + 書き×1.25 + 入力（読み・書きでない分）×1。出力は別に出す。

const USAGE = 'usage: node scripts/token-report.ts --db <path to beat.db> [--days 7] [--runs 20] [--json]';

export const GAP_MS = 5 * 60_000;
export const LONG_GAP_MS = 60 * 60_000;
// 前の呼び出しがキャッシュに置いた分（読み + 書き）のうち、これより少なくしか読めなかった呼び出しを「外れ」と見る
export const MISS_RATIO = 0.95;
const CUT_MARK = toolText('en', 'pipeline.truncated', { shown: '\u0000', total: '\u0000', note: '' }).split('\u0000')[0]!;

export type MissReason = 'tools' | 'frozen' | 'dynamic' | 'removed' | 'gap_5min' | 'history';
export const MISS_REASONS: readonly MissReason[] = ['tools', 'frozen', 'dynamic', 'removed', 'gap_5min', 'history'];

export interface Volume { calls: number; input: number; read: number; write: number; fresh: number; output: number; weighted: number; readShare: number | null }
export interface Reads {
  fileReads: number;
  // 同じ会話で前に同じパス・範囲を読んだ file_read。量は結果の発言の長さ（字）で、間に中身が変わっていても数えるので上限
  dupReads: number; dupChars: number;
  toolChars: number;
  rereadAfterCut: number;
  cutOutputs: number;
  rereadAfterCompact: number;
}
export interface RunReport extends Reads {
  runId: string; kind: string; conversationId: string | null; startedAt: number;
  turn: number; compact: number; discarded: number; children: number;
  volume: Volume; compactVolume: Volume;
  judge: { calls: number; input: number; output: number };
  weightedTotal: number; misses: number; gaps: number; thinkingReplayRejected: boolean;
}
export interface ConversationReport { conversationId: string | null; runs: number; volume: Volume; compactVolume: Volume; judgeInput: number; weightedTotal: number; misses: number; gaps: number }
export interface TokenReport {
  since: number; until: number; notes: string[];
  totals: { volume: Volume; compactVolume: Volume; judge: { calls: number; input: number; output: number }; weightedTotal: number };
  misses: Array<{ reason: MissReason; count: number; lostTokens: number }>;
  gaps: { count: number; longGapWrite: number; longGapShare: number | null };
  reads: Reads;
  thinkingReplayRejected: number;
  conversations: ConversationReport[];
  runs: RunReport[];
}

interface CallRow {
  run_id: string; seq: number; purpose: 'turn' | 'compact' | 'discarded'; input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  output_tokens: number | null; removed: number; tools_hash: string; frozen_hash: string; dynamic_hash: string; started_at: number; conversation_id: string | null;
}
interface RunRow { id: string; kind: string; conversation_id: string | null; parent_run_id: string | null; started_at: number; flags: string }

const emptyVolume = (): Volume => ({ calls: 0, input: 0, read: 0, write: 0, fresh: 0, output: 0, weighted: 0, readShare: null });
const emptyReads = (): Reads => ({ fileReads: 0, dupReads: 0, dupChars: 0, toolChars: 0, rereadAfterCut: 0, cutOutputs: 0, rereadAfterCompact: 0 });

function addCall(v: Volume, c: Pick<CallRow, 'input_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'output_tokens'>): void {
  const input = c.input_tokens ?? 0;
  const read = c.cache_read_tokens ?? 0;
  const write = c.cache_write_tokens ?? 0;
  const fresh = Math.max(0, input - read - write);
  v.calls++; v.input += input; v.read += read; v.write += write; v.fresh += fresh; v.output += c.output_tokens ?? 0;
  v.weighted += read * 0.1 + write * 1.25 + fresh;
  v.readShare = v.input > 0 ? v.read / v.input : null;
}

const addReads = (into: Reads, r: Reads): void => { for (const key of Object.keys(into) as Array<keyof Reads>) into[key] += r[key]; };
const hasTable = (db: DatabaseSync, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const normalPath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//u, '');
const flagsOf = (text: string): string[] => { try { const v = JSON.parse(text) as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

// 前の呼び出しとの比べで、外れた理由を 1 つ決める（先に当てはまったもの）
export function missReason(prev: Pick<CallRow, 'tools_hash' | 'frozen_hash' | 'dynamic_hash' | 'removed' | 'started_at'>, cur: Pick<CallRow, 'tools_hash' | 'frozen_hash' | 'dynamic_hash' | 'removed' | 'started_at'>): MissReason {
  if (prev.tools_hash !== cur.tools_hash) return 'tools';
  if (prev.frozen_hash !== cur.frozen_hash) return 'frozen';
  if (prev.dynamic_hash !== cur.dynamic_hash) return 'dynamic';
  if (prev.removed !== cur.removed) return 'removed';
  if (cur.started_at - prev.started_at > GAP_MS) return 'gap_5min';
  return 'history';
}

export function tokenReport(db: DatabaseSync, options: { since: number; until: number; runLimit: number }): TokenReport {
  const { since, until } = options;
  const report: TokenReport = {
    since, until, notes: [],
    totals: { volume: emptyVolume(), compactVolume: emptyVolume(), judge: { calls: 0, input: 0, output: 0 }, weightedTotal: 0 },
    misses: MISS_REASONS.map(reason => ({ reason, count: 0, lostTokens: 0 })),
    gaps: { count: 0, longGapWrite: 0, longGapShare: null },
    reads: emptyReads(), thinkingReplayRejected: 0, conversations: [], runs: [],
  };
  if (!hasTable(db, 'engine_runs')) { report.notes.push('this database has no engine_runs table (nothing has run yet)'); return report; }
  const calls = hasTable(db, 'model_calls');
  if (!calls) report.notes.push('this database has no model_calls table yet (start beat once with this version); token volumes are empty');

  const parents = new Map((db.prepare('SELECT id, parent_run_id FROM engine_runs WHERE parent_run_id IS NOT NULL').all() as Array<{ id: string; parent_run_id: string }>).map(r => [r.id, r.parent_run_id]));
  const rootOf = (id: string): string => {
    let at = id;
    for (let hops = 0; hops < 50 && parents.has(at); hops++) at = parents.get(at)!;
    return at;
  };
  const windowRuns = db.prepare('SELECT id, kind, conversation_id, parent_run_id, started_at, flags FROM engine_runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at, rowid').all(since, until) as unknown as RunRow[];
  const inWindow = new Set(windowRuns.map(r => r.id));
  const runInfo = new Map(windowRuns.map(r => [r.id, r]));
  const rootRow = (id: string): RunRow => runInfo.get(id) ?? (db.prepare('SELECT id, kind, conversation_id, parent_run_id, started_at, flags FROM engine_runs WHERE id = ?').get(id) as RunRow | undefined) ?? { id, kind: '?', conversation_id: null, parent_run_id: null, started_at: 0, flags: '[]' };

  const roots = new Map<string, RunReport>();
  const rootReport = (runId: string): RunReport => {
    const id = rootOf(runId);
    let r = roots.get(id);
    if (!r) {
      const row = rootRow(id);
      r = { runId: id, kind: row.kind, conversationId: row.conversation_id, startedAt: row.started_at, turn: 0, compact: 0, discarded: 0, children: 0, volume: emptyVolume(), compactVolume: emptyVolume(), judge: { calls: 0, input: 0, output: 0 }, weightedTotal: 0, misses: 0, gaps: 0, thinkingReplayRejected: false, ...emptyReads() };
      roots.set(id, r);
    }
    return r;
  };
  for (const run of windowRuns) {
    const r = rootReport(run.id);
    if (run.id !== r.runId) r.children++;
    if (flagsOf(run.flags).includes('thinking_replay_rejected')) { r.thinkingReplayRejected = true; report.thinkingReplayRejected++; }
  }

  const conversations = new Map<string, ConversationReport>();
  const convKey = (r: RunReport): string => r.conversationId ?? `run:${r.runId}`;
  const conversationReport = (r: RunReport): ConversationReport => {
    let c = conversations.get(convKey(r));
    if (!c) { c = { conversationId: r.conversationId, runs: 0, volume: emptyVolume(), compactVolume: emptyVolume(), judgeInput: 0, weightedTotal: 0, misses: 0, gaps: 0 }; conversations.set(convKey(r), c); }
    return c;
  };

  if (calls) {
    const rows = db.prepare(`
      SELECT m.run_id, m.seq, m.purpose, m.input_tokens, m.cache_read_tokens, m.cache_write_tokens, m.output_tokens, m.removed, m.tools_hash, m.frozen_hash, m.dynamic_hash, m.started_at, r.conversation_id
      FROM model_calls m JOIN engine_runs r ON r.id = m.run_id
      WHERE r.started_at >= ? AND r.started_at < ? ORDER BY m.started_at, m.run_id, m.seq
    `).all(since, until) as unknown as CallRow[];
    const previous = new Map<string, CallRow>();
    for (const row of rows) {
      const r = rootReport(row.run_id);
      const c = conversationReport(r);
      if (row.purpose === 'compact') {
        r.compact++; addCall(r.compactVolume, row); addCall(c.compactVolume, row); addCall(report.totals.compactVolume, row);
        continue;
      }
      if (row.purpose === 'turn') r.turn++; else r.discarded++;
      addCall(r.volume, row); addCall(c.volume, row); addCall(report.totals.volume, row);
      // 子の実行は自分の会話を持つので、前の呼び出しは同じ会話（消した会話は同じ実行）のものと比べる
      const chain = row.conversation_id ?? `run:${row.run_id}`;
      const prev = previous.get(chain);
      previous.set(chain, row);
      if (!prev) continue;
      const gap = row.started_at - prev.started_at;
      if (gap > GAP_MS) {
        r.gaps++; c.gaps++; report.gaps.count++;
        if (gap <= LONG_GAP_MS) report.gaps.longGapWrite += row.cache_write_tokens ?? 0;
      }
      if (row.cache_read_tokens === null) continue;
      const expected = prev.cache_write_tokens !== null ? (prev.cache_read_tokens ?? 0) + prev.cache_write_tokens : prev.input_tokens ?? 0;
      if (expected <= 0 || row.cache_read_tokens >= expected * MISS_RATIO) continue;
      const miss = report.misses.find(m => m.reason === missReason(prev, row))!;
      miss.count++; miss.lostTokens += expected - row.cache_read_tokens;
      r.misses++; c.misses++;
    }
  }

  if (hasTable(db, 'judge_calls')) {
    const judged = db.prepare(`
      SELECT j.run_id, COUNT(*) AS n, COALESCE(SUM(j.input_tokens), 0) AS input, COALESCE(SUM(j.output_tokens), 0) AS output
      FROM judge_calls j JOIN engine_runs r ON r.id = j.run_id WHERE r.started_at >= ? AND r.started_at < ? GROUP BY j.run_id
    `).all(since, until) as Array<{ run_id: string; n: number; input: number; output: number }>;
    for (const j of judged) {
      const r = rootReport(j.run_id);
      r.judge.calls += j.n; r.judge.input += j.input; r.judge.output += j.output;
      conversationReport(r).judgeInput += j.input;
      report.totals.judge.calls += j.n; report.totals.judge.input += j.input; report.totals.judge.output += j.output;
    }
  }

  if (hasTable(db, 'tool_calls')) {
    const cut = db.prepare(`
      SELECT t.run_id, COUNT(*) AS n FROM tool_calls t JOIN engine_runs r ON r.id = t.run_id
      WHERE t.full_ref IS NOT NULL AND r.started_at >= ? AND r.started_at < ? GROUP BY t.run_id
    `).all(since, until) as Array<{ run_id: string; n: number }>;
    for (const row of cut) rootReport(row.run_id).cutOutputs += row.n;
  }

  if (hasTable(db, 'messages')) {
    const compactTimes = (conversationId: string): number[] => calls
      ? (db.prepare("SELECT m.started_at FROM model_calls m JOIN engine_runs r ON r.id = m.run_id WHERE r.conversation_id = ? AND m.purpose = 'compact' ORDER BY m.started_at").all(conversationId) as Array<{ started_at: number }>).map(row => row.started_at)
      : [];
    const ids = [...new Set(windowRuns.flatMap(run => (run.conversation_id ? [run.conversation_id] : [])))];
    const select = db.prepare('SELECT run_id, role, length(text) AS chars, parts, created_at FROM messages WHERE conversation_id = ? AND role IN (\'assistant\', \'tool\') ORDER BY id');
    for (const conversationId of ids) {
      const compacts = compactTimes(conversationId);
      const pending = new Map<string, { path: string; key: string; runId: string | null }>();
      const seen = new Set<string>();
      const cutPaths = new Set<string>();
      const readAt = new Map<string, number[]>();
      for (const m of select.all(conversationId) as Array<{ run_id: string | null; role: string; chars: number; parts: string; created_at: number }>) {
        let parts: { toolCalls?: Array<{ id: string; name: string; arguments?: unknown }>; toolCallId?: string; name?: string; content?: string };
        try { parts = JSON.parse(m.parts) as typeof parts; } catch { continue; }
        if (m.role === 'assistant') {
          for (const call of parts.toolCalls ?? []) {
            const args = call.arguments as { path?: unknown; offset?: unknown; limit?: unknown } | undefined;
            if (call.name !== 'file_read' || typeof args?.path !== 'string') continue;
            const path = normalPath(args.path);
            pending.set(call.id, { path, key: `${path}|${String(args.offset ?? '')}|${String(args.limit ?? '')}`, runId: m.run_id });
          }
          continue;
        }
        const counted = m.run_id !== null && inWindow.has(m.run_id);
        if (counted) rootReport(m.run_id!).toolChars += m.chars;
        const read = parts.toolCallId !== undefined ? pending.get(parts.toolCallId) : undefined;
        if (!read) continue;
        pending.delete(parts.toolCallId!);
        if (counted) {
          const r = rootReport(m.run_id!);
          r.fileReads++;
          if (seen.has(read.key)) { r.dupReads++; r.dupChars += m.chars; }
          if (cutPaths.has(read.path)) r.rereadAfterCut++;
          const lastCompact = compacts.filter(t => t < m.created_at).at(-1);
          if (lastCompact !== undefined && (readAt.get(read.path) ?? []).some(t => t < lastCompact)) r.rereadAfterCompact++;
        }
        seen.add(read.key);
        readAt.set(read.path, [...(readAt.get(read.path) ?? []), m.created_at]);
        if ((parts.content ?? '').includes(CUT_MARK)) cutPaths.add(read.path);
      }
    }
  }

  for (const r of roots.values()) {
    r.weightedTotal = r.volume.weighted + r.compactVolume.weighted + r.judge.input;
    addReads(report.reads, r);
    if (inWindow.has(r.runId) || r.volume.calls > 0) conversationReport(r).runs++;
  }
  for (const c of conversations.values()) c.weightedTotal = c.volume.weighted + c.compactVolume.weighted + c.judgeInput;
  const t = report.totals;
  t.weightedTotal = t.volume.weighted + t.compactVolume.weighted + t.judge.input;
  report.gaps.longGapShare = t.weightedTotal > 0 ? (report.gaps.longGapWrite * 1.25) / t.weightedTotal : null;
  report.conversations = [...conversations.values()].sort((a, b) => b.weightedTotal - a.weightedTotal).slice(0, options.runLimit);
  report.runs = [...roots.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, options.runLimit);
  return report;
}

const pct = (n: number | null): string => (n === null ? '-' : `${(n * 100).toFixed(1)}%`);
const int = (n: number): string => String(Math.round(n));
const VOLUME_HEAD = 'calls\tinput\tread\twrite\tfresh\toutput\tweighted\tread_share';
const volumeCells = (v: Volume): string => `${v.calls}\t${v.input}\t${v.read}\t${v.write}\t${v.fresh}\t${v.output}\t${int(v.weighted)}\t${pct(v.readShare)}`;

export function renderReport(r: TokenReport): string {
  const t = r.totals;
  return [
    `# Token report ${new Date(r.since).toISOString()} .. ${new Date(r.until).toISOString()}`,
    ...r.notes.map(note => `note: ${note}`),
    'weighted = read x 0.1 + write x 1.25 + fresh input x 1 (output not included). Child runs and judge calls are added to their parent run.',
    '',
    '## Totals', `part\t${VOLUME_HEAD}`,
    `model calls (turn + discarded)\t${volumeCells(t.volume)}`,
    `summary calls (compact)\t${volumeCells(t.compactVolume)}`,
    `judge calls\t${t.judge.calls}\t${t.judge.input}\t-\t-\t${t.judge.input}\t${t.judge.output}\t${t.judge.input}\t-`,
    `weighted input, all\t${int(t.weightedTotal)}`,
    '',
    '## Cache misses (read < 95% of what the previous call left in the cache), by first differing part', 'reason\tcount\tlost_tokens',
    ...r.misses.map(m => `${m.reason}\t${m.count}\t${m.lostTokens}`),
    '',
    '## Gaps between calls in one conversation',
    `over 5 min\t${r.gaps.count}`,
    `cache writes after a 5-60 min gap\t${r.gaps.longGapWrite}\t(${pct(r.gaps.longGapShare)} of weighted input)`,
    `runs with thinking_replay_rejected\t${r.thinkingReplayRejected}`,
    '',
    '## Re-reads and cut outputs (dup_chars is an upper bound: the same path and range is counted even if the file changed in between)',
    'file_read\tdup_reads\tdup_chars\ttool_result_chars\tdup_share\treread_after_cut\tcut_outputs\treread_after_compact',
    `${r.reads.fileReads}\t${r.reads.dupReads}\t${r.reads.dupChars}\t${r.reads.toolChars}\t${pct(r.reads.toolChars > 0 ? r.reads.dupChars / r.reads.toolChars : null)}\t${r.reads.rereadAfterCut}\t${r.reads.cutOutputs}\t${r.reads.rereadAfterCompact}`,
    '',
    '## By conversation (most weighted first)', `conversation\truns\t${VOLUME_HEAD}\tcompact_calls\tcompact_weighted\tjudge_input\tweighted_all\tmisses\tgaps`,
    ...r.conversations.map(c => `${c.conversationId ?? '(erased)'}\t${c.runs}\t${volumeCells(c.volume)}\t${c.compactVolume.calls}\t${int(c.compactVolume.weighted)}\t${c.judgeInput}\t${int(c.weightedTotal)}\t${c.misses}\t${c.gaps}`),
    '',
    '## By run (newest first)', `run\tkind\tturn/discarded/compact\tchildren\t${VOLUME_HEAD}\tjudge_in\tweighted_all\tmisses\tgaps\tdup_reads\treread_after_cut\tcut_outputs\treread_after_compact\treplay_rejected`,
    ...r.runs.map(x => `${x.runId}\t${x.kind}\t${x.turn}/${x.discarded}/${x.compact}\t${x.children}\t${volumeCells(x.volume)}\t${x.judge.input}\t${int(x.weightedTotal)}\t${x.misses}\t${x.gaps}\t${x.dupReads}\t${x.rereadAfterCut}\t${x.cutOutputs}\t${x.rereadAfterCompact}\t${x.thinkingReplayRejected ? 'yes' : 'no'}`),
  ].join('\n');
}

export function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

export function readReport(path: string, options: { days: number; runs: number; now?: number | undefined }): TokenReport {
  const db = openReadOnly(path);
  try {
    const now = options.now ?? Date.now();
    return tokenReport(db, { since: now - options.days * 86_400_000, until: now + 1, runLimit: options.runs });
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { db: { type: 'string' }, days: { type: 'string', default: '7' }, runs: { type: 'string', default: '20' }, json: { type: 'boolean', default: false } } });
  const days = Number(values.days);
  const runs = Number(values.runs);
  if (!values.db || !Number.isFinite(days) || days <= 0 || days > 3650 || !Number.isInteger(runs) || runs < 1) throw new Error(USAGE);
  const report = readReport(resolve(values.db), { days, runs });
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
