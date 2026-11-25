import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export interface CheckCommand { command: string; source: string }

export interface FoundChecks { commands: CheckCommand[]; guards: string[]; none?: string; blocked?: string }

export interface FindOptions { env?: Record<string, string>; windows?: boolean }

export const MAX_CHECK_COMMANDS = 4;
export const NONE_FOUND = 'beat found nothing it can run as a check: there is no package.json with build, type, lint or test scripts, and no go.mod, Cargo.toml, Makefile with a check or test target, .sln or .csproj, or pytest configuration in this folder.';
export const BLOCKED_DEPENDENCIES = 'The dependencies are not installed (there is no node_modules folder here), so beat did not run the checks.';
const PYTHON_STUB = 'pytest is configured, but python here is the Microsoft Store stub in WindowsApps, which stops instead of running, so beat did not run it.';
const PYTHON_MISSING = 'pytest is configured, but python was not found on the PATH, so beat did not run it.';

export const PACKAGE_MAX = 1024 * 1024;
const TEXT_MAX = 1024 * 1024;
const AGGREGATE = ['check', 'verify', 'ci'] as const;
const WRITES_FILES = /(?:^|\s)--(?:fix|write)(?=\s|=|$)/u;
const PLACEHOLDER_TEST = /^\s*echo\b[^&|;]*no test specified[^&|;]*&&\s*exit\s+1\s*$/iu;
const WINDOWS_APPS = /[\\/]WindowsApps[\\/]/iu;

export const TEST_CONFIG_NAME = /^((jest|vitest|vitest\.workspace|playwright|cypress|karma|ava|babel)\.config\.[^/]+|karma\.conf\.[^/]+|\.mocharc[^/]*|\.c8rc[^/]*|\.nycrc[^/]*|pytest\.ini|conftest\.py|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?)$/iu;
const NPM_GUARD_NAME = /^(\.npmrc|tsconfig[^/]*\.json|eslint\.config\.[^/]+|\.eslintrc.*|vite\.config\.[^/]+)$/u;
const MAKEFILE_NAME = /^(GNUmakefile|makefile|Makefile)$/u;
const PYTHON_FILES = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'conftest.py'];

interface Listing { names: string[]; files: Set<string> }

interface Kind { commands: CheckCommand[]; guards: string[]; blocked?: true; note?: string }

export const PACKAGE_SETTING_KEYS = ['ava', 'babel', 'c8', 'eslintConfig', 'jest', 'mocha', 'nyc'] as const;

interface PackageInfo { scripts: Record<string, string>; hasDependencies: boolean; settings: Record<string, string> }

const emptyPackage = (): PackageInfo => ({ scripts: {}, hasDependencies: false, settings: {} });

function listing(root: string): Listing {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    return { names: entries.map(entry => entry.name).sort(), files: new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name)) };
  } catch { return { names: [], files: new Set() }; }
}

export function readRegular(root: string, name: string, max = TEXT_MAX): string | undefined {
  try {
    const path = join(root, name);
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= max ? readFileSync(path, 'utf8') : undefined;
  } catch { return undefined; }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const byKey = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (isObject(item) ? Object.fromEntries(Object.entries(item).sort(byKey)) : item));

export function readPackage(root: string): PackageInfo | undefined {
  const text = readRegular(root, 'package.json', PACKAGE_MAX);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return emptyPackage(); }
  if (!isObject(parsed)) return emptyPackage();
  const scripts = isObject(parsed.scripts) ? Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  const hasDependencies = ['dependencies', 'devDependencies'].some(key => isObject(parsed[key]) && Object.keys(parsed[key] as object).length > 0);
  const settings = Object.fromEntries(PACKAGE_SETTING_KEYS.filter(key => Object.hasOwn(parsed, key)).map(key => [key, canonical(parsed[key])]));
  return { scripts, hasDependencies, settings };
}

const only = (list: Listing, pattern: RegExp): string[] => list.names.filter(name => pattern.test(name));

function npmKind(root: string, list: Listing): Kind | undefined {
  if (!list.files.has('package.json')) return undefined;
  const info = readPackage(root);
  const guards = ['package.json', ...only(list, NPM_GUARD_NAME), ...only(list, TEST_CONFIG_NAME)];
  if (!info) return { commands: [], guards };
  const manager = list.files.has('pnpm-lock.yaml') ? 'pnpm' : list.files.has('yarn.lock') ? 'yarn' : list.files.has('bun.lock') || list.files.has('bun.lockb') ? 'bun' : 'npm';
  const has = (name: string): boolean => Object.hasOwn(info.scripts, name);
  const names: string[] = [];
  const aggregate = AGGREGATE.find(has);
  if (aggregate) names.push(aggregate);
  else {
    const types = ['typecheck', 'type-check'].find(has);
    if (types) names.push(types);
    if (has('lint') && !WRITES_FILES.test(info.scripts.lint!)) names.push('lint');
    if (has('build')) names.push('build');
    if (has('test') && !PLACEHOLDER_TEST.test(info.scripts.test!)) names.push('test');
  }
  const commands = names.map(name => ({ command: `${manager} run ${name}`, source: `package.json scripts.${name}` }));
  const blocked = commands.length > 0 && info.hasDependencies && !list.names.includes('node_modules');
  return { commands, guards, ...(blocked ? { blocked: true as const } : {}) };
}

