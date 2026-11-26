import type { Notification } from '../notify/notifications.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import type { TaskView } from '../tasks/store.ts';

export type EngineErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'provider_error'
  | 'cancelled'
  | 'internal';

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  raw?: string;
}

// 提供元が返した考える部分のブロック（Anthropic の thinking / redacted_thinking）。中身も署名も受け取ったまま持ち、送り返すときも変えない。
// at: そのブロックより前にあった道具の呼び出しの数。lead: まだ文が出ていなかった（送り返すとき文より前に置く）
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string; at: number; lead?: true }
  | { type: 'redacted_thinking'; data: string; at: number; lead?: true };

// 返事の考える部分。書いた提供元とモデル（provider の id とモデルの名前）が同じ相手に送るときだけ送り返す。
// tokens: 送り返すときの量の見積もり（その返事の出力のトークンから、文と呼び出しの分を引いたもの。考える部分の中身は見えないため）
export interface ThinkingRecord { provider: string; model: string; blocks: ThinkingBlock[]; tokens: number }

export interface AttachmentMeta { id: string; name: string; kind: 'text' | 'pdf' | 'image' }

export interface ImageRef {
  mediaType: string;
  data: string;
}

// tail: この発言に付けて送った、毎回変わる部分（時刻・Checklist・裏のコマンド）。エンジンだけが付け、発言の parts に保存する（text と検索の索引には入れない。TE-1）。
// 一度送った tail は、次の実行でも同じ文で同じ場所に送る（前の発言を変えると、考える部分の送り返しとキャッシュが崩れる）。いまの会話の印で囲まれていない tail は送らない
export type ChatMessage =
  // askAnswer: ask_owner の札が開いているあいだに届いた発言（札の答え。選んだ札の文は AI が書いたものなので、持ち主の文〔ToolContext.ownerText〕に数えない。9-1b）
  | { role: 'user'; content: string; images?: ImageRef[]; attachments?: AttachmentMeta[]; generated?: true; note?: 'pending' | 'continue'; fetched?: true; tail?: string; askAnswer?: true }
  // runtime: 外の実行役が動かした道具の呼び出し・結果の行。beat の道具には結び付かない（名前が `<種類>:<道具>` で registry に無い）。nested: 実行役の子の担当が動かしたもの
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; thinking?: ThinkingRecord; runtime?: true; nested?: true }
  // images: 道具の結果に添えた画像（ToolOutput.images。失敗の結果には付けない）。3 つの提供元の変換が、読めるモデルにだけ渡す
  // imageIds: 保存した発言だけが持つ。images の中身（base64）の代わりに、添付と同じ置き場（uploads の行とファイル）の id を残す。モデルに渡すときに images へ戻す。DB の大きさを増やさないため。以前の保存分は images に base64 のまま入っている
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean; images?: ImageRef[]; imageIds?: string[]; gate?: ToolGate; tail?: string; runtime?: true; nested?: true };

// runtime: 外の実行役が自分の許可の設定で通した（beat は見ていない）
export type ToolGate = { by: 'judge'; reason: string; same?: number } | { by: 'pending'; id: number } | { by: 'not-parked' } | { by: 'no-judge' } | { by: 'rule'; id: number; shown: string } | { by: 'runtime' }
  // guard: beat's own code refused a request of the runtime without asking the owner (key: the closed refusal reason). owner: the owner decided a request of the runtime in Pending (allowed: false = declined; closed: the request ended without an answer from the owner, for example it timed out or the reply ended)
  | { by: 'guard'; key: string } | { by: 'owner'; id: number; allowed: boolean; closed?: true };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ContextReason =
  | 'server_ctx_too_small'
  | 'exceeds_model_limit'
  | 'context_unknown'
  | 'prompt_exceeds'
  | 'server_truncation_suspected';

export interface ContextDetail {
  reason: ContextReason;
  measured?: number;
  required?: number;
  hint?: string;
}

export type EngineResult =
  // truncated: 最後の返事が出力の上限で途中で切れた（成功扱いでも、最後まで書けていない）
  // split: 人のいない実行が区切りの回数に来た（max_iterations）か、タスクの実行のやり取りが長くなった（context）ので終わった。続きは次の実行
  | { ok: true; runId: string; text: string; modelId: string; usage: Usage; stop: StopReason; workDone: number; changeDone: number; iterations: number; truncated?: true; split?: 'max_iterations' | 'context' }
  | {
    ok: false;
    runId: string;
    text: '';
    errorKind: EngineErrorKind;
    errorMessage: string;
    errorCode?: string;
    errorParams?: MessageParams;
    retryable: boolean;
    detail?: ContextDetail;
  };

