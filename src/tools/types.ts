import type { DatabaseSync } from 'node:sqlite';
import type { TSchema } from '@sinclair/typebox';
import type { AppConfig, Language } from '../config/schema.ts';
import type { ImageRef, RunEvent, ToolGate } from '../engine/types.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { TaskStore } from '../tasks/store.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from './skills/store.ts';
import type { DownloadNetwork, PageNetwork } from './web/public-page.ts';
import type { SearchThrottle } from './web/search.ts';
import type { BrowserSession } from './browser/session.ts';
import type { AppPaths } from '../paths.ts';
import type { Decision } from './hooks/shell-guard.ts';
import type { Outbound } from './hooks/outbound.ts';
import type { ScopePolicy } from './hooks/scope.ts';
import type { ApprovalPath, PreviewFile } from './approvals.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { PlanStore } from '../projects/plan.ts';
import type { AcceptanceStore } from '../projects/acceptance.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { Mesh } from '../mesh/index.ts';
import type { QuestionStore } from '../questions/store.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

// 確かめ（ask）になった理由の種類。パイプラインは、順 4（製品の中で動かす）と、人のいない実行の外を読んだあとの持ち主行きを、これで見分ける。
// precheck: 道具の事前の判定で、細かい種類が付いていない理由 / code: コードを動かす / taint: 外から読んだ内容のあと / policy: 道具ごとの方針の ask / hook: 実行前フック。
// 事前の判定が付ける細かい種類 — outside_read: 許可フォルダの外を読む / outside_write: 外に書く / risky_command: サービスの操作・リモートの設定 /
// egress: 外とやり取りする・外のコードを入れる・外を読んだあとの送信 / git_write: git が書く / opaque: 中身や行き先が判定できない / persona: 人格・スキルの書き込み /
// owner: 持ち主が書いた確かめ / web: Web の道具の事前の確かめ。
// 種類の付かない理由・知らない種類は、自動では通さない（新しい確かめを足したときに、黙って自動になることを防ぐ）
export type AskKind =
  | 'precheck' | 'code' | 'taint' | 'policy' | 'hook'
  | 'outside_read' | 'outside_write' | 'risky_command' | 'egress' | 'git_write' | 'opaque' | 'persona' | 'owner' | 'web';

// agent: 親の担当から任された子の担当の実行（agent_run が始める。深さ 1）
export type RunKind = 'chat' | 'task' | 'review' | 'agent';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  fullRef?: string;
  noRemoteContent?: boolean;
  // この結果が外の中身を持ち込んだ（実行の結果を見てからでないと分からないとき。file_search が downloads/ の下の行を返したときなど）。パイプラインは「外から読んだ」印を付ける。印を付ける向きにしか働かない（付けない・外す効果は無い）
  fetched?: boolean;
  // この結果に添える画像（image_view）。エンジンが道具の結果の発言に持たせて保存し、画像を読めるモデルにだけ渡す。失敗（isError）の結果の画像は保存しない。tool.result の出来事・tool_calls の行・output_preview には入れない（文字だけ）
  images?: ImageRef[];
  exitCode?: number;
  pushRefused?: boolean;
  pushCheckUnavailable?: boolean;
}

export interface PreCheck {
  decision: Decision;
  reasons: string[];
  details?: string[];
  // 見つけたパスごとの判定（details と同じ材料を構造で。Pending の再実行で、承認のあとに新しい確かめが出たかを比べるのに使う。recheckOf / newChecks）
  paths?: ApprovalPath[];
  pathsMore?: number;
  // ask の理由の種類（理由ごとに付ける。付けなければ pipeline が precheck とみなして、自動では通さない）
  askKinds?: AskKind[];
  // 確かめで見せるコードのファイル
  preview?: PreviewFile[];
  // 見せたファイルの中身の指紋。承認のあと実行の前にもう一度判定して、変わっていたら実行しない
  bind?: string;
  // シェル: コマンドの git がすべて、設定に core.hooksPath の無い 1 つのリポジトリのもので、そのリポジトリ自身のフックの置き場所。許されたときだけ、git のフックをここに向ける
  ownHooksDir?: string;
  // 事前の判定: この呼び出しが外の中身を持ち込む（シェルの取得・doc_read・downloads/ の下を読む道具など。シェルは git の fetch・pull・clone、パッケージの導入を含む）。実行したら、パイプラインは「外から読んだ」印を付ける（通信の道具と同じ）
  fetched?: boolean;
  // 事前の判定: この呼び出しが外へ送りうる / 消しうる。MCP の道具の申告（outbound.ts の outboundOfCall が読む）
  sends?: boolean;
  removes?: boolean;
  outbound?: Outbound;
  writes?: string[];
  cwd?: string;
  places?: string[];
  created?: string[];
  readPaths?: string[];
  pushes?: Array<{ dir: string | null; parsed?: boolean }>;
  gitStaging?: true;
  reasonKeys?: string[];
  productRun?: 'product-code' | 'product-git';
  ownerReason?: string;
}