function goKind(list: Listing): Kind | undefined {
  if (!list.files.has('go.mod')) return undefined;
  return { commands: ['go build ./...', 'go vet ./...', 'go test ./...'].map(command => ({ command, source: 'go.mod' })), guards: only(list, TEST_CONFIG_NAME) };
}

function cargoKind(list: Listing): Kind | undefined {
  if (!list.files.has('Cargo.toml')) return undefined;
  return { commands: ['cargo build', 'cargo test'].map(command => ({ command, source: 'Cargo.toml' })), guards: only(list, TEST_CONFIG_NAME) };
}

function hasTarget(text: string, target: string): boolean {
  for (const line of text.split(/\r?\n/u)) {
    if (/^[\s#]/u.test(line) || line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0 || line[colon + 1] === '=') continue;
    const head = line.slice(0, colon);
    if (head.includes('=')) continue;
    if (head.split(/\s+/u).includes(target)) return true;
  }
  return false;
}

function makeKind(root: string, list: Listing, env: Record<string, string>, windows: boolean | undefined): Kind | undefined {
  const makefiles = only(list, MAKEFILE_NAME);
  const file = ['GNUmakefile', 'makefile', 'Makefile'].find(name => makefiles.includes(name) && list.files.has(name));
  if (!file) return undefined;
  const text = readRegular(root, file);
  if (text === undefined || !findExecutable('make', env, root, windows === undefined ? {} : { windows })) return { commands: [], guards: makefiles };
  const target = hasTarget(text, 'check') ? 'check' : hasTarget(text, 'test') ? 'test' : undefined;
  return { commands: target ? [{ command: `make ${target}`, source: `${file} target ${target}` }] : [], guards: makefiles };
}

function dotnetKind(list: Listing): Kind | undefined {
  const found = [...list.files].filter(name => /\.(sln|slnx|slnf|\w*proj)$/iu.test(name)).sort();
  const chosen = found.length === 1 && /\.(sln|csproj)$/iu.test(found[0]!) ? found[0]! : undefined;
  if (!chosen) return undefined;
  return { commands: ['dotnet build', 'dotnet test'].map(command => ({ command, source: chosen })), guards: [chosen, ...only(list, /^Directory\.Build\.props$/u)] };
}

function pythonConfigured(root: string, list: Listing): boolean {
  if (list.files.has('pytest.ini')) return true;
  const sections: Array<[string, RegExp]> = [['pyproject.toml', /^\s*\[tool\.pytest\b/mu], ['tox.ini', /^\s*\[pytest\]/mu], ['setup.cfg', /^\s*\[tool:pytest\]/mu]];
  return sections.some(([name, pattern]) => list.files.has(name) && pattern.test(readRegular(root, name) ?? ''));
}

function pythonOnPath(env: Record<string, string>, cwd: string, windows: boolean): 'found' | 'stub' | 'missing' {
  const lookup = (key: string): string | undefined => env[key] ?? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
  const exts = windows ? (lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase()) : [''];
  for (const raw of (lookup('PATH') ?? '').split(windows ? ';' : delimiter)) {
    const dir = raw === '' || raw === '.' ? cwd : raw;
    for (const ext of exts) {
      const file = join(dir, `python${ext}`);
      const store = WINDOWS_APPS.test(file);
      try {
        lstatSync(file);
        if (store) return 'stub';
        if (statSync(file).isFile()) return 'found';
      } catch (error) {
        if (store && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'stub';
      }
    }
  }
  return 'missing';
}

function pythonKind(root: string, list: Listing, env: Record<string, string>, windows: boolean | undefined): Kind | undefined {
  if (!pythonConfigured(root, list)) return undefined;
  const guards = PYTHON_FILES.filter(name => list.names.includes(name));
  const python = pythonOnPath(env, root, windows ?? process.platform === 'win32');
  if (python === 'missing') return { commands: [], guards, note: PYTHON_MISSING };
  if (python === 'stub') return { commands: [], guards, note: PYTHON_STUB };
  return { commands: [{ command: 'python -m pytest', source: 'pytest configuration' }], guards };
}

export function findChecks(root: string, options: FindOptions = {}): FoundChecks {
  const list = listing(root);
  const env = options.env ?? scrubEnv([]);
  const kinds = [npmKind(root, list), goKind(list), cargoKind(list), makeKind(root, list, env, options.windows), dotnetKind(list), pythonKind(root, list, env, options.windows)];
  let commands: CheckCommand[] = [];
  const guards = new Set<string>();
  let blocked = false;
  let note: string | undefined;
  for (const kind of kinds) {
    if (!kind) continue;
    if (kind.blocked) blocked = true;
    note ??= kind.note;
    const room = MAX_CHECK_COMMANDS - commands.length;
    const taken = kind.commands.slice(0, Math.max(0, room));
    commands.push(...taken);
    if (taken.length > 0 || kind.blocked) for (const name of kind.guards) guards.add(name);
  }
  if (blocked) commands = [];
  const sorted = [...guards].sort();
  if (blocked) return { commands, guards: sorted, blocked: BLOCKED_DEPENDENCIES };
  if (commands.length === 0) return { commands, guards: [], none: note ?? NONE_FOUND };
  return { commands, guards: sorted };
}
