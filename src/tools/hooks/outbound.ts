import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import type { PreCheck, ToolDef } from '../types.ts';
import { outboundText, type OutboundMessageKey } from '../../shared/messages/outbound.ts';
import { sanitizeModelInputText } from '../../shared/redaction.ts';
import { longOption, pushProblem, pushRepo, type PushEnv } from './push-target.ts';
import { isInside, realish } from './scope.ts';
import type { FactWord, StatementFacts } from './shell-guard.ts';

export type OutboundKind = 'send' | 'delete' | 'deny';
export interface Outbound { kind: OutboundKind; reason: string; targets: string[] }

export type OutboundFacts =
  | { tool: 'shell'; statements: readonly StatementFacts[] }
  | { tool: 'mcp'; sends?: boolean | undefined; removes?: boolean | undefined }
  | { tool: 'browser'; submits: boolean }
  | { tool: 'other' };

export interface OutboundEnv extends PushEnv {
  language?: Language;
  productRoot?: string | undefined;
  workspaceRoots?: readonly string[];
  isTracked(path: string): boolean;
  isClean(path: string): boolean;
  isCreated(path: string): boolean;
}

interface Hit { kind: OutboundKind; key: OutboundMessageKey; params: Record<string, string>; targets: string[] }
const hit = (kind: OutboundKind, key: OutboundMessageKey, params: Record<string, string> = {}, targets: string[] = []): Hit => ({ kind, key, params, targets });

