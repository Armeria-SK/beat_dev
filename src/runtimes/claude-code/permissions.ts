// Claude Code に渡す許可まわりの決まりと、承認の答えの作り方。ここにあるものが、使う人の設定や決まりを書き換える答え・何でも通す設定を作らないことの根拠（PLAN.md「第 5 版の決め」の 3）
import type { HookCallback, HookCallbackMatcher, HookEvent, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { SECRET_GLOBS } from '../../tools/hooks/scope.ts';
import { PERMISSIONS, permissionFor, type ApprovalDecision } from '../types.ts';

export type ClaudePermissionMode = (typeof PERMISSIONS)['claude-code'][number];

// 無い・知らない値は、既定の default に倒す。何でも通す側（bypassPermissions）・裏で判定する側（auto）・黙って断る側（dontAsk）・計画（plan）には倒れない。
// 別の実行役（Codex）の値は倒さずに断る（isCodexPermission。Codex 側の isClaudeCodePermission と同じ向き）
export function claudeMode(value: string | undefined): ClaudePermissionMode {
  const mode = permissionFor('claude-code', value);
  return PERMISSIONS['claude-code'].find(allowed => allowed === mode) ?? PERMISSIONS['claude-code'][0];
}

const claudeValues: readonly string[] = PERMISSIONS['claude-code'];
const codexValues: readonly string[] = PERMISSIONS.codex;

export function isCodexPermission(value: string | undefined): boolean {
  return value !== undefined && !claudeValues.includes(value) && codexValues.includes(value);
}

// 外す道具（名前は SDK の BUILTIN_TOOL_NAMES の綴り）。外した名前の道具は、どの許可のモードでも使えない。ここで保証するのは、その名前の道具をモデルが使えないことだけ。
// 同じことをする別の入り口は、この一覧では止まらない。止めているのは Agent の isolation だけ（下の toolHooks）。使う人の設定の agent の定義（frontmatter の permissionMode・isolation・hooks）・skill の allowed-tools・
// permissions.allow・設定の worktree.* は止めていない（settingSources: ['user'] で読まれる。AR-6 の知らせに書く）。
//  - AskUserQuestion: 質問を画面で受ける口が無いので外す（文で聞かせる）
//  - CronCreate・CronDelete・CronList・ScheduleWakeup: あとで動く予定を作る・変える（1 回の返事で終わるプロセスの外に残る。SDK の文書: 「この会話をあとで起こす」予定）
//  - RemoteTrigger: 遠くで動く仕事を起こす
//  - Artifact・ClaudeDesign: claude.ai 側にページ・デザインを作って載せる（名前による。本物では動かしていない）
//  - PushNotification・SendUserMessage・SendUserFile: 使う人の端末への通知・メッセージ・ファイルの送り出し（名前による。本物では動かしていない）
//  - SendMessage: ほかの会話へ送る（SDK の文書: Remote Control で別のマシンの会話にも届く）
//  - SendFeedback: 下書きのフィードバックを Anthropic へ送る
//  - ShareOnboardingGuide: 名前が「共有」（外へ出す）。名前による。本物では動かしていない
//  - EnterWorktree・ExitWorktree: 作業の木（git worktree）を作って入る。木の置き場は beat が決めて守るので、Claude Code に作らせない（beat の守りは Claude Code の作る木を見ず、木は返事が終わっても残る）
//  - Workflow: 複数の作業役を束ねる道具で、木での隔離も頼める（SDK の本体の読みによる。本物では動かしていない）
//  - Projects: 作業フォルダのファイルを claude.ai のプロジェクトへ上げ、向こうの文書を消せる（SDK の道具の定義）。Artifact と同じ外へ出す種類
export const DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger',
  'Artifact', 'ClaudeDesign',
  'PushNotification', 'SendUserMessage', 'SendUserFile', 'SendMessage', 'SendFeedback', 'ShareOnboardingGuide',
  'EnterWorktree', 'ExitWorktree',
  'Workflow', 'Projects',
] as const;

// 残す道具（組み込み。SDK の BUILTIN_TOOL_NAMES から、外す道具を引いた残り。試験が 2 つの一覧の合わせを SDK の名前の全部と突き合わせる）。起こすときの `tools` に渡して、基本の一覧をこれに固定する。
// 使う人の claude.exe は自分で更新されて新しい道具を足すことがあるが、ここに無い名前は基本の一覧に入らない。それでも入ってきたとき（起動の知らせの tools にこれ以外の組み込みの名前があるとき）は、protocol.ts がその返事を続けない。
// どれも、名前と SDK の文書で見直して外す理由が無いとした道具（本物で動かしたものは一部）。Agent の isolation だけは、下のフックで断る
export const KEPT_TOOLS = [
  'Agent', 'Bash', 'Edit', 'EndConversation', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'ListAgents', 'ListMcpResourcesTool', 'LSP', 'Monitor',
  'NotebookEdit', 'OfferChromeSetup', 'PowerShell', 'propose_skills', 'Read', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool', 'ReadNotifications', 'ReportFindings', 'SetGoal',
  'ShowOnboardingRolePicker', 'Skill', 'SubagentHandback', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch', 'WebSearch', 'Write',
] as const;

// 本物の Claude Code 2.1.331 は、起動の知らせの tools で Agent を旧い名前 Task で言う（呼び出しの名前は Agent。本物で見た）。その別名は見直し済みの Agent として数える。tools には渡さない（Agent で足りる）
export const REPORTED_ALIASES = ['Task'] as const;

