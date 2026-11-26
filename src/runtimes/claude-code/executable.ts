// 使う人が自分で入れた Claude Code の本体（claude.exe）の場所を見つける。beat は本体を同梱せず・入れず・書き換えない。
// PATH の claude は Windows では .cmd の入れ物（シェルなしでは起こせない）なので、npm で入れたものはその隣の実体を指す
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { absolutePathEntries, findExecutable } from '../../tools/shell/runner.ts';

const WINDOWS = process.platform === 'win32';
const LAUNCHERS = new Set(['.cmd', '.bat', '.ps1']);

export type Found = { path: string } | { reason: string };

// PATH は絶対パスの項目だけで探す。空の項目と . は、探す側の作業フォルダ（ここでは一時フォルダ）を指してしまうので使わない。PATH が無い・絶対の項目が 1 つも無いなら探さない
function absolutePathEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const strings = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const cleaned = Object.fromEntries(Object.entries(strings).flatMap(([name, value]): Array<[string, string]> => {
    if (name.toUpperCase() !== 'PATH') return [[name, value]];
    const dirs = absolutePathEntries(value);
    return dirs === '' ? [] : [[name, dirs]];
  }));
  return Object.keys(cleaned).some(name => name.toUpperCase() === 'PATH') ? cleaned : undefined;
}

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

// npm の入れ物（claude.cmd）の隣にある実体
function besideLauncher(launcher: string): string | undefined {
  const candidate = join(dirname(launcher), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return isFile(candidate) ? candidate : undefined;
}

export function findClaudeExecutable(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Found {
  let path = configured?.trim() === '' ? undefined : configured?.trim();
  if (path !== undefined && !isAbsolute(path)) return { reason: 'The Claude Code path in the runtime settings must be an absolute path' };
  if (path === undefined) {
    const searchEnv = absolutePathEnv(env);
    path = searchEnv ? findExecutable('claude', searchEnv, tmpdir()) : undefined;
    if (path === undefined && WINDOWS) {
      const native = join(homedir(), '.local', 'bin', 'claude.exe');
      if (isFile(native)) path = native;
    }
    if (path === undefined) return { reason: 'Claude Code was not found on PATH. Install Claude Code, or set its full path in the runtime settings' };
  }
  if (WINDOWS && LAUNCHERS.has(extname(path).toLowerCase())) {
    const real = besideLauncher(path);
    if (real === undefined) return { reason: 'Found a Claude Code launcher, but not the claude.exe beside it. Set the path of claude.exe in the runtime settings' };
    path = real;
  }
  return isFile(path) ? { path } : { reason: 'The Claude Code program was not found at the given path' };
}
