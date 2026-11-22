import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse as parsePath, posix, resolve } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import type { AskKind } from '../types.ts';
import { askKindOf } from './ask-kinds.ts';
import { entryMatches, parseAllowEntry } from './allow-entry.ts';
import { classifyStatements, matchStatement, noRepo, type CdUse, type CopyUse, type MatchCtx, type PathRef, type Reason, type RepoInfo } from './allowlist.ts';
import { codeFindings, unshownCodeOf } from './code-guard.ts';
import { gitGlobalOf, inlineCode, innerSource, joinWords, programOdd, type DeleteTarget, type StatementFacts } from './shell-facts.ts';
import { isCdHead } from './allowlist-core.ts';
import { gitSubcommand } from './allowlist-git.ts';
import { inspectRepo } from './git-repo.ts';
import { segments, splitCommand } from './parse-cmd.ts';
import { containsGitDir, exists, expandGlob, isDirectory, listTree, protectedInside, wildcardMatches } from './path-expand.ts';
import { containsToolConfig, curlConfigFile, isToolConfigPath, npmProjectConfigFile, wgetConfigFile, type Env } from './tool-config.ts';
import { expandPath, inDependencies, isInside, isSecretPath, placePath, realish, windowsNames, writeApprovalKind, type Expanded, type Placement, type ProtectedKind, type ScopePolicy, type SecretScope } from './scope.ts';
import { isPowerShell, type LexFail, type ShellKind, type Statement, type Word } from './shell-lex.ts';

export type Decision = 'allow' | 'ask' | 'deny';
const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
export const worst = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

export interface ShellGuardOptions {
  policy: ScopePolicy;
  outsideRoots: 'ask' | 'deny';
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
  // OS（既定は動いている OS）。shell の既定: Windows は powershell、それ以外は bash
  windows?: boolean;
  shell?: ShellKind;
  language?: Language;
  // server.origins の host。Tailscale の URL なども beat 自身に届くので、ループバックと同じに確かめる
  selfHosts?: readonly string[];
  // C2: 子プロセスの PATH で、名前から実際に起動されるファイル。許可フォルダ・データのフォルダの中なら、その名前の一覧はすべて今回だけ
  which?: (name: string) => string | undefined;
  dataDir?: string;
  // 子プロセスの環境変数（ツールの設定ファイルの場所に使う。既定は動いているプロセスのもの）
  env?: Env;
  // git をホーム・システムの設定の洗い出しつきで動かせるか（既定は true。shell.ts は実際の git の版から渡す）
  gitIsolated?: boolean;
  depth?: number;
  // 包むコマンドの中を調べるとき、それより前の文が外から取得したか
  fetchedBefore?: boolean;
  // 包むコマンドの中を調べるとき、外の文が今いられるフォルダ
  cwdState?: CwdState;
  productEnv?: (name: string) => boolean;
  productEnvPath?: (value: string) => boolean;
}

// now: 次の文が動きうるフォルダ。all: これまでにいられたすべてのフォルダ。known: cd の先をすべて決められたか（変数・ワイルドカード・決められない先、また動く本体の中の cd で false）。
// 動いたか分からない cd、決められない cd でも、フォルダを now・all から消さず、確かめも飛ばさない
// open: いま中にいる bash のサブシェル（( ) $( )）と、入ったときの now・known。出たら戻す（中の cd は外に残らない）。changed: 前の文が書いた・消した（cd の先が今あっても、そのときには無いかもしれない）
interface CwdTrack { now: string[]; all: string[]; known: boolean; open: Array<{ id: number; now: string[]; known: boolean }>; changed: boolean }
export interface CwdState { now: readonly string[]; all: readonly string[]; known: boolean }
const CWD_CAP = 32;
const CWD_ALL_CAP = 256;

export interface CheckedPath { input: string; path?: string; placement: Placement | { kind: 'unresolved'; reason: string }; write: boolean }

export interface ShellVerdict {
  decision: Decision;
  reasons: string[];
  paths: CheckedPath[];
  // コードを動かす確かめ（種類 'code'）を含む。会話の許可を越えず、毎回確かめる
  onceOnly: boolean;
  // 確かめで中身を見せるファイルの絶対パス（3 つまで）
  scripts: string[];
  unshown?: string;
  // ふつうの確かめ・今回だけの確かめになった理由の種類（理由ごとに付く。自動承認が判定役に回すかの材料）
  askKinds: AskKind[];
  // 見せたファイルのほかに、読み込まれるファイルや入れた部品のコードも動く（札に限界の文を添える）
  limits: boolean;
  // コマンドの git がすべて、設定に core.hooksPath の無い 1 つのリポジトリのもので、そのリポジトリ自身のフックの置き場所（.git/hooks）。そうでなければ null
  ownHooksDir: string | null;
  // コマンドのどれかが外から取得する（curl・wget・Invoke-WebRequest など）か、外の中身を持ち込む（git の fetch・pull・clone・ls-remote・submodule、パッケージの導入）。実行すると外の中身を読むので、パイプラインは「外から読んだ」印を付ける
  fetched: boolean;
  // fetched のうち、外から取得するもの（curl・wget など）だけ。git の取得やパッケージの導入は含めない（取ってきたものを動かす形の禁止に使う）
  downloaded: boolean;
  statements: StatementFacts[];
  writes: string[];
  reasonKeys: string[];
}

export type { DeleteTarget, FactWord, StatementFacts } from './shell-facts.ts';

interface Said { key: string; text: string }
const STDIN_OPS: ReadonlySet<string> = new Set(['<', '<<', '<<<', '<<-']);

const URL_IN_WORD = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/giu;
const HARD_DENY_CMDS = new Map<string, GuardMessageKey>([
  ['mkfs', 'hard.fs_create'], ['format', 'hard.disk_format'], ['diskpart', 'hard.disk_ops'], ['fdisk', 'hard.disk_ops'],
  ['parted', 'hard.disk_ops'], ['shutdown', 'hard.os_stop'], ['reboot', 'hard.os_restart'], ['halt', 'hard.os_stop'], ['poweroff', 'hard.os_stop'],
  ['stop-computer', 'hard.os_stop'], ['restart-computer', 'hard.os_restart'], ['bcdedit', 'hard.boot'], ['vssadmin', 'hard.shadow'],
  ['set-executionpolicy', 'hard.exec_policy'], ['reg', 'hard.registry'], ['regedit', 'hard.registry'], ['takeown', 'hard.ownership'],
  ['passwd', 'hard.password'], ['useradd', 'hard.user_add'], ['userdel', 'hard.user_del'], ['net', 'hard.net'],
  ['crontab', 'hard.schedule'], ['schtasks', 'hard.schedule'], ['register-scheduledtask', 'hard.schedule'],
  ['format-volume', 'hard.disk_format'], ['initialize-volume', 'hard.disk_format'], ['new-volume', 'hard.disk_format'],
  ['mke2fs', 'hard.fs_create'], ['mkswap', 'hard.fs_create'], ['mkntfs', 'hard.fs_create'], ['mkdosfs', 'hard.fs_create'],
  ['clear-disk', 'hard.disk_wipe'], ['reset-physicaldisk', 'hard.disk_wipe'], ['remove-virtualdisk', 'hard.disk_wipe'], ['remove-storagepool', 'hard.disk_wipe'], ['remove-physicaldisk', 'hard.disk_wipe'],
  ['wipefs', 'hard.disk_wipe'], ['blkdiscard', 'hard.disk_wipe'],
  ['initialize-disk', 'hard.disk_ops'], ['set-disk', 'hard.disk_ops'], ['new-partition', 'hard.disk_ops'], ['remove-partition', 'hard.disk_ops'],
  ['set-partition', 'hard.disk_ops'], ['resize-partition', 'hard.disk_ops'], ['gdisk', 'hard.disk_ops'], ['sgdisk', 'hard.disk_ops'], ['sfdisk', 'hard.disk_ops'], ['cfdisk', 'hard.disk_ops'],
  ['wbadmin', 'hard.backup'],
]);

