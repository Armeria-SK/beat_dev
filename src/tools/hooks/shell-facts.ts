import { posix } from 'node:path';
import { WRAPPED_VALUE_FLAGS } from './code-guard.ts';
import type { ShellKind, Word } from './shell-lex.ts';

export interface FactWord { text: string; dynamic: boolean; glob: boolean }
export interface DeleteTarget { input: string; path?: string; wild: boolean }
export interface StatementFacts {
  program: string;
  programDynamic: boolean;
  programOdd: boolean;
  words: FactWord[];
  urls: Array<{ text: string; dynamic: boolean }>;
  env: string[];
  gitGlobal: string[];
  code: string[];
  codeDynamic: boolean;
  stdin: boolean;
  shapes: string[];
  reasonKeys: string[];
  deletes: boolean;
  targets: DeleteTarget[];
  writes: string[];
  piped?: boolean;
  redirected?: boolean;
  cwd: string | null;
  inner?: StatementFacts[] | null;
}

export type InnerSource = { text: string; shell: ShellKind } | null | undefined;

const SAFE = /^[A-Za-z0-9_./:=@%+,~^-]+$/u;
const PLACEHOLDER = '"$1"';

function quote(w: Word | FactWord, ps: boolean): string {
  if (w.dynamic) return `"${w.text}"`;
  if (w.glob || SAFE.test(w.text)) return w.text;
  return ps ? `'${w.text.replaceAll("'", "''")}'` : `'${w.text.replaceAll("'", `'"'"'`)}'`;
}

const joinWords = (words: readonly Word[], ps: boolean): string => words.map(w => quote(w, ps)).join(' ');
const anyDynamic = (words: readonly Word[]): boolean => words.some(w => w.dynamic);

const STDIN_SCRIPT = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/u;
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const XARGS_VALUES: ReadonlySet<string> = new Set([...WRAPPED_VALUE_FLAGS['xargs']!].filter(f => !['-i', '-l', '-e'].includes(f)));
const PACKAGE_GLOBAL_VALUES = new Set(['--prefix', '-w', '--workspace', '-C', '--dir', '--filter', '-F', '--cwd', '--registry', '--userconfig', '--cache', '--loglevel']);
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|fish)$/u;
const POWERSHELL = /^(?:powershell|pwsh)$/u;
const PS_VALUE_PARAMS = ['executionpolicy', 'windowstyle', 'inputformat', 'outputformat', 'version', 'configurationname', 'workingdirectory', 'settingsfile', 'custompipename', 'psconsolefile'];
const PS_SHORT_VALUES = new Set(['ep', 'ex', 'w', 'wd', 'v', 'o', 'of', 'i', 'if']);
const SPAWNERS_WITH_BLOCKS = new Set(['at', 'batch', 'systemd-run', 'screen', 'tmux', 'start-job', 'start-threadjob', 'invoke-command', 'icm', 'new-pssession', 'enter-pssession', 'sajb']);
const START_PROCESS = new Set(['start-process', 'saps', 'start']);
const START_PARAMS = ['filepath', 'argumentlist', 'workingdirectory', 'verb', 'windowstyle', 'wait', 'passthru', 'nonewwindow', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'credential', 'loaduserprofile', 'usenewenvironment', 'environment'];

function decodePs(b64: string): string | null {
  if (!/^[A-Za-z0-9+/=]+$/u.test(b64)) return null;
  const text = Buffer.from(b64, 'base64').toString('utf16le');
  return Buffer.from(text, 'utf16le').toString('base64').replace(/=+$/u, '') === b64.replace(/=+$/u, '') ? text : null;
}

function powershellCode(args: readonly Word[], stdin: boolean): InnerSource {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const m = /^(?:--?|\/)([A-Za-z]+)(?::.*)?$/u.exec(w.text);
    if (!m || w.dynamic) {
      const rest = args.slice(i);
      return anyDynamic(rest) ? null : { text: rest.map(x => x.text).join(' '), shell: 'powershell' };
    }
    const name = m[1]!.toLowerCase();
    if ('command'.startsWith(name) || 'commandwithargs'.startsWith(name)) {
      const rest = args.slice(i + 1);
      return rest.length === 0 || anyDynamic(rest) ? null : { text: rest.map(x => x.text).join(' '), shell: 'powershell' };
    }
    if (name === 'e' || name === 'ec' || name.startsWith('en')) {
      const code = args[i + 1] && !args[i + 1]!.dynamic ? decodePs(args[i + 1]!.text) : null;
      return code === null ? null : { text: code, shell: 'powershell' };
    }
    if ('file'.startsWith(name)) return undefined;
    if (PS_SHORT_VALUES.has(name) || (name.length >= 2 && PS_VALUE_PARAMS.some(p => p.startsWith(name)))) i++;
  }
  return args.length > 0 || stdin ? null : undefined;
}

