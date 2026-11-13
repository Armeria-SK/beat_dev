import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEV_RUNNERS, PRODUCT_CODE_KEYS, SERVICE_PROGRAMS } from './decision-order.ts';
import { sanitizeModelInputText } from '../../shared/redaction.ts';
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
  ownerHooks?: () => boolean;
}

export type ProductRunResult = { run: ProductRun } | { secret: string } | { secretMessage: true } | undefined;

const RUN_KINDS = new Set(['code', 'git_write']);
const AWS_KEY = /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/u;
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

const RUNNER_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: ['package.json'],
  make: ['Makefile', 'makefile', 'GNUmakefile'], gmake: ['Makefile', 'makefile', 'GNUmakefile'], nmake: ['Makefile', 'makefile'],
  just: ['justfile', 'Justfile', '.justfile'], rake: ['Rakefile', 'rakefile', 'Rakefile.rb'], ninja: ['build.ninja'],
  pytest: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'], tox: ['tox.ini', 'pyproject.toml', 'setup.cfg'], nox: ['noxfile.py'],
  jest: ['package.json', 'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'],
  vitest: ['package.json', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js'],
  mocha: ['package.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.jsonc'],
};
const PLACE_FLAGS = new Set(['directory', 'file', 'makefile', 'include-dir', 'rootdir', 'root', 'config', 'config-file', 'justfile', 'working-directory', 'pyargs',
  'confcutdir', 'basetemp', 'require', 'workdir', 'toxinidir', 'envdir', 'noxfile', 'project', 'projects', 'dir', 'cwd', 'chdir', 'prefix', 'userconfig', 'globalconfig']);
const PLACE_SHORT = /^-[A-Za-z]*[CfcpdIrR]/u;

type FlagValue = 'number' | 'word' | 'expr' | 'reporter' | null;
const MAKE_FLAGS: Readonly<Record<string, FlagValue>> = { '-j': 'number', '-k': null, '-s': null, '-n': null };
const RUNNER_FLAGS: Readonly<Record<string, Readonly<Record<string, FlagValue>>>> = {
  make: MAKE_FLAGS, gmake: MAKE_FLAGS, nmake: {}, just: {}, rake: {}, ninja: { '-j': 'number', '-v': null },
  pytest: { '-q': null, '-v': null, '-x': null, '-k': 'expr', '-m': 'expr' },
  jest: { '--watch=false': null, '-t': 'expr' }, vitest: { '--run': null, '--watch=false': null, '-t': 'expr' },
  mocha: { '--reporter': 'reporter' }, tox: { '-e': 'word' }, nox: { '-s': 'word' },
};
const VALUE_FORMS: Readonly<Record<Exclude<FlagValue, null>, RegExp>> = {
  number: /^\d{1,4}$/u, word: /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u, expr: /^(?!-)(?!.*__)[A-Za-z0-9_ .:()[\]-]+$/u,
  reporter: /^(?:spec|dot|nyan|tap|landing|list|progress|json|json-stream|min|doc|markdown|xunit|base)$/iu,
};
const RUNNER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  vitest: new Set(['init']), mocha: new Set(['init']), tox: new Set(['devenv', 'd', 'quickstart', 'q', 'exec', 'e']),
};

const programName = (st: StatementFacts): string => st.program.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
const pathLike = (text: string): boolean => /[\\/]/u.test(text) || text.startsWith('.') || text.startsWith('~') || /^[A-Za-z]:/u.test(text) || isAbsolute(text);

const looseInside = (text: string, cwd: string, root: string): boolean => !text.startsWith('~') && !/^[A-Za-z]:(?![\\/])/u.test(text) && inside(root, resolve(cwd, text.replace(/\\/gu, '/')));

function plainPathInside(text: string, cwd: string, root: string): boolean {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./\\:+@,-]*$/u.test(text) || /^[A-Za-z]:/u.test(text) || isAbsolute(text)) return false;
  const parts = text.split(/[\\/]/u);
  if (parts.includes('..')) return false;
  return inside(root, resolve(cwd, parts.join('/')));
}

