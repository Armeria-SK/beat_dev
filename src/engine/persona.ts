import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../config/store.ts';
import type { Language } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { readTemplate } from './workspace.ts';

export const PERSONA_FILES = ['SOUL.md', 'USER.md'] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];
export const PERSONA_MAX_CHARS = 20_000;
export const NAME_MAX_CHARS = 40;
export const USER_NAME_MAX_CHARS = 80;
export const STYLE_NOTE_MAX_CHARS = 1000;

export const STYLES = ['calm', 'friendly', 'direct', 'none'] as const;
export type Style = (typeof STYLES)[number];

type Section = 'userBasic' | 'soulName' | 'soulStyle';

const HEADINGS: Record<Section, readonly [string, ...string[]]> = {
  userBasic: ['Basic information', '基本情報'],
  soulName: ['Name', '名前'],
  soulStyle: ['Way of speaking', '話し方'],
};

const USER_LABELS: Record<'name' | 'call', readonly [string, ...string[]]> = {
  name: ['Name', '名前'],
  call: ['Preferred name', '呼び方'],
};

const STYLE_TEXT: Record<Exclude<Style, 'none'>, Record<Language, string>> = {
  calm: {
    en: 'Speak calmly and concisely. Skip preambles and grand phrasing; give the conclusion first and only what is needed.',
  },
  friendly: {
    en: 'Speak in a friendly, polite way. Use gentle wording, stay close to how the person feels, and explain things clearly.',
  },
  direct: {
    en: 'Speak frankly and briefly. Say plainly what you can and cannot do, and avoid roundabout phrasing and long explanations.',
  },
};

export class PersonaError extends Error {
  readonly code: 'persona_unsafe';
  readonly file: string;
  constructor(code: 'persona_unsafe', file: string) {
    super(`${code}: ${file}`);
    this.code = code;
    this.file = file;
  }
}

