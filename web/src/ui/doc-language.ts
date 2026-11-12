import type { Project } from '../api.ts';
import { t } from '../i18n/index.ts';

const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const LANGUAGES: readonly string[] = ['en', 'ja', 'zh', 'zh-Hant', 'ko', 'es', 'fr', 'de', 'pt-BR', 'it'];

export const OTHER = 'other';

export const hasDocLanguage = (project: Project): boolean => project.doc_language !== undefined;

export function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name && name !== tag ? `${name} (${tag})` : tag;
  } catch { return tag; }
}

export interface LanguagePick { pick: string; other: string }

export function languagePick(project: Project): LanguagePick {
  const tag = project.doc_language;
  if (!project.doc_language_pinned || !tag) return { pick: '', other: '' };
  return LANGUAGES.includes(tag) ? { pick: tag, other: '' } : { pick: OTHER, other: tag };
}

export function autoLabel(project: Project): string {
  if (project.doc_language_pinned) return t('ui.ps.langAuto');
  return project.doc_language ? t('ui.ps.langDetected', project.doc_language) : t('ui.ps.langNone');
}

export function languagePatch(project: Project, pick: string, other: string): { docLanguage: string | null } | null | 'invalid' {
  const chosen = pick === OTHER ? other.trim() : pick;
  if (pick === OTHER && !TAG.test(chosen)) return 'invalid';
  const pinned = project.doc_language_pinned === true;
  if (chosen === '') return pinned ? { docLanguage: null } : null;
  if (!TAG.test(chosen)) return 'invalid';
  return pinned && chosen === project.doc_language ? null : { docLanguage: chosen };
}
