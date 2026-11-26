import type { RuntimeKind } from '../config/schema.ts';

// 実行役ごとに選べる許可の設定（閉じた一覧。先頭が既定）。何でも通す設定・裏で別のモデルが判定する設定は出さない（PLAN.md「選べる許可の設定」）
export const PERMISSIONS = {
  'claude-code': ['default', 'acceptEdits'],
  codex: ['read-only', 'workspace-write'],
} as const satisfies Readonly<Record<RuntimeKind, readonly [string, ...string[]]>>;

// 選べる値の型。RuntimeRequest.permission がこの型なので、一覧に無い値（bypassPermissions など）は型の上で渡せない
export type RuntimePermission = (typeof PERMISSIONS)[RuntimeKind][number];

// 無い・知らない値は既定（先頭）に倒す。何でも通す側へは倒れない。実行役の作り手（AR-4・AR-5）は、受け取った値にもこれをもう一度通す
export function permissionFor(kind: RuntimeKind, value: string | undefined): RuntimePermission {
  const allowed: readonly RuntimePermission[] = PERMISSIONS[kind];
  return allowed.find(permission => permission === value) ?? PERMISSIONS[kind][0];
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

// 確かめで見つかった、画面に出す注意。種類は閉じた一覧（画面が言葉にする）。detail は短い技術の語だけ（版・状態の語・フォルダの名前・道具の名前）
export const RUNTIME_ISSUES = ['too_old', 'sandbox_not_ready', 'world_writable', 'writable_scan_failed', 'tools_unreviewed'] as const;
export type RuntimeIssueCode = (typeof RUNTIME_ISSUES)[number];

export interface RuntimeIssue {
  code: RuntimeIssueCode;
  detail?: string;
}

// 会話を始められなくする注意（それ以外は、見せるだけ）
export const BLOCKING_ISSUES: ReadonlySet<RuntimeIssueCode> = new Set(['too_old', 'sandbox_not_ready']);

export interface RuntimeStatus {
  installed: boolean;
  version?: string;
  // ログインの状態。beat はログインの中身を読まない（実行役の公式の口で聞くだけ）
  auth: 'ok' | 'login_required' | 'unknown';
  reason?: string;
  // beat が確かめた版か（確かめていない版は、動くかもしれないが保証しない）
  verified?: boolean;
  // 実際に使う認証。subscription = 契約のログイン（Claude Code は authMethod が claude.ai で apiProvider が firstParty のときだけ、Codex は account.type が chatgpt）、other = それ以外（API キーなど）。読めなければ無い
  login?: 'subscription' | 'other';
  issues?: readonly RuntimeIssue[];
}

// 会話を始められない確かめの結果か（会話を始められなくする注意がある、または契約ではないログイン）。画面の札とモデルの状態が同じ決まりを使う
export const startBlocked = (status: Pick<RuntimeStatus, 'login' | 'issues'>): boolean => status.login === 'other' || (status.issues ?? []).some(issue => BLOCKING_ISSUES.has(issue.code));

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
  // 考える深さ（そのモデルの一覧にある値。呼ぶ側が一覧と突き合わせて渡す。実行役の作り手は、知らない形の値を渡さない）
  effort?: string;
  // beat が渡す指示の文。Claude Code は system の文への追加として使い（製品の CLAUDE.md の全文＝持ち主の決め Q-AR-13、計画モードでは計画の指示が続く）、Codex は返事の頭に添える（計画モードの会話だけ。AR-9b）
  instructions?: string;
  // 計画モードの会話だけ（AR-9b）: beat 自身の計画の道具。Claude Code に MCP の道具として見せる。Codex には渡さない（返事の文の中の決まった塊を beat が取り出す）
  planTools?: BeatPlanTools;
  // 続きの会話の ID（実行役が持つもの）
  resume?: string;
  // beat 自身の待ち受けのポート。Claude Code には、このポートへの接続を含むシェルの命令を、使う人の許す決まりより先に断る決まりとして渡す（実行役のシェルから beat の API を呼ばせない）。無ければ決まりを足さない
  beatPort?: number;
  // 起こすたびに必ず渡す。レジストリが設定から決めて入れる（無い・知らない値は既定）
  permission: RuntimePermission;
  signal: AbortSignal;
}

