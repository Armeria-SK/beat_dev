import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findGitDir, parseGitConfig } from '../tools/hooks/git-repo.ts';
import { isRemotePath } from '../tools/hooks/scope.ts';

export interface Remote { name: string; url: string; pushUrl: string | null }

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_REMOTES = 50;
const MAX_TEXT = 2000;

const withoutPassword = (url: string): string => url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@:]*):[^/@]*@/u, '$1@');

export function readRemotes(root: string): Remote[] {
  try {
    const dotGit = join(root, '.git');
    const own = lstatSync(dotGit, { throwIfNoEntry: false });
    if (!own || own.isSymbolicLink()) return [];
    if (own.isFile() && (own.size > 4096 || isRemotePath(readFileSync(dotGit, 'utf8').replace(/^gitdir: /u, '').trim()))) return [];
    const found = findGitDir(root);
    if (!found || found.broken || (own.isDirectory() && found.gitDir !== dotGit)) return [];
    const file = join(found.commonDir, 'config');
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > MAX_CONFIG_BYTES) return [];
    const entries = parseGitConfig(readFileSync(file, 'utf8'));
    if (!entries) return [];
    const remotes = new Map<string, Remote>();
    for (const { key, value } of entries) {
      const parts = key.split('.');
      const field = parts.at(-1);
      if (parts[0] !== 'remote' || parts.length < 3 || (field !== 'url' && field !== 'pushurl')) continue;
      const name = parts.slice(1, -1).join('.').slice(0, MAX_TEXT);
      const remote = remotes.get(name) ?? { name, url: '', pushUrl: null };
      const url = withoutPassword(value).slice(0, MAX_TEXT);
      if (field === 'url' && !remote.url) remote.url = url;
      if (field === 'pushurl' && remote.pushUrl === null) remote.pushUrl = url;
      remotes.set(name, remote);
    }
    return [...remotes.values()].filter(r => r.url).slice(0, MAX_REMOTES);
  } catch { return []; }
}
