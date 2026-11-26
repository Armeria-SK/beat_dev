// Codex app-server の使う口の型（auth-runtime AR-4）。
// 出どころ: `codex app-server generate-ts`（--experimental なし = 安定の面だけ）を codex-cli 0.172.0 から書き出し、beat が使う分だけを書き写して狭めたもの。
// 試験的な口（`capabilities.experimentalApi` で開くもの）は使わない。beat から送る値は、型の上で「聞く側・読むだけ／作業フォルダの中だけ」に閉じてある:
// 送れる approvalPolicy は on-request だけ（untrusted は公式の文で廃止、never・granular は聞かなくなる）、approvalsReviewer は user だけ、sandbox は read-only / workspace-write だけ。
// 返してよい承認の答えも閉じた一覧だけ（許しを残す答え = execpolicy・network policy の変更は型の上で作れない）。
import { PERMISSIONS, permissionFor, type RuntimePermission } from '../types.ts';

// 本物の確かめ（initialize・account/read・model/list・windowsSandbox/readiness）を 2026-11-26 にした版。1 往復の会話はこの PC では確かめられなかった（Windows の囲いが updateRequired）
export const VERIFIED_VERSION = '0.172.0';

export type RequestId = string | number;

export type JsonObject = { [key: string]: unknown };

// ---- 送るもの（beat → app-server） ----

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  // experimentalApi は false の型だけ。true を書けない
  capabilities: { experimentalApi: false; requestAttestation: false };
}

export interface UserInputText { type: 'text'; text: string; text_elements: [] }

export type SentApprovalPolicy = 'on-request';
export type SentReviewer = 'user';
export type SentSandboxMode = 'read-only' | 'workspace-write';
export type SentSandboxPolicy =
  | { type: 'readOnly'; networkAccess: false }
  | { type: 'workspaceWrite'; writableRoots: []; networkAccess: false; excludeTmpdirEnvVar: false; excludeSlashTmp: false };

export interface PermissionParams {
  approvalPolicy: SentApprovalPolicy;
  approvalsReviewer: SentReviewer;
  sandbox: SentSandboxMode;
  sandboxPolicy: SentSandboxPolicy;
}

// 許可の設定 → 送る値。codex の一覧に無い値は既定（read-only + on-request）。どの値でも approvalPolicy は on-request、approvalsReviewer は user
export function wirePermission(permission: RuntimePermission | string | undefined): PermissionParams {
  const safe = permissionFor('codex', permission);
  if (safe === 'workspace-write') {
    return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  }
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}

// Claude Code の値（default・acceptEdits）を Codex に渡さない。値の一覧は types.ts の PERMISSIONS だけが持つ
export function isClaudeCodePermission(value: unknown): boolean {
  return typeof value === 'string' && (PERMISSIONS['claude-code'] as readonly string[]).includes(value);
}

export interface ThreadStartParams extends Pick<PermissionParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'> {
  cwd: string;
  model?: string;
  ephemeral: false;
}

export interface ThreadResumeParams extends Pick<PermissionParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'> {
  threadId: string;
  cwd: string;
  model?: string;
  excludeTurns: true;
}

// turn/start は sandbox（モード）でなく sandboxPolicy（形）を取る。毎回の番にも許可の設定を渡す（番の上書きは次の番の既定にもなるため）
export interface TurnStartParams extends Pick<PermissionParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandboxPolicy'> {
  threadId: string;
  input: UserInputText[];
  cwd: string;
  model?: string;
}

export interface ClientMethods {
  initialize: { params: InitializeParams; result: unknown };
  'account/read': { params: { refreshToken: false }; result: unknown };
  'windowsSandbox/readiness': { params: undefined; result: unknown };
  'model/list': { params: { cursor?: string; limit: number }; result: unknown };
  'thread/start': { params: ThreadStartParams; result: unknown };
  'thread/resume': { params: ThreadResumeParams; result: unknown };
  'turn/start': { params: TurnStartParams; result: unknown };
  'turn/interrupt': { params: { threadId: string; turnId: string }; result: unknown };
}
export type ClientMethod = keyof ClientMethods;

// ---- 返す答え（beat → app-server の求めへの返事）。閉じた一覧だけ ----

export type CommandDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type FileChangeDecision = CommandDecision;
export interface CommandApprovalAnswer { decision: CommandDecision }
export interface FileChangeApprovalAnswer { decision: FileChangeDecision }
// 求められた分だけ、その回だけ（scope は turn だけ。session は返さない）。何も足さないときは permissions が空
export interface PermissionsApprovalAnswer { permissions: { network?: { enabled: boolean | null }; fileSystem?: JsonObject }; scope: 'turn' }
export interface ElicitationDeclineAnswer { action: 'decline'; content: null; _meta: null }
export interface UserInputEmptyAnswer { answers: Record<string, never> }

// ---- 受けるもの（app-server → beat）。形は信用せず、読む側が確かめる。ここは使う欄の名前だけ ----

export const SERVER_REQUEST = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
} as const;

// 聞かれても beat の持ち主へは出さず、読み捨てるだけの知らせ（版が上がっても増えるだけで、beat の動きには関わらない）
export const IGNORED_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'thread/started', 'thread/status/changed', 'thread/readState/changed', 'thread/tokenUsage/updated', 'thread/settings/updated', 'thread/name/updated',
  'thread/compacted', 'thread/closed', 'thread/queue/changed', 'thread/goal/updated', 'thread/goal/cleared', 'thread/prediction/updated',
  'turn/started', 'turn/diff/updated', 'turn/plan/updated', 'turn/moderationMetadata',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/plan/delta',
  'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress',
  'item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'autoApprovalReview/strictReviewRequired',
  'rawResponseItem/completed', 'rawResponse/completed', 'hook/started', 'hook/completed', 'skills/changed',
  'account/updated', 'account/rateLimits/updated', 'remoteControl/status/changed', 'mcpServer/startupStatus/updated', 'mcpServer/oauthLogin/completed',
  'model/rerouted', 'model/verification', 'model/safetyBuffering/updated', 'app/list/updated', 'fs/changed', 'windows/worldWritableWarning',
  'modelProvider/authRecoveryStarted', 'modelProvider/authRecoveryCompleted',
]);

// 記録だけして続ける知らせ（文は伏せて 1 行）
export const WARNING_NOTIFICATIONS: ReadonlySet<string> = new Set(['warning', 'configWarning', 'guardianWarning', 'deprecationNotice']);

// 道具として扱う項目の種類（item/started・item/completed）。ほかの種類は読み捨てるか、知らない出来事として残す
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'subAgentActivity']);
export const QUIET_ITEM_TYPES: ReadonlySet<string> = new Set([
  'agentMessage', 'userMessage', 'reasoning', 'plan', 'contextCompaction', 'hookPrompt', 'functionCallOutput', 'imageView', 'imageGeneration', 'sleep', 'enteredReviewMode', 'exitedReviewMode',
]);

export type WindowsSandboxStatus = 'ready' | 'notConfigured' | 'updateRequired';
