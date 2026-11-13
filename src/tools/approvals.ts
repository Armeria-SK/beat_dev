import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Placement } from './hooks/scope.ts';

// 確かめの札で見せるコードのファイル（読めないものは text に理由の文を入れる）
export interface PreviewFile { path: string; text: string; truncated: boolean }

// 承認の札に出す、見つけたパスごとの判定。in: 許可フォルダの中（mode はそのフォルダの読み書き / 読むだけ）、out: 外、deny: 拒否、unknown: 判定できない（変数など。path は無い）
export interface ApprovalPath { input: string; path?: string; verdict: 'in' | 'out' | 'deny' | 'unknown'; mode?: 'read' | 'write' }

// 判定の材料: 道具の事前判定が、見つけたパスごとに残した置き場所
export interface PlacedPath { input: string; path?: string | undefined; placement: Placement | { kind: 'unresolved'; reason: string } }

const MAX_APPROVAL_PATHS = 30;

// 判定そのものは事前判定が済ませている。ここでは見つけたパスを、画面に渡す形に直すだけで、判定には何も足さない。
// 同じ入力・同じ場所・同じ判定の重なりは 1 行にする
function distinctPaths(found: readonly PlacedPath[]): ApprovalPath[] {
  const out: ApprovalPath[] = [];
  const seen = new Set<string>();
  for (const { input, path, placement } of found) {
    const item: ApprovalPath = placement.kind === 'inside' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'in', mode: placement.mode }
      : placement.kind === 'outside' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'out' }
      : placement.kind === 'deny' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'deny' }
      : { input, verdict: 'unknown' };
    const key = JSON.stringify([item.input, item.path, item.verdict, item.mode]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// 画面に出す行: 許可フォルダの外・拒否・判定できないを先に（それぞれ見つけた順）、中はそのあと。多すぎる分は切る
export function approvalPaths(found: readonly PlacedPath[]): ApprovalPath[] {
  const all = distinctPaths(found);
  return [...all.filter(p => p.verdict !== 'in'), ...all.filter(p => p.verdict === 'in')].slice(0, MAX_APPROVAL_PATHS);
}

// 切って出さなかった行の数
export function approvalPathsMore(found: readonly PlacedPath[]): number {
  return Math.max(0, distinctPaths(found).length - MAX_APPROVAL_PATHS);
}

export interface AutoRecord { runId: string; conversationId: string; tool: string; input: unknown; reasons: string[] }

function inputHash(tool: string, input: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify([tool, stable(input)])).digest('hex');
}

export class ApprovalBroker {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) { this.#db = db; }

  // 自動承認（判定役）が許したことを記録する。札は出さない。status は approved、scope は auto。reasons には、元の確かめの理由のあとに判定役の理由を 1 つ足す（最後の要素）。
  // 戻り値の id を、道具の記録（tool_calls.approval_id）につなぐ
  recordAuto(req: AutoRecord, classifierReason: string): string {
    const now = Date.now();
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, scope, created_at, expires_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'auto', ?, ?, ?)`).run(id, req.runId, req.conversationId, req.tool, JSON.stringify(req.input), inputHash(req.tool, req.input), JSON.stringify([...req.reasons, classifierReason]), now, now, now);
    return id;
  }
}
