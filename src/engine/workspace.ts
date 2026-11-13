import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';

export const WORKSPACE_FILES = ['SOUL.md', 'USER.md', 'CURIOSITY.md'] as const;
export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];
export type TemplateName = 'rules' | WorkspaceFile;

export function templatePath(paths: AppPaths, name: TemplateName): string | undefined {
  const path = join(paths.templates, name === 'rules' ? 'rules.md' : name);
  return existsSync(path) ? path : undefined;
}

export function ensureWorkspace(paths: AppPaths): void {
  mkdirSync(paths.workspace, { recursive: true });
  for (const name of WORKSPACE_FILES) {
    const target = join(paths.workspace, name);
    const source = templatePath(paths, name);
    if (!source) continue;
    try { copyFileSync(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

function readIfExists(path: string | undefined): string {
  if (!path) return '';
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''; } catch { return ''; }
}

export function readTemplate(paths: AppPaths, name: TemplateName): string {
  return readIfExists(templatePath(paths, name));
}

export const REQUIREMENTS_COMPACT_BELOW = 32_000;

export function requirementsText(paths: AppPaths, available: number): string {
  return readIfExists(join(paths.templates, available < REQUIREMENTS_COMPACT_BELOW ? 'requirements.compact.md' : 'requirements.md')).replace(/\r\n/gu, '\n');
}

export function defaultTexts(paths: AppPaths): { rules: string; files: Array<{ name: WorkspaceFile; content: string }> } {
  return {
    rules: readTemplate(paths, 'rules'),
    files: WORKSPACE_FILES.map(name => ({ name, content: readTemplate(paths, name) })),
  };
}

export interface Snapshot {
  text: string;
  hash: string;
}

const SNAPSHOT_HEADINGS: Record<Language, { soul: string; user: string }> = {
  en: { soul: '# Who you are (SOUL.md)', user: '# About the user (USER.md)' },
};

export function buildSnapshot(paths: AppPaths, extra: { memories?: string; skills?: string; persona?: boolean; instructions?: string | undefined } = {}, language: Language = DEFAULT_LANGUAGE): Snapshot {
  const rules = readTemplate(paths, 'rules');
  const persona = extra.persona !== false;
  const soul = persona ? readIfExists(join(paths.workspace, 'SOUL.md')) : '';
  const user = persona ? readIfExists(join(paths.workspace, 'USER.md')) : '';
  const headings = SNAPSHOT_HEADINGS[language];
  const sections = [
    rules,
    soul && `${headings.soul}\n\n${soul}`,
    user && `${headings.user}\n\n${user}`,
    extra.instructions,
    extra.memories,
    extra.skills,
  ].filter(Boolean);
  const text = sections.join('\n\n---\n\n');
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

export function recordFileVersions(db: DatabaseSync, paths: AppPaths, now = Date.now()): void {
  for (const name of ['SOUL.md', 'USER.md']) {
    const content = readIfExists(join(paths.workspace, name));
    if (!content) continue;
    const hash = createHash('sha256').update(content).digest('hex');
    const last = db.prepare('SELECT content_hash FROM file_versions WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { content_hash: string } | undefined;
    if (last?.content_hash === hash) continue;
    db.prepare('INSERT INTO file_versions (name, content, content_hash, created_at) VALUES (?, ?, ?, ?)').run(name, content, hash, now);
  }
}

const DYNAMIC: Record<Language, { locale: string; format: Intl.DateTimeFormatOptions; time: (formatted: string, timezone: string) => string; reply: string; plan: string; product: (name: string, root: string) => string; docLanguage: (tag: string) => string }> = {
  en: {
    product: (name, root) => `This conversation belongs to the product "${name}". Product folder: ${root} (relative paths start here).`,
    docLanguage: tag => `Owner-facing documents of this product (plan, acceptance items, questions, deviation notes) are written in ${tag}.`,
    locale: 'en-US',
    format: { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    time: (formatted, timezone) => `Current time: ${formatted} (${timezone})`,
    reply: "Reply in the language the user writes in (the language of the user's own words, not of these instructions, templates or tool results).",
    plan: 'You are in "plan mode". You cannot change files, run commands, or write memories or tasks (only tools that read, and reading the web, are available). Do not change anything: investigate if needed, then finish by presenting a plan as a numbered list of steps.',
  },
};

// 毎回組み立てる system の部分（固定の system は変えない）。計画モード（plan）のときだけ、計画の指示を足す
export function buildDynamic(timezone: string, language: Language = DEFAULT_LANGUAGE, now = new Date(), mode: PermissionMode = 'auto', product?: { name: string; root: string; docLanguage?: string | null }, requirements = ''): string {
  const text = DYNAMIC[language];
  const formatted = new Intl.DateTimeFormat(text.locale, { ...text.format, timeZone: timezone }).format(now);
  return [text.time(formatted, timezone), ...(product ? [text.product(product.name, product.root)] : []), ...(product?.docLanguage ? [text.docLanguage(product.docLanguage)] : []), text.reply, ...(mode === 'plan' ? [product && requirements ? requirements : text.plan] : [])].join('\n');
}
