import type { DatabaseSync } from 'node:sqlite';
import type { AutoVerdict, JudgeSpend } from './auto-approve.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { RunKind } from './types.ts';

export type JudgeOutcome = 'allow' | 'ask' | 'failed';

export interface JudgeCallInput {
  runId: string;
  runKind: RunKind;
  projectId: string | null;
  tool: string;
  reasonKeys: readonly string[];
  askKinds: readonly string[];
  outcome: JudgeOutcome;
  failed?: string | undefined;
  // 呼べなかった理由（種類と、例外の文を 1 行にしたもの）。error のときだけ。`<種類>: <文>` の形で 300 字までに切って残す。記録とログにだけ使い、承認待ちの文・モデルへの返事には入れない
  detail?: { kind: string; text: string } | undefined;
  spend: JudgeSpend;
}

const KEY = /^[a-z][a-z0-9_.-]{0,79}$/u;
const KEYS_MAX = 32;
const DETAIL_MAX = 300;
const FAILED: ReadonlySet<string> = new Set<NonNullable<AutoVerdict['failed']>>(['error', 'cancelled', 'timeout', 'unparsable', 'no_request', 'too_long', 'slot_timeout', 'no_judge', 'judge_refused']);
export const BEFORE_MODEL: ReadonlySet<string> = new Set<NonNullable<AutoVerdict['failed']>>(['no_judge', 'no_request', 'too_long', 'slot_timeout']);

const keysOf = (keys: readonly string[]): string[] => [...new Set(keys.filter(key => KEY.test(key)))].sort().slice(0, KEYS_MAX);
const count = (value: number | undefined): number | null => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

// 種類は決まった語の形だけ（そうでなければ internal）。文は秘密を伏せてから種類を前に付ける（種類を付けた形を伏せると、`auth: 401` の 401 が伏せられる）
const detailOf = (detail: { kind: string; text: string }): string => `${KEY.test(detail.kind) ? detail.kind : 'internal'}: ${redactSecrets(detail.text)}`.slice(0, DETAIL_MAX);