const takesValue = (t: string): boolean => SHELL_VALUE_OPTIONS.has(t) || /^[-+][A-Za-z]*[oO][A-Za-z]*$/u.test(t);
const stdinPath = (p: string): boolean => p === '-' || STDIN_SCRIPT.test(posix.normalize(p));

function shellCode(args: readonly Word[], stdin: boolean): InnerSource {
  if (stdin) return null;
  const at = args.findIndex(w => !w.dynamic && /^-[A-Za-z]*c[A-Za-z]*$/u.test(w.text));
  if (at >= 0) {
    let j = at + (/[oO]/u.test(args[at]!.text) ? 2 : 1);
    while (j < args.length && !args[j]!.dynamic) {
      const t = args[j]!.text;
      if (t === '--') { j++; break; }
      if (takesValue(t)) { j += 2; continue; }
      if (!/^[-+][A-Za-z]+$/u.test(t)) break;
      j++;
    }
    const code = args[j];
    return !code || code.dynamic ? null : { text: code.text, shell: 'bash' };
  }
  if (args.some(w => w.dynamic)) return null;
  const options: Word[] = [];
  let script: Word | undefined;
  for (let j = 0; j < args.length; j++) {
    const t = args[j]!.text;
    if (t === '--') { script = args[j + 1]; break; }
    if (t === '-' || !/^[-+]/u.test(t)) { script = args[j]; break; }
    options.push(args[j]!);
    if (takesValue(t)) j++;
  }
  if (options.some(w => /^-[A-Za-z]*s[A-Za-z]*$/u.test(w.text))) return null;
  return !script || stdinPath(script.text) ? null : undefined;
}

function sourceCode(args: readonly Word[], stdin: boolean): InnerSource {
  const file = args[0]?.text === '--' ? args[1] : args[0];
  if (stdin) return null;
  return !file || file.dynamic || stdinPath(file.text) ? null : undefined;
}

