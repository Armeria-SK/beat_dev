import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type AppConfig, type BuiltinHookConfig, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { HookPayload, HookResult } from './command-hook.ts';
import { isInside, realish, windowsNames } from './scope.ts';

export const PROTECT_FILES = 'protect-files';
export const PROTECT_FILES_OFFERED = 'hooks.protect-files.offered';

export const DEFAULT_PROTECT_FILES: BuiltinHookConfig = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'], afterOutside: ['package.json'] };

const WINDOWS = process.platform === 'win32';
const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);
const GLOB_CHAR = /[*?]/u;
const WALK_LIMIT = 20_000;

interface Rule { bases: string[]; rest: string[] }

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
    else if (g === glob.length) result = false;
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
  const rest = (first < 0 ? [] : parts.slice(first)).filter(Boolean).map(fold).filter((s, i, all) => !(s === '**' && all[i - 1] === '**'));
  const make = (base: string): Rule => ({ bases: [...new Set([base, realish(base)])], rest });
  if (!absolute) return roots.map(root => make(resolve(root, ...fixed)));
  const head = drive ? `${fixed[0]}/` : '/';
  return [make(resolve(head, ...fixed.slice(drive ? 1 : 0).filter(Boolean)))];
}

function relSegs(base: string, target: string): string[] {
  const rel = relative(fold(base), fold(target));
  return rel === '' ? [] : rel.split(sep);
}

function hits(rule: Rule, target: string, dir: boolean): boolean {
  return rule.bases.some(base => {
    if (isInside(target, base)) return true;
    if (!isInside(base, target)) return false;
    return rule.rest.length === 0 || matchSegs(rule.rest, relSegs(base, target), dir);
  });
}

type Inodes = Map<string, string> | 'overflow';

function protectedInodes(rules: Rule[]): Inodes {
  const found = new Map<string, string>();
  let seen = 0;
  const add = (rule: Rule, base: string, file: string): void => {
    if (rule.rest.length && !matchSegs(rule.rest, relSegs(base, file), false)) return;
    try { const st = statSync(file, { bigint: true }); found.set(`${st.dev}:${st.ino}`, file); } catch { }
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
          if (++seen > WALK_LIMIT) return 'overflow';
          const full = join(current, entry.name);
          if (entry.isDirectory()) queue.push(full);
          else if (entry.isFile()) add(rule, base, full);
        }
      }
    }
  }
  return found;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function runProtectFiles(hook: BuiltinHookConfig, payload: HookPayload, language: Language = DEFAULT_LANGUAGE): HookResult {
  const writes = (payload.paths ?? []).filter(p => p.write && typeof p.path === 'string' && p.path !== '');
  const none: HookResult = { hook: PROTECT_FILES, decision: undefined, reason: '' };
  if (!writes.length) return none;
  const roots = [...new Set([payload.project_root, ...(payload.product_roots ?? [])].filter((r): r is string => typeof r === 'string' && r !== ''))];
  const patterns = [...hook.always, ...(payload.tainted === true ? hook.afterOutside : [])];
  const rules = patterns.flatMap(p => rulesOf(p, roots));
  if (!rules.length) return none;
  let inodes: Inodes | undefined;
  const reasons: string[] = [];
  for (const entry of writes) {
    const given = resolve(payload.cwd, entry.path);
    const lexical = WINDOWS ? windowsNames(given) : given;
    const real = realish(lexical);
    const dir = entry.dir === true || /[\\/]$/u.test(entry.path) || isDirectory(real);
    const targets = [...new Set([given, lexical, real])];
    const shown = fold(real) === fold(given) ? entry.path : guardText(language, 'hook.protected_real', { path: entry.path, real });
    if (rules.some(rule => targets.some(target => hits(rule, target, dir)))) { reasons.push(shown); continue; }
    let st;
    try { st = statSync(real, { bigint: true }); } catch { continue; }
    if (!st.isFile() || st.nlink < 2n) continue;
    inodes ??= protectedInodes(rules);
    const same = inodes === 'overflow' ? real : inodes.get(`${st.dev}:${st.ino}`);
    if (same !== undefined) reasons.push(guardText(language, 'hook.protected_link', { path: entry.path, other: same }));
  }
  if (!reasons.length) return none;
  return { hook: PROTECT_FILES, decision: 'ask', reason: guardText(language, 'hook.protected', { path: [...new Set(reasons)].join(', ') }) };
}

export function hasProtectFiles(config: AppConfig): boolean {
  return config.tools.hooks.preToolUse.some(h => 'builtin' in h && h.builtin === PROTECT_FILES);
}