// 実行の直前に、パイプライン（承認なし）または Pending の再実行（replay.ts）が道具へ渡す、この 1 回の呼び出しの承認の結果
export interface ExecuteInfo {
  // 持ち主が、この呼び出しの「今回だけ」の確かめ（コードを動かす確かめ）を許した
  approvedOnce: boolean;
  // 許したときに持ち主に見せた事前の判定
  check?: PreCheck;
  // Pending で承認された呼び出しで、再実行の前の再判定が比べて一致した bind（承認のときに見せたものの指紋）。道具は実行の直前の探し直しで、同じ指紋になることをもう一度確かめて、違えば実行しない。
  bind?: string;
  // この呼び出しの id（モデルが付けたもの。agent_run が、画面の agent.state をどの呼び出しの行に結ぶかに使う）
  callId?: string;
  pushCheck?: { tips: readonly string[]; required: boolean };
}

export interface ToolContext {
  runId: string;
  conversationId: string;
  kind: RunKind;
  signal: AbortSignal;
  stopSignal?: AbortSignal | undefined;
  config: AppConfig;
  paths: AppPaths;
  policy: ScopePolicy;
  workspace: string;
  home?: string | undefined;
  project?: { id: string; root?: string | undefined } | undefined;
  taint: { tainted: boolean; sources: string[] };
  // この会話が、これまでの実行のどこかで「よそから来た文を読んだ」ことがあるか（taint はこの実行だけ。これは会話ぜんぶ。読めないときは「ある」側）。
  // 無いとき（試験など）は「ない」として扱う。browser_open の事前の確かめが、この実行で読んでいなくても、会話が読んだあとなら確かめるために見る
  conversationTainted?: (() => boolean) | undefined;
  // この実行で、検索が自動アクセスの判定（ボット判定）で続けて止められた回数（成功・別の失敗で 0 に戻る）
  searchBlocks?: number | undefined;
  // この実行で、task_create で作った・task_update で触ったタスクの id（会話の実行が終わるとき、会話で進んだ分を渡す先を決める）
  touchedTasks?: Set<string> | undefined;
  log: (line: string) => void;
  services?: {
    db: DatabaseSync; memory: MemoryStore; emit: (event: RunEvent) => void;
    tasks?: TaskStore | undefined; curiosity?: CuriosityStore | undefined; skills?: SkillStore | undefined; plans?: PlanStore | undefined; mesh?: Mesh | undefined;
    acceptance?: AcceptanceStore | undefined; projects?: ProjectStore | undefined; questions?: QuestionStore | undefined;
    // 持ち主へのお知らせ（同じ dedupKey は 1 日に重ねない）
    notify?: ((input: { kind: 'info' | 'health_alert'; title: string; body?: string; link?: string; dedupKey: string }) => unknown) | undefined;
    web?: { network?: PageNetwork | undefined; download?: DownloadNetwork | undefined; throttle?: SearchThrottle | undefined } | undefined;
    // ブラウザの道具（browser_*）が使う、全会話で 1 つのブラウザ。無ければ道具は「ブラウザが無い」で失敗する
    browser?: BrowserSession | undefined;
  } | undefined;
  task?: { id: string; control: TaskControl } | undefined;
  // 道具の結果を返せる量の上限（見積もりのトークン。モデルのコンテキストの残りに合わせて、エンジンが呼ぶたびに決める）。
  // 文字数の上限（pipeline.ts の TOOL_OUTPUT_LIMIT = 16,000 文字）とは別で、先に達した方で切る。無ければ文字数の上限だけ
  outputTokens?: number | undefined;
  contextAvailable?: number | undefined;
  // いまモデルを呼んでいる（この道具の結果を次に読む）モデル。エンジンが道具を呼ぶ直前に入れる（鎖で替わったら替わる）。vision は設定の models[].vision。無い（試験・ほかの呼び方）なら、画像を読めないとみなす
  model?: { id: string; vision: boolean } | undefined;
  // この実行では渡さず、呼ばれても拒否する道具の名前（例: 整理の振り返りでは memory_forget）
  forbiddenTools?: ReadonlySet<string> | undefined;
  // 会話のチャットの実行が始まったときの権限モード（段 8b）。無ければ auto。実行に効くのは、これと会話のいまのモードの厳しい方（pipeline.ts の effectiveMode）
  permissionMode?: PermissionMode | undefined;
  noteCreated?: ((path: string) => void) | undefined;
  isCreated?: ((path: string) => boolean) | undefined;
  toolWindow?: (() => () => void) | undefined;
  // agent_run: 子の担当を始めて、終わるまで待つ（チャット・許したタスクの実行にだけ付く。子の実行には付かない = 深さ 1）。結果は区切りで包んだ答え。失敗は isError
  agent?: ((input: AgentRunInput, callId?: string) => Promise<ToolOutput>) | undefined;
  runTool?: ((name: string, input: unknown) => Promise<ToolRunResult>) | undefined;
  deferred?: { loaded: ReadonlySet<string>; list: () => ToolDef[]; load: (names: readonly string[]) => void } | undefined;
  // 子の担当の実行: 親の実行（権限・taint・承認の表示先の元）
  parent?: { runId: string; conversationId: string; kind: RunKind; title: string; taskId?: string | undefined } | undefined;
}

