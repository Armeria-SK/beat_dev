import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { atomicWriteFile } from '../../config/store.ts';
import { languageOf } from '../../shared/language.ts';
import { appendDelta, lineDelta } from '../../shared/line-delta.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { approvalPaths } from '../approvals.ts';
import { expandPath, placePath, writeApprovalKind } from '../hooks/scope.ts';
import { isToolConfigPath } from '../hooks/tool-config.ts';
import { askBeforeRegister } from '../skills/store.ts';
import { isUnderDownloads } from './downloads-core.ts';
import type { PreCheck, ToolContext, ToolDef } from '../types.ts';

const FILE_KEYS = { persona: 'file.persona', skill: 'file.skill', git: 'file.git', instructions: 'file.instructions' } as const;

const MAX_READ_BYTES = 512 * 1024;
const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_CHARS = 1_000_000;

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
  if (placement.kind === 'outside') {
    return result({ decision: 'deny', reasons: [guardText(language, 'file.outside', { path: abs, roots: ctx.policy.roots.map(r => guardText(language, r.mode === 'write' ? 'file.root_write' : 'file.root_read', { path: r.path })).join(guardText(language, 'file.root_sep')) })] });
  }
  if (need === 'write' && placement.mode === 'read') return result({ decision: 'deny', reasons: [guardText(language, 'file.readonly', { root: placement.root })] });
  if (need === 'write' && existsSync(abs) && lstatSync(abs).isSymbolicLink()) return result({ decision: 'deny', reasons: [guardText(language, 'file.symlink')] });
  const protectedKind = need === 'write' ? writeApprovalKind(abs, ctx.policy) : undefined;
  // .git への書き込みはフックや設定というコードを書くことになるので、コードの確かめ（種類 code）にする。人格・スキルは、中身が引数にあるので今までどおり
  if (protectedKind === 'git') return result({ decision: 'ask', reasons: [guardText(language, FILE_KEYS.git)], askKinds: ['code'], reasonKeys: [FILE_KEYS.git] });
  if (protectedKind) {
    const key = protectedKind === 'skill' && !askBeforeRegister(ctx.config) ? 'file.skill_auto' : FILE_KEYS[protectedKind];
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
  description: 'Read a text file. With offset (the line to start from, starting at 1) and limit (how many lines) you can read just part of it.',
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
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) return { content: toolText(language, 'file.binary'), isError: true };
    const lines = text.split(/\r?\n/u);
    const start = (input.offset ?? 1) - 1;
    const end = input.limit ? start + input.limit : lines.length;
    const body = lines.slice(start, end).join('\n');
    const more = end < lines.length ? `\n\n${toolText(language, 'file.more', { total: lines.length, from: start + 1, to: end, next: end + 1 })}` : '';
    return { content: body + more };
  },
};

export const fileWrite: ToolDef<{ path: string; content: string; mode?: 'overwrite' | 'append' | 'create' }> = {
  name: 'file_write',
  description: 'Write a text file. mode: overwrite (overwrite; the default) / append (add to the end) / create (create only if it does not exist). Folders are created automatically.',
  input: Type.Object({
    path: PathArg, content: Type.String({ maxLength: MAX_WRITE_CHARS }),
    mode: Type.Optional(Type.Union([Type.Literal('overwrite'), Type.Literal('append'), Type.Literal('create')])),
  }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'write', ctx).check,
  summarize: (input, language) => ({ title: toolText(language, 'summary.file_write', { path: input.path }), body: input.content.slice(0, 4000) }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    const language = languageOf(ctx.config);
    const exists = existsSync(abs);
    if (input.mode === 'create' && exists) return { content: toolText(language, 'file.exists', { path: shown(abs, ctx) }), isError: true };
    if (exists && statSync(abs).isDirectory()) return { content: toolText(language, 'file.is_dir', { path: shown(abs, ctx) }), isError: true };
    mkdirSync(dirname(abs), { recursive: true });
    // フォルダを作った後は realpath が実体を指すので、シンボリックリンク経由で外に出ていないかをもう一度確かめる
    // （ask は実行前に承認済みなので、ここでは deny だけを止める）
    const recheck = checkFilePath(abs, 'write', ctx).check;
    if (recheck.decision === 'deny') return { content: toolText(language, 'file.recheck_failed', { detail: recheck.reasons.join(' / ') }), isError: true };
    const appending = input.mode === 'append' && exists;
    const current = appending ? readFileSync(abs, 'utf8') : '';
    const next = appending ? current + input.content : input.content;
    const before = appending ? null : exists ? previousForDelta(abs) : '';
    atomicWriteFile(abs, next);
    if (!exists) ctx.noteCreated?.(abs);
    const params = { verb: toolText(language, exists ? (input.mode === 'append' ? 'file.wrote.append' : 'file.wrote.overwrite') : 'file.wrote.create'), path: shown(abs, ctx), chars: next.length.toLocaleString('en-US') };
    const delta = appending ? appendDelta(current, input.content) : before === null ? null : lineDelta(before, next);
    if (!delta) return { content: toolText(language, 'file.wrote', params) };
    return { content: toolText(language, 'file.wrote_lines', { ...params, added: delta.added.toLocaleString('en-US'), removed: delta.removed.toLocaleString('en-US') }) };
  },
};

export const fileEdit: ToolDef<{ path: string; old: string; new: string; all?: boolean }> = {
  name: 'file_edit',
  description: 'Replace part of a file. old must be text that appears exactly once in the file (with all=true, every occurrence is replaced).',
  input: Type.Object({ path: PathArg, old: Type.String({ minLength: 1 }), new: Type.String(), all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'write', ctx).check,
  summarize: (input, language) => ({ title: toolText(language, 'summary.file_edit', { path: input.path }), body: `- ${input.old.slice(0, 2000)}\n+ ${input.new.slice(0, 2000)}` }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    const language = languageOf(ctx.config);
    if (!existsSync(abs)) return { content: toolText(language, 'file.not_found', { path: shown(abs, ctx) }), isError: true };
    const text = readFileSync(abs, 'utf8');
    const count = text.split(input.old).length - 1;
    if (count === 0) return { content: toolText(language, 'file.no_match'), isError: true };
    if (count > 1 && !input.all) return { content: toolText(language, 'file.many_matches', { count }), isError: true };
    atomicWriteFile(abs, input.all ? text.split(input.old).join(input.new) : text.replace(input.old, () => input.new));
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