function hardDenyOf(name: string, words: readonly string[]): GuardMessageKey | undefined {
  const fixed = HARD_DENY_CMDS.get(name) ?? (name.startsWith('mkfs') ? 'hard.fs_create' : undefined);
  if (fixed) return fixed;
  const args = words.slice(1);
  if (name === 'cipher' && args.some(a => /^\/w(?::|$)/iu.test(a))) return 'hard.disk_wipe';
  if (name === 'fsutil' && args[0]?.toLowerCase() === 'file' && args[1]?.toLowerCase() === 'setzerodata') return 'hard.disk_wipe';
  if (name === 'shred' && args.some(a => !a.startsWith('-') && posix.normalize(a).startsWith('/dev/'))) return 'hard.disk_wipe';
  if (CIM_METHOD_CMDS.has(name) && args.some(a => DISK_METHODS.test(a.replace(/^-[A-Za-z]+:/u, '')))) return 'hard.disk_wipe';
  const lower = args.map(a => a.toLowerCase());
  if (name === 'wmic' && lower.some((a, i) => a === 'call' && lower[i + 1] === 'format')) return 'hard.disk_format';
  if (name.startsWith('newfs')) return 'hard.fs_create';
  const positional = lower.filter(a => !a.startsWith('-'));
  if (name === 'diskutil' && (DISKUTIL_WIPE.test(positional[0] ?? '') || (positional[0] === 'apfs' && DISKUTIL_APFS_WIPE.test(positional[1] ?? '')))) return 'hard.disk_wipe';
  if (name === 'gpt' && positional[0] === 'destroy') return 'hard.disk_ops';
  if (name === 'asr' && lower.some(a => a === '--erase' || a === '-erase')) return 'hard.disk_wipe';
  return undefined;
}

const CIM_METHOD_CMDS: ReadonlySet<string> = new Set(['invoke-cimmethod', 'icim', 'invoke-wmimethod', 'iwmi']);
const DISK_METHODS = /^(?:format|clear|initialize|deleteobject|createpartition)$/iu;
const DISKUTIL_WIPE = /^(?:erase\w*|zerodisk|randomdisk|secureerase|partitiondisk|reformat)$/iu;
const DISKUTIL_APFS_WIPE = /^(?:deletecontainer|erasevolume|deletevolume)$/iu;
const ALIAS_CMDS: ReadonlySet<string> = new Set(['set-alias', 'new-alias', 'sal', 'nal']);
const ITEM_CMDS: ReadonlySet<string> = new Set(['set-item', 'si', 'new-item', 'ni']);
const COMMON_VALUED = ['erroraction', 'warningaction', 'informationaction', 'progressaction', 'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable'];
const COMMON_VALUED_ALIASES: ReadonlySet<string> = new Set(['ea', 'wa', 'infa', 'proga', 'ev', 'wv', 'iv', 'ov', 'ob', 'pv']);

const programNameOf = (text: string): string => (text.split(/[\\/]/u).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/u, '');

const systemToolOf = (text: string): string => (text.split(/[\\/]/u).pop() ?? '').toLowerCase().replace(/\.(?:exe|com)$/u, '');

function aliasValue(args: readonly string[]): string | undefined {
  const positional: string[] = [];
  let named = false;
  for (let i = 0; i < args.length; i++) {
    const m = /^-([A-Za-z]+)(:?)(.*)$/u.exec(args[i]!);
    if (!m) { positional.push(args[i]!); continue; }
    const param = m[1]!.toLowerCase();
    const value = m[2] ? m[3] || args[++i] : undefined;
    if ('value'.startsWith(param)) return value ?? args[i + 1];
    if ('name'.startsWith(param)) { named = true; if (!m[2]) i++; continue; }
    if ((['scope', 'option', 'description', ...COMMON_VALUED].some(p => p.startsWith(param)) || COMMON_VALUED_ALIASES.has(param)) && !m[2]) i++;
  }
  return positional[named ? 0 : 1];
}

interface HardHit { key: GuardMessageKey; cmd: string }

function hardOfWords(words: readonly string[], depth = 0): HardHit | undefined {
  const name = systemToolOf(words[0] ?? '');
  if (!name) return undefined;
  if (name === 'cmd') return depth < 3 ? cmdHard(words.slice(1), depth + 1) : undefined;
  if (ALIAS_CMDS.has(name)) {
    const value = aliasValue(words.slice(1));
    return value && depth < 3 ? hardOfWords([value], depth + 1) : undefined;
  }
  if (ITEM_CMDS.has(name) && depth < 3 && words.some(w => /^(?:-[A-Za-z]+:)?alias:/iu.test(w))) {
    return words.slice(1).map(w => w.replace(/^-[A-Za-z]+:/u, '')).filter(w => w && !w.startsWith('-') && !/^alias:/iu.test(w))
      .map(w => hardOfWords([w], depth + 1)).find(Boolean);
  }
  const key = hardDenyOf(name, words);
  return key ? { key, cmd: name } : undefined;
}

const CMD_LEADS: ReadonlySet<string> = new Set(['@', 'call', 'do', 'else']);

const CMD_IF_TESTS: ReadonlySet<string> = new Set(['exist', 'defined', 'errorlevel', 'cmdextversion']);
const CMD_COMPARE: ReadonlySet<string> = new Set(['equ', 'neq', 'lss', 'leq', 'gtr', 'geq', '==']);

function cmdRemainder(args: readonly string[]): string[] | undefined {
  for (const [i, arg] of args.entries()) {
    if (!arg.startsWith('/')) continue;
    const pieces = arg.split(/(?=\/)/u);
    const at = pieces.findIndex(p => /^\/[ckr]/iu.test(p));
    if (at < 0) continue;
    const joined = pieces[at]!.slice(2) + pieces.slice(at + 1).join('');
    return [...(joined ? [joined] : []), ...args.slice(i + 1)];
  }
  return undefined;
}

function cmdCondition(tokens: string[]): string[] {
  while (tokens[0]?.toLowerCase() === 'if') {
    let i = 1;
    while (tokens[i] && ['/i', 'not'].includes(tokens[i]!.toLowerCase())) i++;
    const a = tokens[i]?.toLowerCase() ?? '';
    const b = tokens[i + 1]?.toLowerCase() ?? '';
    if (CMD_IF_TESTS.has(a)) i += 2;
    else if (CMD_COMPARE.has(b)) i += 3;
    else if (a.endsWith('==')) i += 2;
    else if (b.startsWith('==')) i += 2;
    else i += 1;
    tokens = tokens.slice(i);
    while (tokens.length && CMD_LEADS.has(tokens[0]!.toLowerCase())) tokens.shift();
  }
  return tokens;
}

