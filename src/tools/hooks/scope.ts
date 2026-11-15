import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { insideGitDir } from './git-repo.ts';
import { isRemotePath } from './remote-path.ts';

export { isRemotePath };

export type RootMode = 'read' | 'write';
export interface ResolvedRoot { path: string; mode: RootMode }

const WINDOWS = process.platform === 'win32';

const KNOWN_VARS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PWD'] as const;

const SECRET_PATTERNS = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/iu,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/iu,
  /(?:^|\/)\.(?:ssh|aws|gnupg|docker|kube)(?:\/|$)/iu,
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|git-credentials)$/iu,
];
// 名前が secrets・secret のフォルダ（中のファイルも）。名前だけを出すコマンドでは、これだけでは止めない
const SECRET_FOLDER = /(?:^|\/)secrets?(?:\/|$)/iu;
// 依存パッケージのフォルダの中。再帰して読む歩きで、ここで見つけた秘密らしい名前は、止めずに今回だけの確かめにする
const DEPENDENCY_FOLDER = /(?:^|\/)node_modules(?:\/|$)/iu;

const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export type Expanded = { path: string } | { unresolved: string };

export function expandPath(input: string, cwd: string, env: NodeJS.ProcessEnv = process.env, language: Language = DEFAULT_LANGUAGE): Expanded {
  let p = input.replace(/^["']|["']$/gu, '');
  // 展開や解決をする前に決める（* ? のワイルドカードの読み取りや resolve で、別の場所に化けないように）。調べる側 (placePath) が止める
  if (isRemotePath(p)) return { path: p.replaceAll('/', '\\') };
  if (/\$\(|`|<\(|>\(/u.test(p)) return { unresolved: guardText(language, 'scope.cmd_subst') };
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));
  else if (/^~[A-Za-z]/u.test(p)) return { unresolved: guardText(language, 'scope.other_home') };
  let unknown: string | undefined;
  const lookup = (name: string): string => {
    const upper = name.toUpperCase();
    const known = (KNOWN_VARS as readonly string[]).includes(upper);
    const value = known ? (upper === 'HOME' ? env.HOME ?? env.USERPROFILE ?? homedir() : upper === 'PWD' ? cwd : env[upper] ?? env[name]) : undefined;
    if (value === undefined) { unknown ??= name; return ''; }
    return value;
  };
  p = p
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/giu, (_, n: string) => lookup(n))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, n: string) => lookup(n))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, n: string) => lookup(n))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_, n: string) => lookup(n));
  if (unknown !== undefined) return { unresolved: guardText(language, 'scope.unknown_env', { name: unknown }) };
  if (isRemotePath(p)) return { path: p.replaceAll('/', '\\') };
  if (/[*?[\]{}]/u.test(p)) {
    const parts = p.split(/[\\/]/u);
    const first = parts.findIndex(part => /[*?[\]{}]/u.test(part));
    if (parts.slice(first).some(part => part === '..')) return { unresolved: guardText(language, 'scope.glob_dotdot') };
    p = parts.slice(0, first).join('/') || '.';
  }
  return { path: resolve(cwd, p) };
}

function danglingTarget(p: string): string | undefined {
  try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : undefined; } catch { return undefined; }
}

export interface RealPath { path: string; sure: boolean }

const unresolvedPath = (abs: string): string => (WINDOWS ? `\\\\?\\${abs}` : abs);

function resolveReal(abs: string, hops: { left: number }): RealPath {
  if (isRemotePath(abs)) return { path: abs, sure: true };
  let current = abs;
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try { return { path: join(realpathSync.native(current), ...rest.reverse()), sure: true }; } catch { return { path: abs, sure: true }; }
    }
    const link = danglingTarget(current);
    if (link !== undefined) {
      if (--hops.left < 0) return { path: unresolvedPath(abs), sure: false };
      if (isRemotePath(link)) return { path: join(link.replaceAll('/', '\\'), ...rest.reverse()), sure: false };
      const parent = resolveReal(dirname(current), hops);
      if (!parent.sure) return { path: unresolvedPath(abs), sure: false };
      return resolveReal(join(resolve(parent.path, link), ...rest.reverse()), hops);
    }
    const parent = dirname(current);
    if (parent === current) return { path: abs, sure: true };
    rest.push(basename(current));
    current = parent;
  }
}

export function realPath(abs: string): RealPath {
  return resolveReal(abs, { left: 40 });
}

export function realish(abs: string): string {
  return realPath(abs).path;
}

const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);

// 書き込み先に Windows が無視する末尾の . と空白を落とす（SOUL.md. は SOUL.md を指す）
export function windowsNames(p: string): string {
  return p.split(sep).map(seg => (seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/u, '') || seg)).join(sep);
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function windowsHazard(p: string, language: Language = DEFAULT_LANGUAGE): string | undefined {
  if (/^\\\\[?.]\\/u.test(p) || isRemotePath(p)) return guardText(language, 'scope.hazard_prefix');
  const withoutDrive = p.replace(/^[A-Za-z]:/u, '');
  if (withoutDrive.includes(':')) return guardText(language, 'scope.hazard_stream');
  if (p.split(/[\\/]/u).some(part => DEVICE_NAMES.test(part))) return guardText(language, 'scope.hazard_device');
  return undefined;
}

// どこまでを秘密のパスとみなすか。all: すべて（既定）。files: secrets・secret のフォルダは除く（名前だけを出すコマンド用）。none: 何も秘密にしない（依存パッケージの中で見つけた分を、別に扱うとき）
export type SecretScope = 'all' | 'files' | 'none';

export function isSecretPath(abs: string, scope: SecretScope = 'all'): boolean {
  if (scope === 'none') return false;
  const normalized = abs.replace(/\\/gu, '/');
  return (scope === 'all' && SECRET_FOLDER.test(normalized)) || SECRET_PATTERNS.some(re => re.test(normalized));
}

export function inDependencies(abs: string): boolean {
  return DEPENDENCY_FOLDER.test(abs.replace(/\\/gu, '/'));
}

export interface ScopePolicy {
  roots: ResolvedRoot[];
  deny: string[];
  // 書き込む前に承認を求める場所（人格・プロフィール・スキルのフォルダ）。.git の段があるパスは、ここに無くても同じに扱う
  askOnWrite?: string[];
  // askOnWrite のうち、スキルのフォルダ（理由の文を分けるため）
  skillsDir?: string;
  instructions?: string[];
  language?: Language;
  guarded?: { roots: string[]; keep?: string[] };
}

// 書き込む前に承認を求める場所の種類。persona: SOUL.md・USER.md、skill: workspace/skills/、git: .git の段があるパス（フックや設定でコマンドを動かせる）
export type ProtectedKind = 'persona' | 'skill' | 'git' | 'instructions';

const hasGitSegment = (p: string): boolean => p.split(/[\\/]/u).some(part => fold(part) === '.git');

export function writeApprovalKind(abs: string, policy: ScopePolicy): ProtectedKind | undefined {
  if (isRemotePath(abs)) return 'git';
  const real = realish(abs);
  if (hasGitSegment(abs) || hasGitSegment(real) || insideGitDir(abs) || (real !== abs && insideGitDir(real))) return 'git';
  if (policy.skillsDir && (isInside(policy.skillsDir, real) || isInside(policy.skillsDir, abs))) return 'skill';
  const bare = WINDOWS ? windowsNames(abs) : abs;
  if (policy.instructions?.some(p => isInside(p, real) || isInside(p, abs) || isInside(p, bare))) return 'instructions';
  return (policy.askOnWrite ?? []).some(p => isInside(p, real) || isInside(p, abs)) ? 'persona' : undefined;
}

export type Placement =
  | { kind: 'deny'; reason: string }
  | { kind: 'inside'; mode: RootMode; root: string }
  | { kind: 'outside' };

export function placePath(abs: string, policy: ScopePolicy, secrets: SecretScope = 'all'): Placement {
  const language = policy.language ?? DEFAULT_LANGUAGE;
  const hazard = windowsHazard(abs, language);
  if (hazard) return { kind: 'deny', reason: hazard };
  const real = realish(abs);
  if (isSecretPath(real, secrets) || isSecretPath(abs, secrets)) return { kind: 'deny', reason: guardText(language, 'scope.secret', { path: abs }) };
  for (const d of policy.deny) {
    if (isInside(d, real) || isInside(d, abs)) return { kind: 'deny', reason: guardText(language, 'scope.deny_list', { path: d }) };
  }
  const guardRoot = guardedRootOf(abs, policy, real);
  if (guardRoot) return { kind: 'deny', reason: guardText(language, 'scope.deny_list', { path: guardRoot }) };
  let best: ResolvedRoot | undefined;
  for (const root of policy.roots) {
    if (isInside(root.path, real) && (!best || root.path.length > best.path.length)) best = root;
  }
  return best ? { kind: 'inside', mode: best.mode, root: best.path } : { kind: 'outside' };
}

export function guardedRootOf(abs: string, policy: ScopePolicy, real = realish(abs)): string | undefined {
  const guard = policy.guarded;
  if (!guard) return undefined;
  return [real, abs].map(p => guard.roots.find(root => isInside(root, p) && !(guard.keep ?? []).some(keep => isInside(keep, p)))).find(Boolean);
}

export function resolveConfigPath(p: string, base: string): string {
  const expanded = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
  return realish(resolve(base, expanded));
}
