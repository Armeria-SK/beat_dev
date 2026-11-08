import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface BrowserChoice { channel: 'auto' | 'msedge' | 'chrome' | 'path'; executablePath: string }
export interface LocateEnv { platform: NodeJS.Platform; env: Record<string, string | undefined>; exists: (file: string) => boolean }
export interface BrowserFound { channel: 'msedge' | 'chrome' | 'path'; path: string }

const defaultEnv = (): LocateEnv => ({ platform: process.platform, env: process.env, exists: existsSync });

// 既定のインストール場所（Playwright が channel で探す場所と同じ顔ぶれ）。doctor が「見つかるか」だけを見るのに使う。起動はしない
function candidates(channel: 'msedge' | 'chrome', { platform, env }: LocateEnv): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const tail = channel === 'msedge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    return roots.map(root => win32.join(root, ...tail));
  }
  if (platform === 'darwin') {
    return channel === 'msedge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return (channel === 'msedge'
    ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']).map(file => posix.normalize(file));
}

// 使うブラウザの実行ファイルが見つかるか。見つからなければ null
export function locateBrowser(choice: BrowserChoice, env: LocateEnv = defaultEnv()): BrowserFound | null {
  if (choice.channel === 'path') return choice.executablePath && env.exists(choice.executablePath) ? { channel: 'path', path: choice.executablePath } : null;
  const order: Array<'msedge' | 'chrome'> = choice.channel === 'auto' ? ['msedge', 'chrome'] : [choice.channel];
  for (const channel of order) {
    const path = candidates(channel, env).find(file => env.exists(file));
    if (path) return { channel, path };
  }
  return null;
}
