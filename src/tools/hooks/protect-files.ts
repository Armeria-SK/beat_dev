import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type AppConfig, type BuiltinHookConfig, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { HookPayload, HookResult } from './command-hook.ts';
import { isInside, realish, realPath, windowsNames } from './scope.ts';

export const PROTECT_FILES = 'protect-files';
export const PROTECT_FILES_OFFERED = 'hooks.protect-files.offered';

export const DEFAULT_PROTECT_FILES: BuiltinHookConfig = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'] };

const WINDOWS = process.platform === 'win32';
const ASCII_ONLY = /^[\x00-\x7f]*$/u;
const foldChar = (c: string): string => { const lower = c.toLowerCase(); return [...lower].length === 1 ? lower : c; };
const fold = (p: string) => (ASCII_ONLY.test(p) ? p.toLowerCase() : Array.from(p, foldChar).join(''));
const baseFold = (p: string) => (WINDOWS ? p.toLowerCase() : p);
const inside = (root: string, target: string): boolean => isInside(root, target) || isInside(fold(root), fold(target));
const GLOB_CHAR = /[*?]/u;
const WALK_LIMIT = 20_000;

interface Rule { bases: string[]; rest: string[]; restBase: string[] }

const segCache = new Map<string, RegExp>();
function segRegex(seg: string): RegExp {
  let re = segCache.get(seg);
  if (!re) {
    re = new RegExp(`^${seg.replace(/\*+/gu, '*').split('').map(c => (c === '*' ? '[^/]*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/gu, '\\$&'))).join('')}$`, 'su');
    segCache.set(seg, re);
  }
  return re;
}

function matchSegs(glob: string[], rel: string[], under: boolean): boolean {
  const memo = new Map<number, boolean>();
  const go = (g: number, r: number): boolean => {
    const key = g * (rel.length + 1) + r;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (r === rel.length) result = g === glob.length || under || glob.slice(g).every(s => s === '**');
    else if (g === glob.length) result = true;
    else if (glob[g] === '**') result = go(g + 1, r) || go(g, r + 1);
    else result = segRegex(glob[g]!).test(rel[r]!) && go(g + 1, r + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function rulesOf(pattern: string, roots: string[]): Rule[] {
  const normalized = pattern.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:(?:\/|$)/u.test(normalized);
  const absolute = drive || isAbsolute(normalized);
  if (!absolute && !roots.length) return [];
  const parts = normalized.split('/');
  const first = parts.findIndex(part => GLOB_CHAR.test(part));
  const fixed = (first < 0 ? parts : parts.slice(0, first)).filter((part, i) => part !== '' || (i === 0 && !drive));
  const tail = (first < 0 ? [] : parts.slice(first)).filter(Boolean);
  const rest = tail.map(fold);
  const restBase = tail.map(baseFold);
  const make = (base: string): Rule => ({ bases: [...new Set([base, realish(base)])], rest, restBase });
  if (!absolute) return roots.map(root => make(resolve(root, ...fixed)));
  if (WINDOWS && normalized.startsWith('//')) return [make(`\\\\${fixed.filter(Boolean).join('\\')}`)];
  const head = drive ? `${fixed[0]}/` : '/';
  return [make(resolve(head, ...fixed.slice(drive ? 1 : 0).filter(Boolean)))];
}

function relSegs(base: string, target: string, f: (p: string) => string): string[] {
  const rel = relative(f(base), f(target));
  return rel === '' ? [] : rel.split(sep);
}

function restMatches(rule: Rule, base: string, target: string, dir: boolean): boolean {
  return matchSegs(rule.rest, relSegs(base, target, fold), dir) || matchSegs(rule.restBase, relSegs(base, target, baseFold), dir);
}

function hits(rule: Rule, target: string, dir: boolean): boolean {
  return rule.bases.some(base => {
    if (inside(target, base)) return true;
    if (!inside(base, target)) return false;
    return rule.rest.length === 0 || restMatches(rule, base, target, dir);
  });
}

type Inodes = Map<string, string> | 'overflow';

interface Budget { left: number }

function protectedInodes(rules: Rule[], budget: Budget): Inodes {
  const found = new Map<string, string>();
  const add = (rule: Rule, base: string, file: string): void => {
    if (rule.rest.length && !restMatches(rule, base, file, false)) return;
    try { const st = statSync(file, { bigint: true }); if (st.nlink > 1n) found.set(`${st.dev}:${st.ino}`, file); } catch { }
  };
  for (const rule of rules) {
    for (const base of rule.bases) {
      let st;
      try { st = statSync(base); } catch { continue; }
      if (st.isFile()) { add(rule, base, base); continue; }
      const queue = [base];
      while (queue.length) {
        const current = queue.shift()!;
        let entries;
        try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (--budget.left < 0) return 'overflow';
          const full = join(current, entry.name);
          if (entry.isDirectory()) queue.push(full);
          else if (entry.isFile()) add(rule, base, full);
        }
      }
    }
  }
  return found;
}

function linkedFiles(dir: string, budget: Budget): Array<{ key: string; file: string }> | 'overflow' {
  const out: Array<{ key: string; file: string }> = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift()!;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (--budget.left < 0) return 'overflow';
      const full = join(current, entry.name);
      if (entry.isDirectory()) { queue.push(full); continue; }
      if (!entry.isFile()) continue;
      try { const st = statSync(full, { bigint: true }); if (st.nlink > 1n) out.push({ key: `${st.dev}:${st.ino}`, file: full }); } catch { }
    }
  }
  return out;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

// 「cp 元… 先のフォルダ」だけの 1 文（mv も）。先のフォルダ自身は書き換えず、書かれるのは 先/元の名前 だけなので、その名前がそろって書き込みの一覧にあるときだけ、先のフォルダを一覧から外す。
// 見張りは先のフォルダと できる名前の両方を書き込みに挙げるので、そのままだと守るフォルダを含むフォルダ（. など）への cp が、守る名前に当たらなくても聞かれる。
// 文字は引用符・変数・ワイルドカード・つなぎ（; && | > など）の無い決まった形だけ読み、旗は値を取らないものだけ。ほかは外さない（rm -rf . のようなフォルダごとの書き込みは今までどおり聞く）
const COPY_PROGRAMS = new Set(['cp', 'mv', 'copy-item', 'move-item', 'cpi', 'mi', 'copy', 'move']);
const COPY_FLAG = /^(?:-[rRfvpnu]+|--(?:recursive|force|verbose|no-clobber|update)|-(?:recurse|force|verbose))$/iu;
const COPY_PATH = /^(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.@+][A-Za-z0-9_.@+/\\-]*$/u;

function copyFolders(payload: HookPayload, writes: ReadonlyArray<{ path: string }>): Set<string> {
  const folders = new Set<string>();
  const input = payload.tool_input;
  const command = payload.tool_name === 'shell_run' && typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== 'string' || command.length > 1_000) return folders;
  const [program, ...rest] = command.trim().split(/[ \t]+/u);
  if (!program || !COPY_PROGRAMS.has(program.toLowerCase())) return folders;
  const flags = rest.filter(word => word.startsWith('-'));
  const paths = rest.filter(word => !word.startsWith('-'));
  if (paths.length < 2 || !flags.every(flag => COPY_FLAG.test(flag)) || !paths.every(word => COPY_PATH.test(word) && (WINDOWS || !word.includes('\\')))) return folders;
  const dest = resolve(payload.cwd, paths.at(-1)!);
  if (!isDirectory(dest)) return folders;
  const names = paths.slice(0, -1).map(word => word.split(/[\\/]/u).filter(Boolean).at(-1));
  if (names.some(name => name === undefined || name === '.' || name === '..')) return folders;
  const written = new Set(writes.map(entry => baseFold(resolve(payload.cwd, entry.path))));
  if (names.every(name => written.has(baseFold(resolve(dest, name!))))) folders.add(baseFold(dest));
  return folders;
}

