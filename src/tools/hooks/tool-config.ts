// ツールの設定ファイル（security-self-api.md の審査 4）。git・curl・wget・npm・シェルの起動ファイル・PowerShell のプロファイルなどは、
// あとで動く許可済みのコマンド（git status・curl・シェルの起動）に、設定でコードを読み込ませられる。そこへの書き込み・消すこと・名前の変更は、
// 許可フォルダの中でも外でも、シェルからは今回だけにする。ここは、その場所の一覧と、調べる関数

import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { isInside, isRemotePath } from './scope.ts';

export type Env = Readonly<Record<string, string | undefined>>;

// ホームの下（ファイルは名前そのもの、フォルダは中すべて）
const HOME_PATHS = [
  '.gitconfig', '.gitattributes', '.config/git', '.curlrc', '_curlrc', 'Application Data/.curlrc', 'Application Data/_curlrc', '.config/curlrc', '.wgetrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.config/yarn', '.config/pnpm', '.config/pip', '.pip', '.pypirc',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.kshrc', '.zlogout', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.inputrc', '.config/fish', '.config/powershell', '.jq', '.ripgreprc', '.cargo/config', '.cargo/config.toml',
  '.docker', '.ssh', '.gnupg', '.aws', '.kube',
  '.local/lib', 'Library/Python', 'AppData/Roaming/Python', '.config/go/env', 'Library/Application Support/go/env', 'AppData/Roaming/go/env',
  'Documents/WindowsPowerShell', 'Documents/PowerShell', 'OneDrive/Documents/WindowsPowerShell', 'OneDrive/Documents/PowerShell',
];
const APPDATA_PATHS = ['_curlrc', '.curlrc', 'pip', 'npm/etc', 'git', 'Microsoft/Windows/PowerShell', 'Python', 'go/env'];
const XDG_PATHS = ['git', 'curlrc', 'powershell', 'pip', 'yarn', 'pnpm', 'fish', 'go/env'];
const POSIX_SYSTEM = ['/etc/gitconfig', '/etc/gitattributes', '/etc/wgetrc', '/etc/npmrc', '/etc/profile', '/etc/profile.d', '/etc/bash.bashrc', '/etc/environment', '/etc/zsh', '/etc/pip.conf', '/usr/local/etc/gitconfig', '/usr/local/etc/wgetrc'];

function windowsSystem(env: Env): string[] {
  const programFiles = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter((x): x is string => Boolean(x)))];
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return [
    ...programFiles.flatMap(p => [join(p, 'Git', 'etc'), join(p, 'Git', 'mingw64', 'etc'), join(p, 'Git', 'mingw32', 'etc'), join(p, 'PowerShell'), join(p, 'WindowsPowerShell')]),
    join(programData, 'Git'), join(systemRoot, 'System32', 'WindowsPowerShell'), join(systemRoot, 'SysWOW64', 'WindowsPowerShell'),
  ];
}

// 場所の一覧（絶対パス。ファイルもフォルダも）
export function toolConfigPaths(env: Env = process.env): string[] {
  const homes = [...new Set([homedir(), env.HOME, env.USERPROFILE].filter((x): x is string => Boolean(x)))];
  const out: string[] = [];
  for (const home of homes) for (const rel of HOME_PATHS) out.push(join(home, ...rel.split('/')));
  if (env.APPDATA) for (const rel of APPDATA_PATHS) out.push(join(env.APPDATA, ...rel.split('/')));
  if (env.XDG_CONFIG_HOME) for (const rel of XDG_PATHS) out.push(join(env.XDG_CONFIG_HOME, ...rel.split('/')));
  if (env.CURL_HOME) out.push(join(env.CURL_HOME, '.curlrc'), join(env.CURL_HOME, '_curlrc'));
  if (env.WGETRC) out.push(env.WGETRC);
  if (env.PYTHONUSERBASE) out.push(env.PYTHONUSERBASE);
  if (env.GOENV && env.GOENV !== 'off') out.push(env.GOENV);
  out.push(...POSIX_SYSTEM, ...windowsSystem(env));
  return out;
}

