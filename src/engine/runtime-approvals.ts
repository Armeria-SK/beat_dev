// 外の実行役が聞いてきた承認の求めのうち、持ち主の答えを待っているものの控え（beat auth-runtime AR-8a）。
// 行（Pending の kind: runtime）は DB にあり、ここにはメモリの上だけの「誰が待っているか」を持つ。持ち主の答えは、求めの ID・セッション・Pending の行の番号がそろった待ちにだけ届き、1 回で消える。
// beat は何も動かさない。答えを実行役へ返すだけ。待っているあいだに実行役が落ちた・返事が終わった・止められた・時間が過ぎた行は、「古くなった」で閉じる。
import type { PendingStatus, PendingStore } from '../pending/store.ts';
import { pendingText } from '../shared/messages/pending.ts';
import type { AgentRuntime, ApprovalDecision } from '../runtimes/types.ts';

export const APPROVAL_WAIT_MS = 30 * 60_000;

export interface ApprovalWaiter {
  pendingId: number;
  runtime: AgentRuntime;
  sessionId: string;
  requestId: string;
  runId: string;
  // 実行役が「この返事が終わるまで聞かない」を持ち、beat も出してよいと決めたか
  reply: boolean;
  // 時間切れで、答えを返したあとに呼ぶ
  onTimeout?: (() => void) | undefined;
}

export interface RuntimeApprovalsOptions {
  pending: Pick<PendingStore, 'closeStale'>;
  log?: ((line: string) => void) | undefined;
  waitMs?: number | undefined;
}

export class RuntimeApprovals {
  readonly #pending: RuntimeApprovalsOptions['pending'];
  readonly #log: (line: string) => void;
  readonly #waitMs: number;
  readonly #waiting = new Map<number, { waiter: ApprovalWaiter; timer: NodeJS.Timeout }>();

  constructor(options: RuntimeApprovalsOptions) {
    this.#pending = options.pending;
    this.#log = options.log ?? (() => undefined);
    this.#waitMs = options.waitMs ?? APPROVAL_WAIT_MS;
  }

  get size(): number { return this.#waiting.size; }

  get waitMs(): number { return this.#waitMs; }

  has(pendingId: number): boolean { return this.#waiting.has(pendingId); }

  // 「この返事が終わるまで聞かない」を持ち主に出してよい待ちか（行の側の印とは別に、いま待っている実行役が持っているか）
  offersReply(pendingId: number): boolean { return this.#waiting.get(pendingId)?.waiter.reply === true; }

  register(waiter: ApprovalWaiter): void {
    const timer = setTimeout(() => this.#expire(waiter.pendingId), this.#waitMs);
    timer.unref();
    this.#waiting.set(waiter.pendingId, { waiter, timer });
  }

  #take(pendingId: number): ApprovalWaiter | undefined {
    const entry = this.#waiting.get(pendingId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.#waiting.delete(pendingId);
    return entry.waiter;
  }

  // 持ち主が承認した。返すのは実行役へ返した答え。待ちが無ければ（もう終わった・知らない行）undefined。答えを返せなければ投げる（呼ぶ側が行を「古くなった」で閉じる）
  async accept(pendingId: number, reply: boolean): Promise<'accept' | 'accept_for_reply' | undefined> {
    const waiter = this.#take(pendingId);
    if (!waiter) return undefined;
    const decision = reply && waiter.reply ? 'accept_for_reply' : 'accept';
    await waiter.runtime.approve(waiter.sessionId, waiter.requestId, decision);
    return decision;
  }

  // 行が、持ち主以外の道で決まった（却下・取り消し・古くなった）。実行役の待ちを断りで閉じる。承認（running）はここでは扱わない
  relay(pendingId: number, status: PendingStatus): void {
    if (status === 'running' || status === 'waiting' || status === 'answered') return;
    const waiter = this.#take(pendingId);
    if (!waiter) return;
    const decision: ApprovalDecision = status === 'rejected' ? 'decline' : 'cancel';
    void Promise.resolve().then(() => waiter.runtime.approve(waiter.sessionId, waiter.requestId, decision))
      .catch((error: unknown) => this.#log(`[INFO] Could not pass the answer of pending item #${pendingId} back to its runtime (it may have ended already): ${(error as Error).message}`));
  }

  // 実行役が自分で終えた求め（答えを待たずに道具が終わった）の行を、古くして閉じる
  release(pendingId: number, reason: 'reply_closed' | 'stopped'): void {
    if (this.#take(pendingId)) this.#pending.closeStale(pendingId, pendingText('en', reason === 'stopped' ? 'runtime_stopped' : 'runtime_reply_closed'));
  }

  // 返事が終わった・止められた・落ちた。この実行の待ちを、答えを返さずに「古くなった」で閉じる（実行役はもう答えを待っていない）
  closeRun(runId: string, reason: 'reply_closed' | 'stopped'): number {
    let closed = 0;
    for (const [pendingId, entry] of [...this.#waiting]) {
      if (entry.waiter.runId !== runId) continue;
      this.#take(pendingId);
      if (this.#pending.closeStale(pendingId, pendingText('en', reason === 'stopped' ? 'runtime_stopped' : 'runtime_reply_closed'))) closed += 1;
    }
    return closed;
  }

  #expire(pendingId: number): void {
    const waiter = this.#take(pendingId);
    if (!waiter) return;
    this.#pending.closeStale(pendingId, pendingText('en', 'runtime_timeout'));
    waiter.onTimeout?.();
    void Promise.resolve().then(() => waiter.runtime.approve(waiter.sessionId, waiter.requestId, 'cancel'))
      .catch((error: unknown) => this.#log(`[INFO] Could not cancel the request of pending item #${pendingId} in its runtime: ${(error as Error).message}`));
  }

  // 後始末（アプリを閉じるとき）。待ちは行のまま残り、次の起動で古くなる
  close(): void {
    for (const entry of this.#waiting.values()) clearTimeout(entry.timer);
    this.#waiting.clear();
  }
}
