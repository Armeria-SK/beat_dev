import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../config/schema.ts';
import type { Conversations } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import { Runs } from '../db/runs.ts';
import { UNATTENDED_ITERATION_CEILING, type ChatEngine } from '../engine/chat.ts';
import type { EngineResult } from '../engine/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import { curiosityText } from '../curiosity/text.ts';
import { bookPressureText, conversationWindow, isNoProposal, productMemoryBudget, productMemoryText, reviewEvidence, reviewPrompt, reviewUptoKey, type ReviewEvidence, reviewWindowLimits, seedSkillUpto, SKILL_REVIEW_TOOLS, skillUpto, skillUptoKey, TIDY_FORBIDDEN_TOOLS, TRIGGER_TEXT, type ReviewJob, type ReviewJobs, type ReviewKind, type WindowLimits } from '../memory/review.ts';
import { planBooks, type MemoryStore } from '../memory/store.ts';
import type { ProductMemory } from '../memory/files.ts';
import type { Notifications } from '../notify/notifications.ts';
import { languageOf } from '../shared/language.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { askBeforeRegister, growSkills } from '../tools/skills/store.ts';
import { resolveConfigPath } from '../tools/hooks/scope.ts';
import type { TaskControl } from '../tools/types.ts';
import { OWNER_FIX, OWNER_RUN_KV, SCOUT_RUN, type Task, type TaskStore } from './store.ts';
import type { ScoutRoute } from '../engine/chat.ts';
import type { PlanStore } from '../projects/plan.ts';
import type { ProjectRow } from '../projects/store.ts';
import { CREDIT_ERROR, nextMidnight, noteCloudRun, cloudRunsLastHour, pickScoutProject, restScout, restUntil, saveScoutState, scoutBuilt, scoutBusy, scoutFailed, scoutMaterials, scoutProjects, scoutsOn, scoutState, SCOUT_SHORT_WAIT_MS } from '../scout/run.ts';
import { dropUnrecordedFixes, fixCandidate, markFixTried, recordFix } from '../scout/fix.ts';
import { runFix } from '../scout/fix-run.ts';
import type { FixCopies } from '../scout/fix-copy.ts';
import { clearSleep, currentMarks, ownerRejectedSince, quickMarks, readSleep, sameQuickMarks, saveSleep, SCOUT_FLAT_RUNS, type Marks, type SleepReason } from '../scout/sleep.ts';
import { headOf, treeMark } from '../scout/areas.ts';
import { readLedger } from '../scout/ledger.ts';
import { PROPOSAL_OPEN_MAX } from '../tools/builtin/proposal.ts';
import { scoutText, type ScoutMessageKey } from '../shared/messages/scout.ts';
import { CHECK_FAIL_LIMIT, CHECK_KEEP, CHECK_OPTIONS, CHECK_TEXT } from '../projects/check-run.ts';
import { GATE_LIMIT, itemSummary, workAgreement } from '../projects/gate.ts';
import { gateText } from '../shared/messages/gate.ts';
import { projectFolderGone } from '../projects/run.ts';
import { needsSnapshot, SNAPSHOT_EVENT, snapshotBeforeBuild, snapshotLine } from '../projects/snapshot-before.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { QuestionStore } from '../questions/store.ts';
import { decidedDuring, openPendingIds } from './pending-wake.ts';
import type { TaskPlaces } from './place.ts';
import { mainGitChanges, mainGitPrint, type MainGitPrint, type Worktrees } from '../projects/worktree.ts';
import type { BackgroundJobs } from '../tools/shell/background.ts';

const IDLE_POLL_MS = 5 * 60_000;
const mayBranch = (c: AppConfig): boolean => c.worker.worktrees !== false && c.worker.maxParallel >= 2;
const LEASE_MS = 30 * 60_000;
const RETRY_DELAYS_MIN = [1, 5, 15];
const STAGNATION_LIMIT = 3;
// 区切り（人のいない実行の回数の上限）が続いたとき、持ち主に 1 回だけ知らせる数。止めはしない
// 終わり方を決めずに区切りで終わった回がこの数だけ続いたら、1 回だけ知らせる
const LONG_RUN_NOTICE = 10;
// Build の仲間（根と、spawned_by でたどれる子孫）が 1 時間に動ける回数の保険。上限で待たない Build の、まだ見つけていない回りっぱなしを止める（ふつうの Build は届かない。持ち主が変えられる仮の数）
const BUILD_FAMILY_HOURLY_MAX = 60;
export const splitKey = (id: string): string => `task-split:${id}`;
const STOPPED_RESUME_MS = 20_000;
const SKILL_REVIEW_IDLE_MS = 5 * 60_000;

export type TickResult = 'ran' | 'idle' | 'busy' | 'paused' | 'budget' | 'no_model' | 'folder_missing';

export interface WorkerDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  engine: ChatEngine;
  conversations: Conversations;
  notifications: Notifications;
  kv: KV;
  config: () => AppConfig;
  log: (line: string) => void;
  now?: () => number;
  autoSchedule?: boolean;
  reviews?: ReviewJobs | undefined;
  memory?: MemoryStore | undefined;
  botMemory?: boolean | undefined;
  memoryFiles?: ProductMemory | undefined;
  curiosity?: CuriosityStore | undefined;
  memoryBudget?: (() => number | undefined) | undefined;
  backgroundAvailable?: (() => number | undefined) | undefined;
  secrets?: (() => readonly string[]) | undefined;
  projects?: ProjectStore | undefined;
  questions?: QuestionStore | undefined;
  pendingWake?: (() => unknown) | undefined;
  plans?: PlanStore | undefined;
  onScoutChange?: ((projectId: string) => void) | undefined;
  places?: TaskPlaces | undefined;
  worktrees?: Pick<Worktrees, 'finishWorktree' | 'removeWorktree'> | undefined;
  background?: Pick<BackgroundJobs, 'stopWhere'> | undefined;
  fixes?: FixCopies | undefined;
}

export type WaitReason = { kind: 'owner' } | { kind: 'off' } | { kind: 'paused' } | { kind: 'chat' } | { kind: 'budget'; at: number } | { kind: 'product' } | { kind: 'slots' };

// fix: 考える番に動かした直す実行（beat 8-6b）
export interface WorkerRunning { kind: 'task' | 'review' | 'scout'; reviewKind?: ReviewKind; taskId: string | null; runId: string; title: string; projectId?: string; fix?: boolean }

interface ScoutPlan { project: ProjectRow; route: ScoutRoute; asked?: boolean; marks?: Marks }

export type ScoutView = { state: 'off' | 'idle' | 'thinking' | 'asleep' | 'resting'; examined: number; area: string | null; lastChangeAt: number | null; note: string | null };
export type ScoutAsk = { ok: true; view: ScoutView } | { ok: false; code: 'scout_off' | 'scout_no_model' | 'scout_cloud_zero' | 'scout_resting' | 'scout_not_built' | 'scout_busy' };

const NOT_SCOUT_RUN = `conversation_id NOT IN (SELECT conversation_id FROM tasks WHERE proposed_by = '${SCOUT_RUN}' AND conversation_id IS NOT NULL)`;

interface TaskText {
  intro: string;
  heading: string;
  id: string;
  title: string;
  origin: string;
  originLabel: Record<Task['origin'], string>;
  details: string;
  nextAction: string;
  doneCriteria: string;
  historyHeading: string;
  ownerReason: string;
  otherReason: string;
  howHeading: string;
  how: readonly string[];
  repliedOnly: string;
  time: (ms: number, timezone: string) => string;
}

const TASK_TEXT: Record<Language, TaskText> = {
  en: {
    intro: '[Task run] You are now working on a task from your own notepad (this is not a conversation with the user; your reply is saved to the record).',
    heading: '# Task',
    id: 'ID',
    title: 'Title',
    origin: 'Where it came from',
    originLabel: { user: "The user's request", self: 'Something you decided yourself', curiosity: 'From your curiosity', schedule: 'Scheduled' },
    details: 'Details',
    nextAction: 'Next step',
    doneCriteria: 'Done when',
    historyHeading: '# History so far (newest first)',
    ownerReason: "reason for cancelling (the user's own words)",
    otherReason: 'reason for cancelling',
    howHeading: '# How to proceed',
    how: [
      '- Make progress with your tools and keep going until the task is done. If the run grows long, beat continues it in a new run right away',
      '- When you are done, call task_complete (a summary of the result). If there is nothing to tell the user, finish quietly with notify=false',
      '- To leave a record of your progress at a milestone, call task_checkpoint (what you tried, the result, the next step); beat continues in a new run right away. If something has to be checked later, create a task for that time with task_create (when), then end this run with task_complete (it waits until the tasks you created finish) or task_checkpoint. While tasks you created are open, this task runs again only after they finish',
      '- If something is unclear, record it with question_add and keep going with the option you assume. Set blocking only when no assumption is safe',
      '- You do not need to wait for a call held in Pending for the user to decide: keep going with whatever else you can do. beat resumes the task as soon as the user decides, so there is no need to check on it. If the rest of the task depends on its result, call task_checkpoint; call task_complete only when nothing left in the task depends on that call',
      '- While a call of this task waits in Pending, task_complete does not finish the task: the task waits for the owner to decide, then continues. Withdraw a waiting call you no longer need with pending_withdraw',
      "- Write notes, questions and the summary in the language the user writes in: the language of the user's own words in the title and details (for a curiosity task, the language of the topic), not the language of these instructions",
    ],
    repliedOnly: '- The previous run ended with a reply only, without task_complete or task_checkpoint. A run that ends that way counts as no progress, and the task is stopped after a few of them in a row',
    time: (ms, timezone) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(ms),
  },
};


export function taskPrompt(task: Task, events: ReadonlyArray<{ kind: string; actor?: string; content: string | null; created_at: number }>, timezone: string, language: Language = DEFAULT_LANGUAGE, agreement?: string, repliedOnly = false): string {
  const text = TASK_TEXT[language];
  const shown = events.filter(e => e.content).slice(0, 10);
  const lastRun = events.findIndex(e => e.kind === 'run' || e.kind === 'answer_moved');
  const unread = (lastRun === -1 ? events : events.slice(0, lastRun)).filter(e => e.kind === 'answer' && e.content && !shown.includes(e));
  const history = [...shown, ...unread].map(e => (e.kind === 'reason'
    ? `- ${text.time(e.created_at, timezone)} ${e.actor === 'user' ? text.ownerReason : text.otherReason}: ${e.content!.replace(/\r\n|[\r\n\p{Zl}\p{Zp}]/gu, '\n  ')}`
    : `- ${text.time(e.created_at, timezone)} ${e.kind}: ${e.content}`));
  return [
    text.intro,
    '',
    text.heading,
    `${text.id}: ${task.id.slice(0, 8)}`,
    `${text.title}: ${task.title}`,
    `${text.origin}: ${text.originLabel[task.origin]}`,
    task.body && `${text.details}:\n${task.body}`,
    task.next_action && `${text.nextAction}: ${task.next_action}`,
    task.done_criteria && `${text.doneCriteria}: ${task.done_criteria}`,
    agreement && `
${agreement}`,
    history.length ? `\n${text.historyHeading}\n${history.join('\n')}` : '',
    '',
    text.howHeading,
    ...text.how,
    repliedOnly && text.repliedOnly,
  ].filter((line): line is string => typeof line === 'string').join('\n').replace(/\n{3,}/gu, '\n\n');
}

