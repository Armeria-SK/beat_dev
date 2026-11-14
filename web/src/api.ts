import type { PermissionMode } from '../../src/shared/permission-mode.ts';
import type { ToolPolicy } from '../../src/tools/tool-policy.ts';
import { getLanguage } from './i18n/state.ts';
import { errorBodyText } from './server-text.ts';

// 会話の要約（読むだけ）。要約が無ければ summary は null
export interface ConversationSummary { summary: string | null; upto: number | null; summarizedMessages: number }
// 作業の一覧（checklist_write で書かれたもの）。項目の文はモデルが書いた文字で、画面には文字のまま出す
export type ChecklistStatus = 'pending' | 'in_progress' | 'done';
export interface ChecklistItem { text: string; status: ChecklistStatus }
// 一覧が無い会話は items が空で updatedAt が null。tainted は、外の内容を読んだあとに書かれた一覧
export interface ChecklistData { items: ChecklistItem[]; tainted: boolean; updatedAt: number | null }
export interface Conversation {
  id: string; title: string | null; created_at: number; last_message_at: number;
  // 要約があるか（全文は api.summary で読む）
  has_summary?: boolean;
  // アーカイブしているか（1 / 0）。会話を開いたときの応答にだけ付く
  archived?: number;
  // 会話で選んだモデルと考える深さ（null は自動・モデルの既定）
  model_id?: string | null; effort?: string | null;
  // 会話の権限モード（無い = ふつう）
  permission_mode?: PermissionMode;
  // 親の担当から任された子の会話か（run の id。無い・null はふつうの会話）と、任せた親の会話。子の会話は読むだけ
  parent_run_id?: string | null; source_conversation_id?: string | null;
  message_count?: number; archived_at?: number | null;
  project_id?: string | null;
}
export interface ProjectRemote { name: string; url: string; push_url: string | null }
export interface ProjectWaiting { proposals: number; questions: number; pending: number }
export interface Project {
  id: string; name: string; root: string;
  check_command: string | null;
  scout_mode: 'off' | 'research' | 'fix';
  remotes: ProjectRemote[];
  archived_at: number | null; created_at: number; updated_at: number;
  is_git: boolean;
  folder_missing: boolean;
  waiting: ProjectWaiting;
  running: number;
  last_activity_at: number | null;
  has_plan?: boolean;
  doc_language?: string | null;
  doc_language_pinned?: boolean;
}
export type PendingKind = 'send' | 'delete' | 'hook' | 'policy' | 'owner' | 'judge' | 'judge_failed';
export type PendingStatus = 'waiting' | 'running' | 'ran' | 'failed' | 'rejected' | 'stale' | 'cancelled';
export interface PendingFact { path: string; exists: boolean; type?: 'file' | 'dir' | 'link' | 'other'; size?: number; mtime?: number; files?: number; newest?: number; more?: boolean }
export interface PendingAction {
  id: number; tool: string; title?: string | null; shown: string; parts?: { body: string | null; cwd: string | null; extra: string | null }; masked: number; kind: PendingKind; reason: string;
  cwd: string | null; preview: PendingPreview[]; files: PendingFact[]; effect?: { files: number; bytes: number; more?: true } | null;
  conversation_id: string; task_id: string | null; project_id: string | null;
  task_title: string | null; project_name: string | null;
  status: PendingStatus; reject_reason: string | null; exit_code: number | null; output_preview: string | null;
  created_at: number; decided_at: number | null; ran_at: number | null;
}
export interface JudgedCounts { allowed: number; parked: Partial<Record<PendingKind, number>>; notParked: number }
export interface PendingCounts { waiting: number; byProject: Record<string, number>; acceptanceChanges: Record<string, number>; judgedToday: { allowed: number; parked: number } }
export type QuestionKind = 'ai' | 'stuck' | 'check_failed' | 'submit_refused';
export type QuestionFix = 'queued' | 'running' | 'done' | 'failed';
export interface Question {
  id: number; project_id: string | null; task_id: string | null; kind: QuestionKind; question: string; why: string | null; options: string[]; chosen: number | null;
  blocking: boolean; acceptance_item: string | null; status: 'open' | 'answered'; answer: string | null; answer_kind: 'kept' | 'changed' | null; fix_task_id: string | null;
  created_at: number; answered_at: number | null; product: string | null; task: string | null; fix: QuestionFix | null;
}
export interface QuestionCounts { open: number; byProject: Record<string, number>; byTask: Record<string, number>; answered: number; changed: number }
export interface QuestionQuery { status: 'open' | 'answered'; projectId?: string; before?: number }
export interface QuestionAnswer { choice: number | null; text?: string }
export interface QuestionAnswered { question: Question; kind: 'kept' | 'changed'; fixTaskId: string | null; reopenedTaskId: string | null; resumedTaskId: string | null; repeated: boolean; reopenedItem: string | null }
export interface PendingQuery { status: 'waiting' | 'decided'; project?: string; before?: number; earlier?: true }
export interface PlanDoc {
  content: string | null; hash: string | null; updated_at: number | null; updated_by: 'ai' | 'owner' | 'outside' | null; tainted: boolean; writing: boolean; reviewLocked: boolean;
}
export type AcceptanceSource =
  | { kind: 'owner_words'; quote: string; context?: string; messageId?: number; conversationId?: string }
  | { kind: 'owner_choice'; question: string; answer: string; questionMessageId?: number; answerMessageId?: number; conversationId?: string }
  | { kind: 'ai_added'; claimed?: 'owner_words' | 'owner_choice'; reason?: 'not_found' | 'too_short' | 'not_next_reply' | 'choice_unverified' | 'scan_budget'; quote?: string; question?: string; answer?: string }
  | { kind: 'owner_edit' };
