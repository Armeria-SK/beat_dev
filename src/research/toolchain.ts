import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const TOOLCHAIN = ['node', 'npm', 'deno', 'bun', 'python', 'python3', 'go', 'cargo', 'rustc', 'java', 'dotnet', 'ruby', 'php'] as const;
export const VERSION_TIMEOUT_MS = 3000;
const VERSION_ARGS: ReadonlyMap<string, readonly string[]> = new Map([['go', ['version']]]);

export type ToolState = 'installed' | 'found' | 'alias' | 'missing' | 'failed';

export interface ToolCheck { name: string; state: ToolState; path: string | null; version: string | null }

export type VersionRunner = (file: string, args: readonly string[], options: { timeout: number; shell: false; windowsHide: true }) => Promise<string>;

export interface ToolchainOptions {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  run?: VersionRunner | undefined;
}

const runVersion: VersionRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(error); else resolve(`${stdout}\n${stderr}`);
  });
});

const present = (path: string): boolean => {
  try { return !lstatSync(path).isDirectory(); } catch { return false; }
};

export function findExecutable(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const pathVar = (windows ? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : env.PATH) ?? '';
  const exts = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of pathVar.split(windows ? ';' : ':')) {
    if (!dir.trim() || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      if (present(file)) return file;
    }
  }
  return null;
}

const isAlias = (file: string): boolean => file.split(/[\\/]/u).some(part => part.toLowerCase() === 'windowsapps');

export async function checkToolchain(names: readonly string[] = TOOLCHAIN, options: ToolchainOptions = {}): Promise<ToolCheck[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runVersion;
  return Promise.all(names.map(async (name): Promise<ToolCheck> => {
    const file = /^[A-Za-z0-9_-]+$/u.test(name) ? findExecutable(name, platform, env) : null;
    if (file === null) return { name, state: 'missing', path: null, version: null };
    if (platform === 'win32' && isAlias(file)) return { name, state: 'alias', path: file, version: null };
    if (platform === 'win32' && !/\.(?:exe|com)$/iu.test(file)) return { name, state: 'found', path: file, version: null };
    try {
      const out = await run(file, VERSION_ARGS.get(name) ?? ['--version'], { timeout: VERSION_TIMEOUT_MS, shell: false, windowsHide: true });
      const version = out.split(/\r?\n/u).map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? null;
      return { name, state: 'installed', path: file, version };
    } catch {
      return { name, state: 'failed', path: file, version: null };
    }
  }));
}
