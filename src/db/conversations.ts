import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import type { ChatMessage } from '../engine/types.ts';
import { readMode, type PermissionMode } from '../shared/permission-mode.ts';

export interface ConversationRow {
  id: string;
  kind: 'chat' | 'task';
  title: string | null;
  snapshot: string | null;
  snapshot_hash: string | null;
  archived: number;
  created_at: number;
  last_message_at: number;
  summary: string | null;
  summary_upto: number | null;
  model_id: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  // 1 = この会話のチャットの実行が、外から読んだ内容（Web・添付・シェルの取得）を一度でも読んだ。付いたら外れない
  ever_tainted: number;
  // 記憶の振り返りの会話だけが持つ。振り返りの材料にした会話・タスク（振り返りの会話には、その全文が入る）。外のモデルの履歴の検索・読み出しから隠す決まりに使う
  source_conversation_id: string | null;
  source_task_id: string | null;
  // 子の担当（agent_run）の会話だけが持つ。親の実行の id。NULL はふつうの会話
  parent_run_id: string | null;
  project_id: string | null;
}

export const LIST_NO_PROJECT_LIMIT = 100;
export const LIST_PER_PROJECT_LIMIT = 30;

// 一覧に出す会話。固定の system の全文や要約の全文は載せない（要約は has_summary で有無だけ。全文は summaryOf で読む）
export type ConversationListItem = Omit<ConversationRow, 'snapshot' | 'snapshot_hash' | 'summary' | 'ever_tainted' | 'source_conversation_id' | 'source_task_id'> & { has_summary: boolean; message_count: number; archived_at: number | null };
const ARCHIVED_AT = 'archived-at:';
type ListRow = Omit<ConversationListItem, 'has_summary'> & { has_summary: number };
const LIST_COLUMNS = `conversations.id, conversations.kind, conversations.title, conversations.archived, conversations.created_at, conversations.last_message_at, conversations.summary_upto,
        conversations.model_id, conversations.effort, conversations.permission_mode, conversations.project_id,
        (conversations.summary IS NOT NULL AND conversations.summary != '') AS has_summary,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id) AS message_count,
        (SELECT CAST(value AS INTEGER) FROM kv WHERE key = '${ARCHIVED_AT}' || conversations.id) AS archived_at`;

export interface StoredMessage {
  id: number;
  conversation_id: string;
  run_id: string | null;
  role: ChatMessage['role'];
  text: string;
  message: ChatMessage;
  created_at: number;
}

export function messageText(message: ChatMessage): string {
  if (message.role === 'tool') return `[${message.name}] ${message.content}`;
  return message.content;
}

