import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { recordToolWrite } from '../../changes/record.ts';
import { atomicWriteFile } from '../../config/store.ts';
import type { Language } from '../../config/schema.ts';
import { prefixLength } from '../../engine/tokens.ts';
import { languageOf } from '../../shared/language.ts';
import { appendDelta, lineDelta } from '../../shared/line-delta.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { approvalPaths } from '../approvals.ts';
import { expandPath, placePath, writeApprovalKind } from '../hooks/scope.ts';
import { isToolConfigPath } from '../hooks/tool-config.ts';
import { mainWrites, WT_WRITE_MAIN } from '../hooks/worktree-git.ts';
import { askBeforeRegister, growSkills } from '../skills/store.ts';
import { TOOL_OUTPUT_LIMIT } from '../pipeline.ts';
import { isUnderDownloads } from './downloads-core.ts';
import type { KV } from '../../db/kv.ts';
import type { FileReadLog, PreCheck, ToolContext, ToolDef } from '../types.ts';

const FILE_KEYS = { persona: 'file.persona', skill: 'file.skill', git: 'file.git', instructions: 'file.instructions' } as const;

const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_READ_LINES = 2000;
const PAGE_NOTE_ROOM = 400;
const REDACT_WINDOW_LINES = 300;
const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_CHARS = 1_000_000;
const READ_LOG_LIMIT = 200;

export function fileReadLog(kv: KV, conversationId: string): FileReadLog {
  const key = `file-reads:${conversationId}`;
  const load = (): Array<[string, string]> => {
    const saved = kv.getJson<unknown>(key);
    return Array.isArray(saved) ? saved.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  };
  return {
    get: path => load().find(([p]) => p === path)?.[1],
    set: (path, hash) => kv.setJson(key, [...load().filter(([p]) => p !== path), [path, hash]].slice(-READ_LOG_LIMIT)),
  };
}