export type AcceptanceCheck = { kind: 'command'; command: string } | { kind: 'look' } | { kind: 'read' };
export interface AcceptanceItem {
  id: string; result: string; source: AcceptanceSource; check: AcceptanceCheck; state: 'open' | 'met' | 'unverified'; evidence: unknown[]; changedIn: number | null; removedIn: number | null;
}
export interface NotDoingItem { id: string; text: string; source: AcceptanceSource }
export interface Acceptance {
  version: number; language: string | null; items: AcceptanceItem[]; not_doing: NotDoingItem[]; draft: boolean; hash: string | null;
  frozen: { version: number; hash: string; plan_hash: string | null; created_at: number; source: string; build_task_id: string | null } | null;
  tainted?: boolean;
  change?: AcceptanceChange | null;
  unbuilt?: string[];
  open_build_task_id?: string | null;
}
export interface AcceptanceChangeItem { result: string; check: AcceptanceCheck }
export type OwnerOp = { op: 'add'; item: AcceptanceChangeItem } | { op: 'change'; id: string; item: AcceptanceChangeItem } | { op: 'remove'; id: string };
export type AcceptanceOp = OwnerOp & { source: AcceptanceSource };
export interface AcceptanceChange { id: string; base_version: number; ops: AcceptanceOp[]; language: string | null; conversation_id: string | null; tainted: boolean; status: string; created_at: number }
export interface AcceptanceVersion { project_id: string; version: number; hash: string; plan_hash: string | null; source: string; build_task_id: string | null; created_at: number }
export interface AcceptanceVersionDetail extends AcceptanceVersion { content: unknown }
export interface AcceptanceEdit { baseVersion: number; baseHash: string | null; ops: OwnerOp[] }
export interface UnreferencedMessage { message_id: number; conversation_id: string; text: string; created_at: number }
export interface Coverage {
  owner_words: number; owner_choice: number; owner_edit: number; ai_added: number; by_hand: number; unreferenced: UnreferencedMessage[]; unreferenced_total: number;
}
export type ProjectNote = 'nested_inside' | 'contains_product' | 'inside_config_root' | 'config_root_read_only' | 'not_git';
export interface NewProject { root: string; name?: string; checkCommand?: string }
export interface ProjectPatch { name?: string; checkCommand?: string | null; archived?: boolean; refreshRemotes?: true; docLanguage?: string | null }
export interface FolderEntry { name: string; path: string; selectable: boolean; reason?: string; isGit: boolean; link: boolean }
export interface FolderList { path: string | null; parent: string | null; entries: FolderEntry[]; truncated: boolean }
export interface ConversationList { conversations: Conversation[]; more?: Record<string, number> }
export type ToolGate = { by: 'judge'; reason: string } | { by: 'pending'; id: number } | { by: 'not-parked' };
export interface Message {
  id: number; role: 'user' | 'assistant' | 'tool'; text: string; runId: string | null; createdAt: number;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
  toolName?: string; toolCallId?: string; isError?: boolean; gate?: ToolGate;
  attachments?: Array<{ id: string; name: string; kind: 'text' | 'pdf' | 'image' }>;
}
// 会話で選ぶモデルと考える深さ。渡さなかった方は変えない。null は自動・モデルの既定に戻す
export interface ModelChoice { modelId?: string | null; effort?: string | null; permissionMode?: PermissionMode }
// 実行中に送って、まだ履歴に入っていない発言（今の実行の次の区切りで入る）
export interface PendingMessage { id: string; text: string; attachments: Array<{ id: string; name: string; kind: 'text' | 'pdf' | 'image' }>; interrupt: boolean; createdAt: number }
export interface UploadView { id: string; name: string; mime: string; kind: 'text' | 'pdf' | 'image'; size: number; chars: number | null; pages: number | null }
export interface PendingPreview { path: string; text: string; truncated: boolean }
// 会話を次に送るときのコンテキストの使用量。tokens は古い発言を削る前の見積もり、available は削り始める境目、capacity はモデル全体、ratio は tokens / available（1 を超えうる）
export interface ContextUsage { modelId: string; tokens: number; available: number; capacity: number; ratio: number }
export interface ContextDetail { reason: string; measured?: number; required?: number; hint?: string }

