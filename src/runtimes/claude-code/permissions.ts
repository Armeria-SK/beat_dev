// Claude Code に渡す許可まわりの決まりと、承認の答えの作り方。ここにあるものが、使う人の設定や決まりを書き換える答え・何でも通す設定を作らないことの根拠（PLAN.md「第 5 版の決め」の 3）
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
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

// 外す道具（名前は SDK の BUILTIN_TOOL_NAMES の綴り）。外した道具は、どの許可のモードでも使えない。
//  - AskUserQuestion: 質問を画面で受ける口が無いので外す（文で聞かせる）
//  - CronCreate・CronDelete・CronList・ScheduleWakeup: あとで動く予定を作る・変える（1 回の返事で終わるプロセスの外に残る。SDK の文書: 「この会話をあとで起こす」予定）
//  - RemoteTrigger: 遠くで動く仕事を起こす
//  - Artifact・ClaudeDesign: claude.ai 側にページ・デザインを作って載せる（名前による。本物では動かしていない）
//  - PushNotification・SendUserMessage・SendUserFile: 使う人の端末への通知・メッセージ・ファイルの送り出し（名前による。本物では動かしていない）
//  - SendMessage: ほかの会話へ送る（SDK の文書: Remote Control で別のマシンの会話にも届く）
//  - SendFeedback: 下書きのフィードバックを Anthropic へ送る
//  - ShareOnboardingGuide: 名前が「共有」（外へ出す）。名前による。本物では動かしていない
//  - EnterWorktree・ExitWorktree: 作業の木（git worktree）を作って入る。木の置き場は beat が決めて守るので、Claude Code に作らせない（beat の守りは Claude Code の作る木を見ず、木は返事が終わっても残る）
export const DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger',
  'Artifact', 'ClaudeDesign',
  'PushNotification', 'SendUserMessage', 'SendUserFile', 'SendMessage', 'SendFeedback', 'ShareOnboardingGuide',
  'EnterWorktree', 'ExitWorktree',
] as const;

// beat の秘密の道の名前（scope.ts の SECRET_GLOBS）から作る、読む道具・書く道具の deny の決まり。deny の決まりは、許可のモードや使う人の allow の決まりより先に効く
export function secretDenyRules(): string[] {
  return SECRET_GLOBS.flatMap(glob => [`Read(${glob})`, `Edit(${glob})`]);
}

export function disallowedTools(): string[] {
  return [...DISALLOWED_TOOLS, ...secretDenyRules()];
}

// 「この返事が終わるまで聞かない」で返してよい更新。destination が session（この Claude Code のプロセスの中だけ）の、聞かない決まり（allow の addRules）だけ。
// 許可のモードの切り替え（Write の求めに付いてくる acceptEdits など）は、残りの返事ぜんぶの編集を通すことになり、1 回の許しより広いので返さない。
// localSettings・projectSettings・userSettings・cliArg への書き込み、ディレクトリを足す更新、決まりを消す・置き換える更新も、使う人の設定や決まりを書き換えるか、聞かれた範囲より広いので返さない。
// 残るものが無ければ、ふつうの許し（accept）と同じ答えになる
export function sessionOnlyUpdates(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).filter(update => update.destination === 'session' && update.type === 'addRules' && update.behavior === 'allow');
}

const DECLINED = 'The owner declined this request.';
const CANCELLED = 'The owner stopped the reply.';

// 答えの作り方。許可は入力を書き換えず（updatedInput は元の入力）、閉じた一覧の外の答えは断りにする
export function answerFor(decision: ApprovalDecision, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[] | undefined): PermissionResult {
  switch (decision) {
    case 'accept': return { behavior: 'allow', updatedInput: input };
    case 'accept_for_reply': {
      const updatedPermissions = sessionOnlyUpdates(suggestions);
      return { behavior: 'allow', updatedInput: input, ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}) };
    }
    case 'cancel': return { behavior: 'deny', message: CANCELLED, interrupt: true };
    default: return { behavior: 'deny', message: DECLINED };
  }
}

// 番が止まったときなど、答えを待っている求めを閉じるときの答え
export const STOPPED_ANSWER: PermissionResult = { behavior: 'deny', message: CANCELLED, interrupt: true };
