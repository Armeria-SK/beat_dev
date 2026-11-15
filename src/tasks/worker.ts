import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../config/schema.ts';
import type { Conversations } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import { UNATTENDED_ITERATION_CEILING, type ChatEngine } from '../engine/chat.ts';
import type { EngineResult } from '../engine/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import { curiosityText } from '../curiosity/text.ts';
import { bookPressureText, isNoProposal, reviewPrompt, TIDY_FORBIDDEN_TOOLS, transcriptOf, TRIGGER_TEXT, type ReviewJob, type ReviewJobs } from '../memory/review.ts';
import { planBooks, type MemoryStore } from '../memory/store.ts';
import type { Notifications } from '../notify/notifications.ts';
import { BLOCKING_QUESTION_KEY } from '../shared/notification-list.ts';
import { languageOf } from '../shared/language.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { askBeforeRegister } from '../tools/skills/store.ts';
import type { TaskControl } from '../tools/types.ts';
import type { Task, TaskStore } from './store.ts';
import { CHECK_FAIL_LIMIT, CHECK_KEEP, CHECK_OPTIONS, CHECK_TEXT } from '../projects/check-run.ts';
import { projectFolderGone } from '../projects/run.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { QuestionStore } from '../questions/store.ts';
import { decidedDuring, openPendingIds } from './pending-wake.ts';

const IDLE_POLL_MS = 5 * 60_000;
const LEASE_MS = 30 * 60_000;
const RETRY_DELAYS_MIN = [1, 5, 15];
const STAGNATION_LIMIT = 3;
// 区切り（人のいない実行の回数の上限）が続いたとき、持ち主に 1 回だけ知らせる数。止めはしない
const SPLIT_LIMIT = 3;
export const splitKey = (id: string): string => `task-split:${id}`;
const STOPPED_RESUME_MS = 20_000;

export type TickResult = 'ran' | 'idle' | 'busy' | 'paused' | 'disabled' | 'budget' | 'no_model' | 'folder_missing';

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
  curiosity?: CuriosityStore | undefined;
  memoryBudget?: (() => number | undefined) | undefined;
  projects?: ProjectStore | undefined;
  questions?: QuestionStore | undefined;
  pendingWake?: (() => unknown) | undefined;
}

export interface WorkerRunning { kind: 'task' | 'review'; taskId: string | null; runId: string; title: string }

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
      '- Make progress with your tools. Do not overdo it in a single run',
      '- When you are done, call task_complete (a summary of the result). If there is nothing to tell the user, finish quietly with notify=false',
      '- To continue later or to wait for something, call task_checkpoint (what you tried, the result, the next step, and how many minutes until you resume)',
      '- Use ask_user only for what you cannot move forward on without checking with the user',
      '- You do not need to wait for a call held in Pending for the user to decide: keep going with whatever else you can do. beat resumes the task as soon as the user decides, so there is no need to check on it. If the rest of the task depends on its result, call task_checkpoint; call task_complete only when nothing left in the task depends on that call',
      "- Write notes, questions and the summary in the language the user writes in: the language of the user's own words in the title and details (for a curiosity task, the language of the topic), not the language of these instructions",
    ],
    time: (ms, timezone) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(ms),
  },
};

export function inQuietHours(now: number, timezone: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  return start < end ? hm >= start && hm < end : hm >= start || hm < end;
}

