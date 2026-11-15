import type { RunRow, ToolCallRow } from './api.ts';
import { formatList, formatNumber, t, type PlainKey } from './i18n/index.ts';

const RUN_KIND: Record<string, PlainKey> = { chat: 'runs.kind.chat', task: 'runs.kind.task', review: 'runs.kind.review', agent: 'runs.kind.agent' };
const DECISION: Record<ToolCallRow['decision'], PlainKey> = { allow: 'runs.decision.allow', ask: 'runs.decision.ask', deny: 'runs.decision.deny' };
const DECIDED_BY: Record<string, PlainKey> = {
  builtin: 'runs.by.builtin', registry: 'runs.by.registry', truncated: 'runs.by.truncated', validation: 'runs.by.validation', user: 'runs.by.user', 'conversation-grant': 'runs.by.grant', recheck: 'runs.by.recheck', policy: 'runs.by.policy', 'auto-mode': 'runs.by.auto', 'judge-reuse': 'runs.by.judgeReuse', mode: 'runs.by.mode', 'folder-grant': 'runs.by.folder', pending: 'runs.by.pending', 'not-parked': 'runs.by.notParked', outbound: 'runs.by.outbound', 'no-judge': 'runs.by.noJudge',
};
const CHANGE: Record<string, PlainKey> = {
  create: 'runs.reviews.change.create', update: 'runs.reviews.change.update', forget: 'runs.reviews.change.forget', restore: 'runs.reviews.change.restore',
};

// 知らない値（あとから増えた種類など）は、コードをそのまま出す。
export const runKindLabel = (kind: string): string => (RUN_KIND[kind] ? t(RUN_KIND[kind]) : kind);

// 1000 以上は 3.2k のように短くする。
export const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : formatNumber(n));

// 成功は「入 3.2k · 出 412 · キャッシュ 1.1k」、失敗は理由のあとに試行の回数。見積もりと付いた印は、どちらにも付ける。
export function runDetail(run: RunRow): string {
  const parts: string[] = [];
  if (run.ok === 0) {
    parts.push(run.error_message ?? '');
    if (run.attempts > 0) parts.push(t('runs.detail.attempts', run.attempts));
  } else {
    if (run.input_tokens !== null) parts.push(t('runs.detail.in', formatTokens(run.input_tokens)));
    if (run.output_tokens !== null) parts.push(t('runs.detail.out', formatTokens(run.output_tokens)));
    if (run.cache_read_tokens) parts.push(t('runs.detail.cache', formatTokens(run.cache_read_tokens)));
    if (run.attempts > 1) parts.push(t('runs.detail.attempts', run.attempts));
  }
  if (run.est_prompt_tokens !== null) parts.push(t('runs.detail.est', formatTokens(run.est_prompt_tokens)));
  if (run.flags.length) parts.push(formatList(run.flags));
  return parts.filter(Boolean).join(' · ');
}

export const decisionLabel = (decision: ToolCallRow['decision']): string => (DECISION[decision] ? t(DECISION[decision]) : decision);

export function decidedByLabel(by: string): string {
  if (DECIDED_BY[by]) return t(DECIDED_BY[by]!);
  if (by.startsWith('hook:')) return t('runs.by.hook', by.slice('hook:'.length));
  return by;
}

export const changeLabel = (action: string): string => (CHANGE[action] ? t(CHANGE[action]!) : action);
