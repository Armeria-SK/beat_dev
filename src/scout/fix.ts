// beat 8-6b: 直す番。直す提案の選び方・runFix の結果を提案に書く・提案の形の prefix（8-6c の画面が使う）
import type { DatabaseSync } from 'node:sqlite';
import type { KV } from '../db/kv.ts';
import { checkCommandOf, type ProjectRow } from '../projects/store.ts';
import type { WorktreeRow, Worktrees } from '../projects/worktree.ts';
import type { Language } from '../config/schema.ts';
import { scoutText, type ScoutMessageKey } from '../shared/messages/scout.ts';
import { readProposal } from '../tasks/proposal.ts';
import type { TaskStore } from '../tasks/store.ts';
import type { FixReason } from './fix-copy.ts';
import type { FixRunResult } from './fix-run.ts';
import { readLedger, recordEntry } from './ledger.ts';

export interface Prefix { branch: string; base: string; checks: 'passed'; files: number; added: number; removed: number; diff: string[] }

// その提案に直しを試した HEAD（同じ HEAD で 2 回は試さない。D-7）と、通った直しの大きさと 6 行の見本（表 worktrees の fix の行ごと）
const triedKey = (proposalId: string): string => `scout:fix-tried:${proposalId}`;
const prefixKey = (rowId: string): string => `scout:prefix:${rowId}`;
// 直しを持っている・作っている fix の行（もう一度は試さない）
const HOLDING = "('creating', 'active', 'removing', 'branch', 'merged')";

export function latestFixRow(db: DatabaseSync, proposalId: string): WorktreeRow | undefined {
  return db.prepare("SELECT * FROM worktrees WHERE proposal_id = ? AND kind = 'fix' ORDER BY created_at DESC, id DESC LIMIT 1").get(proposalId) as WorktreeRow | undefined;
}

// 直す提案: fix の製品・確かめのコマンドあり・未処理・kind bug・大きさ S / M・fixable・その HEAD でまだ試していない・直しを持っていない。古いものから 1 つ
export function fixCandidate(db: DatabaseSync, kv: KV, project: ProjectRow, head: string | null): string | undefined {
  if (project.scout_mode !== 'fix' || !head) return undefined;
  let check: string | null;
  try { check = checkCommandOf(project.check_command); } catch { check = null; }
  if (!check) return undefined;
  const rows = db.prepare(`SELECT id, proposal FROM tasks WHERE project_id = ? AND status = 'inbox' AND proposal IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.proposal_id = tasks.id AND w.kind = 'fix' AND w.state IN ${HOLDING})
    ORDER BY created_at, rowid`).all(project.id) as Array<{ id: string; proposal: string }>;
  return rows.find(row => {
    const p = readProposal(row.proposal);
    return p?.kind === 'bug' && (p.size === 'S' || p.size === 'M') && p.fixable === true && kv.get(triedKey(row.id)) !== head;
  })?.id;
}

export function markFixTried(kv: KV, proposalId: string, head: string): void { kv.set(triedKey(proposalId), head); }

// 提案の形の prefix: いちばん新しい fix の行が直しを持っている（取り込み待ち・取り込み済み）ときだけ
export function prefixOf(db: DatabaseSync, kv: KV, proposalId: string): Prefix | null {
  const row = latestFixRow(db, proposalId);
  if (!row || (row.state !== 'branch' && row.state !== 'merged')) return null;
  const kept = kv.getJson<Pick<Prefix, 'files' | 'added' | 'removed' | 'diff'>>(prefixKey(row.id));
  if (!kept || !Array.isArray(kept.diff)) return null;
  return { branch: row.branch, base: row.base, checks: 'passed', files: kept.files, added: kept.added, removed: kept.removed, diff: kept.diff.slice(0, 6) };
}

export interface FixRecordDeps {
  db: DatabaseSync;
  kv: KV;
  tasks: Pick<TaskStore, 'get' | 'event'>;
  worktrees: Pick<Worktrees, 'removeWorktree'>;
  projectsDir: string;
  language: Language;
  log?: (line: string) => void;
}

const REASONS: Record<Exclude<FixReason, 'main_changed'>, ScoutMessageKey> = {
  check_failed: 'prefix.why.check_failed', check_changed_files: 'prefix.why.check_changed_files', tests_removed: 'prefix.why.tests_removed',
  check_touched: 'prefix.why.check_touched', has_links: 'prefix.why.has_links', too_large: 'prefix.why.too_large',
  not_descendant: 'prefix.why.not_descendant', no_changes: 'prefix.why.no_changes', failed: 'prefix.why.failed',
};

export function notKeptText(language: Language, reason: FixReason | 'run' | 'copy', detail: string): string {
  const short = detail.split('\n')[0]!.slice(0, 300);
  const why = reason === 'main_changed' ? scoutText(language, 'prefix.main_changed', { names: short })
    : reason === 'run' ? scoutText(language, 'prefix.why.run', { detail: short })
      : reason === 'copy' ? scoutText(language, 'prefix.why.copy', { detail: short })
        : scoutText(language, REASONS[reason], { detail: short });
  return scoutText(language, 'prefix.not_kept', { reason: why });
}

// runFix の結果を提案に書く。通った直しは prefix と確認済みの一覧の result（fix <branch>）に、落ちた直しは提案の経過に 1 行。
// 直しのあいだに持ち主が提案を Approve / Reject した（未処理でなくなった）ら、取ってきたブランチを捨てる。返り値: 新しい Pre-fix が残ったか
export async function recordFix(d: FixRecordDeps, proposalId: string, result: FixRunResult): Promise<boolean> {
  if (!result.ok) {
    if (result.reason === 'run_failed' || result.reason === 'copy_failed') d.tasks.event(proposalId, 'prefix', 'scout', notKeptText(d.language, result.reason === 'run_failed' ? 'run' : 'copy', result.detail));
    return false;
  }
  const outcome = result.result;
  if (!outcome.kept) {
    d.tasks.event(proposalId, 'prefix', 'scout', notKeptText(d.language, outcome.reason, outcome.detail));
    return false;
  }
  if (d.tasks.get(proposalId)?.status !== 'inbox') {
    const dropped = await d.worktrees.removeWorktree(result.row.id, { keepBranch: false, state: 'discarded' });
    if (!dropped.ok || dropped.branchKept) d.log?.(`[WARN] Could not remove the fix branch ${result.row.branch} of a proposal the owner already decided`);
    return false;
  }
  d.kv.setJson(prefixKey(result.row.id), { files: outcome.files, added: outcome.added, removed: outcome.removed, diff: outcome.diff });
  d.tasks.event(proposalId, 'prefix', 'scout', scoutText(d.language, 'prefix.kept', { branch: outcome.branch, files: outcome.files, added: outcome.added, removed: outcome.removed }));
  const projectId = result.row.project_id;
  const ledger = readProposal(d.tasks.get(proposalId)?.proposal)?.ledger;
  if (ledger) {
    try {
      const entry = readLedger(d.projectsDir, projectId).entries.find(e => e.id === ledger && !e.broken);
      if (entry && entry.area !== null) recordEntry(d.projectsDir, projectId, { id: entry.id, title: entry.title, area: entry.area, checked: entry.checked, result: `fix ${outcome.branch}` }, { when: entry.when, commit: entry.commit, by: entry.by });
    } catch (error) { d.log?.(`[WARN] Could not write the pre-fix to the scout ledger: ${(error as Error).message}`); }
  }
  return true;
}
