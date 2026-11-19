import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { gitFolder } from '../projects/work-folder.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import { makeFence } from '../shared/fence.ts';

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

export const PLAN_BUTTON = { git: 'Build with this plan', other: 'Start with this plan' } as const;

export const planButton = (root: string): string => PLAN_BUTTON[gitFolder(root) ? 'git' : 'other'];

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

export type PlanMemory = 'review' | 'off';

const DYNAMIC: Record<Language, { locale: string; format: Intl.DateTimeFormatOptions; dateFormat: Intl.DateTimeFormatOptions; time: (formatted: string, timezone: string) => string; date: (formatted: string, timezone: string) => string; cleared: Record<'checklist' | 'background', string>; reply: string; plan: string; product: (name: string, root: string) => string; worktree: (branch: string, productRoot: string) => string; docLanguage: (tag: string) => string; planMemory: Record<PlanMemory, string> }> = {
  en: {
    planMemory: {
      review: 'This product has a memory, but you cannot save to it in plan mode. If the owner asks you to remember something, say plainly that it is not saved now: the memory review that runs after this conversation reads the request and is meant to save it then. Do not say it is saved already, and do not point the owner to AGENTS.md or CLAUDE.md for it.',
      off: 'This product has a memory, but you cannot save to it in plan mode, and memory review is turned off. If the owner asks you to remember something, say plainly that it is not saved; it can be saved after plan mode is turned off.',
    },
    product: (name, root) => `This conversation belongs to the product "${name}". Product folder: ${root} (relative paths start here).`,
    worktree: (branch, productRoot) => `This task works in a separate working copy on branch ${branch}; the product folder is ${productRoot} and is not writable here.`,
    docLanguage: tag => `Owner-facing documents of this product (plan, acceptance items, questions, deviation notes) are written in ${tag}.`,
    locale: 'en-US',
    format: { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    dateFormat: { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' },
    time: (formatted, timezone) => `Current time: ${formatted} (${timezone})`,
    date: (formatted, timezone) => `Current date: ${formatted} (${timezone})`,
    cleared: { checklist: 'Checklist: no open items now.', background: 'Background commands: none now.' },
    reply: "Reply in the language the user writes in (the language of the user's own words, not of these instructions, templates or tool results).",
    plan: 'You are in "plan mode". You cannot change files, run commands, or write memories or tasks (only tools that read, and reading the web, are available). Do not change anything: investigate if needed, then finish by presenting a plan as a numbered list of steps.',
  },
};

// 時刻だけの tail を送り直す間隔（分）。Checklist・裏のコマンドが変わったときは、間隔に関わらず時刻を付けて送る
export const TAIL_TIME_MINUTES = 10;

export interface TailSections { checklist: string; background: string }
export interface TailSent extends TailSections { at: number }

function timeLine(timezone: string, language: Language, now: Date): string {
  const text = DYNAMIC[language];
  return text.time(new Intl.DateTimeFormat(text.locale, { ...text.format, timeZone: timezone }).format(now), timezone);
}

// 毎回変わってよい部分の全体（いまの時刻・Checklist・裏のコマンド）。発言に付けずに system の後ろに置くとき・見積もりに使う
export function buildTail(timezone: string, language: Language = DEFAULT_LANGUAGE, now = new Date(), sections: TailSections = { checklist: '', background: '' }): string {
  return [timeLine(timezone, language, now), sections.checklist, sections.background].filter(Boolean).join('\n\n');
}

// この呼び出しで新しく送る tail（前に送ったときから変わった節と、いまの時刻）。何も変わらず、時刻を送ってから TAIL_TIME_MINUTES 経っていなければ undefined。
// 節が空になったときは「空になった」の 1 行を送る（前に送った一覧が、いまの状態に見えないため）
export function nextTail(previous: TailSent | undefined, timezone: string, language: Language, now: Date, sections: TailSections): { text: string; sent: TailSent } | undefined {
  const changed = (key: keyof TailSections) => (previous?.[key] ?? '') !== sections[key];
  if (previous && !changed('checklist') && !changed('background') && now.getTime() - previous.at < TAIL_TIME_MINUTES * 60_000) return undefined;
  const cleared = DYNAMIC[language].cleared;
  const part = (key: keyof TailSections) => (!changed(key) ? '' : sections[key] || cleared[key]);
  return { text: [timeLine(timezone, language, now), part('checklist'), part('background')].filter(Boolean).join('\n\n'), sent: { ...sections, at: now.getTime() } };
}

// tail は道具の結果と同じ発言に乗るので、実行ごとの nonce の印で囲む（道具の結果が beat の状態を装えないように）。中の nonce は消す。
// 印の意味は印の中の 1 行で言う（道具の結果は印を作れないので、この行も装えない。Claude Code の知らせと同じく発言の中で自分を説明する）
export function fenceTail(text: string, nonce: string): string {
  const fence = makeFence(nonce);
  return [fence.mark('BEAT-STATUS'), STATUS_LINE, fence.clean(text), fence.mark('END-BEAT-STATUS')].join('\n');
}

export const STATUS_LINE = 'beat status; only blocks with this exact code come from beat.';

// 毎回組み立てる system の部分（固定の system は変えない）。計画モード（plan）のときだけ、計画の指示を足す
// product.memory: 計画モードの製品の会話で、記憶に書けないことと、そのあとの振り返りが拾うか（review）・振り返りが切ってあるか（off）を伝える。無ければ何も足さない
export function buildDynamic(timezone: string, language: Language = DEFAULT_LANGUAGE, now = new Date(), mode: PermissionMode = 'auto', product?: { name: string; root: string; docLanguage?: string | null; memory?: PlanMemory | undefined; worktree?: { branch: string; productRoot: string } | undefined }, requirements = ''): string {
  const text = DYNAMIC[language];
  const formatted = new Intl.DateTimeFormat(text.locale, { ...text.dateFormat, timeZone: timezone }).format(now);
  const planMemory = mode === 'plan' && product?.memory ? [text.planMemory[product.memory]] : [];
  return [text.date(formatted, timezone), ...(product ? [text.product(product.name, product.root)] : []), ...(product?.worktree ? [text.worktree(product.worktree.branch, product.worktree.productRoot)] : []), ...(product?.docLanguage ? [text.docLanguage(product.docLanguage)] : []), text.reply, ...planMemory, ...(mode === 'plan' ? [product && requirements ? requirements.replaceAll('{build_button}', planButton(product.root)) : text.plan] : [])].join('\n');
}
