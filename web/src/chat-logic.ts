import type { PermissionMode } from '../../src/shared/permission-mode.ts';
import { ApiError, type ModelChoice, type ModelView } from './api.ts';
import { getLanguage, type Lang, type PlainKey } from './i18n/index.ts';
import { probeMessage, serverText } from './server-text.ts';

export interface ModelProblem { modelId: string; status: string; message: string; hint?: string | undefined; messageCode?: string | undefined; messageParams?: Record<string, string | number> | undefined }

export interface SendFailure {
  message: string;
  hint: string | null;
  context: boolean;
  noModels: boolean;
  body: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function isProblem(value: unknown): value is ModelProblem {
  const record = asRecord(value);
  return record !== null && typeof record.modelId === 'string' && typeof record.status === 'string' && typeof record.message === 'string';
}

// 「使えるモデルがない」の 409 は、モデルごとの理由の行（{lines}）をサーバーが文にして入れている（コードには値が付かない）。
// 画面の言語で出すため、problems の行を組み立て直す。各行は、problems[] 自身の messageCode / messageParams から作る。
// 古いサーバーでコードが付かないときだけ、同じ状態のモデルの確認（コード付き）から作る。組み立てられなければ null（サーバーの文のまま）。
export function noUsableText(body: unknown, models: readonly ModelView[], language: Lang): string | null {
  const record = asRecord(body);
  if (record?.errorCode !== 'engine.no_usable' || !Array.isArray(record.problems) || !record.problems.every(isProblem)) return null;
  const lines: string[] = [];
  for (const problem of record.problems.filter(isProblem)) {
    const probe = models.find(m => m.id === problem.modelId)?.probe ?? null;
    const message = problem.messageCode
      ? probeMessage({ message: problem.message, messageCode: problem.messageCode, messageParams: problem.messageParams }, language)
      : probe !== null && probe.status === problem.status ? probeMessage(probe, language) : problem.message;
    const hintPart = problem.hint ? serverText('engine.problem.hint_suffix', { hint: problem.hint }, language) : '';
    const line = hintPart === null ? null : serverText('engine.problem.line', { id: problem.modelId, message, hintPart }, language);
    if (line === null) return null;
    lines.push(line);
  }
  const text = lines.length ? lines.join('\n') : serverText('engine.problem.none', {}, language);
  return text === null ? null : serverText('engine.no_usable', { lines: text }, language);
}

export function sendFailureOf(error: unknown, fallback: string, models: readonly ModelView[] = []): SendFailure {
  if (!(error instanceof ApiError)) return { message: fallback, hint: null, context: false, noModels: false, body: null };
  const body = asRecord(error.body);
  return {
    noModels: body?.errorCode === 'engine.no_usable' && Array.isArray(body.problems) && body.problems.length === 0,
    message: noUsableText(error.body, models, getLanguage()) ?? error.message,
    hint: text(asRecord(body?.detail)?.hint),
    context: (body?.errorKind ?? body?.error) === 'context_overflow',
    body: error.body,
  };
}

export interface ChatRunRow { id: string; model_id: string | null; model?: string | null; started_at: number }

type IdSource = { randomUUID?: () => string; getRandomValues: (bytes: Uint8Array) => Uint8Array };

// 新しい会話の id。randomUUID は https か localhost でしか使えないので、http の画面では getRandomValues から UUID（v4）を作る。
export function newConversationId(source: IdSource = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 発言と一緒に送る、モデルと考える深さの選び。会話がまだ無いときは、画面で覚えている選びを最初の発言と一緒に送る（サーバーにまだ覚える会話が無いため）。
// 会話があれば送らない（サーバーが覚えている）。override（使えるモデルで送る道など、その場で決めた選び）は、画面で覚えている選びより優先して、そのまま送る
// （画面の状態は、押した直後はまだ古いので使わない。モデルだけを替えるときは、古い考える深さも持ち越さない）
export function sendChoiceOf(conversationId: string | null, current: { modelId: string | null; effort: string | null; permissionMode?: PermissionMode }, override?: ModelChoice, product = false): ModelChoice {
  if (override) return { ...override };
  if (conversationId) return {};
  return { ...(current.modelId ? { modelId: current.modelId } : {}), ...(current.effort ? { effort: current.effort } : {}), ...(product ? { permissionMode: current.permissionMode ?? 'auto' } : current.permissionMode && current.permissionMode !== 'auto' ? { permissionMode: current.permissionMode } : {}) };
}

// 流れている返事を描き直す間隔（ミリ秒）。描き直しは文の長さに比例して重く（1000 文字で約 1 ms、5 万文字で約 60 ms）、
// 断片が届くたびに全文を描き直すと、長い返事の終わりごろには画面がほぼ描き直しだけで埋まる。短い返事は今までどおり届くたびに描く
export function liveRenderDelay(length: number): number {
  return length < 3000 ? 0 : Math.min(1000, Math.round(length / 100));
}

export interface ThrottleTimers {
  // fn を ms 後に呼ぶ。止める関数を返す
  setTimer: (fn: () => void, ms: number) => () => void;
  now: () => number;
  redraw: () => void;
}

// 流れている文を、長さに応じた間隔でしか描き直さない。間隔が過ぎていれば、届いた分をすぐ描く。届かなくなったら、残りを間隔の終わりに描く。
// 画面の部品（useThrottledText）はこれを呼ぶだけにして、時計と待ちを差し替えて試せるようにしてある
export class TextThrottle {
  shown: string;
  drawnAt = 0;
  constructor(initial: string) { this.shown = initial; }

  // 描くたびに呼ぶ。今描く文を返す
  next(text: string, now: number): string {
    const delay = liveRenderDelay(text.length);
    if (delay === 0 || now - this.drawnAt >= delay || !text.startsWith(this.shown)) { this.shown = text; this.drawnAt = now; }
    return this.shown;
  }

  // 描いていない残りがあるとき、間隔の終わりに描き直す待ちを置く。置いたものを止める関数を返す（残りが無ければ undefined）
  arm(text: string, timers: ThrottleTimers): (() => void) | undefined {
    if (this.shown === text) return undefined;
    // 待ちが鳴った時点で残りを描いたことにする。時計が少し早く鳴ると、次の描き直しで「間隔がまだ過ぎていない」と見て、
    // 残りが描かれないまま、文が変わるまで待ちも置き直されない（描き残し）ため
    return timers.setTimer(() => { this.shown = text; this.drawnAt = timers.now(); timers.redraw(); }, Math.max(0, liveRenderDelay(text.length) - (timers.now() - this.drawnAt)));
  }
}

export interface ReplyTurn {
  // この返事の文に、見出し（姿・名前・時刻）を付ける。1 回の返事（同じ runId）の最初の文だけ
  head: boolean;
  // コピーのボタンを付ける。1 回の返事の最後の文だけ（まだ続いている最中は付けない）。押すと、その回の文を全部まとめてコピーする
  copyText: string | null;
}

// 1 回の返事（同じ runId）の中で、道具を使うたびに文が分かれて保存される。画面では見出しを 1 つにして、
// 中間の文と道具の行を、見出しの下に順に並べる。発言（user）が入ったら、そこで次の返事になる。runId の無い文は、それぞれが 1 回の返事。
// 返事が上限で切れて beat が続きを頼んだ一言（note: 'continue'）は区切りにせず、切れた文と続きを区切りなしでつないでコピーする
export function replyTurns(
  messages: ReadonlyArray<{ id: number; role: string; runId: string | null; text: string; note?: string | undefined }>,
  liveRunId: string | null = null,
): Map<number, ReplyTurn> {
  const out = new Map<number, ReplyTurn>();
  let group: Array<{ id: number; text: string; glued: boolean }> = [];
  let glue = false;
  let groupRun: string | null = null;
  const close = (): void => {
    const last = group.at(-1);
    if (!last) return;
    const copyText = groupRun !== null && groupRun === liveRunId ? null : group.map((g, i) => (i === 0 ? '' : g.glued ? '' : '\n\n') + g.text).join('');
    group.forEach((g, i) => out.set(g.id, { head: i === 0, copyText: g === last ? copyText : null }));
    group = [];
    groupRun = null;
  };
  for (const m of messages) {
    if (m.role === 'user' && m.note === 'continue') { glue = true; continue; }
    if (m.role === 'user') { close(); glue = false; continue; }
    if (m.role !== 'assistant') continue;
    if (m.runId === null || m.runId !== groupRun) { close(); glue = false; }
    groupRun = m.runId;
    group.push({ id: m.id, text: m.text, glued: glue });
    glue = false;
  }
  close();
  return out;
}

export const SLASH_COMMANDS = [
  { name: 'new', desc: 'slash.new' },
  { name: 'task', desc: 'slash.task' },
  { name: 'tasks', desc: 'slash.tasks' },
  { name: 'skills', desc: 'slash.skills' },
  { name: 'log', desc: 'slash.log' },
  { name: 'memory', desc: 'slash.memory' },
  { name: 'stop', desc: 'slash.stop' },
  { name: 'rename', desc: 'slash.rename' },
  { name: 'archive', desc: 'slash.archive' },
  { name: 'summary', desc: 'slash.summary' },
] as const satisfies ReadonlyArray<{ name: string; desc: PlainKey }>;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];
export type SlashName = SlashCommand['name'];

// 実行ごとのお知らせの並び。key が同じ（同じ実行の同じ種類）お知らせは、並べずに最新の内容で置き換える
// （要約した件数・外した件数が増えるたびに、同じお知らせが並ばないように）。max 件を超えたら古いものから落とす
export function mergeNotice<T extends { runId: string; key?: string | undefined }>(list: readonly T[], notice: T, max = 8): T[] {
  const at = notice.key === undefined ? -1 : list.findIndex(n => n.runId === notice.runId && n.key === notice.key);
  const next = at >= 0 ? list.map((n, i) => (i === at ? notice : n)) : [...list, notice];
  return next.slice(-max);
}

export function renameTitleOf(input: string): string | null {
  const title = /^\/rename\s+([\s\S]+)$/u.exec(input.trim())?.[1]?.trim();
  return title ? title.slice(0, 200) : null;
}

export const isRenameWithoutTitle = (input: string): boolean => /^\/rename\s*$/u.test(input.trim());

export function firstLine(value: string, max = 160): string {
  const line = value.split('\n').find(l => l.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}