const ctxLogs = new WeakMap<ToolContext, FileReadLog>();
function readLog(ctx: ToolContext): FileReadLog {
  let log = ctx.fileReads ?? ctxLogs.get(ctx);
  if (!log) {
    const seen = new Map<string, string>();
    log = { get: path => seen.get(path), set: (path, hash) => { seen.set(path, hash); } };
    ctxLogs.set(ctx, log);
  }
  const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const store = log;
  return { get: path => store.get(key(path)), set: (path, hash) => store.set(key(path), hash) };
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const UNSEEN = 'unseen:';

async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeRefusal(abs: string, kind: 'edit' | 'overwrite', ctx: ToolContext, language: Language, current?: Buffer): Promise<string | undefined> {
  const seen = readLog(ctx).get(abs);
  const path = shown(abs, ctx);
  if (seen === undefined) return toolText(language, kind === 'edit' ? 'file.not_read' : 'file.not_read_write', { path });
  const unseen = seen.startsWith(UNSEEN);
  if (unseen && kind === 'edit') return toolText(language, 'file.unseen_edit', { path });
  const now = current ? digest(current) : await hashFile(abs).catch(() => undefined);
  return (unseen ? seen.slice(UNSEEN.length) : seen) === now ? undefined : toolText(language, 'file.changed_since_read', { path });
}

async function writeCheck(input: string, kind: 'edit' | 'overwrite', ctx: ToolContext): Promise<PreCheck> {
  const { abs, check } = checkFilePath(input, 'write', ctx);
  if (check.decision === 'deny' || !statSync(abs, { throwIfNoEntry: false })?.isFile()) return check;
  const refusal = await writeRefusal(abs, kind, ctx, languageOf(ctx.config));
  return refusal ? { decision: 'deny', reasons: [refusal], ...(check.paths ? { paths: check.paths } : {}), ...(check.writes ? { writes: check.writes } : {}) } : check;
}

type Need = 'read' | 'write';

export function previousForDelta(abs: string, io: { size: (path: string) => number; read: (path: string) => string } = { size: p => statSync(p).size, read: p => readFileSync(p, 'utf8') }): string | null {
  try { return io.size(abs) <= MAX_DELTA_BYTES ? io.read(abs) : null; } catch { return null; }
}

export function checkFilePath(input: string, need: Need, ctx: ToolContext): { abs: string; check: PreCheck } {
  const language = languageOf(ctx.config);
  const expanded = expandPath(input, ctx.workspace, process.env, language);
  if ('unresolved' in expanded) return { abs: '', check: { decision: 'deny', reasons: [guardText(language, 'guard.path_unresolved', { input, detail: expanded.unresolved })] } };
  const abs = expanded.path;
  const placement = placePath(abs, ctx.policy);
  const paths = approvalPaths([{ input, path: abs, placement }]);
  const result = (check: PreCheck): { abs: string; check: PreCheck } => ({ abs, check: { ...check, paths, ...(need === 'write' ? { writes: [abs] } : {}) } });
  if (placement.kind === 'deny') return result({ decision: 'deny', reasons: [placement.reason] });
  // 作業コピーで動く実行（beat 8-2 D-12）は、本体の中へ書かない（許可フォルダが本体を含んでいても。書いたパスと実体のパスの両方で見る）
  if (need === 'write' && ctx.place && ctx.project?.root && mainWrites([abs], { productRoot: ctx.place.productRoot, worktree: ctx.project.root }).length) {
    return result({ decision: 'deny', reasons: [guardText(language, WT_WRITE_MAIN, { path: abs })], reasonKeys: [WT_WRITE_MAIN] });
  }
  if (placement.kind === 'outside') {
    return result({ decision: 'deny', reasons: [guardText(language, 'file.outside', { path: abs, roots: ctx.policy.roots.map(r => guardText(language, r.mode === 'write' ? 'file.root_write' : 'file.root_read', { path: r.path })).join(guardText(language, 'file.root_sep')) })] });
  }
  if (need === 'write' && placement.mode === 'read') return result({ decision: 'deny', reasons: [guardText(language, 'file.readonly', { root: placement.root })] });
  if (need === 'write' && existsSync(abs) && lstatSync(abs).isSymbolicLink()) return result({ decision: 'deny', reasons: [guardText(language, 'file.symlink')] });
  const protectedKind = need === 'write' ? writeApprovalKind(abs, ctx.policy) : undefined;
  // .git への書き込みはフックや設定というコードを書くことになるので、コードの確かめ（種類 code）にする。人格・スキルは、中身が引数にあるので今までどおり
  if (protectedKind === 'git') return result({ decision: 'ask', reasons: [guardText(language, FILE_KEYS.git)], askKinds: ['code'], reasonKeys: [FILE_KEYS.git] });
  if (protectedKind) {
    const key = protectedKind === 'skill' && !growSkills(ctx.config) ? 'file.skill_off' : protectedKind === 'skill' && !askBeforeRegister(ctx.config) ? 'file.skill_auto' : FILE_KEYS[protectedKind];
    return result({ decision: 'ask', reasons: [guardText(language, key)], askKinds: ['persona'], reasonKeys: [key] });
  }
  // git・curl・wget・npm・シェルの起動ファイルなどの設定は、あとで動く許可済みのコマンドにコードを読み込ませられるので、毎回確かめる
  if (need === 'write' && isToolConfigPath(abs)) return result({ decision: 'ask', reasons: [guardText(language, 'file.tool_config')], askKinds: ['code'], reasonKeys: ['file.tool_config'] });
  return result({ decision: 'allow', reasons: [] });
}

const shown = (abs: string, ctx: ToolContext) => {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
};

const PathArg = Type.String({ minLength: 1, maxLength: 1024, description: 'A path relative to the working folder, or an absolute path inside an allowed folder' });

export const fileRead: ToolDef<{ path: string; offset?: number; limit?: number }> = {
  name: 'file_read',
  description: 'Read a text file. Without limit it returns up to 2,000 lines; when more remain, the result ends with the offset to read on from. With offset (the line to start from, starting at 1) and limit (how many lines) you can read just part of it.',
  input: Type.Object({ path: PathArg, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  // downloads/ の下は外の中身なので、読んだ実行に「外から読んだ」印を付ける（doc_read と同じ）。断られた読み取りは印を付けない
  preCheck: (input, ctx) => {
    const { abs, check } = checkFilePath(input.path, 'read', ctx);
    return check.decision !== 'deny' && isUnderDownloads(abs, ctx.home ?? ctx.workspace) ? { ...check, fetched: true } : check;
  },
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'read', ctx);
    const language = languageOf(ctx.config);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) return { content: toolText(language, 'file.not_found', { path: shown(abs, ctx) }), isError: true };
    if (stat.isDirectory()) return { content: toolText(language, 'file.is_dir_use_list', { path: shown(abs, ctx) }), isError: true };
    if (stat.size > MAX_READ_BYTES && !input.limit) return { content: toolText(language, 'file.too_big', { size: stat.size.toLocaleString('en-US') }), isError: true };
    const bytes = readFileSync(abs);
    const text = bytes.toString('utf8');
    if (text.includes('\u0000')) {
      readLog(ctx).set(abs, `${UNSEEN}${digest(bytes)}`);
      return { content: toolText(language, 'file.binary'), isError: true };
    }
    const lines = text.split(/\r?\n/u);
    if (lines.length > 1 && text.endsWith('\n')) lines.pop();
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_READ_LINES));
    redactAround(lines, start, end);
    const content = readPage(lines, start, end, language, ctx.outputTokens);
    if (end > start) readLog(ctx).set(abs, digest(bytes));
    return { content };
  },
};