export type RunEvent =
  | { type: 'run.start'; runId: string; conversationId: string; modelId: string }
  | { type: 'model.switch'; runId: string; conversationId: string; from: string; to: string; reason: string }
  | { type: 'text.delta'; runId: string; conversationId: string; text: string }
  | { type: 'warning'; runId: string; conversationId: string; code: string; message: string; params?: Record<string, string | number | MessageParams> }
  | { type: 'message.saved'; runId: string; conversationId: string; messageId: number; role: ChatMessage['role'] }
  | { type: 'tool.call'; runId: string; conversationId: string; callId: string; name: string; input: string; nested?: true }
  | { type: 'tool.result'; runId: string; conversationId: string; callId: string; name: string; ok: boolean; decision: 'allow' | 'ask' | 'deny'; preview: string; gate?: ToolGate; nested?: true }
  // 自動承認の判定役に聞いている（checking）/ 判定役が許した（allowed。reason は判定役の短い理由）/ 判定役が確かめると言った・答えられなかった（asked。このあと Pending に積む）
  | { type: 'tool.auto'; runId: string; conversationId: string; callId: string; name: string; state: 'checking' | 'allowed' | 'asked'; reason?: string }
  | { type: 'memory.changed'; runId: string; conversationId: string; memoryId: number; book: 'user' | 'notes'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { type: 'memoryFile.changed'; runId: string; conversationId: string; projectId: string; name: string; action: 'create' | 'update' | 'forget' | 'restore' | 'reviewed'; eventId: number }
  | { type: 'checklist.updated'; runId: string; conversationId: string; items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>; tainted: boolean }
  | { type: 'compaction'; runId: string; conversationId: string; summarized: number }
  // 子の担当（agent_run）の状態。runId・conversationId・callId は親のもの（親の会話の画面が、その呼び出しの行に結ぶ）。toolCalls は子が動かした道具の回数（running のときは 0）
  | { type: 'agent.state'; runId: string; conversationId: string; callId: string; childRunId: string; childConversationId: string; state: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout'; toolCalls: number }
  | {
    type: 'run.end'; runId: string; conversationId: string; ok: boolean;
    errorKind?: EngineErrorKind; errorMessage?: string; errorCode?: string; errorParams?: MessageParams; detail?: ContextDetail;
  }
  // 会話の題・アーカイブ・削除が変わった（開いているほかの画面が一覧を読み直すため）
  // 実行中に送った待ちの発言が増えた・取り消された・履歴に入った（画面が待ちの一覧を読み直す）
  | { type: 'pending.changed'; conversationId: string }
  | { type: 'pendingAction.changed'; id: number; status: 'waiting' | 'running' | 'ran' | 'failed' | 'rejected' | 'stale' | 'cancelled' | 'answered'; projectId: string | null; conversationId: string; taskId: string | null }
  | { type: 'conversation.changed'; conversationId: string; change: 'renamed' | 'archived' | 'unarchived' | 'deleted'; projectId: string | null }
  | { type: 'project.changed'; projectId: string; change: 'created' | 'updated' | 'archived' | 'restored' }
  | { type: 'plan.changed'; projectId: string; conversationId: string; hash: string; by: 'ai' | 'owner' }
  | { type: 'acceptance.changed'; projectId: string; version: number; draft: boolean }
  | { type: 'question.changed'; id: number; projectId: string | null; status: 'open' | 'answered' }
  | { type: 'task.changed'; task: TaskView }
  // 考える役の状態（GET /api/projects/:id/scout）が変わった。画面は状態を読み直す
  | { type: 'scout.changed'; projectId: string }
  // 調べる記録（beat R）が始まった・部分が進んだ・終わった・確定した。画面は GET /api/projects/:id/research を読み直す
  | { type: 'research.changed'; projectId: string; researchId: string }
  | { type: 'task.deleted'; id: string }
  | { type: 'background.changed'; projectId: string; conversationId: string; id: string; state: 'running' | 'exited' | 'stopped' }
  | { type: 'notification'; notification: Notification }
  // 承認や返事が片づいて、通知が既読になった（画面が一覧と未読数を直す）。unread は既読にしたあとの未読の総数
  | { type: 'notification.read'; ids: number[]; unread: number };