export class Worker {
  readonly #d: WorkerDeps;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextWakeAt: number | undefined;
  // 動いている裏の実行（キーは runId）。入れた順 = 始めた順。worker.maxParallel 本まで
  readonly #running = new Map<string, WorkerRunning>();
  // 閉じようとして閉じられなかった作業コピーの行（このプロセスでは毎回は試し直さない）
  readonly #closeTried = new Set<string>();
  #forced = new Set<string>();
  readonly #scoutStops = new Map<string, ScoutMessageKey>();
  // Think now で頼まれた製品（押した回数ではなく「1 回動かす」の印。動き出したら外す）と、その頼みで動いている実行
  readonly #scoutAsked = new Set<string>();
  readonly #scoutAskedRuns = new Set<string>();
  // 直す実行の確かめのコマンドを止める合図（キーは runId。止める条件で直す実行と一緒に止める）
  readonly #fixAborts = new Map<string, AbortController>();
  // 材料を読んでいて、まだ #running に入っていない考える実行の製品（そのあいだの Think now を重ねないため）
  #scoutStarting: ScoutPlan | undefined;
  // 作業フォルダの印を最後に比べた時刻（製品ごと）。見回りの間隔より短くは比べない
  readonly #treeCheckedAt = new Map<string, number>();
  #ticking = false;
  // tick の最中に来た poke（その tick の予定に上書きされて消えないように、終わったらもう一度回す）
  #pokedWhileTicking = false;
  #stopped = true;