export function taskPrompt(task: Task, events: ReadonlyArray<{ kind: string; actor?: string; content: string | null; created_at: number }>, timezone: string, language: Language = DEFAULT_LANGUAGE): string {
  const text = TASK_TEXT[language];
  const history = events.filter(e => e.content).slice(0, 10).map(e => (e.kind === 'reason'
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
    history.length ? `\n${text.historyHeading}\n${history.join('\n')}` : '',
    '',
    text.howHeading,
    ...text.how,
  ].filter((line): line is string => typeof line === 'string').join('\n').replace(/\n{3,}/gu, '\n\n');
}

export class Worker {
  readonly #d: WorkerDeps;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextWakeAt: number | undefined;
  // 動いている裏の実行（キーは runId）。入れた順 = 始めた順。worker.maxParallel 本まで
  readonly #running = new Map<string, WorkerRunning>();
  #forced = new Set<string>();
  #ticking = false;
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
    this.poke();
  }

  stopTask(taskId: string): boolean {
    for (const run of this.#running.values()) if (run.kind === 'task' && run.taskId === taskId) return this.#d.engine.stop(run.runId);
    return false;
  }

  poke(): void {
    if (this.#stopped || this.#d.autoSchedule === false) return;
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

  runsLastHour(): number {
    // タスクと振り返り（どちらも裏で動く実行）を数える。会話は数えない
    return (this.#d.db.prepare("SELECT COUNT(*) AS n FROM engine_runs WHERE kind IN ('task', 'review') AND started_at > ?").get(this.#now() - 3_600_000) as { n: number }).n;
  }

  quiet(): boolean {
    const c = this.#d.config();
    return inQuietHours(this.#now(), c.timezone, c.worker.quietStart, c.worker.quietEnd);
  }

  status() {
    const c = this.#d.config();
    return {
      enabled: c.worker.enabled, autonomy: c.worker.autonomy, paused: this.paused, quiet: this.quiet(),
      running: [...this.#running.values()][0] ?? null, runningAll: [...this.#running.values()], maxParallel: c.worker.maxParallel, nextWakeAt: this.#nextWakeAt ?? null,
      runsLastHour: this.runsLastHour(), maxRunsPerHour: c.worker.maxRunsPerHour,
    };
  }

  async tick(): Promise<TickResult> {
    const c = this.#d.config();
    // 選ぶ部分は 1 本ずつ（#ticking）。実行を始めたら（await の前に）外して、枠が残っていれば次を選べるようにする
    if (this.#ticking || this.#running.size >= c.worker.maxParallel) return 'busy';
    this.#ticking = true;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#ticking = false;
      if (this.#running.size < this.#d.config().worker.maxParallel) this.poke();
    };
    try {
      const now = this.#now();
      const { tasks } = this.#d;
      const reschedule = (at?: number) => {
        if (this.#stopped || this.#d.autoSchedule === false) return;
        this.#schedule(Math.max(1000, Math.min(at ?? Infinity, now + IDLE_POLL_MS) - now));
      };
      if (!c.worker.enabled) { reschedule(); return 'disabled'; }
      // モデルが 1 つも無いのは「まだ設定していない」だけ。何も選ばず（空の会話も通知も作らず）休む
      if (!c.models.length) { reschedule(); return 'no_model'; }

      // 予定から実行用のタスクを作る・返事待ちを知らせ直す（どちらもモデルは呼ばない）
      tasks.spawnDueSchedules();
      this.#d.pendingWake?.();
      const remindMs = c.worker.remindAfterHours * 3_600_000;
      for (const t of tasks.waitingSince(remindMs).filter(waiting => waiting.waiting_kind !== 'approval')) {
        this.#d.notifications.notify({ kind: 'task_waiting', title: taskText(languageOf(c), 'notify.waiting_reminder', { title: t.title }), body: t.waiting_text ?? undefined, link: `#/tasks/${t.id}`, dedupKey: `remind:${t.id}:${Math.floor(now / remindMs)}`, projectId: t.project_id });
      }
      this.#detectReviewTriggers(c, now);
      if (this.paused) { reschedule(); return 'paused'; }
      // ユーザーとの会話の返事を作っている間は始めない（終われば onRunEnd で起こされる）
      if (this.#d.engine.chatting) { reschedule(now + 60_000); return 'busy'; }
      // 「今すぐ実行」を頼まれたものは、1時間の上限より先に実行する（上限は、ひとりでに動く分の費用を抑えるためのもの）
      let task: Task | undefined;
      // 提供元の空きは、動いている裏の実行それぞれの「最初に使う提供元」で数える（計画の「各実行の providers で数える」より意図して狭い:
      // 全部で数えると、まだ使っていない鎖の後ろの提供元の枠まで塞ぐ。後ろへ回った分の同時数は limiter が抑える）
      const roomFor = (): boolean => this.#d.engine.backgroundHasRoom();
      for (const id of [...this.#forced]) {
        const forced = tasks.get(id);
        if (forced?.status !== 'ready' || forced.attempts >= forced.max_attempts) { this.#forced.delete(id); continue; }
        // 提供元が満杯のあいだは覚えておく（空けば、終わった実行の onRunEnd で拾う）
        if (!roomFor() || tasks.productBusy(forced)) continue;
        this.#forced.delete(id);
        task = forced;
        break;
      }
      if (!task && this.runsLastHour() >= c.worker.maxRunsPerHour) {
        const idleSelf = c.worker.autonomy && !this.quiet() && now - this.#d.engine.lastUserActivity >= c.worker.idleMinutes * 60_000;
        // 「今すぐ実行」で提供元の空きを待っているタスクは、上限より先に動くもの（空き待ちであって上限待ちではない）なので、上限の知らせの数に入れない
        if (tasks.pickNext({ allowSelf: idleSelf, accept: t => !this.#forced.has(t.id) })) {
          this.#d.notifications.notify({
            kind: 'info', title: taskText(languageOf(c), 'notify.budget.title'),
            body: taskText(languageOf(c), 'notify.budget.body', { max: c.worker.maxRunsPerHour }),
            link: '#/tasks', dedupKey: `budget:${Math.floor(now / 3_600_000)}`,
          });
        }
        reschedule(now + 10 * 60_000);
        return 'budget';
      }

      const idleEnough = now - this.#d.engine.lastUserActivity >= c.worker.idleMinutes * 60_000;
      const allowSelf = c.worker.autonomy && !this.quiet() && idleEnough;
      task ??= tasks.pickNext({ allowSelf, accept: roomFor });
      // 実行待ちはあるが、先に使う提供元が満杯で選べない: 何も始めず（振り返りにも回さず）、終わった実行の onRunEnd を待つ
      // （poke が来ない道〔止まっている・自動の予定が無い〕に備えて、保険の予定は 1 分後に置く。終わった実行の poke はそれより早い）
      if (!task && (this.#forced.size > 0 || tasks.pickNext({ allowSelf }))) { reschedule(now + 60_000); return 'busy'; }
      // 実行するタスクが無ければ、振り返りを見る
      const job = !task && c.memory.review ? this.#d.reviews?.next() : undefined;
      if (job) {
        const outcome = await this.#review(job, release);
        reschedule(outcome === 'busy' ? now + 60_000 : now);
        return outcome;
      }
      if (!task) { reschedule(tasks.nextWakeAt({ allowSelf })); return 'idle'; }
      const outcome = await this.#run(task, release);
      reschedule(now);
      return outcome;
    } finally { if (!released) this.#ticking = false; }
  }

  #detectReviewTriggers(c: AppConfig, now: number): void {
    const { reviews, memory, kv } = this.#d;
    if (!reviews || !c.memory.review) return;
    // 機能を入れる前の古い会話を一度に振り返らないよう、最初に動いた時刻より後の会話だけを見る
    let since = Number(kv.get('review:since'));
    if (!Number.isFinite(since) || since <= 0) { since = now; kv.set('review:since', String(now)); }
    reviews.enqueueIdleConversations(c.memory.reviewIdleMinutes * 60_000, since);
    // 記憶が会話に入れる量の予算を超えたら、整理の振り返りを 1 日 1 回積む（予算が決まらないとき・モデルが 0 個のときは積まない）
    const budget = this.#d.memoryBudget?.();
    if (this.#d.botMemory && memory && budget !== undefined && planBooks(memory.list(), languageOf(c), budget).omitted.length > 0) {
      reviews.enqueue('book_full', `book:all:${Math.floor(now / 86_400_000)}`);
    }
  }

  #reviewInput(job: ReviewJob): string | undefined {
    const { db, conversations, tasks, memory, kv } = this.#d;
    const language = languageOf(this.#d.config());
    const skillsAutoRegister = !askBeforeRegister(this.#d.config());
    const forgotten = (db.prepare("SELECT before FROM memory_events WHERE action = 'forget' AND actor = 'user' AND before IS NOT NULL ORDER BY id DESC LIMIT 20").all() as Array<{ before: string }>).map(r => r.before);
    if (job.trigger === 'book_full') {
      const budget = this.#d.memoryBudget?.();
      const plan = memory && budget !== undefined ? planBooks(memory.list(), language, budget) : undefined;
      const pressure = plan && budget !== undefined && plan.omitted.length > 0 ? bookPressureText({ tokens: plan.tokens, budget, outside: plan.omitted }, language) : undefined;
      return reviewPrompt({ trigger: job.trigger, forgotten, bookPressure: pressure, language, memory: true });
    }
    if (job.trigger === 'task') {
      const task = job.task_id ? tasks.get(job.task_id) : undefined;
      if (!task) return undefined;
      return reviewPrompt({ trigger: job.trigger, task, taskEvents: tasks.events(task.id, 30), forgotten, language, skillsAutoRegister, memory: this.#d.botMemory });
    }
    if (!job.conversation_id) return undefined;
    // 前回振り返った発言より後だけを渡す（同じ発言を二度振り返らない）
    const upto = Number(kv.get(`review:upto:${job.conversation_id}`) ?? 0);
    const messages = conversations.messages(job.conversation_id, 200).filter(m => m.id > upto);
    if (!messages.some(m => m.role === 'user')) return undefined;
    return reviewPrompt({ trigger: job.trigger, transcript: transcriptOf(messages, undefined, language), forgotten, language, skillsAutoRegister, memory: this.#d.botMemory });
  }

  async #review(job: ReviewJob, release: () => void): Promise<TickResult> {
    const { reviews, conversations, engine, kv } = this.#d;
    if (!reviews) return 'idle';
    const language = this.#language();
    if (job.trigger === 'book_full' && !this.#d.botMemory) { reviews.finish(job.id, 'done', taskText(language, 'review.tidy_skipped')); return 'idle'; }
    const prompt = this.#reviewInput(job);
    if (!prompt) { reviews.finish(job.id, 'done', taskText(language, 'review.nothing')); return 'idle'; }
    // 先に使う提供元が満杯なら、まだ claim せずに待つ（終わった実行の onRunEnd で呼び直される）
    if (!engine.backgroundHasRoom()) return 'busy';
    const lastMessageId = job.conversation_id ? conversations.messages(job.conversation_id, 1).at(-1)?.id : undefined;
    // 止められて・再起動でやり直す振り返りは、前の回の振り返りの会話に続きを書く（新しく作ると、前の回の会話が記録から外れる）。会話は作るときに材料も覚える
    const source = { conversationId: job.conversation_id, taskId: job.task_id };
    const earlier = job.review_conversation_id ? conversations.get(job.review_conversation_id) : undefined;
    if (earlier?.kind === 'task') conversations.setSource(earlier.id, source);
    const conversation = earlier?.kind === 'task' ? earlier : conversations.create({ kind: 'task', title: taskText(language, 'title.review', { label: TRIGGER_TEXT[language][job.trigger] }), source, projectId: (job.conversation_id ? conversations.projectOf(job.conversation_id) : null) ?? (job.task_id ? this.#d.tasks.get(job.task_id)?.project_id : null) });
    const started = engine.runReview(conversation.id, prompt, job.trigger === 'book_full' ? { forbidTools: TIDY_FORBIDDEN_TOOLS } : {});
    if (!started.ok) {
      this.#d.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.review_no_model'), body: started.errorMessage, link: '#/settings', dedupKey: 'no-model-for-review' });
      return 'no_model';
    }
    reviews.claim(job.id, started.runId, conversation.id);
    this.#running.set(started.runId, { kind: 'review', taskId: job.task_id, runId: started.runId, title: taskText(language, 'title.review_running', { label: TRIGGER_TEXT[language][job.trigger] }) });
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
        if (job.conversation_id && lastMessageId) kv.set(`review:upto:${job.conversation_id}`, String(lastMessageId));
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
      origin: 'curiosity', priority: 3, curiosityId: item.id, propose: c.worker.selfTasksNeedApproval, actor: 'worker',
    });
    curiosity.update(item.id, { status: 'researching', taskId: task.id });
    return task.status === 'ready' ? task : undefined;
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
    const prompt = taskPrompt(task, tasks.events(task.id), c.timezone, language);
    const started = engine.runTask(task, conversationId, prompt);
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
    } finally { this.#running.delete(started.runId); }
    return 'ran';
  }

  #finalize(task: Task, result: EngineResult, control: TaskControl, runId: string): void {
    const { tasks, notifications } = this.#d;
    const now = this.#now();
    const link = `#/tasks/${task.id}`;
    const projectId = task.project_id;
    const language = this.#language();
    const idleKey = `task-idle:${task.id}`;
    // 実行中に、ユーザーが取り消した・完了にした（またはモデルが道具で終えた）なら、その状態を尊重する
    if (tasks.get(task.id)?.status !== 'running') { this.#d.kv.delete(splitKey(task.id)); return; }
    // 割り込みは、やり直しと同じに数える（区切りの数を消しも増やしもしない）
    if (this.#d.engine.wasPreempted(runId) && control.outcome !== 'complete' && control.outcome !== 'failed') {
      tasks.setReady(task.id, { runAt: now + 2 * 60_000, reason: taskText(language, 'reason.preempted') });
      return;
    }
    if (!(result.ok && result.split)) this.#d.kv.delete(splitKey(task.id));
    if (control.outcome === 'complete') {
      this.#d.kv.delete(idleKey);
      tasks.finish(task.id, 'done', control.summary, 'beat', runId);
      if (control.notify) notifications.notify({ kind: 'task_done', title: taskText(language, 'notify.task_done', { title: task.title }), body: control.summary, link, projectId });
      return;
    }
    if (control.outcome === 'yield') {
      this.#d.kv.delete(idleKey);
      tasks.setReady(task.id, { reason: control.reason });
      return;
    }
    if (control.outcome === 'failed') {
      this.#d.kv.delete(idleKey);
      tasks.finish(task.id, 'failed', control.reason, 'beat', runId);
      const failures = tasks.checkFailures(task.id);
      if (failures.count >= CHECK_FAIL_LIMIT) {
        const text = CHECK_TEXT[language];
        this.#d.questions?.add({ kind: 'check_failed', projectId, taskId: task.id, conversationId: tasks.get(task.id)?.conversation_id ?? null, question: text.question(task.title), why: text.why(failures.last), options: CHECK_OPTIONS, chosen: CHECK_KEEP });
      }
      notifications.notify({ kind: 'task_failed', title: taskText(language, 'notify.task_failed', { title: task.title }), body: control.reason, link, dedupKey: `failed:${task.id}:${now}`, projectId });
      return;
    }
    if (control.outcome === 'question') {
      tasks.setWaiting(task.id, 'question', control.question, runId);
      const unread = new Set(notifications.unreadOf('question_new').map(n => n.dedup_key));
      const recorded = this.#d.questions?.list({ status: 'open', taskId: task.id }).some(q => q.blocking && q.question === control.question && unread.has(`${BLOCKING_QUESTION_KEY}${q.id}`)) ?? false;
      if (!recorded) notifications.notify({ kind: 'task_waiting', title: taskText(language, 'notify.task_question', { title: task.title }), body: control.question, link, dedupKey: `waiting:${task.id}:${now}`, projectId });
      return;
    }
    if (control.outcome === 'checkpoint') {
      this.#d.kv.delete(idleKey);
      const decided = decidedDuring(this.#d.db, task.id, runId);
      if (decided) {
        tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction }, 'beat', runId);
        tasks.setReady(task.id, { runAt: now, reason: taskText(language, 'reason.pending_decided', { id: decided.id, status: decided.status }) });
        return;
      }
      const open = result.ok && result.workCalls === 0 ? openPendingIds(this.#d.db, task.id) : [];
      if (open.length) {
        tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction, runAt: null }, 'beat', runId);
        tasks.setWaiting(task.id, 'approval', open.map(id => `#${id}`).join(', '), runId);
        return;
      }
      tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction }, 'beat', runId);
      tasks.setReady(task.id, { runAt: now + Math.min(Math.max(control.resumeAfterMinutes, 1), 10_080) * 60_000, reason: taskText(language, 'reason.checkpoint', { minutes: control.resumeAfterMinutes }) });
      return;
    }
    if (result.ok && result.split) {
      // 区切りの回数に来た: すぐ続ける。進展なしの数（idleKey）は増やしも消しもしない（区切りと返事だけの終わりが交互に続くタスクも、今までどおり相談に届く）。
      // 続けて区切れた数が SPLIT_LIMIT に来たら 1 回だけ知らせる（止めない。止めるのは持ち主の取り消し）
      const splits = (this.#d.kv.getJson<number>(splitKey(task.id)) ?? 0) + 1;
      this.#d.kv.setJson(splitKey(task.id), splits);
      if (splits === SPLIT_LIMIT) {
        notifications.notify({ kind: 'info', title: taskText(language, 'notify.task_long', { title: task.title }), body: taskText(language, 'split.long_body', { title: task.title, runs: SPLIT_LIMIT, max: UNATTENDED_ITERATION_CEILING }), link, dedupKey: `split:${task.id}`, projectId });
      }
      tasks.setReady(task.id, { runAt: now, reason: taskText(language, 'reason.split', { max: UNATTENDED_ITERATION_CEILING }) });
      return;
    }
    if (result.ok) {
      // 道具で終わり方を決めずに返事だけ書いた: 進展が無いとみなし、休む時間を延ばす。続いたら相談する
      const strikes = (this.#d.kv.getJson<number>(idleKey) ?? 0) + 1;
      this.#d.kv.setJson(idleKey, strikes);
      if (result.text.trim()) tasks.update(task.id, { appendNote: taskText(language, result.truncated ? 'note.memo_truncated' : 'note.memo', { text: result.text.trim().slice(0, 500) }) }, 'beat', runId);
      if (strikes >= STAGNATION_LIMIT) {
        this.#d.kv.delete(idleKey);
        const question = taskText(language, 'stuck.question', { title: task.title, strikes });
        tasks.setWaiting(task.id, 'question', question, runId);
        notifications.notify({ kind: 'task_waiting', title: taskText(language, 'notify.task_consult', { title: task.title }), body: question, link, dedupKey: `stuck:${task.id}`, projectId });
      } else {
        tasks.setReady(task.id, { runAt: now + 15 * 60_000 * 2 ** (strikes - 1), reason: taskText(language, 'reason.no_progress') });
      }
      return;
    }
    if (result.errorKind === 'cancelled') {
      tasks.setReady(task.id, { runAt: now + STOPPED_RESUME_MS, reason: taskText(language, 'reason.stopped') });
      return;
    }
    const attempts = task.attempts + 1;
    if (attempts >= task.max_attempts) {
      tasks.finish(task.id, 'failed', result.errorMessage, 'worker', runId);
      notifications.notify({ kind: 'task_failed', title: taskText(language, 'notify.task_failed', { title: task.title }), body: result.errorMessage, link, dedupKey: `failed:${task.id}`, projectId });
      return;
    }
    const delay = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)]!;
    tasks.setReady(task.id, { runAt: now + delay * 60_000, countAttempt: true, reason: taskText(language, 'reason.failed_retry', { detail: result.errorMessage.split('\n')[0]!, delay }) });
  }
}
