import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isEdgeExecutable } from '../../shared/browser-path.ts';

export interface BrowserChoice { channel: 'auto' | 'chrome' | 'path'; executablePath: string }
export interface LocateEnv { platform: NodeJS.Platform; env: Record<string, string | undefined>; exists: (file: string) => boolean }
export interface BrowserFound { channel: 'chrome' | 'path'; path: string }

const defaultEnv = (): LocateEnv => ({ platform: process.platform, env: process.env, exists: existsSync });

// Chrome の既定のインストール場所（Playwright が channel: 'chrome' で探す場所と同じ顔ぶれ）。doctor が「見つかるか」だけを見るのに使う。起動はしない。
// Edge の場所は一切見ない（持ち主の決定: Edge でブラウザ操作はさせない）
function chromeCandidates({ platform, env }: LocateEnv): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].map(file => posix.normalize(file));
}

// 使うブラウザの実行ファイルが見つかるか。見つからなければ null。path が Edge の実行ファイルなら、あっても見つかったことにしない
export function locateBrowser(choice: BrowserChoice, env: LocateEnv = defaultEnv()): BrowserFound | null {
  if (choice.channel === 'path') {
    return choice.executablePath && !isEdgeExecutable(choice.executablePath) && env.exists(choice.executablePath) ? { channel: 'path', path: choice.executablePath } : null;
  }
  const path = chromeCandidates(env).find(file => env.exists(file));
  return path ? { channel: 'chrome', path } : null;
}