function cmdCode(args: readonly Word[], stdin: boolean): InnerSource {
  const at = args.findIndex(w => /^\/[ckr]$/iu.test(w.text));
  if (at < 0) return stdin || args.length > 0 ? null : undefined;
  const rest = args.slice(at + 1);
  if (rest.length === 0 || anyDynamic(rest) || rest.some(w => /[&|<>^%!()"#;,=]/u.test(w.text))) return null;
  return { text: rest.map(w => w.text).join(' '), shell: 'bash' };
}

function wrapped(program: string, args: readonly Word[], ps: boolean, shell: ShellKind): InnerSource {
  const valueFlags = program === 'xargs' ? XARGS_VALUES : WRAPPED_VALUE_FLAGS[program]!;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!.text;
    if (a === '--') { i++; break; }
    if (!a.startsWith('-')) break;
    i += valueFlags.has(a) ? 2 : 1;
  }
  if (program === 'timeout') i++;
  let rest = args.slice(i);
  if (program === 'parallel') { const stop = rest.findIndex(w => w.text === ':::'); if (stop >= 0) rest = rest.slice(0, stop); }
  if (rest.length === 0) return program === 'xargs' ? undefined : null;
  if (program === 'watch') return anyDynamic(rest) ? null : { text: rest.map(w => w.text).join(' '), shell: 'bash' };
  const text = joinWords(rest, ps);
  return { text: program === 'xargs' || program === 'parallel' ? `${text} ${PLACEHOLDER}` : text, shell };
}

function findExec(args: readonly Word[], shell: ShellKind): InnerSource {
  const parts: string[] = [];
  let tokens: string[] | undefined;
  for (const w of args) {
    if (tokens) {
      if (w.text === ';' || w.text === '+') { if (!tokens.length) return null; parts.push(tokens.join(' ')); tokens = undefined; continue; }
      tokens.push(w.text === '{}' ? PLACEHOLDER : quote(w, false));
    } else if (/^-(?:exec|execdir|ok|okdir)$/u.test(w.text)) tokens = [];
  }
  if (tokens) { if (!tokens.length) return null; parts.push(tokens.join(' ')); }
  return parts.length ? { text: parts.join(' ; '), shell } : undefined;
}

function envCommand(args: readonly Word[], shell: ShellKind): InnerSource {
  const assigns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (w.dynamic) return null;
    if (t === '-S' || t === '--split-string' || t.startsWith('--split-string=') || /^-S./u.test(t)) {
      const value = t === '-S' || t === '--split-string' ? args[++i]?.text : t.startsWith('-S') ? t.slice(2) : t.slice(t.indexOf('=') + 1);
      if (value === undefined) return null;
      return { text: [...assigns, value, joinWords(args.slice(i + 1), false)].join(' ').trim(), shell: 'bash' };
    }
    if (t === '-C' || t === '--chdir' || t.startsWith('--chdir=')) return null;
    if (t === '-u' || t === '--unset') { i++; continue; }
    if (t === '--') { const rest = args.slice(i + 1); return rest.length ? { text: [...assigns, joinWords(rest, false)].join(' '), shell } : undefined; }
    if (t.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(t)) { assigns.push(quote(w, false)); continue; }
    return { text: [...assigns, joinWords(args.slice(i), false)].join(' '), shell };
  }
  return undefined;
}

function prefixCommand(program: string, args: readonly Word[], ps: boolean, shell: ShellKind): InnerSource {
  const VALUE: Record<string, ReadonlySet<string>> = { exec: new Set(['-a']), time: new Set(['-f', '-o', '--format', '--output']), setsid: new Set(), nohup: new Set(), command: new Set(), unbuffer: new Set(), chronic: new Set(), builtin: new Set(), winpty: new Set(), '!': new Set(), coproc: new Set(), start: new Set() };
  if (program === 'command' && args.some(w => w.text === '-v' || w.text === '-V')) return undefined;
  let i = 0;
  while (i < args.length && args[i]!.text.startsWith('-')) {
    if (args[i]!.text === '--') { i++; break; }
    i += VALUE[program]!.has(args[i]!.text) ? 2 : 1;
  }
  const rest = args.slice(i);
  if (rest.length === 0) return program === 'nohup' || program === 'setsid' ? null : undefined;
  if (program === 'start' && rest.length === 1 && (rest[0]!.text === '.' || rest[0]!.text === '..')) return undefined;
  return { text: joinWords(rest, ps), shell };
}

function packageExec(program: string, args: readonly Word[], shell: ShellKind): InnerSource {
  const npx = program === 'npx' || program === 'pnpx';
  let i = 0;
  if (!npx) {
    while (i < args.length && args[i]!.text.startsWith('-')) i += PACKAGE_GLOBAL_VALUES.has(args[i]!.text) ? 2 : 1;
    const sub = args[i]?.text;
    if (sub !== 'exec' && !(program === 'npm' && sub === 'x')) return undefined;
    i++;
  }
  for (; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (t === '-c' || t === '--call' || t.startsWith('--call=')) {
      const value = t.startsWith('--call=') ? t.slice(7) : args[i + 1]?.text;
      const dyn = t.startsWith('--call=') ? w.dynamic : args[i + 1]?.dynamic;
      return value === undefined || dyn ? null : { text: value, shell: 'bash' };
    }
    if (t === '--') { i++; break; }
    if (t === '-p' || t === '--package' || t === '-w' || t === '--workspace') { i++; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  if (npx) return undefined;
  const rest = args.slice(i);
  return rest.length ? { text: joinWords(rest, shell === 'powershell' || shell === 'pwsh'), shell } : null;
}

function startProcess(args: readonly Word[]): InnerSource {
  let file: Word | undefined;
  const argList: Word[] = [];
  let mode: 'file' | 'args' | 'skip' | undefined;
  const positional: Word[] = [];
  for (const w of args) {
    const m = /^-([A-Za-z]+):?$/u.exec(w.text);
    const param = m && !w.dynamic ? START_PARAMS.find(p => p.startsWith(m[1]!.toLowerCase())) : undefined;
    if (param) { mode = param === 'filepath' ? 'file' : param === 'argumentlist' ? 'args' : ['wait', 'passthru', 'nonewwindow', 'loaduserprofile', 'usenewenvironment'].includes(param) ? undefined : 'skip'; continue; }
    if (mode === 'file') { file = w; mode = undefined; continue; }
    if (mode === 'args') { argList.push(w); continue; }
    if (mode === 'skip') { mode = undefined; continue; }
    positional.push(w);
  }
  if (!file) file = positional.shift();
  if (argList.length === 0) argList.push(...positional);
  if (!file || file.dynamic || anyDynamic(argList)) return null;
  const argText = argList.map(w => w.text.split(',').map(s => s.trim().replace(/^["']|["']$/gu, '')).join(' ')).join(' ');
  return { text: `${quote(file, false)} ${argText}`.trim(), shell: 'bash' };
}

function wslCommand(args: readonly Word[]): InnerSource {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (['-d', '--distribution', '-u', '--user', '--cd'].includes(t)) { i++; continue; }
    if (t === '-e' || t === '--exec' || t === '--') { const rest = args.slice(i + 1); return rest.length ? { text: joinWords(rest, false), shell: 'bash' } : null; }
    if (t.startsWith('-')) continue;
    const rest = args.slice(i);
    return anyDynamic(rest) ? null : { text: rest.map(w => w.text).join(' '), shell: 'bash' };
  }
  return null;
}

function gitInner(words: readonly Word[]): InnerSource {
  const at = gitGlobalOf(words).length + 1;
  const sub = words[at]?.text;
  const args = words.slice(at + 1);
  const raw = (rest: readonly Word[]): InnerSource => (rest.length === 0 || anyDynamic(rest) ? null : { text: rest.map(w => w.text).join(' '), shell: 'bash' });
  if (sub === 'submodule') {
    const fe = args.findIndex(w => !w.text.startsWith('-'));
    if (fe < 0 || args[fe]!.text !== 'foreach') return undefined;
    return raw(args.slice(fe + 1).filter(w => w.text !== '--recursive' && w.text !== '-q' && w.text !== '--quiet'));
  }
  if (sub === 'bisect') return args[0]?.text === 'run' ? raw(args.slice(1)) : undefined;
  if (sub === 'difftool' || sub === 'mergetool') {
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.text;
      if (t === '-x' || t === '--extcmd') return raw(args.slice(i + 1, i + 2));
      if (t.startsWith('--extcmd=')) return args[i]!.dynamic ? null : { text: t.slice(9), shell: 'bash' };
      if (/^-x./u.test(t)) return args[i]!.dynamic ? null : { text: t.slice(2), shell: 'bash' };
    }
  }
  return undefined;
}

export function innerSource(program: string, words: readonly Word[], shell: ShellKind, stdin: boolean): InnerSource {
  const args = words.slice(1);
  const ps = shell === 'powershell' || shell === 'pwsh';
  if (SHELLS.test(program)) return shellCode(args, stdin);
  if (POWERSHELL.test(program)) return powershellCode(args, stdin);
  if (program === 'cmd') return cmdCode(args, stdin);
  if (program === 'iex' || program === 'invoke-expression') return args.length === 0 || anyDynamic(args) ? null : { text: args.map(w => w.text).join(' '), shell: 'powershell' };
  if (program === 'eval') return args.length === 0 || anyDynamic(args) ? null : { text: args.map(w => w.text).join(' '), shell };
  if (program === '.' || program === 'source') return sourceCode(args, stdin);
  if (program === 'find') return findExec(args, shell);
  if (WRAPPED_VALUE_FLAGS[program]) return wrapped(program, args, ps, shell);
  if (program === 'env') return envCommand(args, shell);
  if (['exec', 'time', 'setsid', 'nohup', 'command', 'unbuffer', 'chronic', 'winpty', '!', 'coproc', 'builtin'].includes(program) || (program === 'start' && !ps)) return prefixCommand(program, args, ps, shell);
  if (program === 'forfiles') return null;
  if (['npm', 'pnpm', 'yarn', 'npx', 'pnpx'].includes(program)) return packageExec(program, args, shell);
  if (program === 'git') return gitInner(words);
  if (START_PROCESS.has(program) && (ps || program !== 'start')) return startProcess(args);
  if (program === 'wsl') return wslCommand(args);
  if (SPAWNERS_WITH_BLOCKS.has(program)) return words.some(w => w.kind === 'block') ? undefined : null;
  return undefined;
}

const CODE_LETTERS: Readonly<Record<string, string>> = { node: 'ep', nodejs: 'ep', bun: 'ep', perl: 'eE', ruby: 'e', php: 'r', py: 'c' };
const LONG_CODE: Readonly<Record<string, readonly string[]>> = { node: ['--eval', '--print'], nodejs: ['--eval', '--print'], bun: ['--eval', '--print'] };
const AWK = /^(?:awk|gawk|mawk|nawk)$/u;

export function inlineCode(program: string, words: readonly Word[]): { code: string[]; dynamic: boolean } {
  const args = words.slice(1);
  const out: string[] = [];
  let dynamic = false;
  const take = (w: Word | undefined): void => { if (w) { out.push(w.text); dynamic ||= w.dynamic; } else dynamic = true; };
  if (program === 'deno') { if (args[0]?.text === 'eval') take(args[1]); return { code: out, dynamic }; }
  if (AWK.test(program)) {
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.text;
      if (t === '-f' || t === '--file') { if (stdinPath(args[i + 1]?.text ?? '-') || args[i + 1]?.dynamic) dynamic = true; return { code: out, dynamic }; }
      if (/^(?:-f.|--file=)/u.test(t)) { if (stdinPath(t.replace(/^(?:-f|--file=)/u, '')) || args[i]!.dynamic) dynamic = true; return { code: out, dynamic }; }
      if (t === '-e' || t === '--source') { take(args[i + 1]); return { code: out, dynamic }; }
      if (t.startsWith('--source=')) { out.push(t.slice(9)); dynamic ||= args[i]!.dynamic; return { code: out, dynamic }; }
      if (t === '--') { take(args[i + 1]); break; }
      if (t === '-F' || t === '-v') { i++; continue; }
      if (t.startsWith('-')) continue;
      take(args[i]);
      break;
    }
    return { code: out, dynamic };
  }
  if (SHELLS.test(program) || POWERSHELL.test(program) || program === 'cmd') {
    const src = innerSource(program, words, 'bash', false);
    return { code: src ? [src.text] : [], dynamic: src === null };
  }
  const letters = /^python[\d.]*$/u.test(program) ? 'c' : CODE_LETTERS[program];
  if (!letters) return { code: [], dynamic: false };
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (program === 'perl' && /^-[Mm]./u.test(t)) { out.push(t.slice(2)); dynamic ||= w.dynamic; continue; }
    const long = LONG_CODE[program]?.find(f => t === f || t.startsWith(`${f}=`));
    if (long) { if (t === long) take(args[++i]); else { out.push(t.slice(long.length + 1)); dynamic ||= w.dynamic; } continue; }
    const m = /^-([A-Za-z]+)(.*)$/su.exec(t);
    if (!m || t.startsWith('--')) continue;
    const cluster = m[1]! + m[2]!;
    const at = [...cluster].findIndex(ch => letters.includes(ch));
    if (at < 0) continue;
    const rest = letters.includes(cluster.at(-1)!) ? '' : cluster.slice(at + 1);
    if (rest) { out.push(rest); dynamic ||= w.dynamic; } else take(args[++i]);
  }
  return { code: out, dynamic };
}

const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);

export function gitGlobalOf(words: readonly Word[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < words.length && !words[i]!.dynamic && /^-/u.test(words[i]!.text); i++) {
    out.push(words[i]!.text);
    if (GIT_VALUE_GLOBALS.has(words[i]!.text) && words[i + 1]) out.push(words[++i]!.text);
  }
  return out;
}

export function programOdd(text: string, name: string): boolean {
  if (text === '.') return false;
  const normal = posix.normalize(text.replaceAll('\\', '/')).replace(/[/. ]+$/u, '');
  return (posix.basename(normal).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/u, '')) !== name;
}
