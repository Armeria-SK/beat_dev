// beat 8-6a: 直す実行の口 runFix(proposalId)。写しを作り（fix-copy.ts）、直す実行を 1 つ動かし（engine の runFix。囲いは D-11）、終わったら合否を出す。
// まだどこからも選ばない（直す番は 8-6b の fix.ts）。実行の行は考える実行と同じ見えない行（proposed_by = 'scout-run'。D-4）
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { Conversations } from '../db/conversations.ts';
import type { ChatEngine } from '../engine/chat.ts';
import type { EngineErrorKind } from '../engine/types.ts';
import { checkCommandOf, folderMissing, type ProjectStore } from '../projects/store.ts';
import type { WorktreeRow } from '../projects/worktree.ts';
import { scoutText } from '../shared/messages/scout.ts';
import { openRunJob } from '../os/run-job.ts';
import { readProposal } from '../tasks/proposal.ts';
import type { TaskStore } from '../tasks/store.ts';
import { FIX_LIMITS, type FixCopies, type FixFinish } from './fix-copy.ts';
import { outside } from './run.ts';

// 実行の行の印（考える実行の行は lease の見回りに入らない。目安だけ）
const FIX_LEASE_MS = 2 * 60 * 60_000;
const PROPOSAL_CHARS = 6000;

export interface FixRunDeps {
  tasks: TaskStore;
  conversations: Pick<Conversations, 'create'>;
  projects: Pick<ProjectStore, 'get'>;
  engine: Pick<ChatEngine, 'scoutRoute' | 'runFix'>;
  fixes: FixCopies;
}

export type FixRunResult =
  | { ok: true; row: WorktreeRow; runId: string; result: FixFinish }
  | { ok: false; reason: 'not_proposal' | 'no_check' | 'no_model' | 'copy_failed' | 'run_failed'; detail: string; runId?: string; errorKind?: EngineErrorKind };

// onStart: 直す実行が動き出したとき（ワーカーが止める先と数を覚える。8-6b）
export interface FixRunOptions { signal?: AbortSignal; onStart?: (runId: string, taskId: string) => void }

export async function runFix(d: FixRunDeps, proposalId: string, options: FixRunOptions = {}): Promise<FixRunResult> {
  const proposalRow = d.tasks.get(proposalId);
  const proposal = readProposal(proposalRow?.proposal);
  if (!proposalRow || !proposal || proposalRow.status !== 'inbox' || !proposalRow.project_id) return { ok: false, reason: 'not_proposal', detail: 'not an open proposal of a product' };
  const project = d.projects.get(proposalRow.project_id);
  if (!project || folderMissing(project)) return { ok: false, reason: 'not_proposal', detail: 'the product folder cannot be found' };
  let check: string | null;
  try { check = checkCommandOf(project.check_command); } catch { check = null; }
  if (!check) return { ok: false, reason: 'no_check', detail: 'the product has no check command' };
  const route = d.engine.scoutRoute();
  if (!route) return { ok: false, reason: 'no_model', detail: scoutText('en', 'stop.route') };

  const title = scoutText('en', 'fix.run_title', { title: proposalRow.title }).slice(0, 200);
  const task = d.tasks.create({ title, origin: 'self', projectId: project.id, scoutRun: true, actor: 'worker' });
  const made = await d.fixes.createFixCopy({ projectId: project.id, root: project.root, proposalId, title: proposalRow.title, taskId: task.id });
  if (!made.ok) {
    d.tasks.finish(task.id, 'failed', `no fix copy: ${made.reason}`, 'worker');
    return { ok: false, reason: 'copy_failed', detail: made.reason };
  }
  const row = made.row;
  const fail = async (detail: string, ended?: { runId: string; errorKind: EngineErrorKind }): Promise<FixRunResult> => {
    await d.fixes.discardFixCopy(row.id, detail);
    d.tasks.finish(task.id, 'failed', detail.slice(0, 300), 'worker', ended?.runId);
    return { ok: false, reason: 'run_failed', detail, ...(ended ? { runId: ended.runId, errorKind: ended.errorKind } : {}) };
  };
  const conversationId = randomUUID();
  if (!d.tasks.claim(task.id, FIX_LEASE_MS, conversationId)) return fail('the run row could not be claimed');
  d.conversations.create({ id: conversationId, kind: 'task', title, projectId: project.id });
  const prompt = [
    scoutText('en', 'fix.prompt', { copy: row.path!, branch: row.branch, command: check, files: FIX_LIMITS.files, lines: FIX_LIMITS.lines }),
    '',
    '## Proposal',
    outside([
      `Title: ${proposalRow.title}`, `Kind: ${proposal.kind}`, `Why: ${proposal.why}`, `Area: ${proposal.area.join(', ') || '(none)'}`,
      ...(proposal.goal ? [`Plan goal: ${proposal.goal}`] : []), ...(proposal.evidence ? [`Evidence: ${proposal.evidence}`] : []),
    ].join('\n'), PROPOSAL_CHARS),
  ].join('\n');
  // 直す実行のシェルと確かめのコマンドが起こすプロセスの入れ物。作れなければ始めない。確かめのあと（本体と比べる前）に finishFixCopy が閉じる
  const job = await openRunJob();
  if ('failed' in job) return fail(`no process container: ${job.failed}`);
  try {
    const started = d.engine.runFix(task, conversationId, prompt, route.modelId,
      { id: row.id, path: row.path!, productRoot: project.root, branch: row.branch, base: row.base, ceiling: dirname(row.path!), job }, scoutText('en', 'proposal.untrusted'));
    if (!started.ok) return await fail(started.errorMessage.split('\n')[0] ?? 'the run did not start');
    d.tasks.event(task.id, 'run', 'worker', null, started.runId);
    options.onStart?.(started.runId, task.id);
    const ended = await started.done;
    if (!ended.ok) { await job.close(); return await fail(ended.errorMessage.split('\n')[0] ?? 'the run failed', { runId: started.runId, errorKind: ended.errorKind }); }
    const result = await d.fixes.finishFixCopy(row.id, { check, job, ...(options.signal ? { signal: options.signal } : {}) });
    d.tasks.finish(task.id, 'done', result.kept ? `Fix kept on ${result.branch}` : `Fix not kept: ${result.reason}`, 'worker', started.runId);
    return { ok: true, row: d.fixes.get(row.id)!, runId: started.runId, result };
  } finally {
    await job.close();
  }
}
