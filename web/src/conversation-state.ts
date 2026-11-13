// サーバーの会話の一覧は 100 件まで（src/db/conversations.ts の list の既定）。件数はそれ以上を「100+」と出す。
export const CONVERSATION_LIST_LIMIT = 100;

export const conversationCountLabel = (count: number): string => (count >= CONVERSATION_LIST_LIMIT ? `${CONVERSATION_LIST_LIMIT}+` : String(count));

export interface RunContext {
  // 会話の ID から、その会話を使っているタスクの ID（タスクの実行の会話は、会話の一覧には出ない）
  taskConversations: ReadonlyMap<string, string>;
  running: { runId: string; kind: 'task' | 'review'; taskId: string | null } | null;
}

export type RunGuess = 'chat' | 'background' | 'unknown';

// ユーザーが会話で頼んだ実行か（タスクと振り返りの実行ではないか）。
// 実行中のタスク・振り返り（worker.running）やタスクの会話は「background」、会話の一覧（chat だけが載る）に載っていれば「chat」。
// どちらとも分からない（一覧の外の古い会話か、実行が短くて worker の状態がまだ届いていない振り返り）は「unknown」で、
// 呼び出し側が会話の種類をサーバーに尋ねて決める。
export function classifyRun(runId: string, conversationId: string, context: RunContext, listedChatIds: ReadonlySet<string>): RunGuess {
  if (context.taskConversations.has(conversationId) || context.running?.runId === runId) return 'background';
  return listedChatIds.has(conversationId) ? 'chat' : 'unknown';
}
