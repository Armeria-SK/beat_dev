// Claude Code に渡す許可まわりの決まりと、承認の答えの作り方。ここにあるものが、使う人の設定や決まりを書き換える答え・何でも通す設定を作らないことの根拠（PLAN.md「第 5 版の決め」の 3）
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { SECRET_GLOBS } from '../../tools/hooks/scope.ts';
import { PERMISSIONS, permissionFor, type ApprovalDecision } from '../types.ts';

export type ClaudePermissionMode = (typeof PERMISSIONS)['claude-code'][number];

// 無い・知らない値・別の実行役（Codex）の値は、既定の default に倒す。何でも通す側（bypassPermissions）・裏で判定する側（auto）・黙って断る側（dontAsk）・計画（plan）には倒れない
export function claudeMode(value: string | undefined): ClaudePermissionMode {
  const mode = permissionFor('claude-code', value);
  return PERMISSIONS['claude-code'].find(allowed => allowed === mode) ?? PERMISSIONS['claude-code'][0];
}

// 質問を画面で受ける口が無いので外す（文で聞かせる）。AskUserQuestion はどの許可のモードでも聞かずには通らない道具
export const DISALLOWED_TOOLS = ['AskUserQuestion'] as const;

// beat の秘密の道の名前（scope.ts の SECRET_GLOBS）から作る、読む道具・書く道具の deny の決まり。deny の決まりは、許可のモードや使う人の allow の決まりより先に効く
export function secretDenyRules(): string[] {
  return SECRET_GLOBS.flatMap(glob => [`Read(${glob})`, `Edit(${glob})`]);
}

export function disallowedTools(): string[] {
  return [...DISALLOWED_TOOLS, ...secretDenyRules()];
}

const allowedModes: readonly string[] = PERMISSIONS['claude-code'];

// 「この返事が終わるまで聞かない」で返してよい更新。destination が session（この Claude Code のプロセスの中だけ）の、聞かない決まり（allow）と、選べる許可のモードへの切り替えだけ。
// localSettings・projectSettings・userSettings・cliArg への書き込み、ディレクトリを足す更新、決まりを消す・置き換える更新は、使う人の設定や決まりを書き換えるか、聞かれた範囲より広いので返さない
export function sessionOnlyUpdates(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).filter(update => update.destination === 'session'
    && ((update.type === 'addRules' && update.behavior === 'allow') || (update.type === 'setMode' && allowedModes.includes(update.mode))));
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
