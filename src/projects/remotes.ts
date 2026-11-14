import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findGitDir, parseGitConfig } from '../tools/hooks/git-repo.ts';
import { isRemotePath } from '../tools/hooks/scope.ts';

export interface Remote { name: string; url: string; pushUrl: string | null }

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_REMOTES = 50;
const MAX_TEXT = 2000;

export const withoutSecrets = (url: string): string => {
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(.*)$/su.exec(url);
  if (parts) {
    const rest = parts[2]!;
    const authority = /^[^/?#]*/u.exec(rest)![0];
    const from = /[@:]/u.test(authority) ? rest.lastIndexOf('@') + 1 : 0;
    return `${parts[1]}${/^[^?#]*/u.exec(rest.slice(from))![0]}`;
  }
  if (/^[A-Za-z]:[\\/]/u.test(url)) return url;
  const scp = /^[^@/\s:]*:.*@([^@]*)$/su.exec(url);
  return scp ? scp[1]! : url;
};

const SSH_SCHEMES: ReadonlySet<string> = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'ssh:': '22', 'git+ssh:': '22', 'ssh+git:': '22', 'https:': '443', 'http:': '80', 'git:': '9418' };

export function remoteKey(url: string): string {
  const raw = url.trim();
  const local = (p: string): string => {
    const clean = p.replaceAll('\\', '/').replace(/\/+$/u, '');
    return `local:${process.platform === 'win32' ? clean.toLowerCase() : clean}`;
  };
  if (/^[A-Za-z]:(?:[\\/]|$)/u.test(raw)) return local(raw);
  const scp = /^(?:[^@/:\s]+@)?([^:/\s]+):(?!\/\/)(.*)$/u.exec(raw);
  let scheme: string;
  let host: string;
  let path: string;
  if (scp) {
    scheme = 'ssh';
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return local(raw); }
    if (parsed.protocol === 'file:' || !parsed.hostname) return local(decodeURIComponent(parsed.pathname));
    scheme = SSH_SCHEMES.has(parsed.protocol) ? 'ssh' : parsed.protocol.slice(0, -1);
    const port = parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';
    host = `${parsed.hostname.toLowerCase().replace(/\.+$/u, '')}${port}`;
    path = parsed.pathname;
  }
  const clean = path.split('/').filter(Boolean).join('/').replace(/\.git$/u, '');
  return `${scheme}://${host}/${clean}`;
}

export function parseRemotes(raw: string | undefined): Remote[] {
  try {
    const list = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap(r => (r && typeof r.name === 'string' && typeof r.url === 'string' ? [{ name: r.name, url: r.url, pushUrl: typeof r.pushUrl === 'string' ? r.pushUrl : null }] : []));
  } catch { return []; }
}

export function readRemotes(root: string): Remote[] {
  try {
    const dotGit = join(root, '.git');
    const own = lstatSync(dotGit, { throwIfNoEntry: false });
    if (!own || own.isSymbolicLink()) return [];
    if (own.isFile() && (own.size > 4096 || isRemotePath(readFileSync(dotGit, 'utf8').replace(/^gitdir: /u, '').trim()))) return [];
    const found = findGitDir(root);
    if (!found || found.broken || (own.isDirectory() && found.gitDir !== dotGit)) return [];
    const file = join(found.commonDir, 'config');
    const st = lstatSync(file, { throwIfNoEntry: false });
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
      const url = withoutSecrets(value).slice(0, MAX_TEXT);
      if (field === 'url' && !remote.url) remote.url = url;
      if (field === 'pushurl' && remote.pushUrl === null) remote.pushUrl = url;
      remotes.set(name, remote);
    }
    return [...remotes.values()].filter(r => r.url).slice(0, MAX_REMOTES);
  } catch { return []; }
}
