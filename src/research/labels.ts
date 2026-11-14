import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { researchText, type ResearchMessageKey } from '../shared/messages/research.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';

export class ResearchError extends LocalizedError<ResearchMessageKey> {
  constructor(code: ResearchMessageKey, params?: MessageParams) { super(researchText, code, params); }
}

export type LabelKind = 'similar' | 'feature' | 'choice' | 'library';

export const LABEL_MAX: Record<LabelKind, number> = { similar: 60, feature: 80, choice: 80, library: 80 };

const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const URL_LIKE = /:\/\/|www\.|[\p{L}\p{N}_-]\.[\p{L}\p{N}_-]{2,}\//iu;
const CODE = /[`]|~~~/u;
const SHELL = /[$;|&<>]/u;
const MARKUP = /\[[^\]]*\]\s*\(|^\s*#|<\/?[a-z!]/iu;

export function checkLabel(kind: LabelKind, raw: string): string {
  const label = raw.normalize('NFKC');
  if (LINE_BREAK.test(label)) throw new ResearchError('label_lines');
  if (CONTROL.test(label)) throw new ResearchError('label_control');
  const trimmed = label.trim();
  if (!trimmed) throw new ResearchError('label_empty');
  if ([...trimmed].length > LABEL_MAX[kind]) throw new ResearchError('label_long', { max: LABEL_MAX[kind] });
  if (URL_LIKE.test(trimmed)) throw new ResearchError('label_url');
  if (CODE.test(trimmed)) throw new ResearchError('label_code');
  if (MARKUP.test(trimmed)) throw new ResearchError('label_markup');
  if (SHELL.test(trimmed)) throw new ResearchError('label_shell');
  if (sanitizeModelInputText(trimmed).redaction_count > 0) throw new ResearchError('label_secret');
  return trimmed;
}
