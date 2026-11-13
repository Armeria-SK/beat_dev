import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type AppConfig, type BuiltinHookConfig, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { HookPayload, HookResult } from './command-hook.ts';
import { isInside, realish } from './scope.ts';

export const PROTECT_FILES = 'protect-files';
export const PROTECT_FILES_OFFERED = 'hooks.protect-files.offered';

export const DEFAULT_PROTECT_FILES: BuiltinHookConfig = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'], afterOutside: ['package.json'] };

const WINDOWS = process.platform === 'win32';
const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);
const GLOB_CHAR = /[*?]/u;

interface Rule { bases: string[]; rest: RegExp | undefined }

function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${re}$`, 'su');
}

function ruleOf(pattern: string, root: string | undefined): Rule | undefined {
  const normalized = pattern.replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized);
  if (!absolute && !root) return undefined;
  const parts = normalized.split('/');
  const first = parts.findIndex(part => GLOB_CHAR.test(part));
  const fixed = first < 0 ? parts : parts.slice(0, first);
  const rest = first < 0 ? '' : parts.slice(first).join('/');
  const base = absolute ? resolve(fixed.join('/') || '/') : resolve(root!, ...fixed);
  return { bases: [...new Set([base, realish(base)])], rest: rest ? globRegex(fold(rest)) : undefined };
}

function hits(rule: Rule, target: string): boolean {
  return rule.bases.some(base => {
    if (isInside(target, base)) return true;
    if (!isInside(base, target) || !rule.rest) return false;
    const rel = relative(fold(base), fold(target)).split(sep).join('/');
    return rule.rest.test(rel) || rule.rest.test(`${rel}/`);
  });
}

export function runProtectFiles(hook: BuiltinHookConfig, payload: HookPayload, language: Language = DEFAULT_LANGUAGE): HookResult {
  const writes = (payload.paths ?? []).filter(p => p.write && typeof p.path === 'string' && p.path !== '');
  const none: HookResult = { hook: PROTECT_FILES, decision: undefined, reason: '' };
  if (!writes.length) return none;
  const root = payload.project_root || undefined;
  const patterns = [...hook.always, ...(payload.tainted === true ? hook.afterOutside : [])];
  const rules = patterns.map(p => ruleOf(p, root)).filter((r): r is Rule => r !== undefined);
  if (!rules.length) return none;
  const matched = writes.filter(({ path }) => {
    const lexical = resolve(payload.cwd, path);
    const targets = [...new Set([lexical, realish(lexical)])];
    return rules.some(rule => targets.some(target => hits(rule, target)));
  }).map(p => p.path);
  if (!matched.length) return none;
  return { hook: PROTECT_FILES, decision: 'ask', reason: guardText(language, 'hook.protected', { path: [...new Set(matched)].join(', ') }) };
}

export function hasProtectFiles(config: AppConfig): boolean {
  return config.tools.hooks.preToolUse.some(h => 'builtin' in h && h.builtin === PROTECT_FILES);
}