  constructor(deps: WorkerDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  #language(): Language { return languageOf(this.#d.config()); }

  get paused(): boolean { return this.#d.kv.get('worker:paused') === '1'; }

  setPaused(paused: boolean): void {
    this.#d.kv.set('worker:paused', paused ? '1' : '0');
    this.#d.log(`[INFO] Worker ${paused ? 'paused' : 'resumed'}`);
    this.poke();
  }

  start(): void {
    this.#stopped = false;
    const recovered = this.#d.tasks.recoverExpiredLeases({ all: true });
    if (recovered) this.#d.log(`[INFO] Put ${recovered} task(s) that had stopped midway back in the queue`);
    const reviews = this.#d.reviews?.recoverRunning() ?? 0;
    if (reviews) this.#d.log(`[INFO] Re-queued ${reviews} review(s) that had stopped midway`);
    if (this.#d.botMemory !== true) this.#d.reviews?.skipPending('memory', taskText(this.#language(), 'review.memory_nothing'), { outsideProduct: true });
    seedSkillUpto(this.#d.db, this.#now());
    this.#d.pendingWake?.();
    this.poke();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  requestRun(taskId: string): void {
    this.#forced.add(taskId);
    this.#d.kv.set(`${OWNER_RUN_KV}${taskId}`, '1');
    this.poke();
  }

  stopTask(taskId: string): boolean {
    for (const run of this.#running.values()) if (run.kind === 'task' && run.taskId === taskId) return this.#d.engine.stop(run.runId);
    return false;
  }

  poke(): void {
    if (this.#stopped || this.#d.autoSchedule === false) return;
    if (this.#ticking) this.#pokedWhileTicking = true;
    this.#schedule(0);
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    this.#nextWakeAt = this.#now() + delayMs;
    this.#timer = setTimeout(() => {
      this.tick().catch(error => {
        this.#d.log(`[ERROR] Worker: ${(error as Error).stack ?? error}`);
        if (!this.#stopped) this.#schedule(IDLE_POLL_MS);
      });
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
  }

  #taskTainted(taskId: string): boolean {
    const conversationId = this.#d.tasks.get(taskId)?.conversation_id ?? null;
    return this.#d.tasks.textTainted(taskId) || (conversationId !== null && new Runs(this.#d.db).anyTaintedTask(conversationId));
  }

  runsLastHour(): number {
    // タスクと振り返り（どちらも裏で動く実行）を数える。会話は数えない
    return (this.#d.db.prepare(`SELECT COUNT(*) AS n FROM engine_runs WHERE kind IN ('task', 'review') AND started_at > ? AND ${NOT_SCOUT_RUN}`).get(this.#now() - 3_600_000) as { n: number }).n;
  }

  skillReviewsOn(c: AppConfig = this.#d.config()): boolean { return c.worker.enabled && c.memory.review && growSkills(c); }

  memoryReviewsOn(ref?: { conversationId?: string | null | undefined; taskId?: string | null | undefined }, c: AppConfig = this.#d.config()): boolean {
    return c.memory.review && (this.#d.botMemory === true || (ref !== undefined && this.#productOf(ref) !== null));
  }

  #productOf(ref: { conversationId?: string | null | undefined; taskId?: string | null | undefined }): string | null {
    const id = (ref.conversationId ? this.#d.conversations.projectOf(ref.conversationId) : null) ?? (ref.taskId ? this.#d.tasks.get(ref.taskId)?.project_id ?? null : null);
    return id !== null && (!this.#d.projects || this.#d.projects.get(id)?.archived_at === null) ? id : null;
  }


  #ownerWork(task: Task): boolean {
    const chain: Task[] = [];
    for (let link: Task | undefined = task; link && !chain.some(seen => seen.id === link!.id); link = link.spawned_by ? this.#d.tasks.get(link.spawned_by) : undefined) {
      if (this.#forced.has(link.id) || this.#d.kv.get(`${OWNER_RUN_KV}${link.id}`) !== undefined) return true;
      chain.push(link);
    }
    return !this.#d.tasks.beatDecided(task.id) && !chain.some(link => this.#beatSchedule(link));
  }

  // Build の根（受け入れの項目を持つ・生んだタスクが無い・直しのタスクでない）か、spawned_by をたどってそこに着くタスク。
  // 持ち主が押した仕事なので、1 時間の上限では待たせない（回数には数える）
  #familyRoot(task: Task): Task | undefined {
    const seen = new Set<string>();
    let root: Task | undefined = task;
    while (root?.spawned_by && !seen.has(root.id)) { seen.add(root.id); root = this.#d.tasks.get(root.spawned_by); }
    return root !== undefined && root.spawned_by === null && root.acceptance_items !== null
      && this.#d.db.prepare('SELECT 1 FROM task_events WHERE task_id = ? AND kind = ? LIMIT 1').get(root.id, OWNER_FIX) === undefined ? root : undefined;
  }

  #buildFamily(task: Task): boolean {
    return this.#familyRoot(task) !== undefined;
  }

  // Build の仲間がこの 1 時間に BUILD_FAMILY_HOURLY_MAX 回動いていれば、窓が空く時刻（それまで仲間は動かない）。notify なら持ち主に 1 回知らせる
  // cache を渡すと、同じ根の数え直しをしない（1 回の tick の中で、候補ごとに数えない）
  #familyFreeAt(task: Task, now: number, notify = false, cache?: Map<string, number | undefined>): number | undefined {
    const root = this.#familyRoot(task);
    if (!root) return undefined;
    if (cache?.has(root.id)) return cache.get(root.id);
    const at = this.#familyCount(root, now, notify);
    cache?.set(root.id, at);
    return at;
  }

  #familyCount(root: Task, now: number, notify: boolean): number | undefined {
    const runs = this.#d.db.prepare(`WITH RECURSIVE fam(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN fam ON t.spawned_by = fam.id)
      SELECT e.created_at AS at FROM task_events e WHERE e.kind = 'run' AND e.created_at > ? AND e.task_id IN (SELECT id FROM fam) ORDER BY e.created_at`).all(root.id, now - 3_600_000) as Array<{ at: number }>;
    if (runs.length < BUILD_FAMILY_HOURLY_MAX) return undefined;
    if (notify) {
      const language = this.#language();
      this.#d.notifications.notify({ kind: 'info', title: taskText(language, 'notify.build_cap.title', { title: root.title }), body: taskText(language, 'notify.build_cap.body', { max: BUILD_FAMILY_HOURLY_MAX }), link: `#/tasks/${root.id}`, dedupKey: `build-cap:${root.id}`, projectId: root.project_id });
    }
    return runs[runs.length - BUILD_FAMILY_HOURLY_MAX]!.at + 3_600_000;
  }

  #beatSchedule(task: Task): boolean {
    if (!task.parent_id) return false;
    return Boolean(this.#d.db.prepare(`SELECT 1 FROM tasks p WHERE p.id = ? AND p.cron IS NOT NULL
      AND EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = p.id AND e.kind = 'created' AND e.actor = 'beat')
      AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = p.id AND e.kind = 'approved')`).get(task.parent_id));
  }

  #budgetFreeAt(c: AppConfig, now: number): number | undefined {
    const over = this.runsLastHour() - c.worker.maxRunsPerHour;
    if (over < 0) return undefined;
    const row = this.#d.db.prepare(`SELECT started_at FROM engine_runs WHERE kind IN ('task', 'review') AND started_at > ? AND ${NOT_SCOUT_RUN} ORDER BY started_at LIMIT 1 OFFSET ?`).get(now - 3_600_000, over) as { started_at: number } | undefined;
    return (row?.started_at ?? now) + 3_600_000;
  }

  #hold(): 'paused' | 'chat' | undefined {
    if (this.paused) return 'paused';
    if (this.#d.engine.chatting) return 'chat';
    return undefined;
  }

  waitReason(task: Task): WaitReason | null {
    const c = this.#d.config();
    const now = this.#now();
    return this.#waitReason(task, c, now, this.#hold(), this.#budgetFreeAt(c, now), this.#d.engine.backgroundHasRoom());
  }

  #waitReason(task: Task, c: AppConfig, now: number, hold: 'paused' | 'chat' | undefined, budgetAt: number | undefined, room: boolean): WaitReason | null {
    if (task.status !== 'ready' || (task.run_at !== null && task.run_at > now) || task.attempts >= task.max_attempts) return null;
    if (!this.#ownerWork(task)) return task.origin === 'self' || task.origin === 'curiosity' ? { kind: 'owner' } : c.worker.enabled ? null : { kind: 'off' };
    if (this.#d.tasks.openChildren(task.id) > 0) return null;
    if (hold) return { kind: hold };
    const familyAt = this.#forced.has(task.id) ? undefined : this.#familyFreeAt(task, now);
    if (familyAt !== undefined) return { kind: 'budget', at: familyAt };
    if (budgetAt !== undefined && !this.#forced.has(task.id) && !this.#buildFamily(task)) return { kind: 'budget', at: budgetAt };
    if (this.#busy(task)) return { kind: 'product' };
    if (this.#running.size >= c.worker.maxParallel || !room) return { kind: 'slots' };
    return null;
  }

  // そのタスクの置き場（本体か作業コピー）が埋まっているか（beat 8-2。置き場を見ないときは今までどおり本体だけ）
  #busy(task: Task): boolean {
    return this.#d.places ? this.#d.places.busy(task) : this.#d.tasks.productBusy(task);
  }

  status() {
    const c = this.#d.config();
    const now = this.#now();
    const hold = this.#hold();
    const budgetAt = this.#budgetFreeAt(c, now);
    const room = this.#d.engine.backgroundHasRoom();
    const waiting: Record<string, WaitReason> = {};
    for (const task of this.#d.tasks.list({ statuses: ['ready'] })) {
      const reason = this.#waitReason(task, c, now, hold, budgetAt, room);
      if (reason) waiting[task.id] = reason;
    }
    return {
      enabled: c.worker.enabled, paused: this.paused,
      running: [...this.#running.values()][0] ?? null, runningAll: [...this.#running.values()], maxParallel: c.worker.maxParallel, nextWakeAt: this.#nextWakeAt ?? null,
      runsLastHour: this.runsLastHour(), maxRunsPerHour: c.worker.maxRunsPerHour, waiting,
    };
  }

  async tick(): Promise<TickResult> {
    const c = this.#d.config();
    if (this.#scoutRunning()) this.#whileScout(c);
    // 選ぶ部分は 1 本ずつ（#ticking）。実行を始めたら（await の前に）外して、枠が残っていれば次を選べるようにする
    if (this.#ticking || this.#running.size >= c.worker.maxParallel) return 'busy';
    this.#ticking = true;
    this.#pokedWhileTicking = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#ticking = false;
      this.#pokedWhileTicking = false;
      if (this.#running.size < this.#d.config().worker.maxParallel) this.poke();
    };
    try {
      const now = this.#now();
      const { tasks } = this.#d;
      const reschedule = (at?: number) => {
        if (this.#stopped || this.#d.autoSchedule === false) return;
        this.#schedule(Math.max(1000, Math.min(at ?? Infinity, now + IDLE_POLL_MS) - now));
      };
      const own = c.worker.enabled;
      const familyCache = new Map<string, number | undefined>();
      const eligible = (t: Task): boolean => (own || this.#ownerWork(t)) && this.#familyFreeAt(t, now, true, familyCache) === undefined;
      const pick = (accept: (t: Task) => boolean): Task | undefined => tasks.pickNext({ accept: t => eligible(t) && accept(t), ...(this.#d.places ? { placeFree: (t: Task) => !this.#busy(t) } : {}) });
      // モデルが 1 つも無いのは「まだ設定していない」だけ。何も選ばず（空の会話も通知も作らず）休む
      if (!c.models.length) { reschedule(); return 'no_model'; }

      // 予定から実行用のタスクを作る（モデルは呼ばない）
      tasks.spawnDueSchedules();
      const stranded = this.#stranded();
      if (stranded.length) await this.#closeStranded(stranded);
      this.#d.pendingWake?.();
      if (own) this.#detectReviewTriggers(c, now);
      const skillOn = this.skillReviewsOn(c);
      if (!skillOn) this.#d.reviews?.skipPending('skill', taskText(languageOf(c), 'review.skill_off'));
      const hold = this.#hold();
      if (hold === 'paused') { reschedule(); return 'paused'; }
      // ユーザーとの会話の返事を作っている間は始めない（終われば onRunEnd で起こされる）
      if (hold === 'chat') { reschedule(now + 60_000); return 'busy'; }
      // 「今すぐ実行」を頼まれたものは、1時間の上限より先に実行する（上限は、ひとりでに動く分の費用を抑えるためのもの）
      let task: Task | undefined;
      // 提供元の空きは、動いている裏の実行それぞれの「最初に使う提供元」で数える（計画の「各実行の providers で数える」より意図して狭い:
      // 全部で数えると、まだ使っていない鎖の後ろの提供元の枠まで塞ぐ。後ろへ回った分の同時数は limiter が抑える）
      const roomFor = (): boolean => this.#d.engine.backgroundHasRoom();
      for (const id of [...this.#forced]) {
        const forced = tasks.get(id);
        if (forced?.status !== 'ready' || forced.attempts >= forced.max_attempts) { this.#forced.delete(id); continue; }
        // 提供元が満杯のあいだは覚えておく（空けば、終わった実行の onRunEnd で拾う）
        if (!roomFor() || this.#busy(forced)) continue;
        this.#forced.delete(id);
        task = forced;
        break;
      }
      const freeAt = this.#budgetFreeAt(c, now);
      let freeAtWake = Infinity;
      // Build の仲間も「今すぐ実行」と同じに上限より先に動く
      if (!task && freeAt !== undefined) task = pick(t => this.#buildFamily(t) && roomFor());
      if (!task && freeAt !== undefined) {
        // 「今すぐ実行」・Build の仲間で提供元の空きを待っているタスクは、上限より先に動くもの（空き待ちであって上限待ちではない）なので、上限の知らせの数に入れない
        if (pick(t => !this.#forced.has(t.id) && !this.#buildFamily(t))) {
          this.#d.notifications.notify({
            kind: 'info', title: taskText(languageOf(c), 'notify.budget.title'),
            body: taskText(languageOf(c), 'notify.budget.body', { max: c.worker.maxRunsPerHour }),
            link: '#/tasks', dedupKey: `budget:${Math.floor(now / 3_600_000)}`,
          });
        } else if ((own || this.#scoutAsked.size > 0) && this.#forced.size === 0 && !pick(t => this.#buildFamily(t))) {
          const scout = await this.#scoutPlan(c, now, own);
          if (scout.plan) {
            const outcome = await this.#runScout(scout.plan, c, now, release);
            reschedule(outcome === 'idle' ? now + SCOUT_SHORT_WAIT_MS : now);
            return outcome;
          }
          if (scout.wakeAt !== undefined) freeAtWake = scout.wakeAt;
        }
        reschedule(Math.min(freeAt, freeAtWake));
        return 'budget';
      }

      const idleEnough = now - this.#d.engine.lastUserActivity >= SKILL_REVIEW_IDLE_MS;
      task ??= pick(roomFor);
      // 実行待ちはあるが、先に使う提供元が満杯で選べない: 何も始めず（振り返りにも回さず）、終わった実行の onRunEnd を待つ
      // （poke が来ない道〔止まっている・自動の予定が無い〕に備えて、保険の予定は 1 分後に置く。終わった実行の poke はそれより早い）
      if (!task && (this.#forced.size > 0 || pick(() => true))) { reschedule(now + 60_000); return 'busy'; }
      // 実行するタスクが無ければ、振り返りを見る
      const holdPiled = this.runsLastHour() >= Math.ceil(c.worker.maxRunsPerHour / 2);
      const reviewing = own && c.memory.review;
      const kinds: ReviewKind[] = skillOn && idleEnough ? ['memory', 'skill'] : ['memory'];
      const job = !task && reviewing ? this.#d.reviews?.next({ skipPiled: holdPiled, kinds }) : undefined;
      const held = !task && !job && holdPiled && reviewing && this.#d.reviews?.next({ kinds }) !== undefined;
      let reviewWait: number | undefined;
      if (job) {
        const outcome = await this.#review(job, release);
        if (outcome !== 'no_model') { reschedule(outcome === 'busy' ? now + 60_000 : now); return outcome; }
        reviewWait = now + 60_000;
      }
      if (!task) {
        const scout = (own || this.#scoutAsked.size > 0) && this.#forced.size === 0 ? await this.#scoutPlan(c, now, own) : {};
        if (scout.plan) {
          const outcome = await this.#runScout(scout.plan, c, now, release);
          reschedule(outcome === 'idle' ? now + SCOUT_SHORT_WAIT_MS : now);
          return outcome;
        }
        reschedule(Math.min(tasks.nextWakeAt({ mayBranch: mayBranch(c) }) ?? Infinity, scout.wakeAt ?? Infinity, reviewWait ?? Infinity));
        return reviewWait !== undefined ? 'no_model' : held ? 'budget' : 'idle';
      }
      const outcome = await this.#run(task, release);
      reschedule(now);
      return outcome;
    } finally {
      if (!released) {
        this.#ticking = false;
        if (this.#pokedWhileTicking) { this.#pokedWhileTicking = false; this.poke(); }
      }
    }
  }

  #detectReviewTriggers(c: AppConfig, now: number): void {
    const { reviews, memory, kv } = this.#d;
    if (!reviews || !c.memory.review) return;
    // 機能を入れる前の古い会話を一度に振り返らないよう、最初に動いた時刻より後の会話だけを見る
    let since = Number(kv.get('review:since'));
    if (!Number.isFinite(since) || since <= 0) { since = now; kv.set('review:since', String(now)); }
    // 製品の記憶の振り返り（Bot モードの外）も同じ: 初めて動いた時刻より前の製品の会話は振り返らない（10-3 を入れた直後に、溜まった会話の振り返りが一度に積まれないように）
    if (this.#d.botMemory !== true) {
      let productSince = Number(kv.get('review:product-since'));
      if (!Number.isFinite(productSince) || productSince <= 0) { productSince = now; kv.set('review:product-since', String(now)); }
      since = Math.max(since, productSince);
    }
    reviews.enqueueIdleConversations(c.memory.reviewIdleMinutes * 60_000, since, { productOnly: this.#d.botMemory !== true });
    // 記憶が会話に入れる量の予算を超えたら、整理の振り返りを 1 日 1 回積む（予算が決まらないとき・モデルが 0 個のときは積まない）
    const budget = this.#d.memoryBudget?.();
    if (this.#d.botMemory && memory && budget !== undefined && planBooks(memory.list(), languageOf(c), budget).omitted.length > 0) {
      reviews.enqueue('book_full', `book:all:${Math.floor(now / 86_400_000)}`);
    }
  }

  #reviewLimits(): WindowLimits { return reviewWindowLimits(this.#d.backgroundAvailable?.()); }

  #reviewInput(job: ReviewJob): { prompt?: string; upto?: number | undefined; evidence?: ReviewEvidence | undefined } {
    const { db, tasks, memory, kv } = this.#d;
    const language = languageOf(this.#d.config());
    const skillsAutoRegister = !askBeforeRegister(this.#d.config());
    const kind = job.kind;
    const forgotten = kind === 'skill' || this.#d.botMemory !== true ? [] : (db.prepare("SELECT before FROM memory_events WHERE action = 'forget' AND actor = 'user' AND before IS NOT NULL ORDER BY id DESC LIMIT 20").all() as Array<{ before: string }>).map(r => r.before);
    if (job.trigger === 'book_full') {
      const budget = this.#d.memoryBudget?.();
      const plan = memory && budget !== undefined ? planBooks(memory.list(), language, budget) : undefined;
      const pressure = plan && budget !== undefined && plan.omitted.length > 0 ? bookPressureText({ tokens: plan.tokens, budget, outside: plan.omitted }, language) : undefined;
      return { prompt: reviewPrompt({ trigger: job.trigger, forgotten, bookPressure: pressure, language, kind: 'memory' }) };
    }
    const projectId = kind === 'memory' && this.#d.botMemory !== true && this.#d.memoryFiles ? this.#productOf({ conversationId: job.conversation_id, taskId: job.task_id }) : null;
    const productMemory = () => projectId !== null ? productMemoryText(this.#d.memoryFiles!, projectId, productMemoryBudget(this.#d.backgroundAvailable?.()), this.#d.secrets?.() ?? []) : undefined;
    if (job.trigger === 'task') {
      const task = job.task_id ? tasks.get(job.task_id) : undefined;
      if (!task) return {};
      const taskEvents = tasks.events(task.id, 30);
      return { prompt: reviewPrompt({ trigger: job.trigger, task, taskEvents, forgotten, productMemory: productMemory(), fileMemory: projectId !== null, language, skillsAutoRegister, kind }), evidence: projectId !== null ? reviewEvidence({ task, taskEvents }, language) : undefined };
    }
    if (!job.conversation_id) return {};
    // 前回振り返った発言より後だけを渡す（同じ発言を二度振り返らない）
    const upto = kind === 'skill' ? skillUpto(db, job.conversation_id) : Number(kv.get(reviewUptoKey(job.conversation_id)) ?? 0);
    const window = conversationWindow(db, job.conversation_id, upto, this.#reviewLimits(), language, kind, this.#d.secrets?.() ?? []);
    const owner = window.messages.some(m => m.message.role === 'user' && m.message.note === undefined);
    if (!owner && (kind === 'memory' || !window.messages.some(m => m.role === 'tool'))) return { upto: window.lastId };
    // 持ち主の言葉は、チャットの会話の持ち主の発言だけ（タスクの会話の user の発言は beat が作った依頼文。beat の注記・beat が作った発言も外す）
    const ownerMessages = this.#d.conversations.get(job.conversation_id)?.kind === 'chat'
      ? window.messages.filter(m => m.role === 'user' && m.message.role === 'user' && m.message.note === undefined && !m.message.generated).map(m => m.text) : [];
    return { prompt: reviewPrompt({ trigger: job.trigger, transcript: window.transcript, forgotten, productMemory: productMemory(), fileMemory: projectId !== null, language, skillsAutoRegister, kind }), upto: window.lastId, evidence: projectId !== null ? reviewEvidence({ transcript: window.transcript, ownerMessages }, language) : undefined };
  }

  #reviewed(conversationId: string, upto: number | undefined, kind: ReviewKind): void {
    if (kind === 'skill') {
      if (upto !== undefined) this.#d.kv.set(skillUptoKey(conversationId), String(upto));
      if (this.skillReviewsOn()) this.#d.reviews?.enqueueSkillIfDue(conversationId);
      return;
    }
    if (upto !== undefined) this.#d.kv.set(reviewUptoKey(conversationId), String(upto));
    if (this.memoryReviewsOn({ conversationId })) this.#d.reviews?.enqueueIfPiled(conversationId, this.#reviewLimits());
  }

  #noReviewModel(detail: string, language: Language): void {
    this.#d.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.review_no_model'), body: detail, link: '#/settings', dedupKey: 'no-model-for-review' });
  }

  async #review(job: ReviewJob, release: () => void): Promise<TickResult> {
    const { reviews, conversations, engine, kv } = this.#d;
    if (!reviews) return 'idle';
    const language = this.#language();
    if (job.trigger === 'book_full' && !this.#d.botMemory) { reviews.finish(job.id, 'done', taskText(language, 'review.tidy_skipped')); return 'idle'; }
    if (job.kind === 'memory' && !this.#d.botMemory && this.#productOf({ conversationId: job.conversation_id, taskId: job.task_id }) === null) { reviews.finish(job.id, 'done', taskText(language, 'review.memory_nothing')); return 'idle'; }
    const { prompt, upto, evidence } = this.#reviewInput(job);
    if (!prompt) {
      reviews.finish(job.id, 'done', taskText(language, 'review.nothing'));
      if (upto !== undefined && job.conversation_id) this.#reviewed(job.conversation_id, upto, job.kind);
      return 'idle';
    }
    // 先に使う提供元が満杯なら、まだ claim せずに待つ（終わった実行の onRunEnd で呼び直される）
    if (!engine.backgroundHasRoom()) return 'busy';
    // 使えるモデルが無ければ、会話を作る前に断る（作ってから断ると、呼び直すたびに空の振り返りの会話が増える）
    const blocked = engine.backgroundBlocked();
    if (blocked !== undefined) { this.#noReviewModel(blocked, language); return 'no_model'; }
    const lastMessageId = job.trigger === 'task' && job.conversation_id ? conversations.messages(job.conversation_id, 1).at(-1)?.id : undefined;
    // 止められて・再起動でやり直す振り返りは、前の回の振り返りの会話に続きを書く（新しく作ると、前の回の会話が記録から外れる）。会話は作るときに材料も覚える
    const source = { conversationId: job.conversation_id, taskId: job.task_id };
    const earlier = job.review_conversation_id ? conversations.get(job.review_conversation_id) : undefined;
    if (earlier?.kind === 'task') conversations.setSource(earlier.id, source);
    const skill = job.kind === 'skill';
    const label = TRIGGER_TEXT[language][job.kind][job.trigger];
    const conversation = earlier?.kind === 'task' ? earlier : conversations.create({ kind: 'task', title: taskText(language, skill ? 'title.skill_review' : 'title.review', { label }), source, projectId: (job.conversation_id ? conversations.projectOf(job.conversation_id) : null) ?? (job.task_id ? this.#d.tasks.get(job.task_id)?.project_id : null) });
    const started = engine.runReview(conversation.id, prompt, skill ? { onlyTools: SKILL_REVIEW_TOOLS } : { forbidTools: job.trigger === 'book_full' ? TIDY_FORBIDDEN_TOOLS : ['skill_draft'], evidence });
    if (!started.ok) { this.#noReviewModel(started.errorMessage, language); return 'no_model'; }
    reviews.claim(job.id, started.runId, conversation.id);
    this.#running.set(started.runId, { kind: 'review', reviewKind: job.kind, taskId: job.task_id, runId: started.runId, title: taskText(language, skill ? 'title.skill_review_running' : 'title.review_running', { label }) });
    release();
    try {
      const result = await started.done;
      if (engine.wasPreempted(started.runId)) { reviews.requeue(job.id); return 'ran'; }
      if (result.ok && result.truncated) {
        // 切れた振り返りは、最後まで書けていないので使わない（見た発言の位置も進めず、整理の案も出さない。次のきっかけでやり直す）
        reviews.finish(job.id, 'failed', taskText(language, 'review.truncated'));
      } else if (result.ok) {
        reviews.finish(job.id, 'done', result.text.trim().slice(0, 1000) || taskText(language, 'review.no_reply'));
        if (job.trigger === 'book_full') this.#proposeTidy(job, result.text, language);
        if (job.trigger === 'task') { if (!skill && job.conversation_id && lastMessageId) kv.set(reviewUptoKey(job.conversation_id), String(lastMessageId)); }
        else if (job.conversation_id && job.trigger !== 'book_full') this.#reviewed(job.conversation_id, upto, job.kind);
      } else {
        // 振り返りは再試行しない（失敗が続いて費用が膨らむのを防ぐ）。次のきっかけでまた積まれる
        reviews.finish(job.id, 'failed', result.errorMessage);
      }
    } finally { this.#running.delete(started.runId); }
    return 'ran';
  }

  // 整理の振り返りは記憶を消さない。返事に書かれた「消す・まとめる案」を、記憶のページへのリンクつきで知らせる
  #proposeTidy(job: ReviewJob, reply: string, language: Language): void {
    const text = reply.trim();
    if (!text || isNoProposal(text)) return;
    this.#d.notifications.notify({ kind: 'info', title: taskText(language, 'notify.memory_tidy'), body: text.slice(0, 1000), link: '#/memory', dedupKey: `memory-tidy:${job.dedup_key}` });
  }

  #spawnCuriosity(c: AppConfig, now: number): Task | undefined {
    const { curiosity, tasks } = this.#d;
    if (!curiosity || c.worker.curiosityPerDay <= 0) return undefined;
    if (tasks.createdSince('curiosity', now - 86_400_000) >= c.worker.curiosityPerDay) return undefined;
    const item = curiosity.nextOpen();
    if (!item) return undefined;
    const text = curiosityText(languageOf(c));
    const task = tasks.create({
      title: text.title(item.topic).slice(0, 200),
      body: [item.why && text.why(item.why), text.summarize].filter(Boolean).join('\n'),
      doneCriteria: text.doneCriteriaQuiet,
      origin: 'curiosity', priority: 3, curiosityId: item.id, propose: true, actor: 'worker',
    });
    curiosity.update(item.id, { status: 'researching', taskId: task.id });
    return task.status === 'ready' ? task : undefined;
  }

  #scoutRunning(): WorkerRunning | undefined { return [...this.#running.values()].find(run => run.kind === 'scout'); }

  // 動いている考える実行を止める理由（D-4・Approach 2）。Off・一時停止・考える役のモデルなし・しまった・モード off・持ち主のタスクがすぐ始められる
  #scoutStopReason(c: AppConfig, run: WorkerRunning): ScoutMessageKey | undefined {
    if (!c.worker.enabled && !this.#scoutAskedRuns.has(run.runId)) return 'stop.off';
    if (this.paused) return 'stop.paused';
    if (!(c.routing.scout ?? []).length) return 'stop.route';
    const project = run.projectId ? this.#d.projects?.get(run.projectId) : undefined;
    if (!project || project.archived_at !== null) return 'stop.archived';
    if (!scoutsOn(project.scout_mode)) return 'stop.mode';
    if (run.fix && project.scout_mode !== 'fix') return 'stop.fix_mode';
    const freeAt = this.#budgetFreeAt(c, this.#now());
    const familyCache = new Map<string, number | undefined>();
    if (this.#d.tasks.pickNext({ accept: t => this.#ownerWork(t) && this.#familyFreeAt(t, this.#now(), false, familyCache) === undefined && (freeAt === undefined || this.#forced.has(t.id) || this.#buildFamily(t)) })) return 'stop.owner';
    return undefined;
  }

  #whileScout(c: AppConfig): void {
    const now = this.#now();
    if (c.models.length) this.#d.tasks.spawnDueSchedules();
    this.#guardScout(c);
    if (this.#stopped || this.#d.autoSchedule === false || !this.#scoutRunning()) return;
    const at = Math.min(this.#d.tasks.nextWakeAt({ mayBranch: mayBranch(c) }) ?? Infinity, this.#budgetFreeAt(c, now) ?? Infinity, now + IDLE_POLL_MS);
    this.#schedule(Math.max(1000, at - now));
  }

  #guardScout(c: AppConfig): void {
    const run = this.#scoutRunning();
    if (!run || this.#scoutStops.has(run.runId)) return;
    const why = this.#scoutStopReason(c, run);
    if (!why) return;
    this.#scoutStops.set(run.runId, why);
    this.#d.engine.stop(run.runId);
    this.#fixAborts.get(run.runId)?.abort();
  }

  async #scoutPlan(c: AppConfig, now: number, own: boolean): Promise<{ plan?: ScoutPlan; wakeAt?: number }> {
    if (this.#scoutRunning() || !this.#d.projects || !(c.routing.scout ?? []).length) return {};
    const route = this.#d.engine.scoutRoute();
    if (!route || !route.room) return {};
    const rest = restUntil(this.#d.kv, route.providerId);
    if (rest > now) return { wakeAt: rest };
    const eligible = scoutProjects(this.#d.db);
    for (const id of [...this.#scoutAsked]) {
      const project = this.#d.projects.get(id);
      if (!project || project.archived_at !== null || !scoutsOn(project.scout_mode) || (!route.local && (c.scout?.cloudRunsPerHour ?? 1) === 0)) {
        this.#scoutAsked.delete(id);
        this.#scoutChanged(id);
        continue;
      }
      const ready = eligible.find(p => p.id === id);
      if (ready) return { plan: { project: ready, route, asked: true } };
      // 押したあとに製品の作業が来た: worker が On ならその作業のあとに動く。Off でも、動いている作業と持ち主の作業（Off でも動く）は待つ。
      // Off のまま動かない作業（ひとりでの作業）だけが塞いでいるなら、待ち続けずに捨てる
      if (!own && scoutBusy(this.#d.db, id) && !this.#ownerBlocking(id)) {
        this.#scoutAsked.delete(id);
        this.#scoutChanged(id);
      }
    }
    if (!own) return {};
    const woken = await this.#wakeSleepers(eligible, now);
    if (!route.local) {
      const runs = cloudRunsLastHour(this.#d.kv, now);
      if (runs.length >= (c.scout?.cloudRunsPerHour ?? 1)) return runs.length ? { wakeAt: Math.min(...runs) + 3_600_000 } : {};
    }
    const picked = pickScoutProject(this.#d.db, this.#d.kv, now);
    const marks = picked.project ? woken.get(picked.project.id) : undefined;
    return picked.project ? { plan: { project: picked.project, route, ...(marks ? { marks } : {}) } } : picked.wakeAt !== undefined ? { wakeAt: picked.wakeAt } : {};
  }

  async #runScout(plan: ScoutPlan, c: AppConfig, now: number, release: () => void): Promise<TickResult> {
    this.#scoutStarting = plan;
    try { return await this.#startScout(plan, c, now, release); } finally { this.#scoutStarting = undefined; }
  }

  async #startScout(plan: ScoutPlan, c: AppConfig, now: number, release: () => void): Promise<TickResult> {
    const { tasks, conversations, engine, kv, projects } = this.#d;
    const language = languageOf(c);
    const { project, route } = plan;
    if (plan.asked) {
      this.#scoutAsked.delete(project.id);
      if (readSleep(kv, project.id)) this.#wake(project.id);
    }
    if (projectFolderGone(projects!, project.id)) {
      this.#scoutFailure(project.id, now, scoutText(language, 'note.folder'), language);
      return 'folder_missing';
    }
    // 直す番（beat 8-6b D-7）: fix の製品に直す提案があれば、考える実行の代わりに直す実行を 1 つ（Think now の回は考える）
    if (!plan.asked && project.scout_mode === 'fix' && this.#d.fixes) {
      const head = await headOf(project.root, dirname(projects!.dir)).catch(() => null);
      const proposalId = head ? fixCandidate(this.#d.db, kv, project, head) : undefined;
      if (proposalId && head) return this.#startFix(plan, proposalId, head, c, now, release);
    }
    const window = route.available ?? 32_000;
    // 休みの印は材料を読む前に取る（読んでいる間の Reject・計画書の保存を、休んだあとの変化として拾う）
    const marks: Marks | undefined = plan.asked ? undefined : plan.marks ?? await currentMarks(this.#d.db, kv, project.id, project.root, dirname(projects!.dir));
    // 前の回のあとに持ち主が Reject していれば（材料を読む前に見る。読んでいる最中の Reject は、印の変化で次の回に拾う）、休む判定を飛ばして 1 回考え直す（Q-79-1。クラウドの回数の上限は #scoutPlan がもう見た）
    const rethink = !plan.asked && ownerRejectedSince(this.#d.db, project.id, scoutState(kv, project.id).last ?? 0);
    let materials: Awaited<ReturnType<typeof scoutMaterials>>;
    try {
      materials = await scoutMaterials({
        db: this.#d.db, project, projectsDir: projects!.dir, dataDir: dirname(projects!.dir), plans: this.#d.plans,
        previousHead: scoutState(kv, project.id).head, maxAgents: c.tools.agent.maxPerRun, budgetChars: Math.max(4000, Math.floor(window * 0.4) * 3), now,
      });
    } catch (error) {
      this.#scoutFailure(project.id, now, (error as Error).message, language);
      this.#scoutChanged(project.id);
      return 'idle';
    }
    saveScoutState(kv, project.id, { examined: materials.examined });
    const sleep = plan.asked || rethink || !marks ? undefined : this.#sleepReason(project.id, materials);
    if (sleep && marks) {
      saveSleep(kv, project.id, { reason: sleep, at: now, ...marks });
      this.#treeCheckedAt.set(project.id, now);
      this.#scoutChanged(project.id);
      return 'idle';
    }
    const title = scoutText(language, 'run.title', { name: project.name }).slice(0, 200);
    const task = tasks.create({ title, origin: 'self', projectId: project.id, scoutRun: true, actor: 'worker' });
    const conversationId = randomUUID();
    if (!tasks.claim(task.id, LEASE_MS, conversationId)) { tasks.finish(task.id, 'cancelled', scoutText(language, 'run.stopped', { reason: 'busy' }), 'worker'); return 'busy'; }
    conversations.create({ id: conversationId, kind: 'task', title, projectId: project.id });
    const started = engine.runScout(task, conversationId, materials.prompt, route.modelId, scoutText(language, 'proposal.untrusted'));
    if (!started.ok) {
      tasks.finish(task.id, 'failed', started.errorMessage.split('\n')[0]!, 'worker');
      this.#scoutFailure(project.id, now, started.errorMessage.split('\n')[0]!, language);
      this.#scoutChanged(project.id);
      return 'no_model';
    }
    if (!route.local) noteCloudRun(kv, now);
    saveScoutState(kv, project.id, { last: now, ...(materials.head ? { head: materials.head } : {}), stale: materials.stale });
    this.#running.set(started.runId, { kind: 'scout', taskId: task.id, runId: started.runId, title, projectId: project.id });
    if (plan.asked) this.#scoutAskedRuns.add(started.runId);
    this.#scoutStarting = undefined;
    this.#scoutChanged(project.id);
    release();
    this.#whileScout(c);
    tasks.event(task.id, 'run', 'worker', null, started.runId);
    try {
      const result = await started.done;
      this.#closeScout(task, plan, result, started.runId, language);
      this.#notifyProposals(project, now, language);
    } finally {
      this.#running.delete(started.runId);
      this.#scoutStops.delete(started.runId);
      this.#scoutAskedRuns.delete(started.runId);
      this.#scoutChanged(project.id);
    }
    return 'ran';
  }

  // 直す実行（beat 8-6b）。考える実行と同じ枠: 同時に 1 本・routing.scout の先頭・クラウドの 1 時間の回数・休みと失敗の歯止め・止める条件（止めたら写しを捨てる）
  async #startFix(plan: ScoutPlan, proposalId: string, head: string, c: AppConfig, now: number, release: () => void): Promise<TickResult> {
    const { kv, tasks } = this.#d;
    const language = languageOf(c);
    const { project, route } = plan;
    const abort = new AbortController();
    let runId: string | undefined;
    // 前の直す実行で消しきれなかった写し（Windows で消したファイルがまだ掴まれているなど）を、新しい写しを作る前に消し直す
    await this.#d.fixes!.sweepFixCopies().catch(() => undefined);
    await dropUnrecordedFixes({ db: this.#d.db, kv, worktrees: this.#d.worktrees!, ...(this.#d.log ? { log: this.#d.log } : {}) }).catch(() => undefined);
    const result = await runFix({ tasks, conversations: this.#d.conversations, projects: this.#d.projects!, engine: this.#d.engine, fixes: this.#d.fixes! }, proposalId, {
      signal: abort.signal,
      onStart: (started, taskId) => {
        runId = started;
        if (!route.local) noteCloudRun(kv, now);
        saveScoutState(kv, project.id, { last: now });
        this.#running.set(started, { kind: 'scout', fix: true, taskId, runId: started, title: tasks.get(taskId)?.title ?? '', projectId: project.id });
        this.#fixAborts.set(started, abort);
        this.#scoutStarting = undefined;
        this.#scoutChanged(project.id);
        release();
        this.#whileScout(c);
      },
    }).finally(() => {
      if (runId) {
        this.#running.delete(runId);
        this.#fixAborts.delete(runId);
      }
    });
    const stop = runId ? this.#scoutStops.get(runId) : undefined;
    if (runId) this.#scoutStops.delete(runId);
    try {
      if (stop || (!result.ok && result.errorKind === 'cancelled')) {
        // 確かめが通ったあとに止まった直しは、持ち主に見せずにブランチごと捨てる（Pre-fix にしない）
        if (result.ok && result.result.kept) {
          const dropped = await this.#d.worktrees!.removeWorktree(result.row.id, { keepBranch: false, state: 'discarded' });
          if (!dropped.ok || dropped.branchKept) this.#d.log?.(`[WARN] Could not remove the branch ${result.row.branch} of a stopped fix`);
        }
        saveScoutState(kv, project.id, { until: now + SCOUT_SHORT_WAIT_MS });
        return 'ran';
      }
      markFixTried(kv, proposalId, head);
      const upstream = result.ok || !result.runId ? '' : new Runs(this.#d.db).get(result.runId)?.error_message ?? '';
      if (!result.ok && (result.errorKind === 'rate_limit' || CREDIT_ERROR.test(upstream) || CREDIT_ERROR.test(result.detail))) {
        const until = nextMidnight(now, c.timezone);
        restScout(kv, route.providerId, until);
        this.#d.notifications.notify({ kind: 'health_alert', title: scoutText(language, 'rest.title'), body: scoutText(language, 'rest.body', { model: route.modelId }), link: '#/settings', dedupKey: `scout-rest:${route.providerId}:${until}` });
      } else if (!result.ok && result.reason === 'run_failed') this.#scoutFailure(project.id, now, result.detail, language);
      else saveScoutState(kv, project.id, { fails: 0, until: now + SCOUT_SHORT_WAIT_MS, note: '' });
      const kept = await recordFix({ db: this.#d.db, kv, tasks, worktrees: this.#d.worktrees!, projectsDir: this.#d.projects!.dir, language, log: this.#d.log }, proposalId, result);
      if (kept) this.#notifyPrefix(project, now, language);
      return runId ? 'ran' : 'idle';
    } finally {
      this.#scoutChanged(project.id);
    }
  }

  // 新しい Pre-fix の知らせ（製品ごとにまとめて 1 つ。読むまで重ねない）
  #notifyPrefix(project: ProjectRow, now: number, language: Language): void {
    const prefix = `scout-prefix:${project.id}:`;
    if (this.#d.notifications.unreadOf('info').some(n => n.dedup_key?.startsWith(prefix))) return;
    this.#d.notifications.notify({ kind: 'info', title: scoutText(language, 'prefixes.title', { name: project.name }), body: scoutText(language, 'prefixes.body', { name: project.name }), link: `#/p/${project.id}`, dedupKey: `${prefix}${now}`, projectId: project.id });
  }

  #scoutChanged(projectId: string): void {
    saveScoutState(this.#d.kv, projectId, { changedAt: this.#now() });
    this.#d.onScoutChange?.(projectId);
  }

  // recount: 「一覧が育たない」の数え直し。作業フォルダの変化だけで起きたときは数え直さない（コミットしていない保存のたびに空回りの 3 回が戻らないように）
  #wake(projectId: string, recount = true): void {
    clearSleep(this.#d.kv, projectId);
    if (recount) saveScoutState(this.#d.kv, projectId, { flat: 0, left: -1 });
    this.#scoutChanged(projectId);
  }

  // 休んでいる製品のうち、HEAD・計画書・カンバン（考える実行の行と、まだ触られていない提案を除く）が休んだときと違うものを起こす。
  // 作業フォルダの印は、見回りの間隔（5 分）に 1 回だけ比べる。起こした製品の印を返す（行を作る前にもう一度取らない）
  async #wakeSleepers(projects: readonly ProjectRow[], now: number): Promise<Map<string, Marks>> {
    const dataDir = dirname(this.#d.projects!.dir);
    const woken = new Map<string, Marks>();
    for (const project of projects) {
      const sleep = readSleep(this.#d.kv, project.id);
      if (!sleep) continue;
      const quick = await quickMarks(this.#d.db, this.#d.kv, project.id, project.root, dataDir);
      const moved = !sameQuickMarks(sleep, quick);
      if (!moved && now - (this.#treeCheckedAt.get(project.id) ?? sleep.at) < IDLE_POLL_MS) continue;
      this.#treeCheckedAt.set(project.id, now);
      const tree = await treeMark(project.root, dataDir).catch(() => '');
      if (!moved && tree === sleep.tree) continue;
      woken.set(project.id, { ...quick, tree });
      // stuck の製品を Reject だけで起こしたときは数え直さない（考え直しは 1 回。一覧が育たなければまた stuck で休む）
      const rejectOnly = sleep.head === quick.head && sleep.plan === quick.plan && ownerRejectedSince(this.#d.db, project.id, sleep.at);
      this.#wake(project.id, sleep.reason !== 'stuck' || (moved && !rejectOnly));
    }
    return woken;
  }

  // 動いている作業か、持ち主の作業（worker が Off でも動く）が製品を塞いでいる
  #ownerBlocking(projectId: string): boolean {
    const rows = this.#d.db.prepare("SELECT id, status FROM tasks WHERE project_id = ? AND status IN ('ready', 'running') AND proposed_by IS NOT 'scout-run'").all(projectId) as Array<{ id: string; status: string }>;
    return rows.some(row => {
      if (row.status === 'running') return true;
      const task = this.#d.tasks.get(row.id);
      return task !== undefined && this.#ownerWork(task);
    });
  }

  // 見る所が無い（見ていない場所も古いエントリも無い）・深める提案が残っていない・見ていない場所の数が続けて減らない、なら休む
  // 深める形（未処理 10 件）では、深めていない提案の数で同じように数える（深めないモデルが止まらずに回らないように）。形が変わったら数え直す
  #sleepReason(projectId: string, materials: { unseen: number; stale: number; open: number; deepen: number }): SleepReason | undefined {
    const { kv } = this.#d;
    const deep = materials.open >= PROPOSAL_OPEN_MAX;
    if (deep && materials.deepen === 0) return 'deepened';
    if (!deep && materials.unseen === 0 && materials.stale === 0) return 'done';
    const state = scoutState(kv, projectId);
    const left = deep ? materials.deepen : materials.unseen + materials.stale;
    const before = (state.deep ?? false) === deep ? state.left ?? -1 : -1;
    const flat = before >= 0 && left >= before ? (state.fails > 0 ? state.flat ?? 0 : (state.flat ?? 0) + 1) : 0;
    saveScoutState(kv, projectId, { left, flat, deep });
    return flat >= SCOUT_FLAT_RUNS ? 'stuck' : undefined;
  }

  #notifyProposals(project: ProjectRow, since: number, language: Language): void {
    const added = (this.#d.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND proposal IS NOT NULL AND status = 'inbox' AND created_at >= ?").get(project.id, since) as { n: number }).n;
    if (!added) return;
    const prefix = `scout-proposals:${project.id}:`;
    if (this.#d.notifications.unreadOf('info').some(n => n.dedup_key?.startsWith(prefix))) return;
    this.#d.notifications.notify({ kind: 'info', title: scoutText(language, 'proposals.title', { name: project.name }), body: scoutText(language, 'proposals.body', { name: project.name }), link: `#/p/${project.id}`, dedupKey: `${prefix}${since}`, projectId: project.id });
  }

  scoutView(projectId: string): ScoutView | undefined {
    const project = this.#d.projects?.get(projectId);
    if (!project) return undefined;
    const c = this.#d.config();
    const { kv } = this.#d;
    const now = this.#now();
    const language = languageOf(c);
    const state = scoutState(kv, projectId);
    const sleep = readSleep(kv, projectId);
    const run = [...this.#running.values()].find(r => r.kind === 'scout' && r.projectId === projectId);
    let broken = 0;
    try { broken = readLedger(this.#d.projects!.dir, projectId).broken; } catch { broken = 0; }
    const note = [
      sleep?.reason === 'stuck' ? scoutText(language, 'note.not_growing', { count: SCOUT_FLAT_RUNS }) : '',
      state.note ?? '',
      broken > 0 ? scoutText(language, 'note.broken', { count: broken }) : '',
    ].filter(Boolean).join(' · ') || null;
    const view = (s: ScoutView['state']): ScoutView => ({ state: s, examined: state.examined ?? 0, area: run ? this.#d.engine.scoutArea(run.runId) : null, lastChangeAt: state.changedAt ?? state.last ?? null, note });
    if (project.archived_at !== null || !scoutsOn(project.scout_mode) || !(c.routing.scout ?? []).length) return view('off');
    if (run) return view('thinking');
    if (sleep) return view('asleep');
    const route = this.#d.engine.scoutRoute();
    const capped = route !== null && !route.local && cloudRunsLastHour(kv, now).length >= (c.scout?.cloudRunsPerHour ?? 1);
    if ((route !== null && restUntil(kv, route.providerId) > now) || capped || (state.fails > 0 && (state.until ?? 0) > now)) return view('resting');
    return view('idle');
  }

  // Think now（持ち主の頼み。D-4: worker が Off でも 1 回動く。一時停止・会話の返事中は tick の順で待つ。D-7: クラウドの 0 と休みのあいだは断る）
  scoutNow(projectId: string): ScoutAsk | undefined {
    const project = this.#d.projects?.get(projectId);
    if (!project) return undefined;
    const c = this.#d.config();
    if (project.archived_at !== null || !scoutsOn(project.scout_mode)) return { ok: false, code: 'scout_off' };
    const route = (c.routing.scout ?? []).length ? this.#d.engine.scoutRoute() : null;
    if (!route) return { ok: false, code: 'scout_no_model' };
    if (!route.local && (c.scout?.cloudRunsPerHour ?? 1) === 0) return { ok: false, code: 'scout_cloud_zero' };
    if (restUntil(this.#d.kv, route.providerId) > this.#now()) return { ok: false, code: 'scout_resting' };
    if (!scoutBuilt(this.#d.db, projectId)) return { ok: false, code: 'scout_not_built' };
    // 材料を読んでいる最中のひとりでの回は、押されたら持ち主の頼みの回に替える（休みの判定を飛ばして必ず動く）
    const starting = this.#scoutStarting?.project.id === projectId ? this.#scoutStarting : undefined;
    if (starting && !starting.asked) {
      starting.asked = true;
      this.#scoutChanged(projectId);
    }
    const running = starting !== undefined || [...this.#running.values()].some(r => r.kind === 'scout' && r.projectId === projectId);
    // 製品の作業が待っている・動いているあいだは考える役は動かない（考える役は製品が空いているときだけ）。待たせずに断る
    if (!running && scoutBusy(this.#d.db, projectId)) return { ok: false, code: 'scout_busy' };
    if (!running && !this.#scoutAsked.has(projectId)) {
      this.#scoutAsked.add(projectId);
      this.#scoutChanged(projectId);
      this.poke();
    }
    return { ok: true, view: this.scoutView(projectId)! };
  }

  #scoutFailure(projectId: string, now: number, reason: string, language: Language): void {
    scoutFailed(this.#d.kv, projectId, now, (count, minutes) => scoutText(language, 'note.failing', { count, reason: reason.slice(0, 200), minutes }));
  }

  // 考える実行の行は使い捨て: どの終わり方でも閉じる（ready に戻さない）
  #closeScout(task: Task, plan: ScoutPlan, result: EngineResult, runId: string, language: Language): void {
    const { tasks, kv } = this.#d;
    const now = this.#now();
    const projectId = plan.project.id;
    if (tasks.get(task.id)?.status !== 'running') return;
    const stop = this.#scoutStops.get(runId);
    const end = this.#d.engine.scoutEnd(runId);
    if (end && this.#d.engine.scoutChildrenAllFailed(runId)) {
      const why = scoutText(language, 'run.ended', { reason: scoutText(language, 'stop.children_failed') });
      tasks.finish(task.id, 'failed', why, 'worker', runId);
      this.#scoutFailure(projectId, now, why, language);
      return;
    }
    if (result.ok || end) {
      tasks.finish(task.id, 'done', end ? scoutText(language, 'run.ended', { reason: scoutText(language, end === 'agents_busy' ? 'stop.agents_busy' : 'stop.agents_used') }) : result.ok && result.text.trim() ? result.text.trim().slice(0, 1000) : scoutText(language, 'run.done'), 'worker', runId);
      saveScoutState(kv, projectId, { fails: 0, until: now + SCOUT_SHORT_WAIT_MS, note: '' });
      return;
    }
    if (stop || result.errorKind === 'cancelled') {
      tasks.finish(task.id, 'cancelled', scoutText(language, 'run.stopped', { reason: stop ? scoutText(language, stop) : result.errorMessage }), 'worker', runId);
      saveScoutState(kv, projectId, { until: now + SCOUT_SHORT_WAIT_MS });
      return;
    }
    tasks.finish(task.id, 'failed', result.errorMessage, 'worker', runId);
    const upstream = new Runs(this.#d.db).get(runId)?.error_message ?? '';
    if (result.errorKind === 'rate_limit' || CREDIT_ERROR.test(upstream) || CREDIT_ERROR.test(result.errorMessage)) {
      const until = nextMidnight(now, this.#d.config().timezone);
      restScout(kv, plan.route.providerId, until);
      this.#d.notifications.notify({ kind: 'health_alert', title: scoutText(language, 'rest.title'), body: scoutText(language, 'rest.body', { model: plan.route.modelId }), link: '#/settings', dedupKey: `scout-rest:${plan.route.providerId}:${until}` });
      return;
    }
    this.#scoutFailure(projectId, now, result.errorMessage.split('\n')[0]!, language);
  }

  async #run(task: Task, release: () => void): Promise<TickResult> {
    const { tasks, conversations, engine } = this.#d;
    const c = this.#d.config();
    const language = languageOf(c);
    const fresh = task.conversation_id ?? randomUUID();
    if (!tasks.claim(task.id, LEASE_MS, fresh)) return 'busy';
    const conversationId = tasks.get(task.id)?.conversation_id ?? fresh;
    if (!conversations.get(conversationId)) conversations.create({ id: conversationId, kind: 'task', title: taskText(language, 'title.task', { title: task.title }), projectId: task.project_id });
    if (this.#d.projects && projectFolderGone(this.#d.projects, task.project_id)) {
      const name = this.#d.projects.get(task.project_id!)?.name ?? task.project_id!;
      tasks.setReady(task.id, { runAt: this.#now() + 10 * 60_000, reason: taskText(language, 'reason.folder_missing', { name }) });
      this.#d.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.task_folder_missing', { name }), link: `#/p/${task.project_id}`, dedupKey: `project-folder-missing:${task.project_id}`, projectId: task.project_id });
      return 'folder_missing';
    }
    const placed = this.#d.places && task.project_id ? await this.#d.places.decide(tasks.get(task.id) ?? task) : undefined;
    if (placed?.kind === 'gone') {
      tasks.finish(task.id, 'failed', taskText(language, 'reason.worktree_gone'), 'beat');
      if (placed.row.task_id === task.id && placed.row.state === 'active') await this.#closeWorktree(task, placed.row.id);
      return 'idle';
    }
    if (placed?.kind === 'wait') {
      tasks.setReady(task.id, { runAt: this.#now() + 10 * 60_000, reason: taskText(language, 'reason.worktree_unavailable') });
      return 'busy';
    }
    const project = this.#d.projects && needsSnapshot(this.#d.db, task) ? this.#d.projects.get(task.project_id!) : undefined;
    if (project) {
      const dataDir = dirname(this.#d.projects!.dir);
      tasks.event(task.id, SNAPSHOT_EVENT, 'beat', snapshotLine(await snapshotBeforeBuild(project.root, task.id, dataDir, c.tools.deny.map(p => resolveConfigPath(p, dataDir)))));
      if (tasks.get(task.id)?.status !== 'running') return 'idle';
    }
    const mainRoot = placed?.kind === 'worktree' ? this.#d.projects?.get(task.project_id!)?.root : undefined;
    const since = this.#now();
    const mainBefore = mainRoot ? await mainGitPrint(mainRoot, dirname(this.#d.projects!.dir), this.#d.places?.placeRoot()) : undefined;
    const events = tasks.events(task.id);
    // 前の回が返事だけだったかは、残した経過の文で見る（サーバーの文は今は英語だけなので、言語が変わって外れることは無い）
    const prompt = taskPrompt(task, events, c.timezone, language, workAgreement(this.#d.db, task, language), events.find(e => e.kind === 'requeued')?.content === taskText(language, 'reason.replied_only', { limit: STAGNATION_LIMIT }));
    const started = engine.runTask(task, conversationId, prompt, placed ? { place: placed.kind === 'worktree' ? placed.row.id : null } : {});
    if (!started.ok) {
      tasks.setReady(task.id, { runAt: this.#now() + 10 * 60_000, reason: taskText(language, 'reason.no_model', { detail: started.errorMessage.split('\n')[0]! }) });
      this.#d.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.task_no_model'), body: started.errorMessage, link: '#/settings', dedupKey: 'no-model-for-tasks' });
      return 'no_model';
    }
    this.#running.set(started.runId, { kind: 'task', taskId: task.id, runId: started.runId, title: task.title });
    release();
    tasks.event(task.id, 'run', 'worker', null, started.runId);
    try {
      const result = await started.done;
      this.#finalize(task, result, started.control.value, started.runId);
      if (mainRoot && mainBefore) await this.#mainChanged(task, mainRoot, mainBefore, since);
      // 生んだタスクから引き継いだ作業コピーは閉じない（ほかの子と生んだタスクがまだ使う）
      if (placed?.kind === 'worktree' && placed.row.task_id === task.id) await this.#closeWorktree(task, placed.row.id);
    } finally { this.#running.delete(started.runId); }
    return 'ran';
  }

  // 作業コピーで動いた実行の前後で、本体の git（HEAD・ブランチ・参照・stash・共有の設定）が変わっていたら、タスクの経過と知らせで持ち主に伝える（止めも戻しもしない）
  // 同じ製品で、その間に本体で動いた（動いている）ほかのタスクがあれば、そちらの変化かもしれないので名前を書き、知らせは出さない
  async #mainChanged(task: Task, root: string, before: MainGitPrint, since: number): Promise<void> {
    const after = await mainGitPrint(root, dirname(this.#d.projects!.dir), this.#d.places?.placeRoot());
    const changed = after ? mainGitChanges(before, after) : ['unreadable'];
    if (changed.length === 0) return;
    const language = this.#language();
    const parts = changed.join(', ');
    const onMain = (this.#d.db.prepare(`SELECT id, title FROM tasks t WHERE project_id = ? AND id != ? AND (status = 'running' OR COALESCE(completed_at, 0) >= ?
      OR EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind = 'run' AND e.created_at >= ?)) AND NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.task_id = t.id AND w.kind = 'task')`)
      .all(task.project_id, task.id, since, since) as Array<{ id: string; title: string }>).filter(other => this.#d.places?.rowOf(other.id)?.state !== 'active');
    if (onMain.length) {
      this.#d.tasks.event(task.id, 'worktree', 'beat', taskText(language, 'event.main_changed_others', { parts, names: onMain.slice(0, 5).map(o => `“${o.title.slice(0, 80)}”`).join(', ') }));
      return;
    }
    this.#d.tasks.event(task.id, 'worktree', 'beat', taskText(language, 'event.main_changed', { parts }));
    this.#d.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.main_changed', { title: task.title, parts }), link: `#/p/${task.project_id}`, dedupKey: `main-changed:${task.id}`, projectId: task.project_id });
  }

  // 動いていないあいだに終わった（取り消し・失敗）作業コピーのタスクの行を閉じる（active のまま残さない。開いた数にも数えない）
  #stranded(): Array<{ id: string; task_id: string }> {
    if (!this.#d.worktrees) return [];
    const runningTasks = new Set([...this.#running.values()].flatMap(r => (r.kind === 'task' ? [r.taskId] : [])));
    const rows = (this.#d.db.prepare(`SELECT w.id AS id, w.task_id AS task_id FROM worktrees w JOIN tasks t ON t.id = w.task_id
      WHERE w.kind = 'task' AND w.state = 'active' AND t.status IN ('done', 'failed', 'cancelled')`).all() as Array<{ id: string; task_id: string }>).filter(row => !runningTasks.has(row.task_id) && !this.#closeTried.has(row.id));
    if (rows.length === 0) return rows;
    // 動いているタスク（生んだタスクの作業コピーを引き継ぐ子も）が使っている行は閉じない
    const places = this.#d.places;
    const used = new Set(this.#d.tasks.list({ statuses: ['running'], limit: 10_000 }).flatMap(t => { const id = places?.rowOf(t.id)?.id; return id ? [id] : []; }));
    return rows.filter(row => !used.has(row.id));
  }

  async #closeStranded(rows: ReadonlyArray<{ id: string; task_id: string }>): Promise<void> {
    for (const row of rows) {
      const task = this.#d.tasks.get(row.task_id);
      if (!task) continue;
      this.#closeTried.add(row.id);
      await this.#closeWorktree(task, row.id);
    }
  }

  // 作業コピーのタスクが終わった（完了・失敗・取り消し）: 書きかけを 1 つのコミットにしてブランチに残す。変わったものが無ければ片づける。
  // 区切り・yield・質問待ちなどで ready / waiting に戻ったときは、次の実行も同じ作業コピーで続けるので何もしない（D-13）
  async #closeWorktree(task: Task, rowId: string): Promise<void> {
    const status = this.#d.tasks.get(task.id)?.status;
    const wt = this.#d.worktrees;
    if (!wt || (status !== 'done' && status !== 'failed' && status !== 'cancelled')) return;
    const language = this.#language();
    try {
      // 裏で動いているコマンドを先に止める（止める前にコミットすると、そのあとの書き込みが作業コピーに残る）
      await this.#d.background?.stopWhere({ taskId: task.id });
      const done = await wt.finishWorktree(rowId, { commitLeftovers: true, message: `beat: ${task.title.replace(/[\r\n]+/gu, ' ').slice(0, 200)}` });
      if (done.ok && done.held?.length) this.#d.tasks.event(task.id, 'worktree', 'beat', taskText(language, 'event.worktree_held', { names: done.held.slice(0, 10).join(', ') }));
      if (done.ok && !done.changed) {
        const removed = await wt.removeWorktree(rowId, { keepBranch: false, state: 'gone' });
        if (!removed.ok) this.#d.log(`[WARN] Could not clean up the working copy of task ${task.id} (${removed.reason})`);
      } else if (!done.ok) {
        this.#d.log(`[WARN] Could not finish the working copy of task ${task.id} (${done.reason})`);
      }
    } catch (error) {
      this.#d.log(`[WARN] Could not finish the working copy of task ${task.id}: ${(error as Error).message}`);
    }
  }

  // 終わり方を決めずに区切り（task_checkpoint・split のどれも）で終わった回を続けて数え、LONG_RUN_NOTICE 回目に 1 回だけ知らせる（止めない。止めるのは持ち主）
  #continued(task: Task): void {
    const runs = (this.#d.kv.getJson<number>(splitKey(task.id)) ?? 0) + 1;
    this.#d.kv.setJson(splitKey(task.id), runs);
    if (runs !== LONG_RUN_NOTICE) return;
    const language = this.#language();
    this.#d.notifications.notify({ kind: 'info', title: taskText(language, 'notify.task_long', { title: task.title }), body: taskText(language, 'split.long_body', { title: task.title, runs: LONG_RUN_NOTICE }), link: `#/tasks/${task.id}`, dedupKey: `split:${task.id}`, projectId: task.project_id });
  }

  // 進展の無い回を 1 つ数える。STAGNATION_LIMIT 回に来たら行き詰まり（failed + stuck の質問 + 知らせ）にして true
  #noProgress(task: Task, runId: string): boolean {
    const { tasks, notifications } = this.#d;
    const idleKey = `task-idle:${task.id}`;
    const strikes = (this.#d.kv.getJson<number>(idleKey) ?? 0) + 1;
    if (strikes < STAGNATION_LIMIT) {
      this.#d.kv.setJson(idleKey, strikes);
      return false;
    }
    this.#d.kv.delete(idleKey);
    const language = this.#language();
    const now = this.#now();
    const projectId = task.project_id;
    const reason = taskText(language, 'stuck.reason', { strikes });
    tasks.finish(task.id, 'failed', reason, 'beat', runId);
    this.#d.questions?.add({ kind: 'stuck', projectId, taskId: task.id, conversationId: tasks.get(task.id)?.conversation_id ?? null, question: taskText(language, 'stuck.question', { title: task.title, strikes }), why: taskText(language, 'stuck.why'), options: CHECK_OPTIONS, chosen: CHECK_KEEP, tainted: this.#taskTainted(task.id) });
    notifications.notify({ kind: 'task_failed', title: taskText(language, 'notify.task_failed', { title: task.title }), body: reason, link: `#/tasks/${task.id}`, dedupKey: `failed:${task.id}:${now}`, projectId });
    return true;
  }

  #followUpAnswers(taskId: string, runId: string): void {
    for (const id of this.#d.questions?.followUpUnread(taskId, runId) ?? []) this.requestRun(id);
  }

  #finalize(task: Task, result: EngineResult, control: TaskControl, runId: string): void {
    const { tasks, notifications } = this.#d;
    const now = this.#now();
    const link = `#/tasks/${task.id}`;
    const projectId = task.project_id;
    const language = this.#language();
    const idleKey = `task-idle:${task.id}`;
    // 仕事をした回は、spawned_by でたどれる先祖すべての進展なしの数も消す（子孫が仕事をしている親は止めない。何もしない子ばかりなら親は 3 回で止まる）
    if (result.ok && result.workDone > 0) {
      const seen = new Set<string>([task.id]);
      for (let up = task.spawned_by; up && !seen.has(up); up = tasks.get(up)?.spawned_by ?? null) {
        seen.add(up);
        this.#d.kv.delete(`task-idle:${up}`);
      }
    }
    // 実行中に、ユーザーが取り消した・完了にした（またはモデルが道具で終えた）なら、その状態を尊重する
    const status = tasks.get(task.id)?.status;
    if (status !== 'running') {
      this.#d.kv.delete(splitKey(task.id));
      if (status === 'done' || status === 'failed' || status === 'cancelled') this.#followUpAnswers(task.id, runId);
      return;
    }
    // 割り込みは、やり直しと同じに数える（区切りの数を消しも増やしもしない）
    if (this.#d.engine.wasPreempted(runId) && control.outcome !== 'complete' && control.outcome !== 'failed' && control.outcome !== 'await_pending') {
      tasks.setReady(task.id, { runAt: now + 2 * 60_000, reason: taskText(language, 'reason.preempted') });
      return;
    }
    if (!(result.ok && result.split) && control.outcome !== 'checkpoint' && control.outcome !== 'yield') this.#d.kv.delete(splitKey(task.id));
    const answered = (this.#d.questions?.answeredDuringRun(task.id, runId).length ?? 0) > 0;
    // もうある子を待つだけの回（この回は子のタスクを作っていない。持ち主の Run now など）は、進展なしに数えない（yield と task_checkpoint で同じ）
    const createdChild = (): boolean => this.#d.db.prepare("SELECT 1 FROM tasks t JOIN task_events e ON e.task_id = t.id AND e.kind = 'context' AND e.run_id = ? WHERE t.spawned_by = ? LIMIT 1").get(runId, task.id) !== undefined;
    const onlyWaits = (): boolean => tasks.openChildren(task.id) > 0 && !createdChild();
    if (control.outcome === 'complete') {
      this.#d.kv.delete(idleKey);
      if (answered) {
        tasks.update(task.id, { appendNote: control.summary }, 'beat', runId);
        tasks.setReady(task.id, { runAt: now, reason: taskText(language, 'reason.answered') });
        return;
      }
      tasks.finish(task.id, 'done', control.summary, 'beat', runId, undefined, { keepPending: true });
      if (itemSummary(this.#d.db, task)?.remaining.length) tasks.setCheckState(task.id, 'awaiting');
      if (control.notify) notifications.notify({ kind: 'task_done', title: taskText(language, 'notify.task_done', { title: task.title }), body: control.summary, link, projectId });
      return;
    }
    if (control.outcome === 'yield') {
      // 子を待って区切る回も、途中経過と同じに数える（子が仕事をすれば、子の回が親の数を消す）
      if ((result.ok && result.workDone > 0) || answered || decidedDuring(this.#d.db, task.id, runId)) this.#d.kv.delete(idleKey);
      else if (!onlyWaits() && this.#noProgress(task, runId)) return;
      this.#continued(task);
      tasks.setReady(task.id, { reason: control.reason });
      return;
    }
    if (control.outcome === 'failed') {
      this.#d.kv.delete(idleKey);
      tasks.finish(task.id, 'failed', control.reason, 'beat', runId);
      this.#followUpAnswers(task.id, runId);
      const failures = tasks.checkFailures(task.id);
      const items = failures.count >= CHECK_FAIL_LIMIT ? undefined : tasks.gateStreak(task.id);
      if (failures.count >= CHECK_FAIL_LIMIT) {
        const text = CHECK_TEXT[language];
        this.#d.questions?.add({ kind: 'check_failed', projectId, taskId: task.id, conversationId: tasks.get(task.id)?.conversation_id ?? null, question: text.question(task.title), why: text.why(failures.last), options: CHECK_OPTIONS, chosen: CHECK_KEEP, tainted: this.#taskTainted(task.id) });
      } else if (items && items.itemFailed >= GATE_LIMIT) {
        this.#d.questions?.add({ kind: 'check_failed', projectId, taskId: task.id, conversationId: tasks.get(task.id)?.conversation_id ?? null, question: gateText(language, 'item_question', { limit: GATE_LIMIT, title: task.title }), why: CHECK_TEXT[language].why(items.last), options: CHECK_OPTIONS, chosen: CHECK_KEEP, tainted: this.#taskTainted(task.id) });
      }
      notifications.notify({ kind: 'task_failed', title: taskText(language, 'notify.task_failed', { title: task.title }), body: control.reason, link, dedupKey: `failed:${task.id}:${now}`, projectId });
      return;
    }
    if (control.outcome === 'question') {
      tasks.setWaiting(task.id, 'question', control.question, runId);
      return;
    }
    if (control.outcome === 'await_pending') {
      this.#d.kv.delete(idleKey);
      this.#d.kv.delete(splitKey(task.id));
      const open = openPendingIds(this.#d.db, task.id);
      if (!open.length) {
        const decided = decidedDuring(this.#d.db, task.id, runId);
        tasks.setReady(task.id, { runAt: now, reason: decided ? taskText(language, 'reason.pending_decided', { id: decided.id, status: decided.status }) : taskText(language, 'reason.pending_closed') });
        return;
      }
      tasks.setWaiting(task.id, 'approval', open.map(id => `#${id}`).join(', '), runId);
      return;
    }
    if (control.outcome === 'checkpoint') {
      const decided = decidedDuring(this.#d.db, task.id, runId);
      if (decided || answered) {
        this.#d.kv.delete(idleKey);
        this.#continued(task);
        tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction }, 'beat', runId);
        tasks.setReady(task.id, { runAt: now, reason: decided ? taskText(language, 'reason.pending_decided', { id: decided.id, status: decided.status }) : taskText(language, 'reason.answered') });
        return;
      }
      const idle = result.ok && result.workDone === 0;
      const open = idle ? openPendingIds(this.#d.db, task.id) : [];
      if (open.length) {
        this.#d.kv.delete(splitKey(task.id));
        tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction, runAt: null }, 'beat', runId);
        tasks.setWaiting(task.id, 'approval', open.map(id => `#${id}`).join(', '), runId);
        return;
      }
      tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction }, 'beat', runId);
      // 道具を使わない区切りは進展なしに数える（休まずに続けるので、空回りは STAGNATION_LIMIT 回で止める）
      if (!idle) this.#d.kv.delete(idleKey);
      else if (!onlyWaits() && this.#noProgress(task, runId)) return;
      this.#continued(task);
      tasks.setReady(task.id, { runAt: now, reason: idle ? taskText(language, 'reason.no_progress', { limit: STAGNATION_LIMIT }) : taskText(language, 'reason.checkpoint') });
      return;
    }
    if (result.ok && result.split) {
      // 区切り: すぐ続ける。道具を使った区切りは進展なしの数（idleKey）を増やしも消しもしない（区切りと返事だけの終わりが交互に続くタスクも、今までどおり相談に届く）。
      // 仕事をせず、答えも Pending の決めも読んでいない区切りは進展なしに数える。長さの区切りは、書き換え・実行の仕事（changeDone）をしていなければ進展なし（読むだけで長くなる回は回りっぱなしになる）
      const idle = result.split === 'context' ? result.changeDone === 0 : result.workDone === 0;
      if (idle && !answered && !decidedDuring(this.#d.db, task.id, runId) && this.#noProgress(task, runId)) return;
      this.#continued(task);
      tasks.setReady(task.id, { runAt: now, reason: result.split === 'context' ? taskText(language, 'reason.context_split') : taskText(language, 'reason.split', { max: UNATTENDED_ITERATION_CEILING }) });
      return;
    }
    if (result.ok && answered) {
      if (result.text.trim()) tasks.update(task.id, { appendNote: taskText(language, result.truncated ? 'note.memo_truncated' : 'note.memo', { text: result.text.trim().slice(0, 500) }) }, 'beat', runId);
      tasks.setReady(task.id, { runAt: now, reason: taskText(language, 'reason.answered') });
      return;
    }
    if (result.ok) {
      // 道具で終わり方を決めずに返事だけ書いた: 進展が無いとみなし、休まずに続ける（次の回の指示に 1 行足す）。続いたら相談する
      if (result.text.trim()) tasks.update(task.id, { appendNote: taskText(language, result.truncated ? 'note.memo_truncated' : 'note.memo', { text: result.text.trim().slice(0, 500) }) }, 'beat', runId);
      if (this.#noProgress(task, runId)) return;
      tasks.setReady(task.id, { runAt: now, reason: taskText(language, 'reason.replied_only', { limit: STAGNATION_LIMIT }) });
      return;
    }
    if (result.errorKind === 'cancelled') {
      tasks.setReady(task.id, { runAt: now + STOPPED_RESUME_MS, reason: taskText(language, 'reason.stopped') });
      return;
    }
    const attempts = task.attempts + 1;
    if (attempts >= task.max_attempts) {
      tasks.finish(task.id, 'failed', result.errorMessage, 'worker', runId);
      this.#followUpAnswers(task.id, runId);
      notifications.notify({ kind: 'task_failed', title: taskText(language, 'notify.task_failed', { title: task.title }), body: result.errorMessage, link, dedupKey: `failed:${task.id}`, projectId });
      return;
    }
    const delay = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)]!;
    tasks.setReady(task.id, { runAt: now + delay * 60_000, countAttempt: true, reason: taskText(language, 'reason.failed_retry', { detail: result.errorMessage.split('\n')[0]!, delay }) });
  }
}