export interface ToolRunResult { output: ToolOutput; decision: Decision; decidedBy: string; gate?: ToolGate }

export interface AgentRunInput { task: string; tools?: string[] | undefined; title?: string | undefined }

export type TaskControl =
  | { outcome: 'none' }
  | { outcome: 'complete'; summary: string; notify: boolean }
  | { outcome: 'checkpoint'; note: string; nextAction: string; resumeAfterMinutes: number }
  | { outcome: 'question'; question: string }
  | { outcome: 'yield'; reason: string }
  | { outcome: 'failed'; reason: string };

export interface ToolDef<I = any> {
  name: string;
  description: string;
  // 設定で変わる説明（モデルへ渡すときに description の代わりに使う）
  describe?: (config: AppConfig) => string;
  input: TSchema;
  effect: ToolEffect;
  allowedIn: readonly RunKind[];
  preCheck?: (input: I, ctx: ToolContext) => PreCheck | Promise<PreCheck>;
  // 外から読んだ内容（Web・添付）のあとで確認を求める道具。書き込み・実行の道具は、これが無くても確認する
  escalateOnTaint?: boolean;
  // 効果は network のまま、ファイルも書く道具（web_download）。計画モードでは書き込みと同じに断り（planAllows）、振り返りでも断り（reviewAllows。効果が何でも）、外から読んだ内容のあとは書き込みと同じに確かめる
  writesFiles?: true;
  // この呼び出し（引数の確かめを通ったあと）が外へ出るか。true なら、効果が network でなくても、外から読んだ印（動かしたら付く）と、自動承認で外を読んだ会話の毎回の確かめを network と同じにする。効果・計画モード・振り返りの扱いは変えない。投げる・false 以外を返すときは外へ出るとみなす
  networkCall?: (input: I) => boolean;
  // 外の MCP サーバーの道具（src/mcp/tool.ts が付ける）。計画モードには渡さない（planAllows）
  mcp?: { server: string; tool: string };
  // ブラウザで押す・入れるなど、ページの中で送信になりうる操作の道具（6b の browser_click / browser_type）。計画モードには渡さず（planAllows）、毎回の承認が要る。6a にはこれを付ける道具は無い
  submits?: true;
  planOk?: true;
  replayable?: false;
  redact?: (text: string) => string;
  projectOnly?: true;
  acceptanceState?: 'draft' | 'frozen';
  summarize?: (input: I, language: Language) => { title: string; body: string; cwd?: string };
  execute: (input: I, ctx: ToolContext, info?: ExecuteInfo) => Promise<ToolOutput>;
}