const ALWAYS_SEND = new Set([
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'aws', 'gcloud', 'gsutil', 'az', 'rclone', 's3cmd', 'http', 'https', 'xh',
  'send-mailmessage', 'mail', 'mailx', 'sendmail', 'bitsadmin', 'start-bitstransfer', 'pscp', 'plink', 'psftp',
]);
const WEB_PROGRAMS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const LOOKUP = new Set(['nslookup', 'dig', 'host', 'ping', 'tracert', 'traceroute', 'resolve-dnsname', 'test-netconnection', 'test-connection']);
const FETCHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'gem', 'cargo', 'go', 'composer', 'docker', 'podman']);
const SECRET_CHECKED = new Set([...ALWAYS_SEND, ...WEB_PROGRAMS, ...LOOKUP, 'gh', 'git', 'openssl', 'tailscale', 'hg', 'svn', ...FETCHERS]);
const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'del', 'erase', 'rd', 'remove-item', 'ri', 'clear-content', 'clc']);
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[\d.]*|py|perl|ruby|php|awk|gawk|mawk|nawk)$/u;
const NET_API = /\b(?:fetch|https?|net\.connect|tls\.connect|dgram|XMLHttpRequest|WebSocket|requests|urllib\d?|http\.client|socket|Net\.WebClient|HttpClient|Invoke-WebRequest|Invoke-RestMethod|undici|axios|curl|wget|smtplib|ftplib|file_get_contents|fsockopen|stream_socket_client|curl_\w+|Net::HTTP|open-uri|TCPSocket|IO::Socket|LWP|HTTP::Tiny|telnetlib|createConnection|http2)\b|\/inet\/|require\(\s*['"](?:node:)?(?:net|dns|tls|dgram|http2?|https)['"]|from\s+['"](?:node:)?(?:net|dns|tls|dgram|http2?|https)['"]/iu;
const PROCESS_API = /\b(?:child_process|execSync|spawnSync|execFile\w*|spawn|exec|subprocess|os\.system|popen|Start-Process|Deno\.Command|Bun\.spawn|system|shell_exec|passthru|proc_open|getline)\b|`|\|\s*"/u;
const DELETE_API = /\b(?:rmSync|rmdirSync|unlinkSync|unlink|rmdir|rm|rmtree|os\.remove|removedirs|remove_tree|rm_rf|Remove-Item|Clear-Content|truncate)\b/u;
const READ_METHODS = /^(?:get|head)$/iu;

const GH_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['view', 'list', 'status', 'diff', 'checks']), issue: new Set(['view', 'list', 'status']), repo: new Set(['view', 'list']),
  release: new Set(['view', 'list', 'download']), run: new Set(['view', 'list', 'watch', 'download']), gist: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']), auth: new Set(['status']), search: new Set(['repos', 'issues', 'prs', 'code', 'commits']), label: new Set(['list']),
};

const flagValue = (words: readonly FactWord[], i: number, names: readonly string[]): string | undefined => {
  const w = words[i]!.text;
  for (const n of names) {
    if (w === n) return words[i + 1]?.text ?? '';
    if (n.startsWith('--') && w.startsWith(`${n}=`)) return w.slice(n.length + 1);
    if (!n.startsWith('--') && w.startsWith(n) && w.length > n.length) return w.slice(n.length);
  }
  return undefined;
};

const psParam = (word: string, name: string, min = 2): boolean => {
  const m = /^-([a-z]+):?$/iu.exec(word);
  return !!m && m[1]!.length >= min && name.startsWith(m[1]!.toLowerCase());
};

const TOOL_ENV = new Set(['CURL_HOME', 'WGETRC', 'SYSTEMWGETRC', 'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'APPDATA']);

function toolConfigHit(st: StatementFacts, cmd: string): Hit | undefined {
  if (st.stdin || st.env.some(n => TOOL_ENV.has(n.replace(/^env:/iu, '').toUpperCase())) || st.reasonKeys.some(k => k.startsWith('list.tool_rc'))) return hit('send', 'send.tool_config', { cmd });
  return undefined;
}

const nonHttpScheme = (words: readonly FactWord[]): boolean => words.slice(1).some(w => {
  const m = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(w.text);
  return !!m && !/^https?$/iu.test(m[1]!);
});

const CURL_VALUE = new Set([...'bcCdDeEFHKmoPQrTuUwxXyYzA']);
const CURL_SEND_LETTERS = new Set([...'dFTK']);
const CURL_OUTPUTS = new Set(['--output', '--dump-header', '--cookie-jar', '--output-dir', '--trace', '--trace-ascii', '--stderr', '--user-agent', '--header', '--referer', '--cookie', '--user', '--proxy', '--max-time', '--connect-timeout', '--retry', '--range', '--write-out', '--cacert', '--cert', '--key', '--resolve', '--connect-to', '--interface', '--limit-rate']);
const CURL_LONG_SENDS = /^--(?:data|json|form|upload-file|url-query|config|expand-|variable|mail-|ftp-|telnet-option|proxy-header|post30)/u;

function curlSends(st: StatementFacts): Hit | undefined {
  const words = st.words;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (w.dynamic) return hit('send', 'send.dynamic_target', { cmd: 'curl' });
    if (t.startsWith('--')) {
      if (CURL_LONG_SENDS.test(t)) return hit('send', 'send.data', { cmd: 'curl' });
      const method = flagValue(words, i, ['--request']);
      if (method !== undefined && !READ_METHODS.test(method)) return hit('send', 'send.data', { cmd: 'curl' });
      if ((t === '--request' || CURL_OUTPUTS.has(t)) && !t.includes('=')) i++;
      continue;
    }
    if (!t.startsWith('-') || t === '-') continue;
    const letters = [...t.slice(1)];
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k]!;
      if (CURL_SEND_LETTERS.has(ch)) return hit('send', 'send.data', { cmd: 'curl' });
      if (!CURL_VALUE.has(ch)) continue;
      const inline = letters.slice(k + 1).join('');
      const value = inline || words[i + 1]?.text || '';
      if (!inline) { if (words[i + 1]?.dynamic) return hit('send', 'send.dynamic_target', { cmd: 'curl' }); i++; }
      if (ch === 'X' && !READ_METHODS.test(value)) return hit('send', 'send.data', { cmd: 'curl' });
      break;
    }
  }
  if (nonHttpScheme(words)) return hit('send', 'send.data', { cmd: 'curl' });
  return toolConfigHit(st, 'curl') ?? psWebSends(words, 'curl');
}

const WGET_OUTPUTS = new Set(['-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix', '-a', '--append-output', '-U', '--user-agent', '-T', '--timeout', '-t', '--tries']);
const WGET_SEND_LONG = ['--post-data', '--post-file', '--body-data', '--body-file', '--method', '--input-file', '--execute', '--config'];

function wgetSends(st: StatementFacts): Hit | undefined {
  const words = st.words;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (WGET_OUTPUTS.has(t)) { i++; continue; }
    if (w.dynamic) return hit('send', 'send.dynamic_target', { cmd: 'wget' });
    if (t.startsWith('--')) {
      const name = WGET_SEND_LONG.find(n => longOption(t, n));
      if (name === '--method') {
        const method = t.includes('=') ? t.slice(t.indexOf('=') + 1) : words[i + 1]?.text ?? '';
        if (!READ_METHODS.test(method)) return hit('send', 'send.data', { cmd: 'wget' });
        continue;
      }
      if (name) return hit('send', 'send.data', { cmd: 'wget' });
      continue;
    }
    if (/^-[A-Za-z]*[ie]/u.test(t)) return hit('send', 'send.data', { cmd: 'wget' });
  }
  if (nonHttpScheme(words)) return hit('send', 'send.data', { cmd: 'wget' });
  return toolConfigHit(st, 'wget') ?? psWebSends(words, 'wget');
}

function psWebSends(words: readonly FactWord[], cmd: string): Hit | undefined {
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (['body', 'infile', 'form'].some(n => psParam(t, n, 1))) return hit('send', 'send.data', { cmd });
    if ((psParam(t, 'method', 1) || psParam(t, 'custommethod', 1)) && !READ_METHODS.test(words[i + 1]?.text ?? '')) return hit('send', 'send.data', { cmd });
    if (psParam(t, 'outfile') || psParam(t, 'sessionvariable')) { i++; continue; }
    if (words[i]!.dynamic) return hit('send', 'send.dynamic_target', { cmd });
  }
  return undefined;
}

function ghSends(words: readonly FactWord[]): Hit | undefined {
  const args = words.slice(1).filter(w => !w.text.startsWith('-'));
  const [group, action] = [args[0]?.text ?? '', args[1]?.text ?? ''];
  if (group === 'api') {
    for (let i = 1; i < words.length; i++) {
      const t = words[i]!.text;
      if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/u.test(t) || /^-[fF]./u.test(t)) return hit('send', 'send.service', { cmd: 'gh api' });
      const method = flagValue(words, i, ['-X', '--method']);
      if (method !== undefined && !READ_METHODS.test(method)) return hit('send', 'send.service', { cmd: 'gh api' });
    }
    return undefined;
  }
  if (group === 'status' || group === 'browse' || group === '--version' || group === 'version') return undefined;
  if (GH_READS[group]?.has(action)) return undefined;
  const upload = (group === 'release' && (action === 'create' || action === 'upload')) || (group === 'gist' && action === 'create');
  return hit('send', upload ? 'send.upload' : 'send.service', { cmd: `gh ${group} ${action}`.trim() });
}

function uploadOf(st: StatementFacts): Hit | undefined {
  const w = st.words.map(x => x.text.toLowerCase());
  const p = st.program;
  const sub = w[1] ?? '';
  const up = (cmd: string): Hit => hit('send', 'send.upload', { cmd });
  if ((p === 'npm' || p === 'yarn' || p === 'pnpm') && w.slice(1).includes('publish')) return up(`${p} publish`);
  if (p === 'cargo' && sub === 'publish') return up('cargo publish');
  if (p === 'twine' && sub === 'upload') return up('twine upload');
  if (/^(?:python[\d.]*|py)$/u.test(p) && w.includes('-m') && w[w.indexOf('-m') + 1] === 'twine' && w.includes('upload')) return up('twine upload');
  if (p === 'gem' && sub === 'push') return up('gem push');
  if (p === 'dotnet' && sub === 'nuget' && w[2] === 'push') return up('dotnet nuget push');
  if ((p === 'docker' || p === 'podman') && (sub === 'push' || (sub === 'image' && w[2] === 'push'))) return up(`${p} push`);
  if (p === 'hg' && (sub === 'push' || sub === 'email')) return up(`hg ${sub}`);
  if (p === 'svn' && ['commit', 'ci', 'import'].includes(sub)) return up(`svn ${sub}`);
  if (p === 'openssl' && sub === 's_client') return hit('send', 'send.network_program', { cmd: 'openssl s_client' });
  if (p === 'tailscale' && sub === 'file' && w[2] === 'cp') return up('tailscale file cp');
  return undefined;
}

function interpreterHit(st: StatementFacts): Hit | undefined {
  const cmd = st.program;
  if (st.codeDynamic) return hit('send', 'send.inline_code', { cmd });
  const loaders = ['--import', '--require', '-r', '--loader', '--experimental-loader'];
  for (let i = 1; i < st.words.length; i++) {
    const t = st.words[i]!.text;
    const flag = loaders.find(l => t === l || t.startsWith(`${l}=`));
    if (!flag) continue;
    const value = t === flag ? st.words[i + 1] : { text: t.slice(flag.length + 1), dynamic: st.words[i]!.dynamic };
    if (!value || value.dynamic || /^(?:data|https?):/iu.test(value.text)) return hit('send', 'send.inline_code', { cmd });
  }
  for (const code of st.code) {
    if (NET_API.test(code) || PROCESS_API.test(code)) return hit('send', 'send.inline_code', { cmd });
    if (DELETE_API.test(code)) return hit('delete', 'delete.inline_code', { cmd });
  }
  const positional = st.words.slice(1).some(w => !w.text.startsWith('-'));
  if (st.code.length === 0 && !positional && st.stdin) return hit('send', 'send.inline_code', { cmd });
  return undefined;
}

function deleteHit(targets: StatementFacts['targets'], env: OutboundEnv): Hit | undefined {
  const known = targets.flatMap(t => (t.path ? [t.path] : []));
  if (!env.productRoot) return hit('delete', 'delete.no_product', {}, known);
  if (targets.length === 0 || known.length < targets.length) return hit('delete', 'delete.unresolved', {}, [...known, ...targets.filter(t => !t.path).map(t => t.input)]);
  const root = env.productRoot;
  const inside = (p: string): boolean => isInside(root, p) && isInside(realish(root), realish(p));
  const outside: string[] = [];
  const kept: string[] = [];
  for (const p of known) {
    if ((env.workspaceRoots ?? []).some(w => isInside(w, p) && isInside(realish(w), realish(p)))) continue;
    if (!inside(p)) { outside.push(p); continue; }
    if (env.isCreated(p)) continue;
    if (env.isTracked(p) && env.isClean(p)) continue;
    kept.push(p);
  }
  if (outside.length) return hit('delete', 'delete.outside', {}, [...outside, ...kept]);
  return kept.length ? hit('delete', 'delete.files', {}, kept) : undefined;
}

const GIT_GLOBALS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--attr-source', '--super-prefix', '--no-pager', '-P', '--paginate', '-p',
  '--no-optional-locks', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--no-lazy-fetch',
  '--no-advice', '--version', '--help', '-v', '-h', '--html-path', '--man-path', '--info-path', '--list-cmds',
]);
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);
const GIT_INFO = new Set(['--version', '--help', '-v', '-h', '--exec-path', '--html-path', '--man-path', '--info-path']);
const GIT_PULLING = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'submodule', 'remote']);
const GIT_SENDERS = new Set(['send-pack', 'http-push', 'send-email', 'imap-send', 'request-pull', 'daemon', 'upload-pack', 'receive-pack', 'http-fetch', 'credential']);
const GIT_KNOWN = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout',
  'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree',
  'merge', 'merge-base', 'merge-file', 'mergetool', 'mktag', 'mktree', 'mv', 'name-rev', 'notes', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack',
  'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace',
  'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree', 'maintenance',
  'prune', 'prune-packed', 'pack-refs', 'mailinfo', 'mailsplit', 'interpret-trailers', 'column', 'init-db', 'unpack-objects', 'pack-objects', 'index-pack', 'verify-pack',
  ...GIT_SENDERS, 'lfs', 'svn', 'p4',
]);

function gitHit(st: StatementFacts, before: readonly StatementFacts[], env: OutboundEnv): Hit | undefined {
  const g = st.gitGlobal;
  for (let i = 0; i < g.length; i++) {
    const name = g[i]!.split('=')[0]!;
    if (!GIT_GLOBALS.has(name)) return hit('send', 'send.git_unknown', { detail: g[i]! });
    if (GIT_VALUE_GLOBALS.has(g[i]!)) {
      const value = g[++i] ?? '';
      if ((name === '-c' || name === '--config-env') && /^alias\./iu.test(value)) return hit('send', 'send.git_unknown', { detail: `${name} ${value}` });
    }
  }
  const subAt = g.length + 1;
  const subWord = st.words[subAt];
  if (!subWord) return g.length > 0 && g.every(x => GIT_INFO.has(x.split('=')[0]!)) || g.length === 0 ? undefined : hit('send', 'send.git_unknown', { detail: g.join(' ') });
  if (subWord.dynamic) return hit('send', 'send.git_unknown', { detail: subWord.text });
  const sub = subWord.text;
  if (!GIT_KNOWN.has(sub)) return hit('send', 'send.git_unknown', { detail: sub });
  const argWords = st.words.slice(subAt + 1);
  const args = argWords.map(w => w.text);
  const has = (...names: string[]): boolean => args.some(a => names.some(n => a === n || (n.startsWith('--') && longOption(a, n))));
  const shortHas = (letter: string): boolean => args.some(a => /^-[a-zA-Z]+$/u.test(a) && a.includes(letter));
  const discard = (cmd: string): Hit => hit('delete', 'delete.git_discard', { cmd });
  if (GIT_PULLING.has(sub) && argWords.some(w => w.dynamic)) return hit('send', 'send.dynamic_target', { cmd: `git ${sub}` });
  if (args.some(a => ['--upload-pack', '--receive-pack', '--exec'].some(n => longOption(a, n)))) return hit('send', 'send.git_unknown', { detail: `git ${sub}` });
  if (sub === 'grep' && args.some(a => /^-O/u.test(a) || longOption(a, '--open-files-in-pager'))) return hit('send', 'send.git_unknown', { detail: 'git grep -O' });
  if (GIT_SENDERS.has(sub)) return hit('send', sub === 'send-email' || sub === 'imap-send' ? 'send.git_mail' : 'send.network_program', { cmd: `git ${sub}` });
  const positionals = args.filter(a => !a.startsWith('-'));
  switch (sub) {
    case 'push': {
      if (has('--delete', '--mirror', '--prune') || shortHas('d') || args.some(a => /^\+?:/u.test(a))) return hit('delete', 'delete.git_remote_branch');
      const problem = pushProblem(st, subAt, before, env);
      if (!problem) return undefined;
      const params = problem.key === 'send.push_target' ? { remote: problem.remote } : 'detail' in problem ? { detail: problem.detail } : {};
      return hit('send', problem.key, params);
    }
    case 'svn': return ['dcommit', 'set-tree'].includes(positionals[0] ?? '') ? hit('send', 'send.upload', { cmd: `git svn ${positionals[0]}` }) : undefined;
    case 'p4': return positionals[0] === 'submit' ? hit('send', 'send.upload', { cmd: 'git p4 submit' }) : undefined;
    case 'lfs': return positionals[0] === 'push' ? hit('send', 'send.upload', { cmd: 'git lfs push' }) : undefined;
    case 'remote': {
      const action = args.find(a => a !== '-v' && a !== '--verbose') ?? '';
      return ['add', 'set-url', 'rename'].includes(action) ? hit('send', 'send.git_remote_change', { cmd: `git remote ${action}` }) : undefined;
    }
    case 'config': {
      if (has('--get', '--get-all', '--get-regexp', '--list', '--get-urlmatch', '--get-color', '--get-colorbool') || args.includes('-l')) return undefined;
      const takesValue = new Set(['-f', '--file', '--blob', '--comment', '--type', '--default', '--value', '--url']);
      let key: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (takesValue.has(a)) { i++; continue; }
        if (a.startsWith('-')) continue;
        if (key === undefined && ['set', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section'].includes(a)) {
          if (a === 'get' || a === 'list') return undefined;
          continue;
        }
        key = a;
        break;
      }
      return key && /^(?:url|remote)\./iu.test(key) ? hit('send', 'send.git_remote_change', { cmd: 'git config' }) : undefined;
    }
    case 'clean': return discard('clean');
    case 'reset': return has('--hard', '--merge', '--keep') ? discard('reset --hard') : undefined;
    case 'checkout': {
      if (has('--', '--force', '--patch', '--ours', '--theirs', '--merge', '--pathspec-from-file') || args.includes('-f') || args.includes('-p') || args.includes('.')) return discard('checkout');
      if (has('--orphan') || args.some(a => /^-[a-zA-Z]*[bB]/u.test(a))) return undefined;
      if (positionals.length >= 2) return discard('checkout');
      if (positionals.length === 1 && (/[*?[]/u.test(positionals[0]!) || positionals[0]!.startsWith(':') || g.some(x => ['-C', '--git-dir', '--work-tree'].includes(x.split('=')[0]!)))) return discard('checkout');
      const one = argWords.find(w => !w.text.startsWith('-'));
      if (one && (one.glob || one.dynamic || st.cwd === null || existsSync(resolve(st.cwd, one.text)))) return discard('checkout');
      return undefined;
    }
    case 'switch': return has('--force', '--discard-changes') || shortHas('f') ? discard('switch') : undefined;
    case 'restore': return has('--staged') || args.includes('-S') ? (has('--worktree') || args.includes('-W') ? discard('restore') : undefined) : discard('restore');
    case 'branch': {
      const del = has('--delete') || shortHas('d');
      const force = has('--force') || shortHas('f');
      return shortHas('D') || (del && force) ? hit('delete', 'delete.git_branch') : undefined;
    }
    case 'stash': return positionals[0] === 'drop' || positionals[0] === 'clear' ? hit('delete', 'delete.git_stash') : undefined;
    case 'worktree': return positionals[0] === 'remove' && (has('--force') || shortHas('f')) ? discard('worktree remove') : undefined;
    case 'update-ref': return args.includes('-d') || has('--stdin') ? hit('delete', 'delete.git_history', { cmd: 'update-ref' }) : undefined;
    case 'reflog': return positionals[0] === 'expire' || positionals[0] === 'delete' ? hit('delete', 'delete.git_history', { cmd: `reflog ${positionals[0]}` }) : undefined;
    case 'gc': return has('--prune') ? hit('delete', 'delete.git_history', { cmd: 'gc --prune' }) : undefined;
    case 'prune': return hit('delete', 'delete.git_history', { cmd: 'prune' });
    case 'checkout-index': return has('--force') || shortHas('f') ? discard('checkout-index') : undefined;
    case 'read-tree': return shortHas('u') || has('--reset') ? discard('read-tree') : undefined;
    case 'rm':
      if (has('--cached')) return undefined;
      if (g.some(x => x !== '--no-pager')) return hit('delete', 'delete.unresolved', {}, st.targets.map(t => t.path ?? t.input));
      return deleteHit(st.targets, env);
    default: return undefined;
  }
}

function statementHits(st: StatementFacts, before: readonly StatementFacts[], env: OutboundEnv, nested: boolean): Hit[] {
  const p = st.program;
  if (st.programDynamic || st.programOdd || (nested && /[\s'"]/u.test(st.words[0]?.text ?? '')) || (p && before.some(definesCommand))) return [hit('send', 'send.unknown_command', { cmd: st.words[0]?.text ?? '' })];
  if (st.inner === null) return [hit('send', 'send.unknown_command', { cmd: p })];
  if (st.inner) return [...walk(st.inner, [...before, st], env, true), ...[statementHit(st, before, env)].filter((h): h is Hit => !!h)];
  if (!p) return [];
  const one = statementHit(st, before, env);
  return one ? [one] : [];
}

function statementHit(st: StatementFacts, before: readonly StatementFacts[], env: OutboundEnv): Hit | undefined {
  const p = st.program;
  if (INTERPRETERS.test(p)) { const code = interpreterHit(st); if (code) return code; }
  if (p === 'git') return gitHit(st, before, env);
  if (FETCHERS.has(p) && st.words.slice(1).some(w => w.dynamic)) return hit('send', 'send.dynamic_target', { cmd: p });
  if (st.urls.some(u => u.dynamic)) return hit('send', 'send.dynamic_target', { cmd: p });
  const upload = uploadOf(st);
  if (upload) return upload;
  if (ALWAYS_SEND.has(p)) return hit('send', 'send.network_program', { cmd: p });
  if (p === 'curl') return curlSends(st);
  if (p === 'wget') return wgetSends(st);
  if (WEB_PROGRAMS.has(p)) return psWebSends(st.words, p);
  if (p === 'gh') return ghSends(st.words);
  if (LOOKUP.has(p)) return st.words.slice(1).some(w => w.dynamic) ? hit('send', 'send.dynamic_target', { cmd: p }) : undefined;
  if (p === 'find' && st.words.some(w => w.text === '-delete')) return hit('delete', 'delete.unresolved');
  if (DELETE_PROGRAMS.has(p) || st.deletes) {
    if ((p === 'remove-item' || p === 'ri' || p === 'rm' || p === 'del') && st.words.some(w => ['include', 'exclude', 'filter'].some(n => psParam(w.text, n)))) return hit('delete', 'delete.unresolved');
    return deleteHit(st.targets, env);
  }
  return undefined;
}

function walk(list: readonly StatementFacts[], prior: readonly StatementFacts[], env: OutboundEnv, nested: boolean): Hit[] {
  return list.flatMap((st, i) => statementHits(st, [...prior, ...list.slice(0, i)], env, nested));
}

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? [])]);

const GIT_NETWORK = new Set([...GIT_PULLING, ...GIT_SENDERS, 'push', 'svn', 'p4', 'lfs', 'config', 'archive', 'fetch-pack', 'bisect', 'difftool', 'mergetool', 'grep']);
const gitNetwork = (st: StatementFacts): boolean => {
  const sub = st.words[st.gitGlobal.length + 1];
  return st.gitGlobal.length > 0 || !sub || sub.dynamic || GIT_NETWORK.has(sub.text) || !GIT_KNOWN.has(sub.text);
};

const ALIAS_PROGRAMS = new Set(['alias', 'set-alias', 'new-alias', 'sal', 'nal', 'import-alias', 'ipal']);
const ITEM_PROGRAMS = new Set(['set-item', 'si', 'new-item', 'ni', 'copy-item', 'cpi', 'rename-item', 'rni']);
function definesCommand(st: StatementFacts): boolean {
  if (ALIAS_PROGRAMS.has(st.program)) return true;
  if (ITEM_PROGRAMS.has(st.program) && st.words.some(w => /^(?:alias|function):/iu.test(w.text))) return true;
  return st.shapes.some(s => s === 'function' || /^control:(?:function|filter|workflow)$/u.test(s));
}

const decoded = (text: string): string => {
  try { return decodeURIComponent(text); } catch { return text.replace(/%([0-9a-f]{2})/giu, (_, h: string) => String.fromCharCode(parseInt(h, 16))); }
};

function secretTarget(st: StatementFacts): string | undefined {
  const candidates = [...st.urls.filter(u => !u.dynamic).map(u => u.text), ...(SECRET_CHECKED.has(st.program) && (st.program !== 'git' || gitNetwork(st)) ? st.words.slice(1).filter(w => !w.dynamic).map(w => w.text) : [])];
  for (const c of candidates) {
    for (const text of new Set([c, decoded(c)])) {
      const clean = sanitizeModelInputText(text);
      if (clean.redaction_count > 0) return clean.text;
    }
  }
  return undefined;
}

export function outboundOf(facts: OutboundFacts, env: OutboundEnv): Outbound | undefined {
  const language = env.language ?? DEFAULT_LANGUAGE;
  const say = (h: Hit): string => outboundText(language, h.key, h.params);
  switch (facts.tool) {
    case 'mcp':
      if (facts.removes === true) return { kind: 'delete', reason: say(hit('delete', 'delete.tool')), targets: [] };
      return facts.sends === false ? undefined : { kind: 'send', reason: say(hit('send', 'send.tool')), targets: [] };
    case 'browser': return facts.submits ? { kind: 'send', reason: say(hit('send', 'send.browser_submit')), targets: [] } : undefined;
    case 'other': return undefined;
    default:
  }
  for (const st of flatten(facts.statements)) {
    const secret = secretTarget(st);
    if (secret) return { kind: 'deny', reason: say(hit('deny', 'deny.secret_target', { target: secret })), targets: [secret] };
  }
  const hits = walk(facts.statements, [], env, false);
  if (!hits.length) return undefined;
  const deletes = hits.find(h => h.kind === 'delete');
  const sends = hits.find(h => h.kind === 'send');
  const targets = [...new Set(hits.flatMap(h => h.targets))];
  if (deletes && sends) return { kind: 'delete', reason: `${say(deletes)} / ${say(sends)}`, targets };
  const first = (deletes ?? sends)!;
  return { kind: first.kind, reason: say(first), targets };
}

const NO_GIT: OutboundEnv = { isTracked: () => false, isClean: () => false, isCreated: () => false, pushUrls: () => undefined, pushRemote: () => undefined };

export function outboundOfCall(tool: Pick<ToolDef, 'mcp' | 'submits'>, check: PreCheck | undefined, language: Language): Outbound | undefined {
  if (check?.outbound) return check.outbound;
  if (tool.mcp) return outboundOf({ tool: 'mcp', sends: check?.sends, removes: check?.removes }, { ...NO_GIT, language });
  if (tool.submits) return outboundOf({ tool: 'browser', submits: true }, { ...NO_GIT, language });
  return undefined;
}

const PLACE_FLAGS = ['--prefix', '-C', '--cwd', '--dir', '--directory', '--manifest-path', '--project', '--working-directory'];

export function placesOf(statements: readonly StatementFacts[], cwd: string): string[] {
  const out = new Set<string>();
  for (const st of flatten(statements)) {
    const base = st.cwd ?? cwd;
    out.add(base);
    for (let i = 0; i < st.words.length; i++) {
      const text = st.words[i]!.text;
      const flag = PLACE_FLAGS.find(f => text === f || text.startsWith(`${f}=`));
      if (!flag) continue;
      const value = text === flag ? st.words[i + 1] : { text: text.slice(flag.length + 1), dynamic: st.words[i]!.dynamic };
      if (!value || value.dynamic || !value.text) continue;
      const place = resolve(base, value.text);
      out.add(flag === '--manifest-path' ? dirname(place) : place);
    }
    if (PUBLISHERS.has(st.program) && st.words[1]?.text === 'publish') {
      for (const word of st.words.slice(2)) if (!word.dynamic && word.text && !word.text.startsWith('-')) out.add(resolve(base, word.text));
    }
  }
  return [...out];
}

const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
export interface RepoBind { dir: string | null }

export function pushesOf(statements: readonly StatementFacts[]): RepoBind[] {
  const out: RepoBind[] = [];
  const visit = (list: readonly StatementFacts[], prior: readonly StatementFacts[]): void => list.forEach((st, i) => {
    const before = [...prior, ...list.slice(0, i)];
    if (st.inner) visit(st.inner, [...before, st]);
    if (st.program !== 'git') return;
    const found = gitHit(st, before, NO_GIT);
    if (!found || (found.kind !== 'send' && found.key !== 'delete.git_remote_branch')) return;
    out.push({ dir: found.key === 'send.git_unknown' || pushUnconfirmable(st) ? null : pushRepo(st, before) });
  });
  visit(statements, []);
  return out;
}

const RECURSE_PINNED = new Set(['no', 'check']);

function pushUnconfirmable(st: StatementFacts): boolean {
  const subAt = st.gitGlobal.length + 1;
  if (st.words[subAt]?.text !== 'push') return false;
  const args = st.words.slice(subAt + 1);
  return args.some((w, i) => {
    if (w.text.includes('@{')) return true;
    if (!longOption(w.text, '--recurse-submodules')) return false;
    const at = w.text.indexOf('=');
    return !RECURSE_PINNED.has(at >= 0 ? w.text.slice(at + 1) : args[i + 1]?.text ?? '');
  });
}