function cmdHeadHard(tokens: readonly string[], depth: number): HardHit | undefined {
  const first = tokens[0] ?? '';
  const slash = first.indexOf('/');
  if (slash > 0) {
    const hit = hardOfWords([first.slice(0, slash), first.slice(slash), ...tokens.slice(1)], depth);
    if (hit) return hit;
  }
  return hardOfWords(tokens, depth);
}

function cmdParts(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  let open = 0;
  const flush = () => { parts.push(part); part = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '&' || ch === '|' || ch === '\r' || ch === '\n') { if (text[i + 1] === ch) i++; flush(); continue; }
    if (ch === '(') {
      const words = part.trim().toLowerCase().split(/\s+/u).map(w => w.replace(/^@+/u, '')).filter(Boolean);
      const last = words.at(-1) ?? '';
      while (words.length && CMD_LEADS.has(words[0]!)) words.shift();
      if (words.length === 0 || words[0] === 'if' || ['do', 'else', 'in'].includes(last)) { flush(); open++; continue; }
    }
    if (ch === ')' && open > 0) { open--; flush(); continue; }
    part += ch;
  }
  flush();
  return parts;
}

// cmd reads ( and ) inside "…" as plain text, so they are blanked before the parts are cut (^ outside quotes escapes the next character)
function blankQuotedParens(text: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\r' || ch === '\n') quoted = false;
    else if (ch === '^' && !quoted && i + 1 < text.length) { out += ch + text[++i]; continue; }
    else if (ch === '"') quoted = !quoted;
    out += quoted && (ch === '(' || ch === ')') ? ' ' : ch;
  }
  return out;
}

