import type { App } from '../app.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { latestFixRow, prefixOf, type Prefix } from '../scout/fix.ts';
import type { Proposal } from '../tasks/proposal.ts';
import { taskView, type RepeatingTask, type Task, type TaskEvent, type TaskView } from '../tasks/store.ts';
import type { WorktreeRow } from '../projects/worktree.ts';

function masked(app: App, text: string | null): string | null {
  return text === null ? null : redactSecrets(text, app.registry.secrets());
}

export interface TaskWorktree { id: string; branch: string; base: string; state: string; files: number | null; added: number | null; removed: number | null; note: string | null; held: { path: string; files: number } | null }

// タスクの取り込み待ちのブランチの行。提案（beat 8-6b）は、その提案を直した fix の行。未処理の提案は直しを持っているときだけ（Proposed の Open diff）
export function branchRowOf(app: App, task: Task): WorktreeRow | undefined {
  const own = app.worktrees?.forTask(task.id);
  if (own || task.proposal === null) return own;
  const fix = latestFixRow(app.db, task.id);
  return fix && (task.status !== 'inbox' || fix.state === 'branch' || fix.state === 'merged') ? fix : undefined;
}

// beat 8-2: タスクの作業コピー（8-3 の画面が使う）。変わった量は数え終わるまで null
function worktreeOf(app: App, task: Task): TaskWorktree | null {
  const row = branchRowOf(app, task);
  if (!row) return null;
  const stats = app.worktrees.statsOf(row);
  return { id: row.id, branch: row.branch, base: row.base, state: row.state, files: stats?.files ?? null, added: stats?.added ?? null, removed: stats?.removed ?? null, note: row.note, held: app.mergeWatch?.held(row) ?? null };
}

// beat 8-6b: 提案の Pre-fix（8-6c の画面が使う）。差分の見本の行も鍵を伏せる
function prefixView(app: App, task: Task): Prefix | null {
  const prefix = task.proposal !== null ? prefixOf(app.db, app.kv, task.id) : null;
  return prefix ? { ...prefix, diff: prefix.diff.map(line => masked(app, line)!) } : null;
}

// モデルが書く提案の文を伏せる（kind・size・fixable・researchItem は鍵を持たない）
function maskedProposal(app: App, proposal: Proposal | null): Proposal | null {
  return proposal && { ...proposal, why: masked(app, proposal.why)!, area: proposal.area.map(entry => masked(app, entry)!), goal: masked(app, proposal.goal), evidence: masked(app, proposal.evidence), ledger: masked(app, proposal.ledger) };
}

// 読むだけの欄（結果の要約・待っている質問・提案の文）を伏せる。持ち主が画面で直して送り返す欄（title・body・next_action）は伏せない（伏せた印が保存されて本物を壊すため）
export function maskedTaskView(app: App, task: Task): TaskView & { reject_reason?: string | null; worktree: TaskWorktree | null; prefix: Prefix | null } {
  const view = taskView(task, languageOf(app.config()));
  const out = { ...view, result_summary: masked(app, view.result_summary), waiting_text: masked(app, view.waiting_text), proposal: maskedProposal(app, view.proposal), worktree: worktreeOf(app, task), prefix: prefixView(app, task) };
  if (task.status !== 'cancelled' || task.cancelled_from !== 'inbox') return out;
  const reason = app.db.prepare(`SELECT content FROM task_events WHERE task_id = ?1 AND kind = 'reason'
    AND id > COALESCE((SELECT MAX(id) FROM task_events WHERE task_id = ?1 AND kind = 'uncancelled'), 0) ORDER BY id DESC LIMIT 1`).get(task.id) as { content: string | null } | undefined;
  return { ...out, reject_reason: masked(app, reason?.content ?? null) };
}

export function maskedEvents(app: App, events: readonly TaskEvent[]): TaskEvent[] {
  return events.map(event => ({ ...event, content: masked(app, event.content) }));
}

export function maskedLastRun(app: App, run: RepeatingTask['last_run']): RepeatingTask['last_run'] {
  return run ? { ...run, summary: masked(app, run.summary) } : null;
}
