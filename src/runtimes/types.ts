import type { RuntimeKind } from '../config/schema.ts';

// 実行役ごとに選べる許可の設定（閉じた一覧。先頭が既定）。何でも通す設定・裏で別のモデルが判定する設定は出さない（PLAN.md「選べる許可の設定」）
export const PERMISSIONS: Readonly<Record<RuntimeKind, readonly [string, ...string[]]>> = {
  'claude-code': ['default', 'acceptEdits'],
  codex: ['read-only', 'workspace-write'],
};

// 無い・知らない値は既定（先頭）に倒す。何でも通す側へは倒れない
export function permissionFor(kind: RuntimeKind, value: string | undefined): string {
  const allowed = PERMISSIONS[kind];
  return value !== undefined && allowed.includes(value) ? value : allowed[0];
}

// 実行役が自分でできること・できないこと。できないことは false と宣言させ、画面にそのまま出す
export interface RuntimeCapabilities {
  streaming: boolean;
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  fileChanges: boolean;
  commandExecution: boolean;
  nativeTools: boolean;
  // models() が実行役自身の一覧を返せる（false なら別名の一覧）
  listsModels: boolean;
  // 承認の求めを実行役の外（beat）で受けられる
  externalApprovals: boolean;
  // 選べる許可の設定（先頭が既定）
  permissions: readonly string[];
}

export interface RuntimeStatus {
  installed: boolean;
  version?: string;
  // ログインの状態。beat はログインの中身を読まない（実行役の公式の口で聞くだけ）
  auth: 'ok' | 'login_required' | 'unknown';
  reason?: string;
}

export interface RuntimeModel {
  id: string;
  label?: string;
  efforts?: readonly string[];
}

export interface RuntimeRequest {
  conversationId: string;
  // 製品のフォルダ
  cwd: string;
  model?: string;
  // 続きの会話の ID（実行役が持つもの）
  resume?: string;
  // 起こすたびに必ず渡す。レジストリが設定から決めて入れる（無い・知らない値は既定）
  permission: string;
  signal: AbortSignal;
}

export interface RuntimeSession {
  id: string;
  // 実行役が付けた会話の ID（続きに使う）
  runtimeSession?: string;
}

export interface RuntimeInput {
  text: string;
}

// 返してよい答えは閉じた一覧だけ。使う人の設定や決まりを書き換える「許しを残す答え」は無い
export type ApprovalDecision = 'accept' | 'accept_for_reply' | 'decline' | 'cancel';

export type RuntimeEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; output: string; isError: boolean }
  | { type: 'approval'; requestId: string; tool: string; input: unknown }
  | { type: 'done' }
  | { type: 'failed'; kind: 'auth' | 'rate_limit' | 'process'; message: string }
  // 知らない出来事は捨てずに残す（版が上がって形が変わったとき）
  | { type: 'unknown'; raw: string };

export interface AgentRuntime {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  probe(): Promise<RuntimeStatus>;
  models(): Promise<RuntimeModel[]>;
  start(request: RuntimeRequest): Promise<RuntimeSession>;
  send(sessionId: string, input: RuntimeInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  events(sessionId: string): AsyncIterable<RuntimeEvent>;
  close(sessionId: string): Promise<void>;
}