export interface Probe {
  modelId: string; status: string; server: string; declared?: number; measured?: number; modelMax?: number; effective?: number;
  required: number; message: string; messageCode?: string; messageParams?: Record<string, string | number>; hint?: string; capabilities?: string[]; checkedAt: number;
}
export interface ModelView {
  id: string; label: string; provider: string; model: string; providerKind?: string;
  contextLength?: number; minContext: number; maxOutputTokens: number; inChat: boolean; probe: Probe | null;
  // そのモデルで選べる考える深さ（無ければ選ばせない）
  efforts?: string[];
}
export interface SettingsView {
  config: Record<string, any>;
  apiKeys: Record<string, boolean>;
  configError: { message: string; problems: string[]; issues?: Array<{ path: string; message: string; code?: string; params?: Record<string, unknown> }> } | null;
  restartRequired: boolean;
  configPath: string;
}
export interface RunRow {
  // parent_run_id は、親の担当から任された子の run のときだけ入る（右パネルで字下げして見せる）
  parent_run_id?: string | null;
  id: string; kind: string; conversation_id: string | null; model_id: string | null; attempts: number;
  started_at: number; duration_ms: number | null; ok: number | null; error_kind: string | null; error_message: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; est_prompt_tokens: number | null; flags: string[];
  project_id?: string | null;
}

// 道具の一覧（GET /api/tools）。policy は設定の tools.policies、configurable が false の道具（タスクの進め方に必要なもの）は方針を変えられない
export interface ToolInfo {
  name: string; effect: 'read' | 'write' | 'exec' | 'network' | 'meta'; allowedIn: Array<'chat' | 'task' | 'review' | 'agent'>; policy: ToolPolicy; configurable: boolean;
  // 外の MCP サーバーの道具のときだけ。asks は、申告から「確認を求める」理由（聞かないときは無い）
  mcp?: { server: string }; asks?: 'sends' | 'removes' | 'write'; askIsBlock?: true;
}

// POST /api/server/apply の応答。url があるときは、ポートが変わったので、画面はそこへ移る
export interface ServerApplyResult { applied: { listen: boolean; auth: boolean }; server: { host: string; port: number }; url: string | null; restartRequired: boolean }

export interface ToolCallRow {
  id: string; run_id: string; conversation_id: string | null; tool: string; input: string;
  decision: 'allow' | 'ask' | 'deny'; decided_by: string; approval_id: string | null; ok: number | null;
  duration_ms: number | null; output_preview: string | null; full_ref: string | null; created_at: number;
  // 自動承認が許した呼び出しで、判定役の短い理由（ほかは null）
  autoReason: string | null;
  project_id?: string | null;
}

export type Book = 'user' | 'notes';
export interface MemoryItem { id: number; book: Book; content: string; origin: string; source_conversation_id: string | null; source_message_id: number | null; created_at: number; updated_at: number }
export interface MemoryEvent { id: number; memory_id: number; action: string; before: string | null; after: string | null; actor: string; reason: string | null; undone_at: number | null; created_at: number }
export interface BookView { used: number; items: MemoryItem[] }
export interface MemoryContext { tokens: number; budget: number | null; omitted: number }
export interface HistoryHit { conversationId: string; title: string | null; messageId: number; role: string; createdAt: number; snippet: string; projectId?: string | null }