const AUTO_TITLE_MAX = 40;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// text の先頭から、見た目の 1 文字（絵文字の合成・国旗・結合文字を含む）の境目だけで、limit 以内（UTF-16 の長さ）まで切り出す
function headWithinGraphemes(text: string, limit: number): string {
  let end = 0;
  for (const { index, segment } of GRAPHEMES.segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  if (end > 0) return text.slice(0, end);
  // 先頭の 1 文字が上限より長い（結合文字だらけ）ときだけ。題を空にしないよう字数で切る（サロゲートの片割れは残さない）
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function shortTitle(text: string): string {
  if (text.length <= AUTO_TITLE_MAX) return text;
  let head = headWithinGraphemes(text, AUTO_TITLE_MAX - 1);
  const space = head.lastIndexOf(' ');
  if (text[head.length] !== ' ' && space >= AUTO_TITLE_MAX / 2) head = head.slice(0, space);
  return `${head.trimEnd()}…`;
}

export interface ReviewSource { conversationId?: string | null | undefined; taskId?: string | null | undefined }

export interface SpeechRow { id: number; conversation_id: string; role: 'user' | 'assistant'; text: string; generated: number; created_at?: number; askAnswer?: number }

export function ownerSpeech(db: DatabaseSync, projectId: string): SpeechRow[] {
  return db.prepare(`SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, COALESCE(json_extract(m.parts, '$.generated'), 0) IS 1 AS generated,
      COALESCE(json_extract(m.parts, '$.askAnswer'), 0) AS askAnswer
    FROM conversations c JOIN messages m ON m.conversation_id = c.id
    WHERE c.project_id = ? AND c.kind = 'chat' AND c.parent_run_id IS NULL AND m.role = 'user'
    ORDER BY m.id`).all(projectId) as unknown as SpeechRow[];
}

// 消した会話の id を覚えておく時間
const DELETED_TTL_MS = 10 * 60_000;

export class Conversations {
  readonly db: DatabaseSync;
  readonly now: () => number;
  readonly #log: ((line: string) => void) | undefined;
  // 消した会話の id と、覚えておく期限。消したあとに、動いていた実行の遅れた書き込みが、会話を作り直さないようにする
  readonly #deleted = new Map<string, number>();
  constructor(db: DatabaseSync, now: () => number = Date.now, log?: (line: string) => void) { this.db = db; this.now = now; this.#log = log; }

  // 消した会話の id を、しばらくのあいだ覚える（その間、その id への ensure / append / setChoice は、会話を作らずに見送る）
  markDeleted(ids: readonly string[]): void {
    const now = this.now();
    for (const [id, until] of this.#deleted) if (until <= now) this.#deleted.delete(id);
    for (const id of ids) this.#deleted.set(id, now + DELETED_TTL_MS);
    // 会話が消えたことを知りたい側（ブラウザのタブを閉じる）へ。ここでの失敗で、消す側の処理を止めない
    try { this.onDeleted?.(ids); } catch (thrown) { this.#log?.(`[ERROR] Failed to notify that conversations were deleted: ${(thrown as Error).message}`); }
  }

  // 会話を消したときに呼ばれる（markDeleted と同じ時点）。App が、消した会話のブラウザのタブを閉じるのに結ぶ
  onDeleted: ((ids: readonly string[]) => void) | undefined;

  // 消した id への新しい発言（持ち主が、同じ id へ送り直した）のとき、覚えを外す。呼ぶのは、ユーザーの発言を受け付ける入口だけ
  reopen(id: string): void { this.#deleted.delete(id); }

  #isDeleted(id: string): boolean {
    const until = this.#deleted.get(id);
    if (until === undefined) return false;
    if (until <= this.now()) { this.#deleted.delete(id); return false; }
    return true;
  }

  // source: 記憶の振り返りの会話を作るとき、材料にした会話・タスク。作ると同時に覚える（作ってから振り返りの記録に結び付くまでの間にも、隠す決まりが効くように）
  create(input: { title?: string; kind?: 'chat' | 'task'; id?: string; source?: ReviewSource; parentRunId?: string; projectId?: string | null | undefined } = {}): ConversationRow {
    const now = this.now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO conversations (id, kind, title, created_at, last_message_at, source_conversation_id, source_task_id, parent_run_id, project_id, permission_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`)
      .run(id, input.kind ?? 'chat', input.title ?? null, now, now, input.source?.conversationId ?? null, input.source?.taskId ?? null, input.parentRunId ?? null, input.projectId ?? null);
    return this.get(id)!;
  }

  projectOf(id: string): string | null {
    return (this.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(id) as { project_id: string | null } | undefined)?.project_id ?? null;
  }

  // 振り返りの会話の材料を覚え直す（前の回から続きを書くとき）
  setSource(id: string, source: ReviewSource): void {
    this.db.prepare('UPDATE conversations SET source_conversation_id = ?, source_task_id = ? WHERE id = ?').run(source.conversationId ?? null, source.taskId ?? null, id);
  }

  get(id: string): ConversationRow | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row && { ...row, permission_mode: readMode(row.permission_mode) };
  }

  // チャットの会話の一覧（新しい順）。archived: true でアーカイブした会話。query は題の部分一致（大文字小文字を区別しない）
  list(limit = 100, options: { archived?: boolean; query?: string; project?: string | null | undefined } = {}): ConversationListItem[] {
    const query = options.query?.trim();
    const like = query ? `%${query.replace(/[!%_]/gu, '!$&')}%` : null;
    const project = options.project === undefined ? '' : options.project === null ? ' AND project_id IS NULL' : ' AND project_id = ?';
    const rows = this.db.prepare(`
      SELECT ${LIST_COLUMNS}
      FROM conversations WHERE archived = ? AND kind = 'chat'${like ? " AND title LIKE ? ESCAPE '!'" : ''}${project}
      ORDER BY last_message_at DESC LIMIT ?
    `).all(...[options.archived ? 1 : 0, ...(like ? [like] : []), ...(options.project ? [options.project] : []), limit]) as unknown as ListRow[];
    return rows.map(row => ({ ...row, permission_mode: readMode(row.permission_mode), has_summary: row.has_summary === 1 }));
  }

  listByProject(options: { query?: string } = {}): { conversations: ConversationListItem[]; more: Record<string, number> } {
    const query = options.query?.trim();
    const like = query ? `%${query.replace(/[!%_]/gu, '!$&')}%` : null;
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY last_message_at DESC) AS rn, COUNT(*) OVER (PARTITION BY project_id) AS total
        FROM conversations WHERE archived = 0 AND kind = 'chat'${like ? " AND title LIKE ? ESCAPE '!'" : ''}
          AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE archived_at IS NULL))
      )
      SELECT ${LIST_COLUMNS}, ranked.total AS total
      FROM ranked JOIN conversations ON conversations.id = ranked.id
      WHERE ranked.rn <= CASE WHEN conversations.project_id IS NULL THEN ${LIST_NO_PROJECT_LIMIT} ELSE ${LIST_PER_PROJECT_LIMIT} END
      ORDER BY conversations.last_message_at DESC
    `).all(...(like ? [like] : [])) as unknown as Array<ListRow & { total: number }>;
    const more: Record<string, number> = {};
    for (const row of rows) {
      const over = row.total - (row.project_id === null ? LIST_NO_PROJECT_LIMIT : LIST_PER_PROJECT_LIMIT);
      if (over > 0) more[row.project_id ?? 'none'] = over;
    }
    return { conversations: rows.map(({ total: _total, ...row }) => ({ ...row, permission_mode: readMode(row.permission_mode), has_summary: row.has_summary === 1 })), more };
  }

  countChats(project: string | null): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE archived = 0 AND kind = 'chat' AND project_id ${project === null ? 'IS NULL' : '= ?'}`).get(...(project === null ? [] : [project])) as { n: number }).n;
  }

  // 会話の要約（全文）と、どこまでの発言を要約したか・要約した発言の件数
  summaryOf(id: string): { summary: string | null; upto: number | null; summarizedMessages: number } {
    const row = this.get(id);
    const upto = row?.summary_upto ?? null;
    const count = upto === null ? 0 : Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id <= ?').get(id, upto) as { n: number }).n);
    return { summary: row?.summary?.trim() ? row.summary : null, upto: row?.summary?.trim() ? upto : null, summarizedMessages: row?.summary?.trim() ? count : 0 };
  }

  // 無ければ空の会話を作る（最初の発言の前に、選んだモデルを覚えるため）。消したばかりの会話は作り直さず、false を返す（見送ったことを記録する）
  ensure(id: string, options: { projectId?: string | null | undefined; modelId?: string | null | undefined; effort?: string | null | undefined; permissionMode?: PermissionMode | undefined } = {}): boolean {
    if (this.get(id)) return true;
    if (this.#isDeleted(id)) { this.#log?.(`[WARN] Skipped writing to deleted conversation ${id} (the conversation is not re-created)`); return false; }
    const now = this.now();
    this.db.prepare(`INSERT INTO conversations (id, kind, created_at, last_message_at, project_id, model_id, effort, permission_mode) VALUES (?, 'chat', ?, ?, ?, ?, ?, ?)`)
      .run(id, now, now, options.projectId ?? null, options.modelId ?? null, options.effort ?? null, options.permissionMode ?? 'auto');
    return true;
  }

  // 会話で選んだモデルと考える深さ・権限モード。渡さなかったものは変えない（モデルと考える深さの null は自動・モデルの既定に戻す）
  setChoice(id: string, choice: { modelId?: string | null | undefined; effort?: string | null | undefined; permissionMode?: PermissionMode | undefined }): void {
    if (!this.ensure(id)) return;
    if (choice.modelId !== undefined) this.db.prepare('UPDATE conversations SET model_id = ? WHERE id = ?').run(choice.modelId, id);
    if (choice.effort !== undefined) this.db.prepare('UPDATE conversations SET effort = ? WHERE id = ?').run(choice.effort, id);
    if (choice.permissionMode !== undefined) this.db.prepare('UPDATE conversations SET permission_mode = ? WHERE id = ?').run(choice.permissionMode, id);
  }

  // 会話に「外から読んだことがある」印を付ける（一度付いたら外れない）。自動承認の判定役に見せる文に「よそから来た文を読んだ会話」の 1 行を足す材料になる（判定役を止めはしない）
  markTainted(id: string): void {
    this.db.prepare('UPDATE conversations SET ever_tainted = 1 WHERE id = ?').run(id);
  }

  // 外から読んだことがある会話か。会話が読めないときは、ある側に倒す
  everTainted(id: string): boolean {
    const row = this.db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get(id) as { ever_tainted: number } | undefined;
    return row === undefined || row.ever_tainted !== 0;
  }

  // 会話の権限モード。無い会話と、前の形の normal は auto
  modeOf(id: string): PermissionMode {
    return readMode((this.db.prepare('SELECT permission_mode FROM conversations WHERE id = ?').get(id) as { permission_mode: string } | undefined)?.permission_mode);
  }

  rename(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  }

  archive(id: string): void {
    const changed = Number(this.db.prepare('UPDATE conversations SET archived = 1 WHERE id = ? AND archived = 0').run(id).changes);
    if (changed > 0) {
      const now = this.now();
      this.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(`${ARCHIVED_AT}${id}`, String(now), now);
    }
  }

  // しまった時刻。しまっていない会話と、時刻を持つ前にしまった会話は null（get は表の行だけで、kv の時刻は一覧と、これで足す）
  archivedAt(id: string): number | null {
    const row = this.db.prepare('SELECT CAST(value AS INTEGER) AS at FROM kv WHERE key = ?').get(`${ARCHIVED_AT}${id}`) as { at: number } | undefined;
    return row?.at ?? null;
  }

  unarchive(id: string): void {
    this.db.prepare('UPDATE conversations SET archived = 0 WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(`${ARCHIVED_AT}${id}`);
  }

  setSnapshotOnce(id: string, snapshot: string, hash: string): boolean {
    const result = this.db.prepare('UPDATE conversations SET snapshot = ?, snapshot_hash = ? WHERE id = ? AND snapshot IS NULL')
      .run(snapshot, hash, id);
    return Number(result.changes) === 1;
  }

  append(conversationId: string, message: ChatMessage, runId?: string): StoredMessage {
    return transaction(this.db, () => {
      const now = this.now();
      const text = messageText(message);
      // 消したばかりの会話への遅れた書き込みは、保存しない（id 0 を返す）
      if (!this.ensure(conversationId)) return { id: 0, conversation_id: conversationId, run_id: runId ?? null, role: message.role, text, message, created_at: now };
      const result = this.db.prepare(`INSERT INTO messages (conversation_id, run_id, role, text, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(conversationId, runId ?? null, message.role, text, JSON.stringify(message), now);
      this.db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, conversationId);
      if (message.role === 'user' && message.attachments?.length) this.markTainted(conversationId);
      return {
        id: Number(result.lastInsertRowid), conversation_id: conversationId, run_id: runId ?? null,
        role: message.role, text, message, created_at: now,
      };
    });
  }

  messages(conversationId: string, limit = 500): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
    `).all(conversationId, limit) as unknown as Array<Omit<StoredMessage, 'message'> & { parts: string }>;
    return rows.map(({ parts, ...row }) => ({ ...row, message: JSON.parse(parts) as ChatMessage }));
  }

  setTail(messageId: number, tail: string): void {
    this.db.prepare("UPDATE messages SET parts = json_set(parts, '$.tail', ?) WHERE id = ? AND role != 'assistant'").run(tail, messageId);
  }

  setSummary(id: string, summary: string, upto: number): void {
    this.db.prepare('UPDATE conversations SET summary = ?, summary_upto = ? WHERE id = ?').run(summary, upto, id);
  }

  autoTitle(id: string, text: string): void {
    const title = shortTitle(text.replace(/\s+/g, ' ').trim());
    if (title) this.db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL').run(title, id);
  }
}