function runnerArgsAllowed(st: StatementFacts, root: string, flags: Readonly<Record<string, FlagValue>>): boolean {
  const words = st.words.slice(1);
  const subcommands = RUNNER_SUBCOMMANDS[programName(st)];
  let positionals = 0;
  const valueOk = (kind: FlagValue, value: string | undefined): boolean => kind !== null && value !== undefined && VALUE_FORMS[kind].test(value);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.dynamic || word.glob) return false;
    const text = word.text;
    if (!text.startsWith('-')) {
      if (positionals++ === 0 && subcommands?.has(text.toLowerCase())) return false;
      if (text.includes('=') || !plainPathInside(text, st.cwd!, root)) return false;
      continue;
    }
    if (Object.hasOwn(flags, text)) {
      const kind = flags[text]!;
      if (kind === null) continue;
      const next = words[++i];
      if (!next || next.dynamic || next.glob || !valueOk(kind, next.text)) return false;
      continue;
    }
    const eq = /^(--[A-Za-z][A-Za-z-]*)=(.*)$/su.exec(text);
    if (eq && Object.hasOwn(flags, eq[1]!) && valueOk(flags[eq[1]!]!, eq[2])) continue;
    const short = /^(-[A-Za-z])(.+)$/su.exec(text);
    if (short && !text.startsWith('--') && Object.hasOwn(flags, short[1]!) && valueOk(flags[short[1]!]!, short[2])) continue;
    return false;
  }
  return true;
}

function runnerStaysInside(st: StatementFacts, root: string): boolean {
  const name = programName(st);
  const files = RUNNER_FILES[name];
  if (files && !files.some(file => statSync(resolve(st.cwd!, file), { throwIfNoEntry: false })?.isFile() === true)) return false;
  if (DEV_RUNNERS.has(name)) return runnerArgsAllowed(st, root, RUNNER_FLAGS[name] ?? {});
  for (const word of st.words.slice(1)) {
    const text = word.text;
    if (text.startsWith('--')) {
      const [name, value] = text.slice(2).split(/=(.*)/su);
      if (PLACE_FLAGS.has(name!.toLowerCase())) return false;
      if (value !== undefined && pathLike(value) && !looseInside(value, st.cwd!, root)) return false;
      continue;
    }
    if (text.startsWith('-') && files && PLACE_SHORT.test(text)) return false;
    if (pathLike(text) && !looseInside(text, st.cwd!, root)) return false;
  }
  return true;
}

function namesFilesOnly(st: StatementFacts): boolean {
  const named = st.words.slice(2).filter(w => !w.text.startsWith('-'));
  if (named.length === 0 || st.words.slice(2).some(w => w.dynamic || w.glob)) return false;
  return named.every(w => statSync(resolve(st.cwd!, w.text), { throwIfNoEntry: false })?.isFile() === true);
}

function secretToAdd(st: StatementFacts, git: ProductRunInput['git']): string | undefined | null {
  const top = git(st.cwd!, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const end = st.words.findIndex(w => w.text === '--');
  const force = st.words.slice(2, end < 0 ? undefined : end).some(w => w.text === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/u.test(w.text));
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
  let others = false;
  const rerouted = verdict.writes.length > 0 || verdict.statements.some(st => st.piped === true || st.redirected === true);
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
    if (st.program !== 'git') {
      if (!runnerStaysInside(st, root)) return undefined;
      others = true;
      continue;
    }
    if (others) return undefined;
    if (st.gitGlobal.length > 0 || rerouted || ![...own].every(key => key === 'list.git_commit')) return undefined;
    const sub = st.words[1]?.text;
    if (sub !== 'add' && sub !== 'commit') return undefined;
    const top = git(st.cwd!, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top || !inside(root, resolve(top))) return undefined;
    if (sub === 'commit' && st.words.slice(2).some(w => !w.dynamic && (sanitizeModelInputText(w.text).redaction_count > 0 || AWS_KEY.test(w.text)))) return { secretMessage: true };
    if (input.ownerHooks?.() !== false) return undefined;
    if (sub === 'add' && namesFilesOnly(st)) {
      const named = st.words.slice(2).filter(w => !w.text.startsWith('-')).map(w => w.text).find(name => isSecretPath(resolve(st.cwd!, name)) || COMMIT_SECRET.test(name.replace(/\\/gu, '/')));
      if (named !== undefined) return { secret: named };
    }
    if (sub === 'add' && !namesFilesOnly(st)) {
      const secret = secretToAdd(st, git);
      if (secret === null) return undefined;
      if (secret !== undefined) return { secret };
    }
    commits = true;
  }
  return { run: commits ? 'product-git' : 'product-code' };
}