// どこにあっても、この名前のファイルは PowerShell のプロファイル（読み込まれるたびに動く）
const PROFILE_NAME = /^(?:microsoft\.powershell_profile|microsoft\.vscode_profile|microsoft\.powershellise_profile)\.ps1$/iu;

// どのフォルダにあっても、この名前のファイルは curl・wget の設定（作業フォルダのものも、cd のあとの curl・wget が読む場所になりうる）
const RC_NAME = /^(?:\.curlrc|_curlrc|\.wgetrc)$/iu;

// どこにあっても、この名前のファイルは python の起動のたびに動く（venv の site-packages など）。.pth は PyTorch の重みと名前が同じなので、user-site の下だけ
const PY_STARTUP_NAME = /^(?:sitecustomize|usercustomize)\.py$/iu;

// ホームの直下に置く名前（.npmrc・.gitattributes・.bashrc・.ssh など）。作業フォルダの中にある同じ名前も、そのツールの設定として読まれうる（プロジェクトの .npmrc など）。
// 「フォルダごと許可」のような広い許可が覆わない場所を見分けるのに使う（パスのどこかの名前が当たれば、設定の場所とみなす。当たりすぎる側は、許可が及ばず確かめに戻るだけ）
const CONFIG_NAMES: ReadonlySet<string> = new Set(HOME_PATHS.filter(p => !p.includes('/')).map(p => p.toLowerCase()));
export function hasToolConfigName(abs: string, env: Env = process.env): boolean {
  return abs.split(/[\\/]/u).some(segment => CONFIG_NAMES.has(segment.toLowerCase())) || isToolConfigPath(abs, env);
}

export function isToolConfigPath(abs: string, env: Env = process.env): boolean {
  const name = abs.split(/[\\/]/u).pop() ?? '';
  if (PROFILE_NAME.test(name) || RC_NAME.test(name) || PY_STARTUP_NAME.test(name)) return true;
  return toolConfigPaths(env).some(p => isInside(p, abs));
}

// フォルダの下に、ツールの設定ファイルがある（そのフォルダごと書く・消すと、設定まで届く）
export function containsToolConfig(dir: string, env: Env = process.env): boolean {
  return toolConfigPaths(env).some(p => isInside(dir, p));
}

// ── 読む側: curl・wget が起動のたびに読む設定ファイル ──
// 書き込みの見張りは上。ここは、許可された curl・wget が、保存先（output・output_document）や送り先を変える設定を読み込むのを防ぐために、読まれる設定ファイルがあるかを調べる。
// 場所は、本物の curl 8.19（Windows の System32 と Git for Windows）と GNU Wget 1.21.2 で確かめた。-q（curl は最初の引数）・--no-config（wget）を付けると読まれない。
// 作業フォルダの .curlrc は curl 8.19 では読まれないが、古い curl が読むかは確かめられないので、あれば同じに扱う。
// wget のシステムの設定（/etc/wgetrc）は、管理者が置いたもの（書き換えは上の見張りで今回だけ）で、Debian では既定でも有効な行があるので、調べない

const MAX_RC_BYTES = 1_048_576;
const MAX_RC_LINK_HOPS = 40;

// 空の行・# のコメントだけなら、読まれても何も変わらない
function withoutLinks(file: string): string | undefined {
  const abs = resolve(file);
  let current = parse(abs).root;
  const rest = abs.slice(current.length).split(/[\\/]/u).filter(Boolean);
  let hops = 0;
  while (rest.length > 0) {
    const next = join(current, rest.shift()!);
    if (!lstatSync(next).isSymbolicLink()) { current = next; continue; }
    if (++hops > MAX_RC_LINK_HOPS) return undefined;
    const stored = readlinkSync(next);
    const target = resolve(current, stored);
    if (isRemotePath(stored) || isRemotePath(target)) return undefined;
    current = parse(target).root;
    rest.unshift(...target.slice(current.length).split(/[\\/]/u).filter(Boolean));
  }
  return current;
}