export function recordJudgeCall(db: DatabaseSync, input: JudgeCallInput, now = Date.now()): void {
  try {
    db.prepare(`INSERT INTO judge_calls (run_id, run_kind, project_id, tool, reason_keys, ask_kinds, outcome, failed, detail, judge_model, input_tokens, output_tokens, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.runId, input.runKind, input.projectId, input.tool.slice(0, 200), JSON.stringify(keysOf(input.reasonKeys)), JSON.stringify(keysOf(input.askKinds)),
      input.outcome, input.failed !== undefined && FAILED.has(input.failed) ? input.failed : input.outcome === 'failed' ? 'error' : null,
      input.detail !== undefined ? detailOf(input.detail) : null,
      input.spend.model?.slice(0, 200) ?? null, count(input.spend.inputTokens), count(input.spend.outputTokens), count(Math.round(input.spend.ms)) ?? 0, now,
    );
  } catch { }
}

// 判定役が「呼べない」で続けて失敗している回数。新しい順に 20 行まで読み、error・timeout・slot_timeout は 1 と数え、答えた行（failed が NULL）で止まる。
// ほかの failed（cancelled・unparsable・judge_refused・no_judge・no_request・too_long）は、判定役に届いたか呼ぶ前に決まったものなので、数えも止めもしない
const STREAK_FAILURES: ReadonlySet<string> = new Set(['error', 'timeout', 'slot_timeout']);
const STREAK_ROWS = 20;

export function judgeFailingStreak(db: DatabaseSync): number {
  try {
    let streak = 0;
    for (const row of db.prepare('SELECT failed FROM judge_calls ORDER BY created_at DESC, id DESC LIMIT ?').all(STREAK_ROWS) as Array<{ failed: string | null }>) {
      if (row.failed === null) break;
      if (STREAK_FAILURES.has(row.failed)) streak++;
    }
    return streak;
  } catch { return 0; }
}

export interface JudgeTotals { calls: number; allow: number; ask: number; failed: number; inputTokens: number; outputTokens: number; ms: number }

export interface JudgeStats {
  since: number;
  until: number;
  totals: JudgeTotals;
  days: Array<{ day: string } & JudgeTotals>;
  runs: Array<{ runId: string; runKind: string; projectId: string | null } & JudgeTotals>;
  keys: Array<{ key: string } & JudgeTotals>;
  askKinds: Array<{ kind: string } & JudgeTotals>;
  models: Array<{ model: string | null } & JudgeTotals>;
  failures: Array<{ reason: string; beforeModel: boolean } & JudgeTotals>;
}

export interface JudgeStatsQuery { since: number; until?: number | undefined; project?: string | null | undefined; timezone?: string | undefined; runLimit?: number | undefined }

interface Row { failed: string | null; run_id: string; run_kind: string; project_id: string | null; reason_keys: string; ask_kinds: string; outcome: JudgeOutcome; judge_model: string | null; input_tokens: number | null; output_tokens: number | null; duration_ms: number; created_at: number }

const empty = (): JudgeTotals => ({ calls: 0, allow: 0, ask: 0, failed: 0, inputTokens: 0, outputTokens: 0, ms: 0 });

// 実行が止められただけの呼び出し（cancelled）は、呼んだ数・量には入れるが、「失敗」の数には入れない
const stopped = (row: Row): boolean => row.outcome === 'failed' && row.failed === 'cancelled';

function add(totals: JudgeTotals, row: Row): void {
  totals.calls++;
  if (!stopped(row)) totals[row.outcome]++;
  totals.inputTokens += Number(row.input_tokens ?? 0);
  totals.outputTokens += Number(row.output_tokens ?? 0);
  totals.ms += Number(row.duration_ms);
}

function listOf(raw: string): string[] {
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; } catch { return []; }
}

function dayFormat(timezone: string | undefined): Intl.DateTimeFormat {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
}

const byCalls = <T extends JudgeTotals>(label: (item: T) => string) => (a: T, b: T): number => b.calls - a.calls || label(a).localeCompare(label(b));

export function judgeStats(db: DatabaseSync, query: JudgeStatsQuery): JudgeStats {
  const until = query.until ?? Date.now();
  const where = ['created_at >= ?', 'created_at < ?'];
  const args: Array<string | number> = [query.since, until];
  if (query.project === null) where.push('project_id IS NULL');
  else if (query.project !== undefined) { where.push('project_id = ?'); args.push(query.project); }
  const rows = db.prepare(`SELECT failed, run_id, run_kind, project_id, reason_keys, ask_kinds, outcome, judge_model, input_tokens, output_tokens, duration_ms, created_at FROM judge_calls WHERE ${where.join(' AND ')} ORDER BY created_at, id`).all(...args) as unknown as Row[];
  const format = dayFormat(query.timezone);
  const totals = empty();
  const days = new Map<string, { day: string } & JudgeTotals>();
  const runs = new Map<string, { runId: string; runKind: string; projectId: string | null } & JudgeTotals>();
  const keys = new Map<string, { key: string } & JudgeTotals>();
  const kinds = new Map<string, { kind: string } & JudgeTotals>();
  const models = new Map<string | null, { model: string | null } & JudgeTotals>();
  const failures = new Map<string, { reason: string; beforeModel: boolean } & JudgeTotals>();
  for (const row of rows) {
    add(totals, row);
    const day = format.format(Number(row.created_at));
    add(days.get(day) ?? days.set(day, { day, ...empty() }).get(day)!, row);
    add(runs.get(row.run_id) ?? runs.set(row.run_id, { runId: row.run_id, runKind: row.run_kind, projectId: row.project_id, ...empty() }).get(row.run_id)!, row);
    for (const key of listOf(row.reason_keys)) add(keys.get(key) ?? keys.set(key, { key, ...empty() }).get(key)!, row);
    for (const kind of listOf(row.ask_kinds)) add(kinds.get(kind) ?? kinds.set(kind, { kind, ...empty() }).get(kind)!, row);
    add(models.get(row.judge_model) ?? models.set(row.judge_model, { model: row.judge_model, ...empty() }).get(row.judge_model)!, row);
    if (row.outcome === 'failed' && !stopped(row)) {
      const reason = row.failed ?? 'error';
      add(failures.get(reason) ?? failures.set(reason, { reason, beforeModel: BEFORE_MODEL.has(reason), ...empty() }).get(reason)!, row);
    }
  }
  const runLimit = Math.min(Math.max(1, query.runLimit ?? 50), 500);
  return {
    since: query.since, until, totals,
    days: [...days.values()],
    runs: [...runs.values()].sort(byCalls(r => r.runId)).slice(0, runLimit),
    keys: [...keys.values()].sort(byCalls(k => k.key)),
    askKinds: [...kinds.values()].sort(byCalls(k => k.kind)),
    models: [...models.values()].sort(byCalls(m => m.model ?? '')),
    failures: [...failures.values()].sort(byCalls(f => f.reason)),
  };
}
