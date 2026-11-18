import type { DictKey } from './types.ts';

// 説明の文の鍵（説明の言語で出す）。ここに無い鍵は名前として英語のまま出る。
export const EXPLAIN_KEYS = [
  'ui.set.look.explainDesc',
  'ui.set.look.reduceDesc',
  'ui.set.provider.addDesc',
  'ui.set.model.addDesc',
  'ui.set.models.checkDesc',
  'ui.set.models.conversationDesc',
  'ui.set.models.judgeDesc',
  'ui.set.models.judgeOffDesc',
  'ui.set.models.judgeBackups',
  'ui.set.models.fallbackDesc',
  'ui.set.models.backgroundDesc',
  'ui.set.models.scoutDesc',
] as const satisfies readonly DictKey[];

export type ExplainKey = typeof EXPLAIN_KEYS[number];

// 説明に見えるが、名前として英語のまま残すと決めた鍵と、その理由。
export const NOT_EXPLAIN: Partial<Record<DictKey, string>> = {};
