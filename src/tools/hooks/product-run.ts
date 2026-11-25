import { lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { GIT_IDENTITY } from './allowlist-git.ts';
import { DEV_RUNNERS, GIT_IDENTITY_KEY, nodeFileIndex, PRODUCT_CODE_KEYS, SERVICE_PROGRAMS } from './decision-order.ts';
import { sanitizeModelInputText } from '../../shared/redaction.ts';
import { definesCommand } from './outbound.ts';
import { isInside, isSecretPath, realish } from './scope.ts';
import type { FactWord, StatementFacts } from './shell-facts.ts';
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
const SOURCE_NAME = /(?:^|\/)[^/:]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|vue|svelte|css|md)$/iu;
// 名前がその言葉だけ（secrets.md・docs/credentials.md・secret.py）のファイルは、拡張子にかかわらず止める。長い名前の一部（credentials-helper.ts）だけが外れる
const EXACT_WORD = /(?:^|\/)(?:secrets?|credentials?)\.[^/]+$/iu;
const commitSecret = (name: string): boolean => COMMIT_SECRET.test(name) && (EXACT_WORD.test(name) || !SOURCE_NAME.test(name));
const MESSAGE_FLAGS = new Set(['-m', '--message']);

const inside = (root: string, path: string): boolean => isInside(root, path) && isInside(realish(root), realish(path));

function programPath(st: StatementFacts, which: ProductRunInput['which']): string | undefined {
  const word = st.words[0]?.text;
  if (!word || st.cwd === null) return undefined;
  if (/[\\/]/u.test(word) || isAbsolute(word)) return resolve(st.cwd, word);
  return which(word, st.cwd);
}

const productEnvOnly = (st: StatementFacts): boolean => st.words.length === 0 && st.env.every(name => /^env:/iu.test(name))
  && !st.reasonKeys.some(key => key === 'list.env' || key === 'code.env');

function plainStatement(st: StatementFacts, root: string): boolean {
  return st.inner === undefined && !st.programDynamic && !st.programOdd && st.code.length === 0 && !st.codeDynamic && (st.env.length === 0 || productEnvOnly(st))
    && !definesCommand(st) && !SERVICE_PROGRAMS.has(st.program) && st.cwd !== null && inside(root, st.cwd);
}

const RUNNER_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: ['package.json'],
  make: ['Makefile', 'makefile', 'GNUmakefile'], gmake: ['Makefile', 'makefile', 'GNUmakefile'], nmake: ['Makefile', 'makefile'],
  just: ['justfile', 'Justfile', '.justfile'], rake: ['Rakefile', 'rakefile', 'Rakefile.rb'], ninja: ['build.ninja'],
  nox: ['noxfile.py'],
  jest: ['package.json', 'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'],
  vitest: ['package.json', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js'],
  mocha: ['package.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.jsonc'],
};
const RUNNER_SECTIONS: Readonly<Record<string, Readonly<Record<string, RegExp | null>>>> = {
  pytest: { 'pytest.ini': null, '.pytest.ini': null, 'pyproject.toml': /^[ \t]*\[tool\.pytest(?:\.ini_options)?\][ \t\r]*$/mu, 'tox.ini': /^[ \t]*\[pytest\][ \t\r]*$/mu, 'setup.cfg': /^[ \t]*\[tool:pytest\][ \t\r]*$/mu },
  tox: { 'tox.ini': null, 'pyproject.toml': /^[ \t]*\[tool\.tox\][ \t\r]*$/mu, 'setup.cfg': /^[ \t]*\[tox:tox\][ \t\r]*$/mu },
};
const SECTION_READ_LIMIT = 1024 * 1024;

function configHas(file: string, section: RegExp | null): boolean {
  const st = statSync(file, { throwIfNoEntry: false });
  if (st?.isFile() !== true) return false;
  if (section === null) return true;
  if (st.size > SECTION_READ_LIMIT) return false;
  try { return section.test(readFileSync(file, 'utf8')); } catch { return false; }
}
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
  reporter: /^(?:spec|dot|nyan|tap|landing|list|progress|json|json-stream|min|doc|markdown|xunit|base)$/u,
};
const RUNNER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  vitest: new Set(['init']), mocha: new Set(['init']), tox: new Set(['devenv', 'd', 'quickstart', 'q', 'exec', 'e']),
};

const programName = (st: StatementFacts): string => st.program.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
const pathLike = (text: string): boolean => /[\\/]/u.test(text) || text.startsWith('.') || text.startsWith('~') || /^[A-Za-z]:/u.test(text) || isAbsolute(text);

const looseInside = (text: string, cwd: string, root: string): boolean => !text.startsWith('~') && !/^[A-Za-z]:(?![\\/])/u.test(text) && inside(root, resolve(cwd, text.replace(/\\/gu, '/')));

