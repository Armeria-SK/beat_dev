import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEV_RUNNERS, PRODUCT_CODE_KEYS, SERVICE_PROGRAMS } from './decision-order.ts';
import { definesCommand } from './outbound.ts';
import { isInside, isSecretPath, realish } from './scope.ts';
import type { StatementFacts } from './shell-facts.ts';
import type { ShellVerdict } from './shell-guard.ts';

export type ProductRun = 'product-code' | 'product-git';

export interface ProductRunInput {
  root: string;
  verdict: Pick<ShellVerdict, 'decision' | 'askKinds' | 'paths' | 'writes' | 'scripts' | 'statements' | 'reasonKeys'>;
  which: (name: string, cwd: string) => string | undefined;
  git: (dir: string, args: string[]) => string | undefined;
}

export type ProductRunResult = { run: ProductRun } | { secret: string } | undefined;

const RUN_KINDS = new Set(['code', 'git_write']);
const COMMIT_SECRET = /(?:^|\/)(?:[^/]*(?:secret|credential)[^/]*|[^/]+\.env)$/iu;

const inside = (root: string, path: string): boolean => isInside(root, path) && isInside(realish(root), realish(path));

function programPath(st: StatementFacts, which: ProductRunInput['which']): string | undefined {
  const word = st.words[0]?.text;
  if (!word || st.cwd === null) return undefined;
  if (/[\\/]/u.test(word) || isAbsolute(word)) return resolve(st.cwd, word);
  return which(word, st.cwd);
}

function plainStatement(st: StatementFacts, root: string): boolean {
  return st.inner === undefined && !st.programDynamic && !st.programOdd && st.code.length === 0 && !st.codeDynamic && st.env.length === 0
    && !definesCommand(st) && !SERVICE_PROGRAMS.has(st.program) && st.cwd !== null && inside(root, st.cwd);
}

function namesFilesOnly(st: StatementFacts): boolean {
  const named = st.words.slice(2).filter(w => !w.text.startsWith('-'));
  if (named.length === 0 || st.words.slice(2).some(w => w.dynamic || w.glob)) return false;
  return named.every(w => statSync(resolve(st.cwd!, w.text), { throwIfNoEntry: false })?.isFile() === true);
}

function secretToAdd(st: StatementFacts, git: ProductRunInput['git']): string | undefined | null {
  const top = git(st.cwd!, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const force = st.words.some(w => w.text === '-f' || w.text === '--force');
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(force ? ['--ignored'] : [])]);
  if (status === undefined) return null;
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = resolve(top, entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (isSecretPath(path) || COMMIT_SECRET.test(entry.slice(3))) return entry.slice(3);
  }
  return undefined;
}

export function productRunOf(input: ProductRunInput): ProductRunResult {
  const { root, verdict, which, git } = input;
  if (verdict.decision !== 'ask' || !verdict.statements.length) return undefined;
  if (!verdict.askKinds.every(kind => RUN_KINDS.has(kind))) return undefined;
  const keys = new Set([...verdict.reasonKeys, ...verdict.statements.flatMap(st => st.reasonKeys)]);
  for (const key of keys) if (!PRODUCT_CODE_KEYS.has(key) && key !== 'list.external' && key !== 'list.command' && key !== 'list.git_commit') return undefined;
  if (verdict.paths.some(p => !p.path || !inside(root, p.path))) return undefined;
  if ([...verdict.writes, ...verdict.scripts].some(p => !inside(root, p))) return undefined;
  let commits = false;
  for (const st of verdict.statements) {
    if (!plainStatement(st, root)) return undefined;
    const own = new Set(st.reasonKeys);
    if (own.has('list.command') && !DEV_RUNNERS.has(st.program)) {
      const path = programPath(st, which);
      if (!path || !inside(root, path)) return undefined;
    }
    if (own.has('list.external')) {
      const path = programPath(st, which);
      if (!path || !inside(root, path)) return undefined;
    }
    if (own.has('list.lang_run')) {
      const file = st.words[1]?.text;
      if (!file || !inside(root, resolve(st.cwd!, file))) return undefined;
    }
    if (st.program !== 'git') continue;
    if (st.gitGlobal.length > 0 || ![...own].every(key => key === 'list.git_commit')) return undefined;
    const sub = st.words[1]?.text;
    if (sub !== 'add' && sub !== 'commit') return undefined;
    const top = git(st.cwd!, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top || !inside(root, resolve(top))) return undefined;
    if (sub === 'add' && !namesFilesOnly(st)) {
      const secret = secretToAdd(st, git);
      if (secret === null) return undefined;
      if (secret !== undefined) return { secret };
    }
    commits = true;
  }
  return { run: commits ? 'product-git' : 'product-code' };
}