function hasSettings(file: string): boolean {
  if (isRemotePath(file)) return true;
  try {
    const target = withoutLinks(file);
    if (target === undefined) return true;
    const st = statSync(target);
    if (!st.isFile()) return false;
    if (st.size > MAX_RC_BYTES) return true;
    return readFileSync(target, 'utf8').split(/\r?\n/u).some(line => !/^\s*(?:#.*)?$/u.test(line));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR';
  }
}

function homesOf(env: Env): string[] {
  const homes = [...new Set([env.HOME, env.USERPROFILE].filter((x): x is string => Boolean(x)))];
  return homes.length > 0 ? homes : [homedir()];
}

// curl が設定として読むファイルのうち、設定が書かれているもの（最初の 1 つ）。cwd は分かるときだけ
export function curlConfigFile(env: Env, cwd?: string): string | undefined {
  const homes = homesOf(env);
  const dirs = [env.CURL_HOME, ...homes, env.APPDATA, ...homes.map(h => join(h, 'Application Data')), cwd].filter((x): x is string => Boolean(x));
  const files = [
    ...dirs.flatMap(d => [join(d, '.curlrc'), join(d, '_curlrc')]),
    ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, 'curlrc')] : []),
    ...homes.map(h => join(h, '.config', 'curlrc')),
  ];
  return files.find(hasSettings);
}

export function npmProjectConfigFile(cwd: string, env: Env, allowed: readonly string[] = []): string | undefined {
  const key = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const own = new Set([key(join(env.HOME || homedir(), '.npmrc')), key(join(homedir(), '.npmrc'))]);
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, '.npmrc');
    if ((!own.has(key(file)) || allowed.some(root => isInside(root, file))) && hasSettings(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

// npm -v・--version が読む .npmrc が、無害と分かっている項目の名前だけでできているか。見るのは項目の名前だけで、値は読まない（トークンなどが入る）。
// Windows の npm.cmd などは、起動の前に .npmrc の prefix（userconfig・globalconfig で指した先の prefix も）が選んだ場所の npm-cli.js を動かす。
// だから表にない名前（prefix・userconfig・globalconfig・cafile・知らない名前）、名前が素直な形でない行、読めない・大きすぎるファイル、リンクの先を決められない場合は、すべて無害でない側に倒す
// npm の ini は行を [\r\n]+ で分けるので、同じ分け方で読む。どの .npmrc が読まれるかは決めきれないので、見つかった .npmrc から上のフォルダまですべて見る
const NPM_HARMLESS_KEY = /^(?:registry|always-auth|save-exact|save-prefix|engine-strict|fund|audit|progress|loglevel|strict-ssl|@[A-Za-z0-9._~-]+:registry|\/\/[A-Za-z0-9._~-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._~%@+-]+)*\/:(?:_authToken|_auth|username|_password|email))$/u;

function npmRcFileHarmless(file: string): boolean {
  if (isRemotePath(file)) return false;
  try {
    const target = withoutLinks(file);
    if (target === undefined) return false;
    const st = statSync(target);
    if (!st.isFile() || st.size > MAX_RC_BYTES) return false;
    return readFileSync(target, 'utf8').split(/[\r\n]+/u).every(line => {
      if (/^\s*(?:[;#]|$)/u.test(line)) return true;
      return NPM_HARMLESS_KEY.test((line.includes('=') ? line.slice(0, line.indexOf('=')) : line).trim());
    });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR';
  }
}

export function npmRcHarmless(files: readonly string[]): boolean {
  const checked = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const rc = join(dir, '.npmrc');
      if (!checked.has(rc)) {
        checked.add(rc);
        if (!npmRcFileHarmless(rc)) return false;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return true;
}

// wget が設定として読むファイルのうち、設定が書かれているもの（最初の 1 つ）
export function wgetConfigFile(env: Env): string | undefined {
  const files = [...(env.WGETRC ? [env.WGETRC] : []), ...homesOf(env).map(h => join(h, '.wgetrc'))];
  return files.find(hasSettings);
}