export function runProtectFiles(hook: BuiltinHookConfig, payload: HookPayload, language: Language = DEFAULT_LANGUAGE): HookResult {
  const writes = (payload.paths ?? []).filter(p => p.write && typeof p.path === 'string' && p.path !== '');
  const none: HookResult = { hook: PROTECT_FILES, decision: undefined, reason: '' };
  if (!writes.length) return none;
  const roots = [...new Set([payload.project_root, ...(payload.product_roots ?? [])].filter((r): r is string => typeof r === 'string' && r !== ''))];
  const rules = hook.always.flatMap(p => rulesOf(p, roots));
  if (!rules.length) return none;
  let inodes: Inodes | undefined;
  const budget: Budget = { left: WALK_LIMIT };
  const reasons: string[] = [];
  const folders = copyFolders(payload, writes);
  for (const entry of writes) {
    const given = resolve(payload.cwd, entry.path);
    if (folders.has(baseFold(given)) && isDirectory(given)) continue;
    const lexical = WINDOWS ? windowsNames(given) : given;
    const resolved = realPath(lexical);
    const real = resolved.path;
    const dir = entry.dir === true || /[\\/]$/u.test(entry.path) || isDirectory(real);
    const targets = [...new Set([given, lexical, real])];
    const shown = (WINDOWS ? fold(real) === fold(given) : real === given) ? entry.path : guardText(language, 'hook.protected_real', { path: entry.path, real });
    if (!resolved.sure) { reasons.push(guardText(language, 'hook.protected_unsure', { path: entry.path })); continue; }
    if (rules.some(rule => targets.some(target => hits(rule, target, dir)))) { reasons.push(shown); continue; }
    let st;
    try { st = statSync(real, { bigint: true }); } catch { continue; }
    if (!st.isDirectory() && !(st.isFile() && st.nlink > 1n)) continue;
    inodes ??= protectedInodes(rules, budget);
    if (inodes === 'overflow') { reasons.push(guardText(language, 'hook.protected_unchecked', { path: entry.path })); continue; }
    if (!inodes.size) continue;
    const linked = st.isDirectory() ? linkedFiles(real, budget) : [{ key: `${st.dev}:${st.ino}`, file: real }];
    if (linked === 'overflow') { reasons.push(guardText(language, 'hook.protected_unchecked', { path: entry.path })); continue; }
    const known = inodes;
    const same = linked.map(l => known.get(l.key)).find(o => o !== undefined);
    if (same !== undefined) reasons.push(guardText(language, 'hook.protected_link', { path: entry.path, other: same }));
  }
  if (!reasons.length) return none;
  return { hook: PROTECT_FILES, decision: 'ask', reason: guardText(language, 'hook.protected', { path: [...new Set(reasons)].join(', ') }) };
}

export function hasProtectFiles(config: AppConfig): boolean {
  return config.tools.hooks.preToolUse.some(h => 'builtin' in h && h.builtin === PROTECT_FILES);
}