function plainPathInside(text: string, cwd: string, root: string): boolean {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./\\:+@-]*$/u.test(text) || /^[A-Za-z]:/u.test(text) || isAbsolute(text)) return false;
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
  const sections = RUNNER_SECTIONS[name];
  if (sections && !Object.entries(sections).some(([file, section]) => configHas(resolve(st.cwd!, file), section))) return false;
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

function gitTarget(st: StatementFacts, root: string): { dir: string; subAt: number } | undefined {
  const subAt = st.gitGlobal.length + 1;
  let dir: string | undefined;
  const identity = new Set<string>();
  for (let i = 1; i < subAt; i += 2) {
    const flag = st.words[i]!;
    const value = st.words[i + 1];
    if (flag.dynamic || flag.glob || !value || i + 1 >= subAt || value.dynamic || value.glob || value.text.includes(',')) return undefined;
    if (flag.text === '-C') {
      if (dir !== undefined || /^(?:~|[\\/]{2})/u.test(value.text) || /^[A-Za-z]:(?![\\/])/u.test(value.text)) return undefined;
      dir = resolve(st.cwd!, value.text);
      if (!inside(root, dir) || statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined;
    } else if (flag.text === '-c') {
      const key = GIT_IDENTITY.exec(value.text)?.[1]!.toLowerCase();
      if (!key || identity.has(key)) return undefined;
      identity.add(key);
    } else return undefined;
  }
  if (identity.size > 0 && st.words[subAt]?.text !== 'commit') return undefined;
  return { dir: dir ?? st.cwd!, subAt };
}

function namesFilesOnly(args: readonly FactWord[], dir: string): boolean {
  const named = args.filter(w => !w.text.startsWith('-'));
  if (named.length === 0 || args.some(w => w.dynamic || w.glob)) return false;
  return named.every(w => statSync(resolve(dir, w.text), { throwIfNoEntry: false })?.isFile() === true);
}

function secretToAdd(args: readonly FactWord[], dir: string, git: ProductRunInput['git']): string | undefined | null {
  const top = git(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const end = args.findIndex(w => w.text === '--');
  const force = args.slice(0, end < 0 ? undefined : end).some(w => w.text === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/u.test(w.text));
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(force ? ['--ignored'] : [])]);
  if (status === undefined) return null;
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = resolve(top, entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (isSecretPath(path) || commitSecret(entry.slice(3))) return entry.slice(3);
  }
  return undefined;
}

const REPO_PARTS = ['objects', 'refs', 'index', 'HEAD'];

const LINK_WALK_CAP = 20_000;
const LINK_WALK_DEEP = new Set(['refs', 'logs']);

// リンク（symlink）に加えて、ふつうのファイルのハードリンクも見る。git は reflog（logs/…）と COMMIT_EDITMSG をその場に書くので、
// 外のファイルとハードリンクでつながっていれば、判定役を通らない commit が外のファイルを書き換える。見るのは .git の直下と refs・logs の下で、
// objects の下は見ない（git clone --local は、オブジェクトを正しくハードリンクする）。
// 'link': symlink がある・数の上限を超えた・読めない（今までの「リンク有り」）。'hard': symlink は無いが、ハードリンクがある。
// 見回りの途中でファイル・サブフォルダが消えた（ENOENT。index.lock などはすぐ消える）ときは、「もう無い」として飛ばす。黙って「リンク有り」にすると、鍵の確かめに届かず判定役へ落ちる。ENOENT 以外の失敗は、今までどおり「リンク有り」。
// 名前が UTF-8 として読めないファイル・フォルダ（Linux の git は ref の名前を生のバイトで扱う）は、readdir が U+FFFD に化けた名前を返し、その名前で lstat・readdir すると ENOENT になる。
// 上の「消えた」と区別できず、実在するハードリンクを飛ばしてしまうので、U+FFFD を含む名前はどの階層でも「リンク有り」にする
type GitDirLinks = 'none' | 'hard' | 'link';