const KEY_MARKER = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

function redactAround(lines: string[], start: number, end: number): void {
  let from = Math.max(0, start - REDACT_WINDOW_LINES);
  for (let i = from - 1; i >= 0; i--) {
    const marker = KEY_MARKER.exec(lines[i]!);
    if (!marker) continue;
    if (marker[1] === 'BEGIN') from = i;
    break;
  }
  const to = Math.min(lines.length, end + REDACT_WINDOW_LINES);
  const redacted = redactSecrets(lines.slice(from, to).join('\n'), [], { keepLines: true }).split('\n');
  for (let i = from; i < to; i++) lines[i] = redacted[i - from] ?? '';
}

function readPage(lines: readonly string[], start: number, end: number, language: Language, tokens: number | undefined): string {
  const budget = tokens ?? Infinity;
  const hint = (to: number) => (to < lines.length ? `\n\n${toolText(language, 'file.more', { total: lines.length, from: start + 1, to, next: to + 1 })}` : '');
  const page = (to: number) => lines.slice(start, to).join('\n') + hint(to);
  const fits = (to: number) => {
    const redacted = redactSecrets(page(to));
    return prefixLength(redacted, TOOL_OUTPUT_LIMIT, budget) >= redacted.length;
  };
  if (start >= end || fits(end)) return page(end);
  const whole = lines.slice(start, end).join('\n');
  let to = start + whole.slice(0, prefixLength(whole, TOOL_OUTPUT_LIMIT - PAGE_NOTE_ROOM, budget - PAGE_NOTE_ROOM / 3.5)).split('\n').length - 1;
  while (to > start && !fits(to)) to = start + Math.floor((to - start) * 0.9);
  if (to > start) return page(to);
  const line = redactSecrets(lines[start] ?? '');
  const shown = prefixLength(line, TOOL_OUTPUT_LIMIT - PAGE_NOTE_ROOM, budget - PAGE_NOTE_ROOM / 3.5);
  const more = start + 1 < lines.length ? toolText(language, 'file.line_cut_more', { next: start + 2 }) : '';
  return `${line.slice(0, shown)}\n\n${toolText(language, 'file.line_cut', { line: start + 1, total: lines.length, chars: line.length.toLocaleString('en-US'), shown: shown.toLocaleString('en-US'), more })}`;
}

