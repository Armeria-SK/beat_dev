import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findGitDir, parseGitConfig } from '../tools/hooks/git-repo.ts';
import { isRemotePath } from '../tools/hooks/scope.ts';

export interface Remote { name: string; url: string; pushUrl: string | null }

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_REMOTES = 50;
const MAX_TEXT = 2000;

export const HIDDEN_URL = '(hidden)';
const HOST_PORT = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d*)?$/u;
const SCP_PLAIN = /^(?:[^@/\s:?#]+@)?[^@/\s:?#]+:(?!\/\/)[^@?#]*$/u;

export const withoutSecrets = (url: string): string => {
  if (/^[A-Za-z]:[\\/]/u.test(url) || /^\/(?!\/)/u.test(url)) return url;
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/u.exec(url);
  if (parts) {
    const authority = parts[2]!;
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (!HOST_PORT.test(host)) return url.includes('@') ? HIDDEN_URL : `${parts[1]}${authority}${parts[3]}`;
    const named = host.startsWith('[') || host.includes('.') || /^localhost(?::|$)/iu.test(host);
    const after = url.slice(parts[1]!.length + authority.length);
    return named || !after.includes('@') ? `${parts[1]}${host}${parts[3]}` : HIDDEN_URL;
  }
  if (!/[@?#]/u.test(url) || SCP_PLAIN.test(url)) return url;
  // git は scp の形を「最初の : の前がホスト」と読む（user:pw@host:path の ssh の相手は user）。@ より後ろを見せると実際と違う送り先になるので、この形は丸ごと隠す
  return HIDDEN_URL;
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

// 控えの送り先の URL（url と pushUrl）。照らし（push-target）と判定役への「信用する宛先」に使う。(hidden) は見せないという印で、本物の宛先ではないので数えない
export const recordedUrls = (remotes: readonly Remote[]): string[] => remotes.flatMap(r => [r.url, ...(r.pushUrl ? [r.pushUrl] : [])]).filter(url => url !== HIDDEN_URL);

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