export type TaskStatus = 'inbox' | 'ready' | 'running' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'cancelled';
export interface Task {
  id: string; title: string; body: string; next_action: string | null; done_criteria: string | null;
  status: TaskStatus; origin: 'user' | 'self' | 'curiosity' | 'schedule'; priority: number;
  cron: string | null; cron_text: string | null; run_at: number | null; parent_id: string | null; waiting_text: string | null;
  conversation_id: string | null; result_summary: string | null; attempts: number; max_attempts: number;
  created_at: number; updated_at: number; completed_at: number | null;
  cancelled_from?: TaskStatus | null;
  timezone?: string | null;
  project_id?: string | null;
  acceptance_items?: string | null;
}
export interface FinishedCursor { beforeT: number; beforeId: string }
export interface TaskLastRun { id: string; status: TaskStatus; summary: string | null; at: number }
export type RepeatingTask = Task & { last_run: TaskLastRun | null };
export interface ScheduleSlot { taskId: string; runTaskId: string | null; title: string; start: number; length: number; state: 'past' | 'live' | 'planned'; projectId?: string | null }
export interface ScheduleView { from: number; to: number; slots: ScheduleSlot[]; templates: Array<{ taskId: string; title: string; cron_text: string; truncated: boolean; projectId?: string | null }>; ranTruncated: boolean }
export interface TaskEvent { id: number; kind: string; actor: string; content: string | null; run_id: string | null; created_at: number }
export interface WorkerRun { kind: 'task' | 'review'; taskId: string | null; runId: string; title: string }
export interface WorkerStatus {
  enabled: boolean; autonomy: boolean; paused: boolean; quiet: boolean;
  running: WorkerRun | null; runningAll: WorkerRun[]; maxParallel: number; nextWakeAt: number | null; runsLastHour: number; maxRunsPerHour: number;
}
export interface NotificationItem { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: number | null; created_at: number; project_id?: string | null }
export type Motion = 'auto' | 'none' | 'float' | 'sway' | 'pulse';
export interface Profile { name: string; shape: string; color: string; motion: Motion; shapes: string[]; motions: Motion[] }
export interface NewTask {
  title: string; body?: string; priority?: number; when?: string;
  repeat?: { freq: string; values: Record<string, string> };
  projectId?: string;
}

export interface SkillSummary { name: string; description: string; uses: number; lastUsedAt: number | null; updatedAt: number; registered: boolean }
export interface SkillDraft {
  id: number; name: string; description: string; body: string; reason: string | null; status: string; created_at: number;
  current: { description: string; body: string } | null;
  from_title?: string | null;
}
export interface SkillVersion { id: string; at: number; who: 'you' | 'beat' | 'beat-auto'; lines: number; description: string; body: string }
export interface CuriosityItem {
  id: number; topic: string; why: string | null; status: 'open' | 'researching' | 'done' | 'dropped'; result: string | null;
  task_id: string | null; source: 'beat' | 'user' | 'file'; created_at: number; updated_at: number;
}
export interface ReviewJob {
  id: number; trigger: string; triggerLabel: string; status: 'pending' | 'running' | 'done' | 'failed'; note: string | null;
  conversation_id: string | null; task_id: string | null; run_id: string | null; created_at: number; finished_at: number | null;
  changes: MemoryEvent[];
  project_id?: string | null;
}

export interface TemplatesView { rules: string; files: Array<{ name: string; content: string }> }
export interface OnboardingView { done: boolean; steps: { user: boolean; identity: boolean; persona: boolean; model: boolean } }
export interface PersonaWrite { userName?: string; callMe?: string; botName?: string; style?: 'calm' | 'friendly' | 'direct' | 'none'; styleNote?: string }
export interface PersonaView { soul: string; user: string; tokens: { soul: number; user: number }; budget: number | null; max: number }
// API キーの状態（GET /api/providers/:id/key）。鍵そのものは返らない
// source: 'os' は、鍵が .env ではなく OS の環境変数にある（ここからは消せない。末尾 4 文字も無い）
export interface ProviderKeyState { set: boolean; last4?: string | null; source?: 'os' }
// 外への通知（webhook）の送り先。URL・token の値は返らない（入っているかだけ）
export type NotifyKind = 'task_done' | 'task_waiting' | 'task_failed' | 'approval_needed' | 'health_alert' | 'info';
export interface NotifyChannelView {
  id: string; kind: 'webhook'; enabled: boolean; kinds: NotifyKind[]; includeBody: boolean;
  urlEnv: string; tokenEnv: string | null; urlSet: boolean; tokenSet: boolean;
  lastOkAt: number | null; lastFailAt: number | null; reason: string | null; fails: number;
}
export interface NotifyLimits { maxChannels: number; maxSendsPerHour: number; timeoutMs: number; retries: number; failsBeforeAlert: number }
export interface NotifyView { channels: NotifyChannelView[]; limits: NotifyLimits; publicBaseUrl: string }
export interface NotifySecretState { set: boolean; source?: 'os' }
export type NotifyTestResult = { ok: true } | { ok: false; reason: string };
// ブラウザの状態（GET /api/browser/status）。道具の有効・無効は設定の側で見る
export interface BrowserStatusView { enabled: boolean; running: boolean; loginOpen: boolean; tabs: number; pausedMinutes: number; canShowWindow: boolean }
// 外の MCP サーバー（GET /api/mcp）。秘密の値は返らない（入っているかだけ）
export type McpServerState = 'connecting' | 'ready' | 'failed' | 'off';
export type McpToolState = 'registered' | 'off' | 'changed' | 'missing' | 'schema_invalid' | 'unlisted' | 'cut';
export type McpEffect = 'read' | 'write' | 'network';
export interface McpToolView { name: string; registered: string; state: McpToolState; reason?: string; description: string }
export interface McpSecretView { kind: 'env' | 'header'; name: string; set: boolean; source?: 'os' }
export interface McpServerView {
  id: string; transport: 'stdio' | 'http'; enabled: boolean; target: string; state: McpServerState;
  reason?: string; detail?: string; stderr: string; tools: McpToolView[]; secrets: McpSecretView[];
}
export interface McpLimits { maxServers: number; maxToolsPerServer: number; callTimeoutMs: number; connectTimeoutMs: number; restartsPerHour: number; resultMaxChars: number }
export interface McpView { servers: McpServerView[]; limits: McpLimits }
export interface McpShapeView { description: string; schema: string; destructive: boolean; openWorld: boolean; stripped: number }
export interface McpDiffView { before?: McpShapeView; after: McpShapeView }
export interface McpAddInput {
  id: string; transport: 'stdio' | 'http'; command?: string[]; cwd?: string; url?: string;
  secrets?: { env?: Record<string, string>; headers?: Record<string, string> };
}
export interface McpToolPatch { enabled?: boolean; effect?: McpEffect | null; sends?: boolean | null; removes?: boolean | null }
export interface EnvReloadView { loaded: boolean; apiKeys: Record<string, boolean>; notApplied: string[] }

