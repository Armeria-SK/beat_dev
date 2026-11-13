import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { outboundText, type OutboundMessageKey } from '../../shared/messages/outbound.ts';
import { sanitizeModelInputText } from '../../shared/redaction.ts';
import { pushProblem, type PushEnv } from './push-target.ts';
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

// 外とやり取りするプログラム（PLAN Approach 4 の一覧）。下の「数えない形」に当たらなければ send
const ALWAYS_SEND = new Set(['ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'aws', 'gcloud', 'gsutil', 'az', 'rclone', 's3cmd', 'http', 'https', 'xh', 'send-mailmessage']);
const WEB_PROGRAMS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const LOOKUP = new Set(['nslookup', 'dig', 'host', 'ping', 'tracert', 'traceroute', 'resolve-dnsname', 'test-netconnection', 'test-connection']);
const NETWORK_WORDS = new Set([...ALWAYS_SEND, ...WEB_PROGRAMS, ...LOOKUP, 'gh', 'git', 'npm', 'yarn', 'pnpm', 'cargo', 'twine', 'gem', 'dotnet', 'docker', 'podman', 'mail', 'sendmail', 'certutil', 'bitsadmin', 'start-bitstransfer', 'net.webclient']);
const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'del', 'erase', 'rd', 'remove-item', 'ri', 'clear-content', 'clc']);
const SHELL_CODE = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'iex', 'invoke-expression']);
const NET_API = /\b(?:fetch|https?|net\.connect|tls\.connect|dgram|XMLHttpRequest|WebSocket|requests|urllib\d?|http\.client|socket|Net\.WebClient|HttpClient|Invoke-WebRequest|Invoke-RestMethod|undici|axios|curl|wget|smtplib|ftplib)\b/iu;
const PROCESS_API = /\b(?:child_process|execSync|spawnSync|execFile\w*|spawn|exec|subprocess|os\.system|popen|Start-Process|Deno\.Command|Bun\.spawn|system|`)/u;
const DELETE_API = /\b(?:rmSync|rmdirSync|unlinkSync|unlink|rmdir|rm|rmtree|os\.remove|Remove-Item|Clear-Content|truncate)\b/u;
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

const psParam = (word: string, name: string): boolean => {
  const m = /^-([a-z]+):?$/iu.exec(word);
  return !!m && m[1]!.length >= 2 && name.startsWith(m[1]!.toLowerCase());
};

function curlSends(words: readonly FactWord[]): Hit | undefined {
  const outputs = new Set(['-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--output-dir', '--trace', '--trace-ascii', '--stderr']);
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (outputs.has(t)) { i++; continue; }
    if (words[i]!.dynamic) return hit('send', 'send.dynamic_target', { cmd: 'curl' });
    if (/^-[a-zA-Z]*[dFT]/u.test(t) && !t.startsWith('--')) return hit('send', 'send.data', { cmd: 'curl' });
    if (/^--(?:data|json|form|upload-file|url-query|config)/u.test(t) || /^-[a-zA-Z]*K/u.test(t)) return hit('send', 'send.data', { cmd: 'curl' });
    const method = flagValue(words, i, ['-X', '--request']);
    if (method !== undefined && !READ_METHODS.test(method)) return hit('send', 'send.data', { cmd: 'curl' });
  }
  return psWebSends(words, 'curl');
}

function wgetSends(words: readonly FactWord[]): Hit | undefined {
  const outputs = new Set(['-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix', '-a', '--append-output']);
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (outputs.has(t)) { i++; continue; }
    if (words[i]!.dynamic) return hit('send', 'send.dynamic_target', { cmd: 'wget' });
    if (/^--(?:post-data|post-file|body-data|body-file)/u.test(t)) return hit('send', 'send.data', { cmd: 'wget' });
    const method = flagValue(words, i, ['--method']);
    if (method !== undefined && !READ_METHODS.test(method)) return hit('send', 'send.data', { cmd: 'wget' });
  }
  return psWebSends(words, 'wget');
}

function psWebSends(words: readonly FactWord[], cmd: string): Hit | undefined {
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (['body', 'infile', 'form'].some(n => psParam(t, n))) return hit('send', 'send.data', { cmd });
    if (psParam(t, 'method') && !READ_METHODS.test(words[i + 1]?.text ?? '')) return hit('send', 'send.data', { cmd });
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
  if (/^(?:python3?|py)$/u.test(p) && w.includes('-m') && w[w.indexOf('-m') + 1] === 'twine' && w.includes('upload')) return up('twine upload');
  if (p === 'gem' && sub === 'push') return up('gem push');
  if (p === 'dotnet' && sub === 'nuget' && w[2] === 'push') return up('dotnet nuget push');
  if ((p === 'docker' || p === 'podman') && (sub === 'push' || (sub === 'image' && w[2] === 'push'))) return up(`${p} push`);
  return undefined;
}

function codeHit(st: StatementFacts): Hit | undefined {
  const cmd = st.program;
  if (SHELL_CODE.has(cmd)) {
    if (st.words.some(w => /^-(?:e|ec|enc|encodedcommand)$/iu.test(w.text)) && (cmd === 'powershell' || cmd === 'pwsh')) return hit('send', 'send.inline_code', { cmd });
    for (const code of st.code) {
      const tokens = code.toLowerCase().split(/[^a-z0-9_.+-]+/u).map(t => t.replace(/\.exe$/u, ''));
      if (tokens.some(t => NETWORK_WORDS.has(t))) return hit('send', 'send.inline_code', { cmd });
      if (tokens.some(t => DELETE_PROGRAMS.has(t))) return hit('delete', 'delete.inline_code', { cmd });
    }
    return undefined;
  }
  for (const code of st.code) {
    if (NET_API.test(code) || PROCESS_API.test(code)) return hit('send', 'send.inline_code', { cmd });
    if (DELETE_API.test(code)) return hit('delete', 'delete.inline_code', { cmd });
  }
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

function gitHit(st: StatementFacts, all: readonly StatementFacts[], env: OutboundEnv): Hit | undefined {
  const subAt = st.gitGlobal.length + 1;
  const sub = st.words[subAt]?.text ?? '';
  const args = st.words.slice(subAt + 1).map(w => w.text);
  const has = (...names: string[]): boolean => args.some(a => names.includes(a));
  const shortHas = (letter: string): boolean => args.some(a => /^-[a-zA-Z]+$/u.test(a) && a.includes(letter));
  switch (sub) {
    case 'push': {
      if (has('--delete', '-d') || shortHas('d') || args.some(a => /^\+?:/u.test(a))) return hit('delete', 'delete.git_remote_branch');
      const problem = pushProblem(st, subAt, all, env);
      if (!problem) return undefined;
      return hit('send', problem.key, problem.key === 'send.push_options' ? { detail: problem.detail } : problem.key === 'send.push_target' ? { remote: problem.remote } : {});
    }
    case 'remote': return ['add', 'set-url', 'rename'].includes(args[0] ?? '') ? hit('send', 'send.git_remote_change', { cmd: `git remote ${args[0]}` }) : undefined;
    case 'config': {
      if (has('--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch')) return undefined;
      const key = args.find(a => !a.startsWith('-'));
      return key && /^(?:url|remote)\./iu.test(key) ? hit('send', 'send.git_remote_change', { cmd: 'git config' }) : undefined;
    }
    case 'send-email': case 'imap-send': return hit('send', 'send.git_mail', { cmd: sub });
    case 'clean': return hit('delete', 'delete.git_discard', { cmd: 'clean' });
    case 'reset': return has('--hard', '--merge', '--keep') ? hit('delete', 'delete.git_discard', { cmd: 'reset --hard' }) : undefined;
    case 'checkout': return has('--', '.', '-f', '--force', '-p', '--patch') ? hit('delete', 'delete.git_discard', { cmd: 'checkout' }) : undefined;
    case 'restore': return has('--staged', '-S') && !has('--worktree', '-W') ? undefined : hit('delete', 'delete.git_discard', { cmd: 'restore' });
    case 'branch': return has('-D') || shortHas('D') || ((has('-d', '--delete') || shortHas('d')) && (has('-f', '--force') || shortHas('f'))) ? hit('delete', 'delete.git_branch') : undefined;
    case 'stash': return args[0] === 'drop' || args[0] === 'clear' ? hit('delete', 'delete.git_stash') : undefined;
    case 'worktree': return args[0] === 'remove' && (has('-f', '--force')) ? hit('delete', 'delete.git_discard', { cmd: 'worktree remove' }) : undefined;
    case 'rm': return has('--cached') ? undefined : deleteHit(st.targets, env);
    default: return undefined;
  }
}

function statementHit(st: StatementFacts, all: readonly StatementFacts[], env: OutboundEnv): Hit | undefined {
  const p = st.program;
  if (!p) return undefined;
  const code = codeHit(st);
  if (code) return code;
  if (p === 'git') return gitHit(st, all, env);
  const upload = uploadOf(st);
  if (upload) return upload;
  if (ALWAYS_SEND.has(p)) return hit('send', 'send.network_program', { cmd: p });
  if (p === 'curl') return curlSends(st.words);
  if (p === 'wget') return wgetSends(st.words);
  if (WEB_PROGRAMS.has(p)) return psWebSends(st.words, p);
  if (p === 'gh') return ghSends(st.words);
  if (LOOKUP.has(p)) return st.words.slice(1).some(w => w.dynamic) ? hit('send', 'send.dynamic_target', { cmd: p }) : undefined;
  if (p === 'find' && st.words.some(w => w.text === '-delete')) return hit('delete', 'delete.unresolved');
  if ((p === 'find' || p === 'xargs' || p === 'parallel') && st.words.slice(1).some(w => DELETE_PROGRAMS.has(w.text.toLowerCase()))) return hit('delete', 'delete.unresolved');
  if (DELETE_PROGRAMS.has(p) || st.deletes) {
    if ((p === 'remove-item' || p === 'ri' || p === 'rm' || p === 'del') && st.words.some(w => ['include', 'exclude', 'filter'].some(n => psParam(w.text, n)))) return hit('delete', 'delete.unresolved');
    return deleteHit(st.targets, env);
  }
  return undefined;
}

function secretTarget(st: StatementFacts): string | undefined {
  const candidates = [...st.urls.filter(u => !u.dynamic).map(u => u.text), ...(LOOKUP.has(st.program) ? st.words.slice(1).filter(w => !w.dynamic && !w.text.startsWith('-')).map(w => w.text) : [])];
  for (const c of candidates) {
    const clean = sanitizeModelInputText(c);
    if (clean.redaction_count > 0) return clean.text;
  }
  return undefined;
}

export function outboundOf(facts: OutboundFacts, env: OutboundEnv): Outbound | undefined {
  const language = env.language ?? DEFAULT_LANGUAGE;
  const done = (h: Hit, targets = h.targets): Outbound => ({ kind: h.kind, reason: outboundText(language, h.key, h.params), targets });
  switch (facts.tool) {
    case 'mcp':
      if (facts.removes === true) return done(hit('delete', 'delete.tool'));
      return facts.sends === false ? undefined : done(hit('send', 'send.tool'));
    case 'browser': return facts.submits ? done(hit('send', 'send.browser_submit')) : undefined;
    case 'other': return undefined;
    default:
  }
  const all = facts.statements;
  for (const st of all) {
    const secret = secretTarget(st);
    if (secret) return done(hit('deny', 'deny.secret_target', { target: secret }, [secret]));
  }
  const hits = all.flatMap(st => statementHit(st, all, env) ?? []);
  const chosen = hits.filter(h => h.kind === 'delete').length ? hits.filter(h => h.kind === 'delete') : hits;
  if (!chosen.length) return undefined;
  return done(chosen[0]!, [...new Set(chosen.flatMap(h => h.targets))]);
}