function gitDirLinks(gitDir: string, cap: number): GitDirLinks {
  let seen = 0;
  let hard = false;
  const list = (dir: string): Dirent[] => {
    try { return readdirSync(dir, { withFileTypes: true }); } catch (error) {
      if (dir !== gitDir && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const clean = (dir: string, depth: number, files: boolean): boolean => {
    for (const entry of list(dir)) {
      if (++seen > cap || entry.isSymbolicLink() || entry.name.includes('�')) return false;
      if (!entry.isDirectory()) {
        if (files && entry.isFile() && (lstatSync(join(dir, entry.name), { throwIfNoEntry: false })?.nlink ?? 0) > 1) hard = true;
        continue;
      }
      const name = entry.name.toLowerCase();
      const below = depth > 0 ? depth - 1 : LINK_WALK_DEEP.has(name) ? Infinity : name === 'objects' ? 1 : 0;
      if (below > 0 && !clean(join(dir, entry.name), below, depth > 0 ? files : name !== 'objects')) return false;
    }
    return true;
  };
  try {
    return lstatSync(gitDir).isSymbolicLink() || !clean(gitDir, 0, true) ? 'link' : hard ? 'hard' : 'none';
  } catch {
    return 'link';
  }
}

export function gitDirLinkFree(gitDir: string, cap = LINK_WALK_CAP): boolean {
  return gitDirLinks(gitDir, cap) === 'none';
}

// 'outside': 製品の外にある・リンクがある・読めない。'hard': 製品の中にあるが、ハードリンクがある。'none': 製品の中で、リンクが無い
export type RepoLinks = 'outside' | 'hard' | 'none';

export function repoLinks(dir: string, root: string, git: ProductRunInput['git']): RepoLinks {
  const places = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', ...REPO_PARTS.flatMap(part => ['--git-path', part])])?.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (places?.length !== 3 + REPO_PARTS.length || !places.every(place => inside(root, resolve(dir, place)))) return 'outside';
  const links = [...new Set([places[1]!, places[2]!].map(place => resolve(dir, place)))].map(place => gitDirLinks(place, LINK_WALK_CAP));
  return links.includes('link') ? 'outside' : links.includes('hard') ? 'hard' : 'none';
}

// 判定役を飛ばす許可（順 4 の product-git・承認の決まりの git の形）に使う。ハードリンクがあれば偽
export function repoInside(dir: string, root: string, git: ProductRunInput['git']): boolean {
  return repoLinks(dir, root, git) === 'none';
}

export function productRunOf(input: ProductRunInput): ProductRunResult {
  const { root, verdict, which, git } = input;
  if (verdict.decision !== 'ask' || !verdict.statements.length) return undefined;
  if (!verdict.askKinds.every(kind => RUN_KINDS.has(kind))) return undefined;
  const keys = new Set([...verdict.reasonKeys, ...verdict.statements.flatMap(st => st.reasonKeys)]);
  for (const key of keys) if (!PRODUCT_CODE_KEYS.has(key) && key !== 'list.external' && key !== 'list.command' && key !== 'list.git_commit' && key !== GIT_IDENTITY_KEY) return undefined;
  if (verdict.paths.some(p => !p.path || !inside(root, p.path))) return undefined;
  if ([...verdict.writes, ...verdict.scripts].some(p => !inside(root, p))) return undefined;
  let commits = false;
  let others = false;
  // ハードリンクのある置き場は、判定役を飛ばす許可だけを止める。持ち主へ回す確かめ（鍵のメッセージ・鍵のファイルの add）は、全部の文についてそのまま働かせる
  let hardLinked = false;
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
      const file = st.words[1 + nodeFileIndex(st.program, st.words.slice(1))]?.text;
      if (!file || !inside(root, resolve(st.cwd!, file))) return undefined;
    }
    if (own.has('list.node_test')) {
      const [flag, ...files] = st.words.slice(1);
      if (!flag || flag.dynamic || flag.text !== '--test' || files.some(w => w.dynamic || w.glob || !plainPathInside(w.text, st.cwd!, root))) return undefined;
    }
    if (st.program !== 'git') {
      if (!runnerStaysInside(st, root)) return undefined;
      others = true;
      continue;
    }
    if (others) return undefined;
    if (rerouted || ![...own].every(key => key === 'list.git_commit' || key === GIT_IDENTITY_KEY)) return undefined;
    const target = gitTarget(st, root);
    if (!target) return undefined;
    const { dir } = target;
    const subWord = st.words[target.subAt];
    const sub = subWord?.dynamic ? undefined : subWord?.text;
    const args = st.words.slice(target.subAt + 1);
    if (sub !== 'add' && sub !== 'commit') return undefined;
    if (st.words.slice(1).some((w, i, all) => w.text.includes(',') && !(i > 0 && MESSAGE_FLAGS.has(all[i - 1]!.text) && !w.text.includes(',-')))) return undefined;
    const links = repoLinks(dir, root, git);
    if (links === 'outside') return undefined;
    if (links === 'hard') hardLinked = true;
    if (sub === 'commit' && st.words.slice(1).some(w => !w.dynamic && (sanitizeModelInputText(w.text).redaction_count > 0 || AWS_KEY.test(w.text)))) return { secretMessage: true };
    if (input.ownerHooks?.() !== false) return undefined;
    if (sub === 'add' && namesFilesOnly(args, dir)) {
      const named = args.filter(w => !w.text.startsWith('-')).map(w => w.text).find(name => isSecretPath(resolve(dir, name)) || commitSecret(name.replace(/\\/gu, '/')));
      if (named !== undefined) return { secret: named };
    }
    if (sub === 'add' && !namesFilesOnly(args, dir)) {
      const secret = secretToAdd(args, dir, git);
      if (secret === null) return undefined;
      if (secret !== undefined) return { secret };
    }
    commits = true;
  }
  if (hardLinked) return undefined;
  return { run: commits ? 'product-git' : 'product-code' };
}