export interface PersonaInput {
  userName?: string;
  callMe?: string;
  botName?: string;
  style?: Style;
  styleNote?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

interface Span { bodyStart: number; end: number; nameIndex: number }

const JAPANESE_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const hasJapaneseHeadings = (lf: string): boolean => [...lf.matchAll(/^#{1,6}[ \t]+(.+)$/gmu)].some(m => JAPANESE_SCRIPT.test(m[1]!));

// 見出し（## ...）は、英語の見出しを先に、なければ日本語の見出しも探す（持ち主の日本語のファイルも同じ節を直す）。足すときは、ファイルの見出しが日本語なら日本語、そうでなければ英語。
function findSection(lf: string, section: Section): Span | null {
  for (const [nameIndex, name] of HEADINGS[section].entries()) {
    const heading = new RegExp(`^##[ \\t]+${escapeRegExp(name)}[ \\t]*$`, 'mu').exec(lf);
    if (!heading) continue;
    const bodyStart = heading.index + heading[0].length + (lf[heading.index + heading[0].length] === '\n' ? 1 : 0);
    const next = /^#{1,2}[ \t]/mu.exec(lf.slice(bodyStart));
    return { bodyStart, end: next ? bodyStart + next.index : lf.length, nameIndex };
  }
  return null;
}

const nameIndexFor = (lf: string, span: Span | null): number => (span ? span.nameIndex : hasJapaneseHeadings(lf) ? 1 : 0);

function setSectionBody(lf: string, section: Section, body: string): string {
  const span = findSection(lf, section);
  const text = body.trim();
  if (!span) return `${lf.replace(/\n*$/u, '\n')}\n## ${HEADINGS[section][nameIndexFor(lf, span)]}\n\n${text}\n`;
  const before = lf.slice(0, span.bodyStart);
  const after = lf.slice(span.end);
  return `${before}\n${text ? `${text}\n` : ''}${after ? '\n' : ''}${after}`;
}

function labelPattern(key: 'name' | 'call'): RegExp {
  const labels = USER_LABELS[key].map(escapeRegExp).join('|');
  return new RegExp(`^-[ \\t]*(?:${labels})[ \\t]*[:：][ \\t]*`, 'u');
}

// USER.md の基本情報の節は、名前と呼び方の行だけを書き換える（持ち主が足したほかの行は残す）。
function setUserLines(lf: string, values: { name?: string | undefined; call?: string | undefined }): string {
  const span = findSection(lf, 'userBasic');
  const lines = span ? lf.slice(span.bodyStart, span.end).split('\n').filter((line, i, all) => line.trim() || (i > 0 && i < all.length - 1)) : [];
  const keep = lines.filter(line => line.trim() !== '');
  const upsert = (key: 'name' | 'call', value: string | undefined): void => {
    if (value === undefined) return;
    const at = keep.findIndex(l => labelPattern(key).test(l));
    if (at >= 0) {
      const prefix = labelPattern(key).exec(keep[at]!)![0];
      keep[at] = `${prefix}${prefix.endsWith(':') ? ' ' : ''}${value}`;
      return;
    }
    const line = `- ${USER_LABELS[key][nameIndexFor(lf, span)]}: ${value}`;
    const nameAt = key === 'call' ? keep.findIndex(l => labelPattern('name').test(l)) : -1;
    if (nameAt >= 0) keep.splice(nameAt + 1, 0, line);
    else keep.unshift(line);
  };
  upsert('name', values.name);
  upsert('call', values.call);
  return setSectionBody(lf, 'userBasic', keep.join('\n'));
}

const oneLine = (value: string): string => value.replace(/[\r\n\t]+/gu, ' ').replace(/ {2,}/gu, ' ').trim();
// 名前の先頭の # は見出しになりうるので、受け付けない（route が 400 にする）。ここでも念のため印を付ける。
export const startsWithHash = (value: string): boolean => oneLine(value).startsWith('#');
const cleanLine = (value: string): string => { const text = oneLine(value); return text.startsWith('#') ? `\\${text}` : text; };
// 自由な文の、見出しになる行（先頭の 3 字までの空白 + #）と、直前の行を見出しにする下線（= か - だけの行）には印を付ける。
const HEADING_LINE = /^(\s{0,3})#/u;
const SETEXT_LINE = /^(\s{0,3})(?:=+|-+)\s*$/u;
const cleanBlock = (value: string): string => value.replace(/\r\n/gu, '\n').split('\n')
  .map(line => (HEADING_LINE.test(line) ? line.replace(HEADING_LINE, '$1\\#') : SETEXT_LINE.test(line) ? line.replace(/^(\s{0,3})/u, '$1\\') : line)).join('\n').trim();

export function styleText(style: Style, language: Language): string {
  return style === 'none' ? '' : STYLE_TEXT[style][language];
}

function eolOf(text: string): string { return text.includes('\r\n') ? '\r\n' : '\n'; }
const toLf = (text: string): string => text.replace(/\r\n/gu, '\n');
const withEol = (lf: string, eol: string): string => (eol === '\n' ? lf : lf.replace(/\n/gu, eol));

// 名前・呼び方・話し方の節だけを書き換えた SOUL.md / USER.md の全文を返す（書き込みはしない）。
export function personaTexts(soul: string, user: string, language: Language, input: PersonaInput): { soul: string; user: string } {
  let soulLf = toLf(soul);
  let userLf = toLf(user);
  if (input.botName !== undefined) soulLf = setSectionBody(soulLf, 'soulName', input.botName);
  if (input.style !== undefined || input.styleNote !== undefined) {
    const parts = [input.style ? styleText(input.style, language) : '', input.styleNote ? cleanBlock(input.styleNote) : ''].filter(Boolean);
    soulLf = setSectionBody(soulLf, 'soulStyle', parts.join('\n\n'));
  }
  if (input.userName !== undefined || input.callMe !== undefined) userLf = setUserLines(userLf, { name: input.userName, call: input.callMe });
  return { soul: withEol(soulLf, eolOf(soul)), user: withEol(userLf, eolOf(user)) };
}

export function normalizePersonaInput(input: PersonaInput): PersonaInput {
  return {
    ...(input.userName !== undefined ? { userName: cleanLine(input.userName).slice(0, USER_NAME_MAX_CHARS) } : {}),
    ...(input.callMe !== undefined ? { callMe: cleanLine(input.callMe).slice(0, USER_NAME_MAX_CHARS) } : {}),
    ...(input.botName !== undefined ? { botName: cleanLine(input.botName).slice(0, NAME_MAX_CHARS) } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.styleNote !== undefined ? { styleNote: input.styleNote } : {}),
  };
}

function readOrEmpty(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (['ENOENT', 'EISDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return ''; throw error; }
}

export function readPersona(paths: AppPaths): { soul: string; user: string } {
  return { soul: readOrEmpty(join(paths.workspace, 'SOUL.md')), user: readOrEmpty(join(paths.workspace, 'USER.md')) };
}

// 書く先の作業フォルダとファイルが、リンク（シンボリックリンク・ジャンクション）や普通のファイルでないときは断る（リンクの先の別のファイルを書き換えさせない）。
function assertWritable(paths: AppPaths, name: PersonaFile): string {
  const target = join(paths.workspace, name);
  for (const path of [paths.workspace, target]) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || (path === target && !stat.isFile()) || (path === paths.workspace && !stat.isDirectory())) throw new PersonaError('persona_unsafe', name);
  }
  return target;
}

// 書く前の控えは、作業フォルダの中ではなく data/backups/persona/ に置く（beat の道具から触れない場所）。
export function writePersonaFile(paths: AppPaths, name: PersonaFile, content: string, now = Date.now()): void {
  const target = assertWritable(paths, name);
  const existing = readOrEmpty(target);
  if (existing !== content) {
    if (existing) {
      const dir = join(paths.backups, 'persona');
      mkdirSync(dir, { recursive: true });
      copyFileSync(target, join(dir, `${name}.${new Date(now).toISOString().replace(/[:.]/gu, '-')}.bak`));
      pruneBackups(dir, name);
    }
    atomicWriteFile(target, content);
  }
}

// 書く前の控えは、ファイルごとに新しいものから 20 個まで残す（古いものから消す。時刻の並びは文字の並びと同じ）。
export const PERSONA_BACKUPS_KEPT = 20;
function pruneBackups(dir: string, name: PersonaFile): void {
  const files = readdirSync(dir).filter(file => file.startsWith(`${name}.`) && file.endsWith('.bak')).sort();
  for (const file of files.slice(0, Math.max(0, files.length - PERSONA_BACKUPS_KEPT))) unlinkSync(join(dir, file));
}

const normalized = (text: string): string => toLf(text).trim();

// 初期の文（英語の初期ファイル）と同じなら、まだ何も書き換えていない。
export function isInitialPersona(paths: AppPaths, name: PersonaFile, current: string): boolean {
  const text = normalized(current);
  if (!text) return true;
  return normalized(readTemplate(paths, name)) === text;
}