export const fileWrite: ToolDef<{ path: string; content: string; mode?: 'overwrite' | 'append' | 'create' }> = {
  name: 'file_write',
  description: 'Write a text file. mode: overwrite (overwrite; the default) / append (add to the end) / create (create only if it does not exist). Folders are created automatically. A file that already exists must have been read with file_read in this conversation before it is changed; for a small change, use file_edit.',
  input: Type.Object({
    path: PathArg, content: Type.String({ maxLength: MAX_WRITE_CHARS }),
    mode: Type.Optional(Type.Union([Type.Literal('overwrite'), Type.Literal('append'), Type.Literal('create')])),
  }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: (input, ctx) => (input.mode === 'append' || input.mode === 'create' ? checkFilePath(input.path, 'write', ctx).check : writeCheck(input.path, 'overwrite', ctx)),
  summarize: (input, language) => ({ title: toolText(language, 'summary.file_write', { path: input.path }), body: input.content.slice(0, 4000) }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    const language = languageOf(ctx.config);
    const exists = existsSync(abs);
    if (input.mode === 'create' && exists) return { content: toolText(language, 'file.exists', { path: shown(abs, ctx) }), isError: true };
    if (exists && statSync(abs).isDirectory()) return { content: toolText(language, 'file.is_dir', { path: shown(abs, ctx) }), isError: true };
    const stale = exists && input.mode !== 'append' ? await writeRefusal(abs, 'overwrite', ctx, language) : undefined;
    if (stale) return { content: stale, isError: true };
    mkdirSync(dirname(abs), { recursive: true });
    // フォルダを作った後は realpath が実体を指すので、シンボリックリンク経由で外に出ていないかをもう一度確かめる
    // （ask は実行前に承認済みなので、ここでは deny だけを止める）
    const recheck = checkFilePath(abs, 'write', ctx).check;
    if (recheck.decision === 'deny') return { content: toolText(language, 'file.recheck_failed', { detail: recheck.reasons.join(' / ') }), isError: true };
    const appending = input.mode === 'append' && exists;
    const previous = appending ? readFileSync(abs) : undefined;
    // append は元のバイト列の後ろに足した文のバイトをつなぐだけ（UTF-8 として読み直して書き戻すと、UTF-8 として正しくないバイトが U+FFFD に化けて戻らない）。current は行の増減を数えるための読みだけに使う
    const current = previous?.toString('utf8') ?? '';
    const written = previous ? Buffer.concat([previous, Buffer.from(input.content, 'utf8')]) : Buffer.from(input.content, 'utf8');
    const before = appending ? null : exists ? previousForDelta(abs) : '';
    const recorded = recordToolWrite(ctx, abs, written);
    atomicWriteFile(abs, written);
    recorded();
    if (!previous || readLog(ctx).get(abs) === digest(previous)) readLog(ctx).set(abs, digest(written));
    if (!exists) ctx.noteCreated?.(abs);
    const params = { verb: toolText(language, exists ? (input.mode === 'append' ? 'file.wrote.append' : 'file.wrote.overwrite') : 'file.wrote.create'), path: shown(abs, ctx), chars: input.content.length.toLocaleString('en-US') };
    const delta = appending ? appendDelta(current, input.content) : before === null ? null : lineDelta(before, input.content);
    if (!delta) return { content: toolText(language, 'file.wrote', params) };
    return { content: toolText(language, 'file.wrote_lines', { ...params, added: delta.added.toLocaleString('en-US'), removed: delta.removed.toLocaleString('en-US') }) };
  },
};

export const fileEdit: ToolDef<{ path: string; old: string; new: string; all?: boolean }> = {
  name: 'file_edit',
  description: 'Replace part of a file. The file must have been read with file_read in this conversation first. old must be text that appears exactly once in the file (with all=true, every occurrence is replaced).',
  input: Type.Object({ path: PathArg, old: Type.String({ minLength: 1 }), new: Type.String(), all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: (input, ctx) => writeCheck(input.path, 'edit', ctx),
  summarize: (input, language) => ({ title: toolText(language, 'summary.file_edit', { path: input.path }), body: `- ${input.old.slice(0, 2000)}\n+ ${input.new.slice(0, 2000)}` }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    const language = languageOf(ctx.config);
    if (!existsSync(abs)) return { content: toolText(language, 'file.not_found', { path: shown(abs, ctx) }), isError: true };
    const bytes = readFileSync(abs);
    const stale = await writeRefusal(abs, 'edit', ctx, language, bytes);
    if (stale) return { content: stale, isError: true };
    const text = bytes.toString('utf8');
    const count = text.split(input.old).length - 1;
    if (count === 0) return { content: toolText(language, 'file.no_match'), isError: true };
    if (count > 1 && !input.all) return { content: toolText(language, 'file.many_matches', { count }), isError: true };
    const next = input.all ? text.split(input.old).join(input.new) : text.replace(input.old, () => input.new);
    const recorded = recordToolWrite(ctx, abs, next);
    atomicWriteFile(abs, next);
    recorded();
    readLog(ctx).set(abs, digest(Buffer.from(next, 'utf8')));
    return { content: toolText(language, 'file.replaced', { count, path: shown(abs, ctx) }) };
  },
};

// 中に何万ものファイルがあり、一覧に入れると 500 件の枠を使い切る（本当に見たいものが出てこない）フォルダ。下の階層を見るときは中に入らない
export const HEAVY_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.next', '.cache', '.turbo', '.parcel-cache']);

export const fileList: ToolDef<{ path?: string; depth?: number; all?: boolean }> = {
  name: 'file_list',
  description: 'List the contents of a folder. If path is omitted, the working folder. depth is how many levels down to look (default 1, max 4). The insides of large folders such as node_modules and .git are not listed by default (it goes inside only when all is true or path names that folder).',
  input: Type.Object({
    path: Type.Optional(PathArg), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    all: Type.Optional(Type.Boolean({ description: 'Also list the insides of large folders such as node_modules and .git' })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: (input, ctx) => checkFilePath(input.path ?? '.', 'read', ctx).check,
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path ?? '.', 'read', ctx);
    const language = languageOf(ctx.config);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) return { content: toolText(language, 'file.no_dir', { path: shown(abs, ctx) }), isError: true };
    const lines: string[] = [];
    const skipped = new Set<string>();
    let fetched = false; // downloads/ の下の名前（相手が決めた名前）を一覧に入れたか
    const walk = (dir: string, depth: number, indent: string) => {
      const inDownloads = isUnderDownloads(dir, ctx.home ?? ctx.workspace);
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (lines.length >= 500) return;
        const full = resolve(dir, entry.name);
        if (placePath(full, ctx.policy).kind === 'deny') continue; // 秘密情報や保護対象は一覧にも出さない
        const heavy = entry.isDirectory() && !input.all && HEAVY_DIRS.has(entry.name);
        const mark = heavy && depth > 1 ? ` ${toolText(language, 'file.list_skipped_mark')}` : '';
        lines.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}${mark}`);
        if (inDownloads) fetched = true;
        if (mark) skipped.add(`${entry.name}/`);
        if (entry.isDirectory() && depth > 1 && !heavy) walk(full, depth - 1, `${indent}  `);
      }
    };
    walk(abs, input.depth ?? 1, '');
    const notes = [
      ...(lines.length >= 500 ? [toolText(language, 'file.list_cut')] : []),
      ...(skipped.size ? [toolText(language, 'file.list_skipped_note', { names: [...skipped].join(', ') })] : []),
    ];
    return { content: lines.length ? `${shown(abs, ctx)}/\n${lines.join('\n')}${notes.map(n => `\n${n}`).join('')}` : toolText(language, 'file.list_empty', { path: shown(abs, ctx) }), ...(fetched ? { fetched: true } : {}) };
  },
};