const KEPT = new Set<string>([...KEPT_TOOLS, ...REPORTED_ALIASES]);

// 起動の知らせの tools のうち、見直していない組み込みの名前（mcp__ で始まる MCP の道具は、組み込みではないので数えない）。tools が配列でないときは undefined（確かめられない）
export function unreviewedTools(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(name => String(name)).filter(name => !name.startsWith('mcp__') && !KEPT.has(name));
}

// 残した Agent（部下の作業役）は、引数の isolation（"worktree" = 作業の木を作る・"remote" = 遠くで動かす。SDK の道具の定義）を付けられる。名前を外すと部下ごと使えなくなるので、
// 外さずに、PreToolUse のフックで isolation が付いた呼び出し（値は何でも）だけ断る。読めない入力も断る。フック自体が失敗したときも、その呼び出しは止める（onFailure: 'block'）。
// どの呼び出しがフックに届くかは matcher（Agent|Task）が決める。コールバックは名前を見直さない（道具の名前が変わって別名が matcher に残っても、断りが消えないように）。
// 断ったあとモデルは isolation なしで頼み直せる（その呼び出しは通る）
const AGENT_TOOL_NAMES = 'Agent|Task';

export const refuseIsolation: HookCallback = async input => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const tool: unknown = input.tool_input;
  const readable = typeof tool === 'object' && tool !== null && !Array.isArray(tool);
  if (readable && (tool as { isolation?: unknown }).isolation === undefined) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: readable
        ? 'beat does not allow an agent to run in its own worktree or remotely (the isolation option). Run the agent without it.'
        : 'beat could not read this agent request, so it was refused.',
    },
  };
};

export function toolHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return { PreToolUse: [{ matcher: AGENT_TOOL_NAMES, hooks: [refuseIsolation], onFailure: 'block' }] };
}

// beat の秘密の道の名前（scope.ts の SECRET_GLOBS）から作る、読む道具・書く道具の deny の決まり。deny の決まりは、許可のモードや使う人の allow の決まりより先に効く
export function secretDenyRules(): string[] {
  return SECRET_GLOBS.flatMap(glob => [`Read(${glob})`, `Edit(${glob})`]);
}

// beat 自身のポートへの接続を含む、シェルの命令（Bash・PowerShell・Monitor）の deny の決まり。使う人の設定の allow（Bash(curl:*) など）に通される形でも、beat の API（承認の答えなど）を実行役が自分で呼べないようにする。
// 命令の文字列に当てる決まりなので、ポートを組み立てて書く形までは止まらない（止めきる守りではない）
const SELF_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor'] as const;

export function selfPortDenyRules(port: number | undefined): string[] {
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return [];
  return SHELL_TOOLS.flatMap(tool => SELF_HOSTS.map(host => `${tool}(*${host}:${port}*)`));
}

export function disallowedTools(beatPort?: number): string[] {
  return [...DISALLOWED_TOOLS, ...secretDenyRules(), ...selfPortDenyRules(beatPort)];
}

// 「この返事が終わるまで聞かない」で返してよい更新。destination が session（この Claude Code のプロセスの中だけ）の、聞かない決まり（allow の addRules）だけ。
// 許可のモードの切り替え（Write の求めに付いてくる acceptEdits など）は、残りの返事ぜんぶの編集を通すことになり、1 回の許しより広いので返さない。
// localSettings・projectSettings・userSettings・cliArg への書き込み、ディレクトリを足す更新、決まりを消す・置き換える更新も、使う人の設定や決まりを書き換えるか、聞かれた範囲より広いので返さない。
// 残るものが無ければ、ふつうの許し（accept）と同じ答えになる
export function sessionOnlyUpdates(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).filter(update => update.destination === 'session' && update.type === 'addRules' && update.behavior === 'allow');
}

const DECLINED = 'The owner declined this request. Do not try to do the same thing another way; go on with other work, or ask the owner what they want instead.';
const DECLINED_BY_BEAT = "beat declined this request without asking the owner (one of beat's own guards, or plan mode). Do not look for another way around this; tell the owner if the work needs it.";
const CANCELLED = 'The owner stopped the reply.';

// 答えの作り方。許可は入力を書き換えず（updatedInput は元の入力）、閉じた一覧の外の答えは断りにする。
// note: beat が断る理由（decline_by_beat のときだけ使う）。計画モードなのか、どの守りなのかを、実行役のモデルへそのまま返す
export function answerFor(decision: ApprovalDecision, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[] | undefined, note?: string): PermissionResult {
  switch (decision) {
    case 'accept': return { behavior: 'allow', updatedInput: input };
    case 'accept_for_reply': {
      const updatedPermissions = sessionOnlyUpdates(suggestions);
      return { behavior: 'allow', updatedInput: input, ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}) };
    }
    case 'cancel': return { behavior: 'deny', message: CANCELLED, interrupt: true };
    case 'decline_by_beat': return { behavior: 'deny', message: note !== undefined && note.trim() !== '' ? note : DECLINED_BY_BEAT };
    default: return { behavior: 'deny', message: DECLINED };
  }
}

// 番が止まったときなど、答えを待っている求めを閉じるときの答え
export const STOPPED_ANSWER: PermissionResult = { behavior: 'deny', message: CANCELLED, interrupt: true };
