import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { researchText, type ResearchMessageKey } from '../shared/messages/research.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';

export class ResearchError extends LocalizedError<ResearchMessageKey> {
  constructor(code: ResearchMessageKey, params?: MessageParams) { super(researchText, code, params); }
}

export type LabelKind = 'similar' | 'feature' | 'choice' | 'library';

export const LABEL_MAX: Record<LabelKind, number> = { similar: 60, feature: 80, choice: 80, library: 80 };

const LINE_BREAK = /[\n\r\u{85}\u{2028}\u{2029}]/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const HIDDEN = /[\p{Co}\p{Cs}\p{Cn}\u{E0100}-\u{E01EF}\u{3164}\u{1160}\u{2800}]/u;
const URL_LIKE = [
  /:\/\/|www\.|\/\/[\p{L}\p{N}]/iu,
  /[\p{L}\p{N}_-]\.[\p{L}\p{N}_-]{2,}[/\\?#:]/iu,
  /(?<![\p{L}\p{N}])(?:mailto|javascript|data|vbscript|file|ftps?|sftp|ssh|tel|sms|blob|about|chrome|intent|magnet|irc|git|wss?|https?|ms-[a-z-]+):/iu,
  /@[\p{L}\p{N}-]+\.[\p{L}\p{N}-]{2,}/iu,
  /(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?[/\\?#]/u,
];
const BARE_DOMAIN = /[\p{L}\p{N}_-]\.(?:com|net|org|io|dev|app|ai|co|me|info|xyz|ru|cn|jp|uk|de|fr|us|biz|site|online|top|link|page|cloud|sh|ly|gg|to|tv|cc|tk)(?![\p{L}\p{N}])/iu;
const BARE_DOMAIN_KINDS: ReadonlySet<LabelKind> = new Set(['feature', 'choice']);
const CODE = /[`]|~~~/u;
const SHELL = /[$;|&<>]/u;
const MARKUP = /\[[^\]]*\]\s*\(|^\s*#|<\/?[a-z!]/iu;

export function checkLabel(kind: LabelKind, raw: string): string {
  const label = raw.normalize('NFKC');
  if (LINE_BREAK.test(label)) throw new ResearchError('label_lines');
  if (CONTROL.test(label) || HIDDEN.test(label) || stripHidden(label) !== label) throw new ResearchError('label_control');
  const trimmed = label.trim();
  if (!trimmed) throw new ResearchError('label_empty');
  if ([...trimmed].length > LABEL_MAX[kind]) throw new ResearchError('label_long', { max: LABEL_MAX[kind] });
  const dotted = trimmed.replace(/\u{3002}/gu, '.');
  if (URL_LIKE.some(pattern => pattern.test(dotted)) || (BARE_DOMAIN_KINDS.has(kind) && BARE_DOMAIN.test(dotted))) throw new ResearchError('label_url');
  if (CODE.test(trimmed)) throw new ResearchError('label_code');
  if (MARKUP.test(trimmed)) throw new ResearchError('label_markup');
  if (SHELL.test(trimmed)) throw new ResearchError('label_shell');
  if (redactSecrets(trimmed) !== trimmed) throw new ResearchError('label_secret');
  return trimmed;
}