export class ApiError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(status: number, body: any) {
    // コード（code / errorCode）が辞書にあれば画面の言語で、無ければサーバーの文のまま
    super(errorBodyText(body, getLanguage()) ?? (typeof body?.errorMessage === 'string' ? body.errorMessage : typeof body?.message === 'string' ? body.message : `HTTP ${status}`));
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch((error: unknown) => { if (init.signal?.aborted) throw error; return {}; });
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const inProject = (project: string | undefined, lead: '?' | '&'): string => (project ? `${lead}project=${encodeURIComponent(project)}` : '');

export const api = {
  conversations: () => call<ConversationList>('/api/conversations'),
  conversationsOf: (project: string, limit = 200) => call<ConversationList>(`/api/conversations?project=${encodeURIComponent(project)}&limit=${limit}`),
  projects: (archived = false) => call<{ projects: Project[] }>(`/api/projects${archived ? '?archived=1' : ''}`),
  createProject: (input: NewProject) => call<{ project: Project; notes: ProjectNote[] }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  patchProject: (id: string, patch: ProjectPatch) => call<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  plan: (id: string) => call<{ plan: PlanDoc }>(`/api/projects/${encodeURIComponent(id)}/plan`),
  acceptance: (id: string, unreferencedBefore?: number) =>
    call<{ acceptance: Acceptance; coverage?: Coverage }>(`/api/projects/${encodeURIComponent(id)}/acceptance${unreferencedBefore === undefined ? '' : `?unreferencedBefore=${unreferencedBefore}`}`),
  acceptanceVersions: (id: string) => call<{ versions: AcceptanceVersion[] }>(`/api/projects/${encodeURIComponent(id)}/acceptance/versions`),
  acceptanceVersion: (id: string, version: number) => call<{ version: AcceptanceVersionDetail }>(`/api/projects/${encodeURIComponent(id)}/acceptance/versions/${version}`),
  decideChange: (id: string, changeId: string, decision: 'approve' | 'reject') =>
    call<{ acceptance: Acceptance }>(`/api/projects/${encodeURIComponent(id)}/acceptance/changes/${encodeURIComponent(changeId)}/${decision}`, { method: 'POST', body: '{}' }),
  editAcceptance: (id: string, edit: AcceptanceEdit) => call<{ acceptance: Acceptance }>(`/api/projects/${encodeURIComponent(id)}/acceptance/edit`, { method: 'POST', body: JSON.stringify(edit) }),
  build: (id: string, hashes: { planHash: string; acceptanceHash: string | null }) =>
    call<{ task: Task; version: number }>(`/api/projects/${encodeURIComponent(id)}/build`, { method: 'POST', body: JSON.stringify(hashes) }),
  planReviewed: (id: string, baseHash: string) => call<{ plan: PlanDoc }>(`/api/projects/${encodeURIComponent(id)}/plan/reviewed`, { method: 'POST', body: JSON.stringify({ baseHash }) }),
  savePlan: (id: string, content: string, baseHash: string | null) => call<{ plan: PlanDoc }>(`/api/projects/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: JSON.stringify({ content, baseHash }) }),
  listFolders: (path?: string) => call<FolderList>('/api/folders/list', { method: 'POST', body: JSON.stringify(path === undefined ? {} : { path }) }),
  archivedConversations: (query = '') => call<{ conversations: Conversation[] }>(`/api/conversations?archived=1${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`),
  renameConversation: (id: string, title: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  archiveConversation: (id: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }),
  unarchiveConversation: (id: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }),
  messages: (id: string) => call<{ conversation: Conversation; messages: Message[]; pending: PendingMessage[]; activeRun: { runId: string; draft: string } | null }>(`/api/conversations/${id}/messages`),
  cancelPending: (id: string, pendingId: string) => call<{ cancelled: true }>(`/api/conversations/${encodeURIComponent(id)}/pending/${encodeURIComponent(pendingId)}`, { method: 'DELETE' }),
  deleteConversation: (id: string) => call<{ deleted: true }>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  summary: (id: string) => call<ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}/summary`),
  checklist: (id: string) => call<ChecklistData>(`/api/conversations/${encodeURIComponent(id)}/checklist`),
  contextUsage: (id: string, modelId?: string) => call<ContextUsage>(`/api/conversations/${encodeURIComponent(id)}/context${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`),
  pending: (query: PendingQuery) =>
    call<{ items: PendingAction[] }>(`/api/pending?status=${query.status}${inProject(query.project, '&')}${query.before === undefined ? '' : `&before=${query.before}`}${query.earlier ? '&earlier=1' : ''}`),
  pendingCounts: () => call<PendingCounts>('/api/pending/counts'),
  approvePending: (id: number) => call<{ item?: PendingAction }>(`/api/pending/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectPending: (id: number, reason: string) => call<{ item?: PendingAction }>(`/api/pending/${id}/reject`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
  questions: (query: QuestionQuery) =>
    call<{ items: Question[] }>(`/api/questions?status=${query.status}${query.projectId ? `&projectId=${encodeURIComponent(query.projectId)}` : ''}${query.before === undefined ? '' : `&before=${query.before}`}`),
  questionCounts: () => call<QuestionCounts>('/api/questions/counts'),
  answerQuestion: (id: number, answer: QuestionAnswer) => call<QuestionAnswered>(`/api/questions/${id}/answer`, { method: 'POST', body: JSON.stringify(answer) }),
  // 実行中に送ると待たされる（queued）。interrupt なら、今の実行を止めて、この発言から始める
  send: (id: string, text: string, attachments: string[] = [], choice: ModelChoice = {}, options: { interrupt?: boolean; projectId?: string; generated?: boolean } = {}) =>
    call<{ runId: string; queued?: boolean; pendingId?: string; effortReset?: boolean }>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}), ...choice, ...(options.interrupt ? { interrupt: true } : {}), ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.generated ? { generated: true } : {}) }) }),
  chooseMode: (id: string, permissionMode: PermissionMode) => call<{ conversation: Conversation }>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ permissionMode }) }),
  chooseModel: (id: string, choice: ModelChoice) => call<{ conversation: Conversation; effortReset?: boolean }>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(choice) }),
  upload: async (file: File) => {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return (body as { upload: UploadView }).upload;
  },
  retry: (id: string) => call<{ runId: string }>(`/api/conversations/${id}/retry`, { method: 'POST', body: '{}' }),
  stop: (runId: string) => call(`/api/runs/${runId}/stop`, { method: 'POST', body: '{}' }),
  runs: (limit = 200, project?: string) => call<{ runs: RunRow[]; total: number; judged: JudgedCounts }>(`/api/runs?limit=${limit}${inProject(project, '&')}`),
  toolCalls: (project?: string) => call<{ toolCalls: ToolCallRow[]; total: number }>(`/api/tool-calls?limit=200${inProject(project, '&')}`),
  settings: (signal?: AbortSignal) => call<SettingsView>('/api/settings', { signal: signal ?? null }),
  applyServer: (force = false) => call<ServerApplyResult>('/api/server/apply', { method: 'POST', body: JSON.stringify(force ? { force: true } : {}) }),
  saveSettings: (config: unknown, signal?: AbortSignal) => call<SettingsView & { models: ModelView[] }>('/api/settings', { method: 'PUT', body: JSON.stringify({ config }), signal: signal ?? null }),
  models: () => call<{ models: ModelView[]; routing: { chat: string[]; background: string[] } }>('/api/models'),
  probe: () => call<{ models: ModelView[] }>('/api/models/probe', { method: 'POST', body: '{}' }),
  memories: () => call<{ books: Record<Book, BookView>; context: MemoryContext | null }>('/api/memories'),
  addMemory: (book: Book, content: string) => call<{ memory: MemoryItem; eventId: number }>('/api/memories', { method: 'POST', body: JSON.stringify({ book, content }) }),
  editMemory: (id: number, content: string) => call<{ memory: MemoryItem; eventId: number }>(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
  forgetMemory: (id: number) => call<{ memory: MemoryItem; eventId: number }>(`/api/memories/${id}`, { method: 'DELETE' }),
  memoryEvents: (id: number) => call<{ events: MemoryEvent[] }>(`/api/memories/${id}/events`),
  recentMemoryEvents: () => call<{ events: MemoryEvent[] }>('/api/memory-events'),
  undoMemory: (eventId: number) => call(`/api/memory-events/${eventId}/undo`, { method: 'POST', body: '{}' }),
  tasks: (project?: string) => call<{ active: Task[]; finished: Task[]; finishedTotal?: number; repeating?: RepeatingTask[] }>(`/api/tasks${inProject(project, '?')}`),
  schedule: (from: number, to: number) => call<ScheduleView>(`/api/schedule?from=${from}&to=${to}`),
  deleteTask: (id: string) => call<{ deleted: { id: string; events: number; keptRuns: number } }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  finishedTasks: (before: FinishedCursor | null, limit = 20, project?: string) =>
    call<{ tasks: Task[]; next: FinishedCursor | null; total: number }>(`/api/tasks/finished?limit=${limit}${before ? `&beforeT=${before.beforeT}&beforeId=${encodeURIComponent(before.beforeId)}` : ''}${inProject(project, '&')}`),
  unapproveTask: (id: string) => call<{ task: Task }>(`/api/tasks/${id}/unapprove`, { method: 'POST', body: '{}' }),
  cancelTask: (id: string, reason = '') => call<{ task: Task }>(`/api/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}) }),
  task: (id: string) => call<{ task: Task; events: TaskEvent[]; runs: Task[] }>(`/api/tasks/${id}`),
  createTask: (task: NewTask) => call<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }),
  editTask: (id: string, patch: { title?: string; body?: string; nextAction?: string | null; doneCriteria?: string | null; priority?: number; when?: string | null; repeat?: NewTask['repeat'] }) =>
    call<{ task: Task }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  answerTask: (id: string, text: string) => call<{ task: Task }>(`/api/tasks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text }) }),
  taskAction: (id: string, action: 'run-now' | 'approve' | 'cancel' | 'uncancel' | 'done') => call<{ task: Task }>(`/api/tasks/${id}/${action}`, { method: 'POST', body: '{}' }),
  worker: () => call<WorkerStatus>('/api/worker'),
  setWorker: (patch: { paused?: boolean; autonomy?: boolean }) => call<WorkerStatus>('/api/worker', { method: 'POST', body: JSON.stringify(patch) }),
  notifications: () => call<{ notifications: NotificationItem[]; unread: number }>('/api/notifications'),
  readNotifications: (ids?: number[]) => call<{ unread: number }>('/api/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }),
  profile: () => call<Profile>('/api/profile'),
  saveProfile: (patch: Partial<Pick<Profile, 'name' | 'shape' | 'color' | 'motion'>>) => call<Profile>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
  review: () => call<{ skillDrafts: SkillDraft[]; taskProposals: Task[] }>('/api/review'),
  approveDraft: (id: number) => call(`/api/skill-drafts/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectDraft: (id: number) => call(`/api/skill-drafts/${id}/reject`, { method: 'POST', body: '{}' }),
  reviews: (project?: string) => call<{ jobs: ReviewJob[]; pending: number; total: number }>(`/api/reviews${inProject(project, '?')}`),
  reviewConversation: (conversationId: string) => call<{ queued: boolean }>('/api/reviews', { method: 'POST', body: JSON.stringify({ conversationId }) }),
  tools: () => call<{ tools: ToolInfo[] }>('/api/tools'),
  setToolPolicy: (name: string, policy: ToolPolicy) => call<{ tool: ToolInfo }>(`/api/tools/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ policy }) }),
  skills: () => call<{ skills: SkillSummary[]; dir: string }>('/api/skills'),
  skill: (name: string) => call<{ skill: SkillSummary & { body: string } }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, description: string, body: string) => call(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ description, body }) }),
  skillHistory: (name: string) => call<{ versions: SkillVersion[] }>(`/api/skills/${encodeURIComponent(name)}/history`),
  registerSkill: (name: string) => call(`/api/skills/${encodeURIComponent(name)}/register`, { method: 'POST', body: '{}' }),
  deleteSkill: (name: string) => call(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  curiosity: (all = false) => call<{ items: CuriosityItem[] }>(`/api/curiosity${all ? '?all=1' : ''}`),
  addCuriosity: (topic: string, why?: string) => call('/api/curiosity', { method: 'POST', body: JSON.stringify({ topic, ...(why ? { why } : {}) }) }),
  updateCuriosity: (id: number, patch: { status?: CuriosityItem['status']; result?: string }) => call(`/api/curiosity/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  curiosityTask: (id: number) => call(`/api/curiosity/${id}/task`, { method: 'POST', body: '{}' }),
  history: (q: string, days?: number) => call<{ hits: HistoryHit[] }>(`/api/history?q=${encodeURIComponent(q)}${days ? `&days=${days}` : ''}`),
  templates: () => call<TemplatesView>('/api/templates'),
  onboarding: () => call<OnboardingView>('/api/onboarding'),
  onboardingDone: () => call<OnboardingView>('/api/onboarding/done', { method: 'POST', body: '{}' }),
  onboardingPersona: (input: PersonaWrite) => call<OnboardingView & { profile: Profile }>('/api/onboarding/persona', { method: 'POST', body: JSON.stringify(input) }),
  providerModels: (id: string) => call<{ models: string[]; truncated: boolean }>(`/api/providers/${encodeURIComponent(id)}/models`),
  resetPreview: (signal?: AbortSignal) => call<{ config: Record<string, any> }>('/api/settings/reset', { signal: signal ?? null }),
  resetSettings: (signal?: AbortSignal) => call<SettingsView & { models: ModelView[]; backup: string }>('/api/settings/reset', { method: 'POST', body: '{}', signal: signal ?? null }),
  providerKey: (id: string) => call<ProviderKeyState>(`/api/providers/${encodeURIComponent(id)}/key`),
  setProviderKey: (id: string, key: string) => call<ProviderKeyState>(`/api/providers/${encodeURIComponent(id)}/key`, { method: 'PUT', body: JSON.stringify({ key }) }),
  deleteProviderKey: (id: string) => call<ProviderKeyState>(`/api/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' }),
  notify: () => call<NotifyView>('/api/notify/channels'),
  addNotifyChannel: (input: { id: string; url: string; token?: string; kinds?: NotifyKind[]; includeBody?: boolean }) => call<NotifyView>('/api/notify/channels', { method: 'POST', body: JSON.stringify(input) }),
  patchNotifyChannel: (id: string, patch: { enabled?: boolean; kinds?: NotifyKind[]; includeBody?: boolean }) => call<NotifyView>(`/api/notify/channels/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteNotifyChannel: (id: string) => call<NotifyView>(`/api/notify/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setNotifySecret: (id: string, field: 'url' | 'token', value: string) => call<NotifySecretState>(`/api/notify/channels/${encodeURIComponent(id)}/secrets/${field}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteNotifySecret: (id: string, field: 'token') => call<NotifySecretState>(`/api/notify/channels/${encodeURIComponent(id)}/secrets/${field}`, { method: 'DELETE' }),
  testNotifyChannel: (id: string) => call<NotifyTestResult>(`/api/notify/channels/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  mcp: () => call<McpView>('/api/mcp'),
  browserStatus: () => call<BrowserStatusView>('/api/browser/status'),
  browserLogin: () => call<BrowserStatusView>('/api/browser/login', { method: 'POST', body: '{}' }),
  browserClose: () => call<BrowserStatusView>('/api/browser/close', { method: 'POST', body: '{}' }),
  browserProfileReset: () => call<BrowserStatusView>('/api/browser/profile/reset', { method: 'POST', body: '{}' }),
  addMcpServer: (input: McpAddInput) => call<McpView>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(input) }),
  patchMcpServer: (id: string, patch: { enabled?: boolean }) => call<McpView>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMcpServer: (id: string) => call<McpView>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restartMcpServer: (id: string) => call<McpView>(`/api/mcp/servers/${encodeURIComponent(id)}/restart`, { method: 'POST', body: '{}' }),
  setMcpSecret: (id: string, kind: 'env' | 'header', name: string, value: string) => call<{ set: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}/secrets/${kind}/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteMcpSecret: (id: string, kind: 'env' | 'header', name: string) => call<{ set: boolean; source?: 'os' }>(`/api/mcp/servers/${encodeURIComponent(id)}/secrets/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  patchMcpTool: (id: string, tool: string, patch: McpToolPatch) => call<McpView>(`/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  acceptMcpTool: (id: string, tool: string) => call<McpView>(`/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/accept`, { method: 'POST', body: '{}' }),
  mcpToolDiff: (id: string, tool: string) => call<McpDiffView>(`/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/diff`),
  patchNotify: (patch: { publicBaseUrl?: string; limits?: Partial<NotifyLimits> }) => call<NotifyView>('/api/notify', { method: 'PATCH', body: JSON.stringify(patch) }),
  reloadEnv: (env: string[] = []) => call<EnvReloadView>('/api/onboarding/reload-env', { method: 'POST', body: JSON.stringify({ env }) }),
  persona: () => call<PersonaView>('/api/workspace/persona'),
  savePersona: (patch: { soul?: string; user?: string }) => call<PersonaView>('/api/workspace/persona', { method: 'PUT', body: JSON.stringify(patch) }),
};