function cmdHard(args: readonly string[], depth: number): HardHit | undefined {
  const rest = cmdRemainder(args);
  if (!rest) return undefined;
  const text = blankQuotedParens(rest.join(' ')).replace(/\^(.)/gsu, '$1').replace(/"/gu, ' ')
    .replace(/\d?>>?\s*(?:&\d|[^\s&|()<>]+)?|<\s*[^\s&|()<>]+/gu, ' ');
  for (const part of cmdParts(text)) {
    let tokens = part.split(/[\s,;]+/u).map(w => w.replace(/^@+/u, '')).filter(Boolean);
    while (tokens.length && CMD_LEADS.has(tokens[0]!.toLowerCase())) tokens.shift();
    if (tokens[0]?.toLowerCase() === 'start') { tokens.shift(); while (tokens[0]?.startsWith('/')) tokens.shift(); }
    tokens = cmdCondition(tokens).join(' ').split(/[\s,;=]+/u).filter(Boolean);
    const hit = cmdHeadHard(tokens, depth);
    if (hit) return hit;
  }
  return undefined;
}
const ELEVATE = /^\s*\(?\s*(?:sudo|doas|su|runas|pkexec)(?:\.exe)?\b/iu;
// 文の頭を見る ELEVATE は、PowerShell の本体の中（try { sudo … }・return sudo …）の文を見ないので、文ごとにも見る
const ELEVATE_NAMES: ReadonlySet<string> = new Set(['sudo', 'doas', 'su', 'runas', 'pkexec']);
const FORK_BOMB = /:\s*\(\s*\)\s*\{/u;
// 外の中身を持ち込む git のサブコマンド（NET のうち、通信するもの。init と worktree は含めない）
const PULLING_GIT: ReadonlySet<string> = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'submodule']);
const SHELL_SINKS = new Set(['sh', 'bash', 'zsh', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby']);
const WRITE_KEYS: Record<ProtectedKind, GuardMessageKey> = { persona: 'guard.write_persona', skill: 'guard.write_skill', git: 'guard.write_git', instructions: 'guard.write_instructions' };
const START_PROCESS_NAMES: ReadonlySet<string> = new Set(['start-process', 'saps', 'start']);
const CWD_CMDS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);

function isCriticalTarget(abs: string, policy: ScopePolicy): boolean {
  const root = parsePath(abs).root;
  if (root && (abs === root || abs.replace(/[\\/]+$/u, '') === root.replace(/[\\/]+$/u, ''))) return true;
  if (isInside(abs, homedir())) return true;
  return policy.roots.some(r => isInside(abs, r.path));
}

// 持ち主が書いた tools.shell.deny / ask は、語の並びの頭が一致するかで見る（大文字小文字は問わない）
function matchesPrefix(words: readonly string[], prefixes: readonly string[] | undefined): string | undefined {
  if (!prefixes?.length) return undefined;
  const normalized = words.join(' ').toLowerCase();
  return prefixes.find(p => normalized === p.toLowerCase() || normalized.startsWith(`${p.toLowerCase()} `));
}

// expandPath が展開できない変数の形（$1 $0 $@ $* $! $? $$ $^ $: ${1} と非 ASCII の名前）。空になりうるので、含むパスは決まらない
const UNEXPANDABLE_VAR = /\$(?![A-Za-z_]|\{[A-Za-z_][A-Za-z0-9_]*\})(?=[\p{L}\p{Nd}?$^:@*#!{(-])/u;

// 語が指すパス。リテラルは $ や % を展開しない（シェルも展開しない）。変数を含むものは既知の変数だけ展開する
export function resolveWord(word: Word, base: string, windows: boolean, language: Language): Expanded {
  if (word.dynamic) {
    const m = UNEXPANDABLE_VAR.exec(word.text);
    if (m) return { unresolved: guardText(language, 'scope.unknown_env', { name: [...word.text.slice(m.index, m.index + 4)].slice(0, 2).join('') }) };
  }
  const text = word.dynamic ? word.text : word.text.replace(/[$%`]/gu, '_');
  const expanded = expandPath(text, base, process.env, language);
  if ('unresolved' in expanded) return expanded;
  return { path: windows ? windowsNames(expanded.path) : expanded.path };
}

// ワイルドカードを含む語の、絶対パスのパターン
function patternOf(word: Word, base: string, windows: boolean): string {
  const text = word.text.replace(/[$%`]/gu, '_');
  const abs = text === '~' || text.startsWith('~/') || text.startsWith('~\\') ? join(homedir(), text.slice(2)) : resolve(base, text);
  return windows ? windowsNames(abs) : abs;
}

const URLISH = /^[a-z][a-z0-9+.-]*:\/\//iu;
const NULL_SINKS = /^(?:\/dev\/null|\$null|nul)$/iu;
const PATH_START = /^(?:[~./\\]|[A-Za-z]:)/u;

// 一覧の表で引数の意味が分からないコマンド（今回だけ）でも、禁止の一覧・秘密のパスに当たる引数は止める（11.1 の 4）
function suspectPaths(words: readonly Word[]): string[] {
  const out: string[] = [];
  for (const [i, w] of words.entries()) {
    if (i === 0 || w.kind !== 'plain') continue;
    let token = w.text;
    if (token.startsWith('-')) {
      const m = /^-[A-Za-z]+:(.+)$/u.exec(token) ?? /^--?[A-Za-z][\w-]*=(.+)$/u.exec(token);
      if (!m || !PATH_START.test(m[1]!)) continue;
      token = m[1]!;
    } else {
      const eq = /^[A-Za-z_][\w-]*=(.+)$/u.exec(token);
      if (eq) { if (!PATH_START.test(eq[1]!)) continue; token = eq[1]!; }
    }
    if (!token || token === '-' || token === '{}' || URLISH.test(token) || NULL_SINKS.test(token) || /^-?\d+(?:\.\d+)?[kKmMgG]?$/u.test(token)) continue;
    if (/\s/u.test(token) && !PATH_START.test(token)) continue;
    // 名前:ストリーム の形（ADS）は、名前のところで調べる。fix:thing のような語は名前だけを見る
    const colon = token.indexOf(':');
    out.push(colon > 1 && !/^[A-Za-z]:[\\/]/u.test(token) ? token.slice(0, colon) : token);
  }
  return out;
}

const lexDetail = (language: Language, fail: LexFail): string => guardText(language, `lex.${fail.code}`, { detail: fail.detail });

export function checkShellCommand(command: string, initialCwd: string, opts: ShellGuardOptions): ShellVerdict {
  const windows = opts.windows ?? process.platform === 'win32';
  const shell: ShellKind = opts.shell ?? (windows ? 'powershell' : 'bash');
  const language = opts.language ?? DEFAULT_LANGUAGE;
  const text = (key: GuardMessageKey, params?: Record<string, string | number>) => guardText(language, key, params);
  const say = (key: GuardMessageKey, params?: Record<string, string | number>): Said => ({ key, text: text(key, params) });
  let decision: Decision = 'allow';
  const reasons: string[] = [];
  const reasonKeys: string[] = [];
  const statements: StatementFacts[] = [];
  const writes: string[] = [];
  let current: StatementFacts | undefined;
  const paths: CheckedPath[] = [];
  const scripts: string[] = [];
  let unshown: string | undefined;
  const addScript = (file: string): void => {
    if (scripts.includes(file)) return;
    if (scripts.length < 3) scripts.push(file);
    else unshown ??= file;
  };
  const askKinds: AskKind[] = [];
  const selfHosts = opts.selfHosts ?? [];
  const env: Env = opts.env ?? process.env;
  let limits = false;
  let fetched = opts.fetchedBefore ?? false;
  // 外の中身を持ち込むコマンド（git の取得・パッケージの導入）。curl などと違い、取ってきたものを動かす形を新しく止める（download_exec）ことはしないので、fetched とは別に持つ
  let pulled = false;
  // ask の理由には種類を付ける。付けなければ precheck（細かい種類なし）で、自動承認の判定役には回らない
  const add = (d: Decision, said: Said, kind: AskKind = 'precheck') => {
    decision = worst(decision, d);
    if (!reasons.includes(said.text)) { reasons.push(said.text); reasonKeys.push(said.key); }
    if (d === 'ask' && !askKinds.includes(kind)) askKinds.push(kind);
  };
  const addCode = (said: Said) => add('ask', said, 'code');
  // PowerShell の代入の右辺・@{ } の値の文（文字の分け方〔segments〕では見えないので、説明のときに文の語から調べ直す）
  let assignedStatements: Statement[] = [];
  // コマンドの git が調べたリポジトリ。持ち主が許したときに、そのリポジトリ自身のフックだけを動かせるかを決める
  const repoLog: { repos: RepoInfo[]; unsafe: boolean } = { repos: [], unsafe: false };
  const ownHooksDir = (): string | null => {
    const found = repoLog.repos.filter(r => r.found);
    if (repoLog.unsafe || found.length === 0 || found.some(r => r.unreadable || !r.configOk || r.hooksPath || !r.hooksDir)) return null;
    const dirs = new Set(found.map(r => r.hooksDir));
    return dirs.size === 1 ? [...dirs][0]! : null;
  };
  const done = (): ShellVerdict => {
    const onceOnly = askKinds.includes('code') && decision !== 'deny';
    if (onceOnly) explainWithCodeGuard();
    return {
      decision, reasons, paths, onceOnly: askKinds.includes('code'), scripts, ...(unshown !== undefined ? { unshown } : {}), askKinds, limits: limits || scripts.length > 0, ownHooksDir: ownHooksDir(), fetched: fetched || pulled, downloaded: fetched,
      statements, writes, reasonKeys,
    };
  };

  // 今回だけにした理由を、より分かる文（ファイルのコードを動かします など）と、中身を見せるファイルで補う（判定は変えない）
  function explainWithCodeGuard(): void {
    let cwd = initialCwd;
    const segs = segments(command, { backticks: !windows });
    for (const [i, seg] of segs.entries()) {
      unshown ??= unshownCodeOf(seg, cwd);
      for (const found of codeFindings(seg, { cwd, language, selfHosts, prev: seg.stdin === 'pipe' ? segs[i - 1] : undefined })) {
        if (!reasons.includes(found.reason)) { reasons.push(found.reason); reasonKeys.push(found.key); }
        for (const file of found.scripts) addScript(file);
      }
      if (CWD_CMDS.has(seg.cmd)) {
        const target = seg.args.find(a => !a.startsWith('-'));
        const e = target ? expandPath(target, cwd, process.env, language) : undefined;
        if (e && 'path' in e) cwd = e.path;
      }
    }
    for (const st of assignedStatements) {
      for (const seg of segments(joinWords(st.words, true))) {
        unshown ??= unshownCodeOf(seg, initialCwd);
        for (const found of codeFindings(seg, { cwd: initialCwd, language, selfHosts })) {
          if (!reasons.includes(found.reason)) { reasons.push(found.reason); reasonKeys.push(found.key); }
          for (const file of found.scripts) addScript(file);
        }
      }
    }
  }

  if (!command.trim()) { add('deny', say('guard.empty')); return done(); }
  if (FORK_BOMB.test(command)) add('deny', say('guard.fork_bomb'));
  if (splitCommand(command).some(part => ELEVATE.test(part))) add('deny', say('guard.elevate'));

  const resolved = new Map<string, string | undefined>();
  const external: MatchCtx['external'] = opts.which ? (name: string) => {
    if (!resolved.has(name)) resolved.set(name, opts.which!(name));
    const found = resolved.get(name);
    if (!found) return { ok: true, ext: '.exe', detail: '' };
    const real = realish(found);
    const roots = [...opts.policy.roots.map(r => r.path), ...(opts.dataDir ? [opts.dataDir] : [])];
    const ext = extname(found).toLowerCase();
    const inside = roots.find(p => isInside(p, real) || isInside(p, found));
    if (inside) return { ok: false, ext, detail: found };
    if (windows && !['.exe', '.com'].includes(ext) && !(['.cmd', '.bat'].includes(ext) && /^(?:npm|pnpm|yarn)$/u.test(name))) return { ok: false, ext, detail: found };
    return { ok: true, ext, detail: '' };
  } : undefined;
  // 許可の一覧の判定は文の順に進む。リポジトリの設定・curl の設定ファイルは、そのとき cd でいられるすべてのフォルダ（最初と、cd で動いた先すべて）で調べる。
  // cd の先が分からなければ（変数・ワイルドカード・cd -・popd など）、調べられないので今回だけ。
  // seen は分類の判定（リポジトリ・設定ファイル）に、track はパスの確かめ（下の文ごとの並び）に使う。どちらも同じ決まりで進む
  const startTrack = (): CwdTrack => (opts.cwdState
    ? { now: [...opts.cwdState.now], all: [...opts.cwdState.all], known: opts.cwdState.known, open: [], changed: false }
    : { now: [initialCwd], all: [initialCwd], known: true, open: [], changed: false });
  const seen = startTrack();
  const track = startTrack();
  // 文が入っているサブシェルの並び（外から内）に合わせる: 出たサブシェルは入ったときのフォルダに戻し、入ったサブシェルは今のフォルダを覚える
  // 戻したあとは、その文から始まるまた動く本体の入口（entries）を足し直す（戻すと入口の分が消えるため）
  const enterScope = (t: CwdTrack, st: Statement, index: number): void => {
    const chain = st.subshells ?? [];
    let left = false;
    while (t.open.length && !chain.includes(t.open.at(-1)!.id)) { const o = t.open.pop()!; t.now = o.now; t.known = o.known; left = true; }
    if (left) enter(t, index);
    for (const id of chain) if (!t.open.some(o => o.id === id)) t.open.push({ id, now: [...t.now], known: t.known });
  };
  const changes = (r: { paths: readonly PathRef[]; copies: readonly CopyUse[]; deletes: boolean }): boolean => r.deletes || r.copies.length > 0 || r.paths.some(p => p.mode === 'write');
  // maybe: 動いたか分からない cd（前のフォルダも残す）。again: また動きうる本体の中の cd（このあとのフォルダは決められない）。
  // 今は無いフォルダ（前の文が書いた・消したなら、あるフォルダでも）への cd は失敗しうる。失敗すれば次の文は元のフォルダで動くので、元も残す
  const followCd = (t: CwdTrack, cd: CdUse, maybe: boolean, again: boolean): void => {
    if (again) t.known = false;
    if (!cd.word || cd.word.dynamic || cd.word.glob) { t.known = false; return; }
    const next = maybe || cd.maybe ? [...t.now] : [];
    for (const from of t.now) {
      const e = resolveWord(cd.word, from, windows, language);
      if ('unresolved' in e) t.known = false;
      const to = 'unresolved' in e ? from : e.path;
      if (!next.includes(to)) next.push(to);
      if ((t.changed || !isDirectory(to)) && !next.includes(from)) next.push(from);
    }
    const added = next.filter(p => !t.all.includes(p));
    // 同時にありうるフォルダは CWD_CAP まで、これまでに通ったフォルダは CWD_ALL_CAP まで。超えたら断る（すべてを見きれないため）
    if (next.length > CWD_CAP || t.all.length + added.length > CWD_ALL_CAP) { t.known = false; add('deny', say('guard.cwd_many', { max: next.length > CWD_CAP ? CWD_CAP : CWD_ALL_CAP })); return; }
    t.now = next;
    t.all.push(...added);
  };
  // また動きうる本体（ループ・関数・trap・スクリプトブロック）の中の cd は、その本体の入口の前にも足す（2 回目に動くときは、その先から始まる）
  const entries = new Map<number, Array<{ word: Word | null }>>();
  const beforeStatements: MatchCtx['beforeStatements'] = all => {
    for (const st of all) {
      const head = st.words[0];
      if (st.reentry === undefined || !head || head.dynamic || !isCdHead(head.text)) continue;
      const cd = matchStatement(st, { shell, windows, repo: noRepo, selfHosts }).cwd;
      if (!cd) continue;
      const list = entries.get(st.reentry) ?? [];
      list.push(cd);
      entries.set(st.reentry, list);
    }
  };
  const enter = (t: CwdTrack, index: number): void => { for (const cd of entries.get(index) ?? []) followCd(t, cd, true, true); };
  const unresolvedRepo = (badKey: string): RepoInfo => { repoLog.unsafe = true; return { found: true, configOk: false, badKey, unreadable: false, hooksPath: false, hooksFiles: false, hooksDir: '', remotes: [], localRemotes: [] }; };
  const inspect = (path: string): RepoInfo => { const info = inspectRepo(path); repoLog.repos.push(info); return info; };
  const mergeRepos = (infos: readonly RepoInfo[]): RepoInfo => infos.find(i => i.unreadable) ?? infos.find(i => !i.configOk) ?? {
    found: infos.some(i => i.found), configOk: true, badKey: '', unreadable: false, hooksPath: infos.some(i => i.hooksPath), hooksFiles: infos.some(i => i.hooksFiles), hooksDir: infos.find(i => i.found)?.hooksDir ?? '', localRemotes: [...new Set(infos.flatMap(i => i.localRemotes))],
    // 宛先の名前は、見つかったすべてのリポジトリにあるものだけ（どれか 1 つでも無ければ、そこでは git がフォルダとして扱う）
    remotes: infos.filter(i => i.found).reduce<readonly string[] | null>((common, i) => (common === null ? i.remotes : common.filter(n => i.remotes.includes(n))), null) ?? [],
  };
  const repoFor = (dashC: string | undefined): RepoInfo => {
    if (!seen.known) return unresolvedRepo('cwd');
    if (dashC === undefined) return mergeRepos([...new Set(seen.all)].map(inspect));
    const targets = new Set<string>();
    for (const base of seen.all) {
      const target = resolveWord({ text: dashC, dynamic: false, glob: false, quoted: false, home: dashC === '~' || dashC.startsWith('~/'), kind: 'plain' }, base, windows, language);
      if (!('path' in target)) return unresolvedRepo('-C');
      targets.add(target.path);
    }
    return mergeRepos([...targets].map(inspect));
  };
  let wroteEarlier = false;
  const toolConfig: MatchCtx['toolConfig'] = tool => {
    if (!seen.known || (tool === 'npm' && wroteEarlier)) return { unknownCwd: true };
    const file = tool === 'curl' ? seen.all.map(c => curlConfigFile(env, c)).find(Boolean)
      : tool === 'npm' ? seen.all.map(c => npmProjectConfigFile(c, env, opts.policy.roots.map(r => r.path))).find(Boolean)
        : wgetConfigFile(env);
    return file ? { file } : undefined;
  };
  let enclosedEarlier = false;
  const afterStatement: MatchCtx['afterStatement'] = (result, st) => {
    if (result.paths.some(p => p.mode === 'write') || result.copies.length > 0) wroteEarlier = true;
    if (st.shapes.some(s => s.startsWith('control:'))) enclosedEarlier = true;
    if (result.cwd) followCd(seen, result.cwd, st.nested === true, st.reentry !== undefined);
    if (changes(result)) seen.changed = true;
  };
  const beforeStatement: MatchCtx['beforeStatement'] = (st, index) => { enter(seen, index); enterScope(seen, st, index); };
  const fileExists = (path: string): boolean => {
    if (wroteEarlier || enclosedEarlier) return false;
    if (!seen.known && !parsePath(path).root) return false;
    return seen.now.every(base => { const full = resolve(base, path); return exists(full) && !isDirectory(full); });
  };
  const ctx: MatchCtx = { shell, windows, repo: repoFor, external, fileExists, selfHosts, gitIsolated: opts.gitIsolated ?? true, toolConfig, afterStatement, beforeStatements, beforeStatement, productEnv: opts.productEnv, productEnvPath: opts.productEnvPath };
  const classified = classifyStatements(command, ctx);
  if (isPowerShell(shell)) assignedStatements = classified.statements.filter(st => st.assigned && st.kind === 'command' && st.words.length > 0);
  if (classified.lex) {
    add('deny', say('lex.denied', { detail: lexDetail(language, classified.lex) }));
    return done();
  }
  if (!classified.statements.length) add('deny', say('guard.no_command'));

  const reasonText = (r: Reason): string => (r.key.startsWith('ask.') ? text('guard.needs_approval', { reason: text(r.key) }) : text(r.key, r.params));
  const fromReason = (r: Reason): Said => ({ key: r.id ?? r.key, text: reasonText(r) });
  const allowEntries = (opts.allow ?? []).map(parseAllowEntry).filter((e): e is string[] => e !== null);

  // 1 つの絶対パスを、書く・読む・消すものとして調べる
  // intentWrite: 確かめの種類を決めるためだけの「書くための参照か」。ワイルドカードの手前のフォルダは write = false で調べるが、書く参照なら外の確かめは outside_write にする
  // secrets: 名前だけを出すコマンドは 'files'（secrets・secret のフォルダだけでは止めない）、依存パッケージの中で見つけた分は 'none'（別に今回だけの確かめにする）
  const evalAbs = (abs: string, input: string, write: boolean, deletes: boolean, primary: boolean, intentWrite: boolean = write, secrets: SecretScope = 'all'): void => {
    const placement = placePath(abs, opts.policy, secrets);
    if (primary) paths.push({ input, path: abs, placement, write });
    if (write) {
      if (!writes.includes(abs)) writes.push(abs);
      if (current && !current.writes.includes(abs)) current.writes.push(abs);
    }
    if (placement.kind === 'deny') { add('deny', { key: 'scope.deny', text: placement.reason }); return; }
    if (deletes && isCriticalTarget(abs, opts.policy)) { add('deny', say('guard.irreversible', { path: abs })); return; }
    // ツールの設定ファイルは、許可フォルダの外（ホームが許可フォルダの外なのが既定）でも、ふつうの確かめではなく今回だけ。外の確かめで戻る前に調べる
    if (write && isToolConfigPath(abs, env)) addCode(say('list.tool_config', { path: abs }));
    // 許可フォルダの外でも、git のフォルダへの書き込みはフックや設定でコードが動くので、外のふつうの確かめでなく今回だけ
    if (write && placement.kind === 'outside' && writeApprovalKind(abs, opts.policy) === 'git') addCode(say(WRITE_KEYS.git, { path: abs }));
    if (placement.kind === 'outside') { add(opts.outsideRoots, say('guard.touches_outside', { path: abs }), intentWrite ? 'outside_write' : 'outside_read'); return; }
    if (write && placement.mode === 'read') { add('deny', say('guard.write_readonly', { path: abs })); return; }
    if (!write) return;
    const kind = writeApprovalKind(abs, opts.policy);
    if (kind) addCode(say(WRITE_KEYS[kind], { path: abs }));
  };
  // フォルダごと書く・消すとき、その中に守る場所（人格・スキル・.git）まで届くなら今回だけ
  const rangeCheck = (dir: string): void => {
    if (protectedInside(dir, opts.policy) || containsToolConfig(dir, env)) addCode(say('list.write_ancestor', { path: dir }));
  };
  const dotfiles = isPowerShell(shell);

  const checkPath = (ref: PathRef, deletes: boolean, record = true): void => {
    const write = ref.mode === 'write';
    const input = ref.word.text;
    const relative = !ref.word.dynamic && !ref.word.home && !/^(?:[~/\\$%]|[A-Za-z]:)/u.test(input);
    const unknownCwd = relative && !track.known;
    // Windows のドライブの根からのパス（\x）・ドライブだけのパス（X:foo）は、フォルダが分からなければドライブも分からない
    const rootish = windows && !ref.word.dynamic && !ref.word.home && (/^[\\/](?![\\/])/u.test(input) || /^[A-Za-z]:(?![\\/])/u.test(input));
    const target = (t: DeleteTarget): void => { if (record && write && current) current.targets.push(t); };
    if (unknownCwd || (rootish && !track.known)) {
      target({ input, wild: false });
      if (record) paths.push({ input, placement: { kind: 'unresolved', reason: text('list.cwd_unknown', { input }) }, write });
      if (write) addCode(say('list.cwd_unknown', { input })); else add('ask', say('list.cwd_unknown', { input }), 'opaque');
    }
    // バッククォートでエスケープした名前（'.en`v' は .env）は、エスケープを外した名前でも調べる。秘密のパスに当たるなら止める
    if (ref.word.unescaped !== undefined) {
      const { unescaped, ...rest } = ref.word;
      checkPath({ ...ref, word: { ...rest, text: unescaped, dynamic: false, glob: /[*?[]/u.test(unescaped) } }, deletes, false);
    }
    // 分かっているフォルダはすべて、どれにいても同じ確かめをする（決められない cd のあとでも飛ばさない）
    // 相対パスはこれまでにいられたすべてのフォルダで、ドライブの根からのパス・別のドライブのパス（X:foo）はいま動きうるすべてのフォルダで調べる
    // 同じ場所になるフォルダは 1 回だけ調べる（先に主でない形で調べた場所が、主として出てきたときだけもう一度）
    const checked = new Map<string, boolean>();
    for (const base of relative ? track.all : track.now) {
      const primary = !unknownCwd && (!relative || track.now.includes(base));
      const expanded = resolveWord(ref.word, base, windows, language);
      const place = 'unresolved' in expanded ? '' : expanded.path;
      if (checked.has(place) && (checked.get(place) || !primary)) continue;
      checked.set(place, primary || checked.get(place) === true);
      if (primary && !unknownCwd) target(ref.word.glob ? { input, wild: true } : 'unresolved' in expanded || ref.word.dynamic ? { input, wild: false } : { input, path: expanded.path, wild: false });
      if ('unresolved' in expanded) {
        if (primary) paths.push({ input, placement: { kind: 'unresolved', reason: expanded.unresolved }, write });
        if (write) addCode(say('list.write_dynamic', { input }));
        else if (ref.strict) addCode(say('list.read_dynamic', { input }));
        else add('ask', say('list.read_dynamic', { input }), 'opaque');
        continue;
      }
      const globbing = ref.word.glob && !ref.word.dynamic;
      // ワイルドカードの手前のフォルダは、書く・消す対象ではない（当たるものだけが対象）。外・禁止のパスかどうかだけ見る
      const scope: SecretScope = ref.names ? 'files' : 'all';
      evalAbs(expanded.path, input, globbing ? false : write, globbing ? false : deletes, primary, write, scope);
      if (globbing) {
        // ワイルドカード: 今あるもののうち当たるものを全部調べる。列挙しきれないときは、手前のフォルダを調べて確かめる
        const globbed = expandGlob(patternOf(ref.word, base, windows), dotfiles, scope);
        // 列挙しきれないときも、列挙した分と、上限を超えた分から探した秘密のパスは調べる（秘密があれば止める）
        for (const match of globbed.matches) {
          evalAbs(match, match, write, deletes, false, write, scope);
          if (write && (ref.recursive || deletes) && isDirectory(match)) rangeCheck(match);
        }
        if (globbed.secret) evalAbs(globbed.secret, globbed.secret, write, deletes, false, write, scope);
        if (!globbed.complete) {
          if (write) rangeCheck(globbed.prefix);
          else add('ask', say('list.wild_many', { input }), 'opaque');
        }
      } else if (write && ref.recursive && isDirectory(expanded.path)) rangeCheck(expanded.path);
      if (ref.list) listCheck(ref, base, expanded.path, globbing);
    }
  };

  // パイプで次のコマンドに流れるファイル（Get-ChildItem の出力など）は、次のコマンドが読む。フォルダなら中のファイルを、読むものとして調べる
  const listCheck = (ref: PathRef, base: string, root: string, globbing: boolean): void => {
    const list = ref.list!;
    const heads = globbing ? expandGlob(patternOf(ref.word, base, windows), dotfiles) : { matches: [root], complete: true };
    let complete = heads.complete;
    // 依存パッケージ（node_modules）の中で見つけた、秘密らしい名前のパス。止めずに、当たったパスを見せて今回だけの確かめにする
    const inDeps = new Set<string>();
    const wanted = (name: string): boolean => (list.include.length === 0 || list.include.some(p => wildcardMatches(name, p, 'include'))) && !list.exclude.some(p => wildcardMatches(name, p, 'exclude'));
    for (const head of heads.matches) {
      if (list.items || !isDirectory(head)) { evalAbs(head, head, false, false, false); continue; }
      const tree = listTree(head, list.deep, undefined, list.skipHidden);
      complete = complete && tree.complete;
      for (const entry of tree.entries) {
        if (!(wanted(basename(entry)) || isDirectory(entry))) continue;
        if (inDependencies(entry) && isSecretPath(entry)) { inDeps.add(entry); evalAbs(entry, entry, false, false, false, false, 'none'); } else evalAbs(entry, entry, false, false, false);
      }
      if (tree.secret && wanted(basename(tree.secret))) evalAbs(tree.secret, tree.secret, false, false, false);
      for (const found of tree.depSecrets ?? []) if (wanted(basename(found))) inDeps.add(found);
    }
    if (inDeps.size) {
      const shown = [...inDeps].slice(0, 5);
      addCode(say('list.secret_in_deps', { count: inDeps.size, paths: shown.join(', ') + (inDeps.size > shown.length ? ', …' : '') }));
    }
    if (!complete) add('ask', say('list.wild_many', { input: ref.word.text }), 'opaque');
  };

  // cp・mv・Copy-Item・Move-Item・Rename-Item・New-Item: 実際に書かれるパスを組み立てて調べる
  const checkCopy = (use: CopyUse): void => {
    for (const base of track.all) {
      const unresolvedWord = (w: Word | null): boolean => w !== null && 'unresolved' in resolveWord(w, base, windows, language);
      const dyn = (w: Word | null): void => { if (w) addCode(say('list.write_dynamic', { input: w.text })); };
      if (use.kind === 'join') {
        if (!use.name || use.name.dynamic || unresolvedWord(use.dest)) { dyn(use.name?.dynamic ? use.name : use.dest ?? use.name); continue; }
        const dir = use.dest ? (resolveWord(use.dest, base, windows, language) as { path: string }).path : base;
        evalAbs(windows ? windowsNames(resolve(dir, use.name.text)) : resolve(dir, use.name.text), use.name.text, true, false, false);
        continue;
      }
      if (use.kind === 'rename') {
        if (!use.name || use.name.dynamic) { dyn(use.name); continue; }
        for (const source of use.sources) {
          const r = resolveWord(source, base, windows, language);
          if ('unresolved' in r) { dyn(source); continue; }
          evalAbs(windows ? windowsNames(resolve(dirname(r.path), use.name.text)) : resolve(dirname(r.path), use.name.text), use.name.text, true, false, false);
        }
        continue;
      }
      // copy
      if (use.dest !== null && unresolvedWord(use.dest)) { dyn(use.dest); continue; }
      // -Destination を付けない Copy-Item・Move-Item は、作業フォルダに入れる（同じ名前なら上書きする。本物の PowerShell 5.1 で確かめた）
      const dest = use.dest === null ? base : (resolveWord(use.dest, base, windows, language) as { path: string }).path;
      const destIsDir = use.dest === null || (!use.noTargetDir && (use.dirFlag || use.sources.length > 1 || /[\\/]$/u.test(use.dest.text) || isDirectory(dest)));
      let unknownNames = false;
      const names: string[] = [];
      for (const source of use.sources) {
        const r = resolveWord(source, base, windows, language);
        if ('unresolved' in r || source.dynamic) { unknownNames = true; continue; }
        if (/(?:^|[\\/])\.\.?$/u.test(source.text) || source.text === '~') {
          unknownNames = true;
          if (use.recursive && containsGitDir(r.path)) addCode(say('list.write_ancestor', { path: r.path }));
          continue;
        }
        if (source.glob) {
          const globbed = expandGlob(patternOf(source, base, windows), dotfiles);
          if (!globbed.complete) { unknownNames = true; continue; }
          names.push(...globbed.matches.map(m => basename(m)));
          if (use.recursive) for (const m of globbed.matches) if (isDirectory(m) && containsGitDir(m)) addCode(say('list.write_ancestor', { path: m }));
          continue;
        }
        names.push(basename(r.path));
        if (use.recursive && isDirectory(r.path) && containsGitDir(r.path)) addCode(say('list.write_ancestor', { path: r.path }));
      }
      if (destIsDir) {
        for (const name of names) {
          const target = join(dest, name);
          evalAbs(target, target, true, false, false);
        }
        if (unknownNames || (use.recursive && names.length === 0)) rangeCheck(dest);
      } else {
        evalAbs(dest, dest, true, false, false);
        if (use.recursive && isDirectory(dest)) rangeCheck(dest);
      }
    }
  };

  // curl -O・wget の既定の名前: URL の最後の名前で、作業場所（または指定のフォルダ）に書く
  const checkRemoteName = (url: Word, dir: Word | null): void => {
    if (url.dynamic) return;
    let name = '';
    try { name = decodeURIComponent(new URL(url.text).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* URL でなければ別の理由で止まっている */ }
    name ||= 'index.html';
    for (const base of track.all) {
      const d = dir ? resolveWord(dir, base, windows, language) : { path: base };
      if ('unresolved' in d) { addCode(say('list.write_dynamic', { input: dir?.text ?? '' })); continue; }
      const target = windows ? windowsNames(resolve(d.path, name)) : resolve(d.path, name);
      evalAbs(target, name, true, false, false);
    }
  };

  for (const [index, st] of classified.statements.entries()) {
    enter(track, index);
    enterScope(track, st, index);
    const result = classified.results[index]!;
    const here = track.now[0]!;
    const cwdState = (): CwdState => ({ now: [...track.now], all: [...track.all], known: track.known });
    const words = st.words.map(w => w.text);
    const first = st.words[0];
    const name = first && !first.dynamic ? (first.text.split(/[\\/]/u).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/u, '') : '';
    const stdin = st.pipedIn || st.redirects.some(r => STDIN_OPS.has(r.op));
    const inline = inlineCode(name, st.words);
    current = {
      program: name, programDynamic: (first?.dynamic ?? false) || st.callComputed === true, programOdd: !!first && !first.dynamic && programOdd(first.text, name), words: st.words.map(w => ({ text: w.text, dynamic: w.dynamic, glob: w.glob })),
      urls: st.words.flatMap(w => [...w.text.matchAll(URL_IN_WORD)].map(m => ({ text: m[0], dynamic: w.dynamic }))),
      env: st.assigns.map(a => a.name), gitGlobal: name === 'git' ? gitGlobalOf(st.words) : [], code: inline.code, codeDynamic: inline.dynamic,
      stdin, shapes: [...st.shapes], reasonKeys: result.reasons.map(r => r.id ?? r.key),
      deletes: result.deletes, targets: [], writes: [], piped: st.pipedIn || st.pipedOut, redirected: st.redirects.length > 0, cwd: track.known && track.now.length === 1 ? here : null, cwds: [...track.now], shell,
    };
    const source = name ? innerSource(name, st.words, shell, stdin) : undefined;
    const matchedEntries = allowEntries.filter(entry => entryMatches(entry, st.words, windows));
    const allowedByConfig = matchedEntries.length > 0;
    const depth = opts.depth ?? 0;
    let wrapped: ShellVerdict | undefined;
    if (source !== undefined) {
      const checkInner = (allow: readonly string[]) => checkShellCommand(source!.text, here, { ...opts, allow, shell: source!.shell, depth: depth + 1, fetchedBefore: fetched, cwdState: cwdState() });
      wrapped = source && depth < 3 ? checkInner(opts.allow ?? []) : undefined;
      if (wrapped && wrapped.statements.length === 0 && (name === 'cmd' || (isPowerShell(shell) && START_PROCESS_NAMES.has(name)))) wrapped = undefined;
      const head = wrapped?.statements[0]?.words.map(w => w.text) ?? [];
      const tails = matchedEntries.flatMap(entry => {
        for (let p = 1; p < entry.length; p++) if (entry.slice(p).every((e, i) => head[i] === e)) return [entry.slice(p).join(' ')];
        return [];
      });
      if (wrapped && tails.length) wrapped = checkInner([...(opts.allow ?? []), ...tails]);
      current.inner = wrapped?.statements.length && track.known ? wrapped.statements : null;
      if (wrapped?.statements.length && !track.known) current.unknownInner = wrapped.statements;
    }
    statements.push(current);
    const hardSaid = (hit: HardHit | undefined): Said | undefined => hit && say('guard.hard_denied', { label: text(hit.key), cmd: hit.cmd });
    const hardIn = (code: string, sh: ShellKind): Said | undefined => {
      if (depth >= 3) return undefined;
      const v = checkShellCommand(code, here, { ...opts, shell: sh, depth: depth + 1, cwdState: cwdState() });
      const at = v.reasonKeys.indexOf('guard.hard_denied');
      return at >= 0 ? { key: 'guard.hard_denied', text: v.reasons[at]! } : undefined;
    };
    const literalHard = (prog: string, ws: readonly Word[], fromStdin: boolean): Said | undefined => {
      const inner = innerSource(prog, ws.map(w => ({ ...w, dynamic: false })), shell, fromStdin);
      return inner ? hardIn(inner.text, inner.shell) : undefined;
    };
    const iexHard = (prog: string, texts: readonly string[]): Said | undefined => {
      if (prog !== 'iex' && prog !== 'invoke-expression') return undefined;
      for (const t of texts.slice(1)) {
        const code = t.replace(/^-[A-Za-z]+:/u, '');
        const hit = code && !code.startsWith('-') ? hardIn(code, 'powershell') : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    const headHard = (head: readonly string[]): Said | undefined => {
      const direct = hardSaid(hardOfWords(head)) ?? iexHard(programNameOf(head[0] ?? ''), head);
      if (direct) return direct;
      const headName = programNameOf(head[0] ?? '');
      if (!headName) return undefined;
      const headWords = head.map((h): Word => ({ text: h, dynamic: h.includes('$'), glob: false, quoted: false, home: false, kind: h === '{…}' ? 'block' : 'plain' }));
      const inner = innerSource(headName, headWords, shell, false);
      if (inner === null) {
        if (current) current.programDynamic = true;
        return literalHard(headName, headWords, false);
      }
      return inner ? hardIn(inner.text, inner.shell) : undefined;
    };
    const topHard = name ? hardSaid(hardOfWords(words)) ?? (source === null ? literalHard(name, st.words, stdin) : undefined) ?? iexHard(name, words) : undefined;
    const hardReason = topHard ?? st.heads?.map(headHard).find(Boolean);
    const hard = hardReason !== undefined;
    if (hardReason) add('deny', hardReason);
    if (ELEVATE_NAMES.has(name)) add('deny', say('guard.elevate'));
    if (name === 'dd' && words.some(a => /^of=\/dev\//u.test(a) || (/^of=/u.test(a) && posix.normalize(a.slice(3)).startsWith('/dev/')))) add('deny', say('guard.device_write'));
    const denied = matchesPrefix(words, opts.deny);
    if (denied) add('deny', say('guard.config_denied', { prefix: denied }));
    if (result.fetch) fetched = true;
    else if (fetched && name && SHELL_SINKS.has(name)) add('deny', say('guard.download_exec'));
    if (name === 'git' && PULLING_GIT.has(gitSubcommand(st.words) ?? '')) pulled = true;

    for (const reason of result.reasons) {
      if (hard || denied) break;
      if (reason.key === 'list.install' || (reason.key === 'list.git_net' && PULLING_GIT.has(String(reason.params.cmd)))) pulled = true;
      if (reason.exempt && allowedByConfig) continue;
      if (reason.key === 'list.install' || reason.key === 'list.expand') limits = limits || reason.key === 'list.install';
      if (reason.level === 'deny') add('deny', fromReason(reason));
      else if (reason.level === 'once') addCode(fromReason(reason));
      else add('ask', fromReason(reason), askKindOf(reason.key));
    }
    if (source !== undefined && !hard && !denied) {
      const innerReasons = () => wrapped!.reasons.forEach((reason, i) => { if (!reasons.includes(reason)) { reasons.push(reason); reasonKeys.push(wrapped!.reasonKeys[i]!); } });
      if (!wrapped) {
        if (fetched) add('deny', say('guard.download_exec'));
        else if (depth >= 3) add('deny', say('code.wrapped_unknown', { cmd: name }));
        else if (allowedByConfig) addCode(say('code.wrapped_unknown', { cmd: name }));
      } else if (allowedByConfig && track.known) {
        decision = worst(decision, wrapped.decision);
        innerReasons();
        for (const kind of wrapped.askKinds) if (!askKinds.includes(kind)) askKinds.push(kind);
        paths.push(...wrapped.paths);
        writes.push(...wrapped.writes);
        for (const file of wrapped.scripts) addScript(file);
        unshown ??= wrapped.unshown;
        limits ||= wrapped.limits;
      } else {
        if (allowedByConfig) addCode(say('code.wrapped_unknown', { cmd: name }));
        decision = worst(decision, wrapped.decision);
        if (wrapped.decision === 'deny' || result.level !== 'allow') innerReasons();
        if (track.known) { paths.push(...wrapped.paths); writes.push(...wrapped.writes); }
      }
      if (wrapped) { fetched ||= wrapped.downloaded; pulled ||= wrapped.fetched; }
    }
    const asked = matchesPrefix(words, opts.ask);
    if (asked && !allowedByConfig) add('ask', say('guard.needs_approval', { reason: asked }), 'owner');

    for (const ref of result.paths) checkPath(ref, result.deletes);
    for (const use of result.copies) checkCopy(use);
    for (const remote of result.remoteNames) checkRemoteName(remote.url, remote.dir);
    if (result.level === 'once' || result.level === 'deny') {
      for (const token of suspectPaths(st.words)) {
        for (const base of track.all) {
          const resolved = resolveWord({ text: token, dynamic: st.words.some(w => w.text === token && w.dynamic), glob: false, quoted: false, home: token === '~' || token.startsWith('~/'), kind: 'plain' }, base, windows, language);
          if ('unresolved' in resolved) continue;
          const placement = placePath(resolved.path, opts.policy);
          if (placement.kind === 'deny') add('deny', { key: 'scope.deny', text: placement.reason });
        }
      }
    }

    if (result.cwd) followCd(track, result.cwd, st.nested === true, st.reentry !== undefined);
    if (changes(result)) track.changed = true;
  }
  return done();
}