// beat 自身の計画の道具（plan_write・acceptance_write・acceptance_change）。中身は beat の道具の登録の側が動かす（beat の道具の道を通る: 秘密の確かめ・長さ・書いた人の印・控え・出来事）。実行役は名前と説明を見て、call を呼ぶだけ
export interface BeatToolSpec { name: string; description: string }
export interface BeatToolResult { text: string; isError: boolean }
export interface BeatPlanTools {
  // 実行役に見せる道具（受け入れの項目は、固定の前は acceptance_write、固定のあとは acceptance_change の片方だけ）
  specs: readonly BeatToolSpec[];
  call(name: string, input: unknown): Promise<BeatToolResult>;
}

export interface RuntimeSession {
  id: string;
  // 実行役が付けた会話の ID（続きに使う）
  runtimeSession?: string;
  // 実行役のプロセスを、孫まで止められる入れ物（Windows のジョブ）に入れられなかった理由。入れられていれば無い（画面に出す）
  containReason?: string;
}

export interface RuntimeInput {
  text: string;
}

// 返してよい答えは閉じた一覧だけ。使う人の設定や決まりを書き換える「許しを残す答え」は無い
// decline は持ち主が断った答え、decline_by_beat は beat が持ち主に聞かずに断った答え（守りに当たった・計画モード・聞く先が無い）。実行役の側でも断りの理由が分かれる
export type ApprovalDecision = 'accept' | 'accept_for_reply' | 'decline' | 'decline_by_beat' | 'cancel';

// tool_start・tool_end の入力・出力と approval の入力は、実行役が言ってきたまま（伏せていない）。表示・保存する写しは、受け取った側（src/engine/runtime-bridge.ts）が伏せる。
// nested: 子の担当（Claude Code のサブエージェント）が動かした道具。本筋の道具と区別して残す
export type RuntimeEvent =
  // boundary: 実行役が「ここから次の発言」と言った切れ目（Codex の agentMessage の変わり目）。beat は計画の塊を最後の発言からだけ取り出す（AR-9b）
  | { type: 'text'; delta: string; boundary?: true }
  | { type: 'tool_start'; id: string; name: string; input: unknown; nested?: true }
  | { type: 'tool_end'; id: string; output: string; isError: boolean; nested?: true }
  // forReply: 実行役がこの求めに「この返事が終わるまで聞かない」の答えを返せる（Claude Code は session だけの聞かない決まりの提案があるとき、Codex は acceptForSession が効く求めのとき）
  // beatTool: 実行役の窓口が、beat が渡した計画の道具（RuntimeRequest.planTools）の呼び出しだと自分で確かめたときだけ付く、その道具の名前（Claude Code は SDK が言う mcpServer.source が sdk のときだけ）
  | { type: 'approval'; requestId: string; tool: string; input: unknown; forReply?: true; beatTool?: string }
  // 会話の途中で来た、状態の行に出す注意（Codex の windows/worldWritableWarning など）。会話は止まらない
  | { type: 'issue'; issue: RuntimeIssue }
  | { type: 'done' }
  // issue: この失敗の理由を、状態の行に覚えさせる注意（見直していない道具が出たときなど）
  | { type: 'failed'; kind: 'auth' | 'rate_limit' | 'process'; message: string; issue?: RuntimeIssue }
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
  // note: beat が断る理由の文（decline_by_beat のとき）。Claude Code は断りの文として実行役のモデルへ返す。Codex の断りには文を載せる所が無い
  approve(sessionId: string, requestId: string, decision: ApprovalDecision, note?: string): Promise<void>;
  events(sessionId: string): AsyncIterable<RuntimeEvent>;
  close(sessionId: string): Promise<void>;
}
