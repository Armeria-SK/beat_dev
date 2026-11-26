import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { AppConfig, Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { redactKeyEcho, redactOpenKey, redactSecrets } from '../../shared/redaction.ts';
import { approvalPaths, approvalPathsMore, type PreviewFile } from '../approvals.ts';
import { ruleShapeField } from '../approval-rules.ts';
import { DEFAULT_BEAT_PORT, deniedLoopbackPorts } from '../browser/loopback.ts';
import { DEV_RUNNERS, NODE_SKIP_FLAG } from '../hooks/decision-order.ts';
import { cardQuote, isInterpreter, packageScriptName, packageScriptView, PWSH_FILE_FLAG, selfTouchMarkers, type BeatPorts } from '../hooks/code-guard.ts';
import { expandPath, isInside, placePath, realish, type ScopePolicy } from '../hooks/scope.ts';
import { checkShellCommand, type StatementFacts } from '../hooks/shell-guard.ts';
import { outboundOf, placesOf, pushesOf, type Outbound } from '../hooks/outbound.ts';
import { gitOutboundEnv, isolatedGit, ownerHooksPathSet } from '../hooks/outbound-env.ts';
import { productEnvPath, productEnvReader } from '../hooks/product-env.ts';
import { productRunOf } from '../hooks/product-run.ts';
import { judgeFilesOf } from '../judge-files.ts';
import { fixShellRefusal } from '../hooks/fix-guard.ts';
import { broadPush, gitWithOutsidePath, linkOutOfCopy, mainWrites, namesMain, worktreeGitRefusal, WT_MAIN_PATH, WT_OUTSIDE_PATH, WT_PUSH_BEAT, WT_WRITE_MAIN } from '../hooks/worktree-git.ts';
import { pushProtectOf } from '../hooks/push-protect.ts';
import { installTouchOf, protectedTouchOf } from '../hooks/protected-touch.ts';
import { selfTarget } from '../hooks/self-port.ts';
import { outboundText } from '../../shared/messages/outbound.ts';
import { pendingText } from '../../shared/messages/pending.ts';
import { parseRemotes, type Remote } from '../../projects/remotes.ts';
import type { ShellKind } from '../hooks/shell-lex.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../shell/git-env.ts';
import { findExecutable, resolveShell, runProcess, scrubEnv, type StreamRest } from '../shell/runner.ts';
import type { ExecuteInfo, PreCheck, ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { BACKGROUND_OUTPUT_CHARS, BACKGROUND_SETTLE_SEC, jobLines, jobState, newest, notContained } from './shell-bg.ts';

interface ShellInput { command: string; cwd?: string; timeoutSec?: number; background?: boolean }

export function shellTranscript(command: string, header: string, body: readonly string[]): string {
  const echo = redactKeyEcho(`$ ${command}`);
  const rest = body.join('\n\n');
  return [echo.text, header, ...(body.length ? [echo.open ? redactOpenKey(rest) : rest] : [])].join('\n\n');
}

function resolveCwd(input: ShellInput, ctx: ToolContext): { cwd: string } | { problem: string } {
  const language = languageOf(ctx.config);
  if (ctx.project && !ctx.project.root) return { problem: guardText(language, 'shell.cwd_outside', { path: ctx.workspace }) };
  if (!input.cwd) return { cwd: ctx.workspace };
  const expanded = expandPath(input.cwd, ctx.workspace, process.env, language);
  if ('unresolved' in expanded) return { problem: guardText(language, 'shell.cwd_unresolved', { detail: expanded.unresolved }) };
  const placement = placePath(expanded.path, ctx.policy);
  if (placement.kind !== 'inside') return { problem: guardText(language, 'shell.cwd_outside', { path: expanded.path }) };
  if (!statSync(expanded.path, { throwIfNoEntry: false })?.isDirectory()) return { problem: guardText(language, 'shell.cwd_missing', { path: expanded.path }) };
  return { cwd: expanded.path };
}

const PREVIEW_CHARS = 8000;
const SHELL_TAIL_BYTES = 16_384;
const FINGERPRINT_LIMIT_BYTES = 1_048_576;

function commonEdge(a: string, b: string, fromEnd: boolean): number {
  let n = 0;
  while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
  return n;
}

function headAndTail(head: string, rest: StreamRest | undefined, language: Language): string {
  if (!rest || (rest.text === '' && rest.skipped === 0)) return head;
  if (rest.skipped === 0) return head + rest.text;
  const ownHead = redactSecrets(head);
  const shownHead = ownHead.slice(0, commonEdge(ownHead, redactSecrets(head + rest.afterHead), false));
  const ownTail = redactSecrets(rest.text);
  const matched = ownTail.slice(ownTail.length - commonEdge(ownTail, redactSecrets(rest.before + rest.text), true));
  const shownTail = rest.before.includes('\n') ? matched : matched.slice(matched.indexOf('\n') + 1 || matched.length);
  const skipped = rest.skipped + Buffer.byteLength(ownTail, 'utf8') - Buffer.byteLength(shownTail, 'utf8');
  return `${shownHead.trimEnd()}\n${toolText(language, 'shell.omitted', { bytes: skipped.toLocaleString('en-US') })}\n${shownTail}`;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

// server.origins の host。Tailscale の URL なども beat に届くので、ループバックと同じに確かめる
function selfHostsOf(config: AppConfig): string[] {
  return config.server.origins.flatMap(origin => {
    try { return [new URL(origin).hostname]; } catch { return origin.trim() ? [origin.trim()] : []; }
  });
}

// own: 数字だけでも印を付ける beat 自身のポート。denied: ループバックの書き方の後ろにあれば印を付けるポート（中継・提供元・MCP も）
function beatPortsOf(ctx: ToolContext): BeatPorts {
  const browser = ctx.services?.browser;
  return {
    own: new Set([...(browser?.selfPorts() ?? []), DEFAULT_BEAT_PORT]),
    denied: browser?.loopbackDenied() ?? deniedLoopbackPorts(ctx.config, []),
  };
}

// 子プロセスの環境。git には、ホーム・システムの設定からコードを動かせる項目を落とした設定だけを読ませる（git-env.ts。実行のたびに新しい置き場所に作る）。
// 洗い出せない git（2.32 より古い）、または作業フォルダの中の git は、その版を調べるために動かさず、洗い出していないものとして扱う
export function droppedGitEnv(config: AppConfig): string[] {
  return config.tools.shell.envAllow.filter(name => /^git_/iu.test(name));
}

function childEnvFor(shell: AppConfig['tools']['shell'], cwd: string, powershell: boolean): { env: Record<string, string>; gitIsolated: boolean; gitExe?: string } {
  const base = Object.fromEntries(Object.entries(scrubEnv(shell.envAllow)).filter(([key]) => !/^git_/iu.test(key)));
  const gitExe = findExecutable('git', base, cwd, { powershell });
  if (gitExe && (isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe))) return { env: base, gitIsolated: false };
  return { env: base, gitIsolated: true, ...(gitExe ? { gitExe } : {}) };
}

// beat の作業ブランチがあるリポジトリで、それをまとめて送る・消しうる push（D-6・8-1 の申し送り）。git が動かせなければ見ない（push も同じ git で動く）
function beatBranchPush(statements: readonly StatementFacts[], git: (dir: string, args: string[]) => string | undefined, cwd: string): string | undefined {
  const beat = git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/beat/']);
  if (!beat?.trim()) return undefined;
  const settings = git(cwd, ['config', '--get-regexp', '^(push\\.default|remote\\..*\\.mirror)$']) ?? '';
  const lines = settings.split('\n').map(line => line.trim().toLowerCase());
  return broadPush(statements, { matching: lines.includes('push.default matching'), mirror: lines.some(line => /^remote\..*\.mirror true$/u.test(line)) });
}

interface Peeked { preview: PreviewFile; fingerprint: string; content?: string }

// 確かめの札で見せるファイルを読む。指紋は、承認のあとで中身が変わったかを調べるためのもの
function peek(file: string, language: Language): Peeked {
  const unreadable = (fingerprint: string): Peeked => ({ preview: { path: file, text: guardText(language, 'code.preview_unreadable'), truncated: false }, fingerprint });
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { preview: { path: file, text: guardText(language, 'code.preview_missing'), truncated: false }, fingerprint: `${file}\0missing` };
  if (!stat.isFile() || stat.size > FINGERPRINT_LIMIT_BYTES) return unreadable(`${file}\0${stat.isFile() ? 'big' : 'dir'}\0${stat.size}\0${stat.mtimeMs}`);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return unreadable(`${file}\0unreadable`); }
  const fingerprint = `${file}\0${sha256(bytes)}`;
  if (bytes.subarray(0, 8000).includes(0)) return unreadable(fingerprint);
  const content = bytes.toString('utf8');
  return { preview: previewOf(file, content), fingerprint, content };
}

function previewOf(path: string, content: string): PreviewFile {
  const rest = redactSecrets(content);
  return { path, text: content.slice(0, PREVIEW_CHARS), truncated: content.length > PREVIEW_CHARS, ...(content.length > PREVIEW_CHARS ? { chars: content.length } : {}), rest: { text: rest.slice(0, PREVIEW_CHARS), truncated: rest.length > PREVIEW_CHARS } };
}

const PACKAGE_PROGRAM = /^(?:npm|pnpm|yarn|bun)$/u;
const PACKAGE_WRAPPER = /^(?:npx|pnpx|bunx|corepack)$/u;
const ENV_PROGRAM = /^(?:export|declare|typeset|local|readonly|set|setx|setenv|set-item|si|set-variable|sv|new-item|ni|env|eval|iex|invoke-expression|source|\.)$/u;
const ENTRY_FILES_MAX = 4;
const NOT_SHOWN_NAMES_MAX = 8;
const EXCERPT_NOTE = '(excerpt of package.json: only the scripts that run)';
const lowerName = (text: string): string => text.toLowerCase().replace(/\.(?:exe|cmd)$/u, '');

// package.json ごとに、その文が動かすスクリプトの名前。同じ package.json に、ほかの呼び出し（install・旗・環境変数・動的な名前・npm が語に出るだけの文）が 1 つでも届けば、その package.json は入れない（札は全体を見せる）。
// 作業フォルダが決まらない文・包み（inner）・動的な実行役・npx / pnpx / bunx / corepack・環境変数を決める文が 1 つでもあれば、どれも入れない
function scriptRuns(statements: readonly StatementFacts[], scripts: ReadonlySet<string>, reasonKeys: readonly string[]): Map<string, string[]> {
  const runs = new Map<string, string[] | null>();
  const walk = (list: readonly StatementFacts[]): boolean => list.every(st => {
    const program = lowerName(st.program);
    if (st.cwd === null || st.programDynamic || st.inner !== undefined || st.unknownInner?.length || PACKAGE_WRAPPER.test(program) || ENV_PROGRAM.test(program) || st.words.some(w => PACKAGE_WRAPPER.test(lowerName(w.text)))) return false;
    if (!st.words.some(w => PACKAGE_PROGRAM.test(lowerName(w.text)))) return true;
    const words = st.words.slice(1);
    const clean = PACKAGE_PROGRAM.test(program) && lowerName(st.words[0]!.text) === program && st.env.length === 0 && !words.some(w => w.dynamic || w.glob);
    const name = clean ? packageScriptName(program, words.map(w => w.text)) : undefined;
    const file = resolve(st.cwd, 'package.json');
    const known = runs.get(file);
    runs.set(file, name === undefined || known === null ? null : [...(known ?? []), name]);
    return true;
  });
  const ok = !reasonKeys.some(key => key === 'list.env' || key === 'code.env') && walk(statements);
  return new Map([...runs].flatMap(([file, names]) => (ok && names && scripts.has(file) ? [[file, names] as [string, string[]]] : [])));
}

// npm run x などの札: package.json の全体のかわりに、動かすスクリプトの行（抜き出しだと分かる 1 行を付ける）と、その行が渡すファイル（製品の中・秘密のパスでない・ふつうのファイル）を見せる。
// 見せなかったファイルは名前だけを 1 行で挙げる（中身は読まない）。判定には使わない。指紋は package.json の全体と見せたファイルを bind に入れるので、あとで変わったら承認は古くなる。
// 何か投げたら、札はこれまでどおり（全体）
function runCards(cards: readonly Peeked[], statements: readonly StatementFacts[], scripts: readonly string[], reasonKeys: readonly string[], root: string, policy: ScopePolicy, language: Language): Peeked[] {
  try {
    const runs = scriptRuns(statements, new Set(scripts), reasonKeys);
    if (runs.size === 0) return [...cards];
    const have = new Set(cards.map(card => card.preview.path));
    const shown = (file: string): boolean => isInside(root, file) && isInside(realish(root), realish(file)) && placePath(file, policy).kind === 'inside' && statSync(file, { throwIfNoEntry: false })?.isFile() === true;
    return cards.flatMap(card => {
      const names = runs.get(card.preview.path);
      const view = names && card.content !== undefined ? packageScriptView(card.content, names, dirname(card.preview.path), language) : undefined;
      if (!view) return [card];
      const wanted = view.files.filter(file => !have.has(file));
      const entries = wanted.filter(shown).slice(0, ENTRY_FILES_MAX);
      for (const file of entries) have.add(file);
      const left = wanted.filter(file => !entries.includes(file)).map(file => cardQuote(relative(dirname(card.preview.path), file).replaceAll('\\', '/')));
      const note = left.length ? [`(not shown: ${[...left.slice(0, NOT_SHOWN_NAMES_MAX), ...(left.length > NOT_SHOWN_NAMES_MAX ? ['…'] : [])].join(', ')})`] : [];
      return [{ ...card, preview: previewOf(card.preview.path, [EXCERPT_NOTE, ...view.lines, ...note].join('\n')) }, ...entries.map(file => peek(file, language))];
    });
  } catch { return [...cards]; }
}

function hookFingerprints(dir: string | null | undefined, language: Language): string[] {
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return [`${dir}\0unreadable`]; }
  return names.filter(name => !name.endsWith('.sample')).sort().map(name => peek(join(dir, name), language).fingerprint);
}

const GIT_STAGING = new Set(['add', 'commit']);

function gitStagingOnly(statements: readonly StatementFacts[]): boolean {
  return statements.length > 0 && statements.every(st => {
    const sub = st.words[st.gitGlobal.length + 1];
    return st.program === 'git' && st.words[0]?.text === 'git' && !st.programDynamic && !st.programOdd && !st.inner && !st.piped && !st.redirected
      && !st.env.length && !st.gitGlobal.length && !st.shapes.length && !st.reasonKeys.some(key => key.startsWith('shape.') || key.startsWith('code.'))
      && sub !== undefined && GIT_STAGING.has(sub.text) && !st.words.some(w => w.dynamic);
  });
}

function remotesOf(ctx: ToolContext): Remote[] | undefined {
  if (!ctx.project) return undefined;
  try { return parseRemotes(ctx.services?.projects?.get(ctx.project.id)?.remotes); } catch { return []; }
}

function shellOutbound(command: string, statements: readonly StatementFacts[], ctx: ToolContext, env: Record<string, string>, gitExe: string | undefined, language: Language, created: Set<string>): Outbound | undefined {
  if (!statements.length) return { kind: 'send', reason: outboundText(language, 'send.unknown_command', { cmd: command.trim().slice(0, 80) }), targets: [] };
  const outEnv = gitOutboundEnv({
    productRoot: ctx.project?.root, remotes: remotesOf(ctx), dataDir: ctx.paths.data, env, gitExe: gitExe ?? '', language,
    ...(ctx.place && ctx.project?.root ? { workspaceRoots: [ctx.project.root] } : {}),
    isCreated: path => {
      let yes = false;
      try { yes = ctx.isCreated?.(path) === true; } catch { yes = false; }
      if (yes) created.add(path);
      return yes;
    },
  });
  try { return outboundOf({ tool: 'shell', statements }, outEnv); } catch (error) {
    return { kind: 'send', reason: outboundText(language, 'send.unknown_command', { cmd: `${command.trim().slice(0, 60)} (${(error as Error).message.slice(0, 60)})` }), targets: [] };
  }
}

const REWRITE_KEYS = new Set(['list.expand', 'list.git_moves']);
const READ_PROGRAMS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location', 'pwd', 'get-location', 'cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail',
  'grep', 'egrep', 'fgrep', 'rg', 'select-string', 'sls', 'findstr', 'wc', 'diff', 'cmp', 'sort', 'uniq', 'nl', 'file', 'stat', 'ls', 'dir', 'get-childitem', 'gci', 'tree', 'du', 'df', 'get-item', 'gi',
  'test-path', 'resolve-path', 'split-path', 'join-path', 'echo', 'write-output', 'write-host', 'printf', 'which', 'where', 'get-command', 'gcm', 'whoami', 'date', 'get-date', 'true', 'false', 'sleep', 'start-sleep']);
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'grep']);
const ENV_ONLY = new Set(['list.env']);

const gitRead = (st: StatementFacts): boolean => {
  const words = st.words.slice(1).map(w => w.text);
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '-C' || words[i] === '-c') { i++; continue; }
    if (words[i]!.startsWith('-')) return false;
    return GIT_READS.has(words[i]!);
  }
  return false;
};

const pwshFile = (st: StatementFacts): boolean => /^(?:pwsh|powershell)(?:[.]exe)?$/iu.test(st.program) && st.words.slice(1).some(w => PWSH_FILE_FLAG.test(w.text));
const runsCode = (st: StatementFacts): boolean => isInterpreter(st.program.toLowerCase().replace(/\.exe$/u, '')) || st.code.length > 0 || pwshFile(st);

// 見せるファイルは、コマンドが始まる前の中身。最後のコードの実行より前の文が、書かないと分かっているもの（読むだけ・cd・見せる実行そのもの）でなければ持ち主
const literal = (st: StatementFacts): boolean => st.words.every(w => !w.dynamic && !w.glob);
// 作るのはフォルダだけと分かる mkdir（bash・cmd の mkdir・md、PowerShell の mkdir か New-Item -ItemType Directory）。値・リダイレクト・ほかの理由のあるものは外す
function makesDirOnly(st: StatementFacts, program: string): boolean {
  if (st.redirected || !literal(st) || st.words.some(w => /^-va/iu.test(w.text)) || !st.reasonKeys.every(key => key === 'list.ps_write')) return false;
  if (program === 'mkdir' || program === 'md') return st.shell === 'powershell' || st.reasonKeys.length === 0;
  if (program !== 'new-item') return false;
  const at = st.words.findIndex(w => /^-itemtype$/iu.test(w.text));
  return at > 0 && /^directory$/iu.test(st.words[at + 1]?.text ?? '');
}

// 実行の文のファイル（旗でない最初の語）が、判定役に見せるファイルに入っているか
function shownRun(st: StatementFacts, shown: ReadonlySet<string>): boolean {
  if (st.code.length > 0) return true;
  const target = st.words.slice(1).find(w => !w.text.startsWith('-'));
  if (!target || !literal(st) || st.cwd === null) return false;
  return shown.has(resolve(st.cwd, target.text));
}

const PLAIN_RUNNERS = /^(?:node|nodejs|tsx|bun|python\d*(?:\.\d+)?|py|ruby|perl|bash|sh)$/u;
const MODULE_RUNNERS = new Set(['pytest', 'unittest']);

// 判定役にファイルを見せるのは、最後のコードの実行が決まった実行役で、最初の引数が製品の中にある拡張子つきのファイルのときだけ。
// ほかのファイルの実行（拡張子の無い先・./x・-m・.・-- のあと）は、実行役のファイルの選び方を真似しきれないので持ち主（P2 の範囲、4 回の審査の決め）
// 値を取らない旗（これより前の語は、旗の値をファイルと読み違えないよう、=つきか、この一覧だけ）
const NO_VALUE_FLAGS: ReadonlyArray<[RegExp, RegExp]> = [
  [/^(?:node|nodejs|tsx)$/u, NODE_SKIP_FLAG],
  [/^(?:python\d*(?:\.\d+)?|py)$/u, /^-[bBdEhiIOqsSuvVx]+$/u],
  [/^(?:bash|sh)$/u, /^(?:-[euxvn]+|--norc|--noprofile|--login)$/u],
  [/^(?:ruby|perl)$/u, /^-[wTW]$/u],
  [/^bun$/u, /^(?:--no-check|--quiet|-q)$/u],
];
const noValueFlag = (program: string, flag: string): boolean => /^--[^=]+=/u.test(flag) || NO_VALUE_FLAGS.some(([who, ok]) => who.test(program) && ok.test(flag));

// pwsh・powershell の -File より前に置いてよい語: 値を取らない -NoProfile・-NonInteractive・-NoLogo と、値を 1 つ取る -ExecutionPolicy（PowerShell が受ける頭だけの書き方 -nop・-noni・-nol・-ep・-ex も。大文字小文字を問わない）。
// -Command などほかの語が 1 つでもあれば、PowerShell は -File でなくそちらを動かす（-Command は残りをコマンドとして動かす）ので、x.ps1 は見せない（持ち主）
function pwshFlagsOk(before: StatementFacts['words']): boolean {
  for (let i = 0; i < before.length; i++) {
    const word = before[i]!;
    if (word.dynamic || word.glob || !/^[-/][A-Za-z]+$/u.test(word.text)) return false;
    const name = word.text.slice(1).toLowerCase();
    if ((name.length >= 3 && 'noprofile'.startsWith(name)) || (name.length >= 4 && 'noninteractive'.startsWith(name)) || (name.length >= 3 && 'nologo'.startsWith(name))) continue;
    if (name !== 'ep' && !(name.length >= 2 && 'executionpolicy'.startsWith(name))) return false;
    const value = before[++i];
    if (!value || value.dynamic || value.glob || !/^[A-Za-z]+$/u.test(value.text)) return false;
  }
  return true;
}

// pwsh・powershell の文を -File の旗の前と後ろに分ける。pwsh・powershell でない・-File が無いなら undefined
function pwshSplit(st: StatementFacts): { lead: StatementFacts['words']; after: StatementFacts['words'] } | undefined {
  if (!/^(?:pwsh|powershell)(?:[.]exe)?$/iu.test(st.program)) return undefined;
  const words = st.words.slice(1);
  const at = words.findIndex(w => PWSH_FILE_FLAG.test(w.text));
  return at < 0 ? undefined : { lead: words.slice(0, at), after: words.slice(at + 1) };
}

function plainFileRun(st: StatementFacts, root: string | undefined): boolean {
  const program = st.program.toLowerCase().replace(/\.exe$/u, '');
  let words = st.words.slice(1);
  if (program === 'pwsh' || program === 'powershell') {
    const split = pwshSplit(st);
    if (!split || !pwshFlagsOk(split.lead)) return false;
    words = split.after;
  } else if (!PLAIN_RUNNERS.test(program)) return false;
  const at = words.findIndex(w => !w.text.startsWith('-'));
  if (at < 0 || words.slice(0, at).some(w => w.text === '--' || w.dynamic || !noValueFlag(program, w.text))) return false;
  const target = words[at]!;
  if (target.dynamic || target.glob || !/\.[A-Za-z0-9]+$/u.test(target.text) || st.cwd === null || !root) return false;
  const path = resolve(st.cwd, target.text);
  return isInside(root, path) && statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

const RUNNER_PROGRAMS = new Set([...DEV_RUNNERS, 'npm', 'yarn', 'pnpm', 'pnpx']);

// bun run <先>・bun x <先>・bunx <先>（旗でない最初の語）が、スクリプト名・部品名でなくファイルらしいか。値・ワイルドカードは何になるか分からないので、ファイルらしい側に倒す
// ファイルらしい = / か \ を含む・. か ~ で始まる・拡張子（ . のあとの英数字）で終わる（大文字小文字を問わない。evil.sh・evil.wasm・evil.TS も）。
// x・bunx（部品を取ってきて動かす）だけは、先頭が @ の「@スコープ/名前」と、末尾の @版（cowsay@1.5.0）を部品名として外す。bun run @evil.ts の @ は例外にしない
const FILE_LIKE_TARGET = /^(?:.*[/\\]|[.~]|.*\.[A-Za-z0-9]+$)/u;
const PACKAGE_NAME = /^@[^/\\@]+\/[^/\\@]+$/u;
const packageIsFile = (text: string): boolean => {
  const name = text.replace(/(?<=.)@[^/\\@]*$/u, '');
  return !PACKAGE_NAME.test(name) && FILE_LIKE_TARGET.test(name);
};
function bunRunsFile(st: StatementFacts, from: number, package_: boolean): boolean {
  const words = st.words.slice(from);
  const at = words.findIndex(w => !w.text.startsWith('-'));
  // x・bunx の部品を旗でくっつけて渡す書き方（--package=./evil.tgz・-p=…）は、先の語（tsc）でなく旗の値が取ってくる部品。値が動的・ワイルドカード・ファイルらしいなら実行
  if (package_ && words.slice(0, at < 0 ? words.length : at).some(w => { const value = /^(?:--package|-p)=(.*)$/su.exec(w.text)?.[1]; return value !== undefined && (w.dynamic || w.glob || packageIsFile(value)); })) return true;
  const target = words[at];
  if (target === undefined) return false;
  if (target.dynamic || target.glob) return true;
  return package_ ? packageIsFile(target.text) : FILE_LIKE_TARGET.test(target.text);
}

// 試験の道具・パッケージの道具（--test・-m pytest|unittest は、実行の先より前にあるときだけ）
function isRunner(st: StatementFacts): boolean {
  const program = st.program.toLowerCase().replace(/\.(?:exe|cmd)$/u, '');
  const words = st.words.slice(1).map(w => w.text);
  if (program === 'npx') return true;
  if (program === 'bun') return words[0] === 'test' || (words[0] === 'run' && !bunRunsFile(st, 2, false)) || (words[0] === 'x' && !bunRunsFile(st, 2, true));
  if (program === 'bunx') return !bunRunsFile(st, 1, true);
  if (RUNNER_PROGRAMS.has(program)) return true;
  // powershell・pwsh は、--test や -m があっても試験の道具ではない（下の node・python 向けの見分けに通さない）
  if (program === 'pwsh' || program === 'powershell') return false;
  if (!runsCode(st)) return false;
  const target = words.findIndex(w => !w.startsWith('-'));
  const before = target < 0 ? words : words.slice(0, target);
  if (before.includes('--test')) return true;
  const m = words.indexOf('-m');
  return m >= 0 && (target < 0 || m < target) && MODULE_RUNNERS.has(words[m + 1] ?? '');
}

// PowerShell の Import-Module・ipmo は、ファイルのコードを動かす。先（旗でない語。-Name の値・-Name:値 も、PowerShell の字句解析が別の語に分ける）が値か、ファイルらしいか
// ファイルらしい = / か \ を含む・. か ~ で始まる・.psm1 .psd1 .ps1 .dll で終わる。名前だけ（Import-Module Pester）は数えない
const MODULE_FILE_LIKE = /^(?:.*[/\\]|[.~]|.*\.(?:psm1|psd1|ps1|dll)$)/iu;
// 先が 1 つも無い Import-Module・ipmo は、前の文から流し込まれる（Get-Item ./x.psm1 | Import-Module）ので、何が入るか分からない＝ファイルらしい側に倒す
function importsFile(st: StatementFacts): boolean {
  const names = st.words.slice(1).filter(w => !w.text.startsWith('-'));
  return names.length === 0 || names.some(w => w.dynamic || w.glob || MODULE_FILE_LIKE.test(w.text));
}

// runsCode にも isRunner にも数えられない実行: bun・bunx の <ファイルか名前>（bun test と、先がファイルらしくない bun run・x・bunx は道具。bun run evil.ts・bun x ./evil.ts・bunx ./evil.ts は bun evil.ts と同じ実行。旗だけの bun --version は動かさない）と、source・.（PowerShell の . ./x.ps1 も。ファイルのコードをその場で動かす）と、PowerShell の Import-Module・ipmo の <ファイル>（先の無い、流し込まれるものも）と using module・using assembly。
// 数えないと、道具と同じ文（npx tsx run.ts; bun evil.ts）が「道具だけ」になり、evil.ts が判定役に届かない。
// 数えても 1 つだけの文は今までどおり持ち主（filesScope の最後で plainFileRun に渡さない。bun は PLAIN_RUNNERS にいるが、今までここへ届かず持ち主だった。判定役に回すのは緩めることになる）
function looseRun(st: StatementFacts): boolean {
  const program = st.program.toLowerCase().replace(/\.(?:exe|cmd)$/u, '');
  if (program === 'source' || program === '.' || st.shapes.includes('dot_source')) return true;
  if (program === 'import-module' || program === 'ipmo') return importsFile(st);
  // using module・using assembly は中身を読めない文（先がファイルか名前かも分からない）。ファイルのコードを動かしうるので数える
  if (st.shapes.includes('control_opaque:using')) return true;
  return (program === 'bun' || program === 'bunx') && !isRunner(st) && st.words.slice(1).some(w => !w.text.startsWith('-'));
}

type FilesScope = { kind: 'files' } | { kind: 'command' } | { kind: 'owner'; why: string };

// 判定役にファイルを見せるのは、コードを動かす文が全体で 1 つだけ、包みの中でなく、決まった実行役で拡張子つきのファイル（製品の中）を動かすときだけ。
// コードを動かす文が試験・パッケージの道具だけなら、FILES を付けずコマンドだけ（計画より前と同じ）。ほかは持ち主（P2 の範囲、審査の決め）
export function filesScope(sts: readonly StatementFacts[], keys: readonly string[], root: string | undefined, scripts: readonly string[] = []): FilesScope {
  if (keys.includes('code.cmd_is_file')) return { kind: 'owner', why: 'a direct run of a file' };
  const runs: StatementFacts[] = [];
  let unknown = false;
  const envSet = keys.includes('code.env') || keys.includes('list.env');
  const listedPlain = (st: StatementFacts): boolean => !envSet && st.inner === undefined && st.code.length === 0 && !st.codeDynamic && !st.programDynamic && st.reasonKeys.length === 0 && st.env.length === 0
    && (isRunner(st) || st.words.slice(1).every(w => w.text.startsWith('-')));
  const walk = (list: readonly StatementFacts[]): boolean => {
    let any = false;
    for (const st of list) {
      if (st.inner === null) unknown = true;
      const inside = walk([...(st.inner ?? []), ...(st.unknownInner ?? [])]);
      if (listedPlain(st)) continue;
      if (isRunner(st) || runsCode(st) || looseRun(st) || inside) { runs.push(st); any = true; }
    }
    return any;
  };
  walk(sts);
  if (unknown) return { kind: 'owner', why: 'a wrapped command beat could not read' };
  if (runs.length === 0) return keys.includes('code.file_run') || scripts.length > 0 ? { kind: 'owner', why: 'a file run beat could not tie to a statement' } : { kind: 'command' };
  if (runs.every(isRunner)) return { kind: 'command' };
  if (runs.length > 1) return { kind: 'owner', why: 'more than one code run, or a run inside a wrapper' };
  const [only] = runs;
  // -Command・-c の文字（code）があっても、-File の前に許す旗以外の語があれば、PowerShell が動かすのは -File の x.ps1 でない（持ち主）
  const split = pwshSplit(only!);
  if (split && !pwshFlagsOk(split.lead)) return { kind: 'owner', why: only!.words.map(w => w.text).join(' ') || only!.program };
  if (only!.code.length > 0) return { kind: 'files' };
  return !looseRun(only!) && plainFileRun(only!, root) ? { kind: 'files' } : { kind: 'owner', why: only!.words.map(w => w.text).join(' ') || only!.program };
}

function rewritesOf(sts: readonly StatementFacts[], shown: ReadonlySet<string>): string | undefined {
  const quiet = (st: StatementFacts): boolean => {
    const name = st.program.toLowerCase().replace(/\.exe$/u, '');
    if (makesDirOnly(st, name)) return true;
    if (st.redirected || st.writes.length > 0 || st.reasonKeys.some(key => REWRITE_KEYS.has(key) || key === 'list.write_dynamic')) return false;
    const program = st.program.toLowerCase().replace(/\.exe$/u, '');
    if (program === '') return st.words.length === 0 && st.code.length === 0 && st.reasonKeys.every(key => ENV_ONLY.has(key));
    if (runsCode(st)) return st.inner === undefined ? shownRun(st, shown) : st.inner !== null && st.inner.every(quiet);
    return st.reasonKeys.length === 0 && (READ_PROGRAMS.has(program) || (program === 'git' && gitRead(st)));
  };
  const moved = sts.flatMap(st => [st, ...(st.inner ?? []), ...(st.unknownInner ?? [])]).find(st => st.reasonKeys.some(key => REWRITE_KEYS.has(key)));
  if (moved) return moved.program || 'statement';
  const last = sts.findLastIndex(runsCode);
  if (last < 0) return undefined;
  const bad = sts.slice(0, last).find(st => !quiet(st));
  if (bad) return bad.program || 'statement';
  const run = sts[last]!;
  if (run.inner === null) return run.program;
  return run.inner === undefined ? undefined : rewritesOf(run.inner, shown);
}

export function shellPreCheck(input: ShellInput, ctx: ToolContext): PreCheck {
  const language = languageOf(ctx.config);
  if (!ctx.config.tools.shell.enabled) return { decision: 'deny', reasons: [guardText(language, 'shell.disabled')] };
  if (input.background === true && !ctx.project?.root) return { decision: 'deny', reasons: [guardText(language, 'shell.background_no_product')] };
  const cwd = resolveCwd(input, ctx);
  if ('problem' in cwd) return { decision: 'deny', reasons: [cwd.problem] };
  const shell = ctx.config.tools.shell;
  const spec = resolveShell(shell.shell);
  const powershell = spec.name === 'powershell' || spec.name === 'pwsh';
  const { env: childEnv, gitIsolated, gitExe } = childEnvFor(shell, cwd.cwd, powershell);
  const checked = checkShellCommand(input.command, cwd.cwd, {
    policy: ctx.policy, outsideRoots: ctx.config.tools.outsideRoots, allow: shell.allow, ask: shell.ask, deny: shell.deny, language,
    selfHosts: selfHostsOf(ctx.config), shell: spec.name as ShellKind, windows: process.platform === 'win32', dataDir: ctx.paths.data,
    gitIsolated,
    which: name => findExecutable(name, childEnv, cwd.cwd, { powershell }),
    ...(ctx.project?.root ? { productEnv: productEnvReader(ctx.project.root), productEnvPath: productEnvPath({ root: ctx.project.root, dataDir: ctx.paths.data, policy: ctx.policy, protect: ctx.config.tools.hooks.preToolUse.filter(h => 'builtin' in h) }) } : {}),
  });
  const touch = checked.decision === 'deny' ? undefined : protectedTouchOf(input.command, checked.statements, ctx.policy, cwd.cwd);
  const verdict = touch && !checked.reasonKeys.includes(touch.key) ? { ...checked, decision: 'ask' as const, reasons: [...checked.reasons, guardText(language, touch.key, { path: touch.path })], reasonKeys: [...checked.reasonKeys, touch.key], askKinds: [...new Set([...checked.askKinds, 'code' as const])] } : checked;
  const self = verdict.decision === 'deny' ? undefined : selfTarget(input.command, ctx.config.server);
  if (self !== undefined) return { decision: 'deny', reasons: [guardText(language, 'guard.self_port', { target: self })], reasonKeys: ['guard.self_port'] };
  const place = ctx.place?.kind === 'worktree' && ctx.project?.root ? { worktree: ctx.project.root, productRoot: ctx.place.productRoot, cwd: cwd.cwd } : undefined;
  // 作業コピーのタスクは、本体のフォルダ（作業コピーの外）を作業フォルダにして動かさない（files.ts の checkFilePath のシェル版）
  if (place && mainWrites([cwd.cwd], place).length) return { decision: 'deny', reasons: [guardText(language, WT_MAIN_PATH, { path: cwd.cwd })], reasonKeys: [WT_MAIN_PATH] };
  if (place && verdict.decision !== 'deny') {
    const wtGit = gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: place.worktree }) : undefined;
    const once = <T>(fn: () => T): (() => T) => { let done = false; let value: T; return () => { if (!done) { value = fn(); done = true; } return value; }; };
    const refused = worktreeGitRefusal(verdict.statements, {
      ...place, command: input.command, powershell,
      remotes: once(() => wtGit?.(place.worktree, ['remote'])?.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)),
      sharedConfig: once(() => wtGit?.(place.worktree, ['config', '--list'])),
    });
    if (refused !== undefined) return { decision: 'deny', reasons: [guardText(language, refused.key, { cmd: refused.cmd, path: refused.path ?? refused.cmd })], reasonKeys: [refused.key] };
    // git の文があるコマンドで、見張りが作業コピーの外（または決められない場所）を指すパスを見つけたら、git ごと断る（字句の読み違いの受け止め）
    const outside = gitWithOutsidePath(verdict.statements, verdict.paths, place);
    if (outside !== undefined) return { decision: 'deny', reasons: [guardText(language, WT_OUTSIDE_PATH, { path: outside })], reasonKeys: [WT_OUTSIDE_PATH] };
    // 書く場所が決められない（変数で組んだパス）・先の決まらないリンクは、本体かもしれないので断る
    const unknownWrite = verdict.paths.find(p => p.write && !p.path)?.input ?? (verdict.reasonKeys.includes('list.write_dynamic') ? input.command.slice(0, 200) : linkOutOfCopy(verdict.statements, place));
    if (unknownWrite !== undefined) return { decision: 'deny', reasons: [guardText(language, WT_WRITE_MAIN, { path: unknownWrite })], reasonKeys: [WT_WRITE_MAIN] };
    const main = mainWrites([...verdict.writes, ...verdict.paths.flatMap(p => (p.write && p.path ? [p.path] : []))], place);
    if (main.length) return { decision: 'deny', reasons: [guardText(language, WT_WRITE_MAIN, { path: main[0]! })], reasonKeys: [WT_WRITE_MAIN] };
    const named = namesMain(input.command, verdict.statements, place);
    if (named !== undefined) return { decision: 'deny', reasons: [guardText(language, WT_MAIN_PATH, { path: named })], reasonKeys: [WT_MAIN_PATH] };
  }
  const details = verdict.paths.map(p => guardText(language, 'shell.detail', {
    input: p.input, path: p.path ?? guardText(language, 'shell.unresolved_path'),
    place: guardText(language, p.placement.kind === 'inside' ? (p.placement.mode === 'write' ? 'shell.place.write' : 'shell.place.read')
      : p.placement.kind === 'outside' ? 'shell.place.outside' : p.placement.kind === 'deny' ? 'shell.place.deny' : 'shell.place.unknown'),
  }));
  const paths = approvalPaths(verdict.paths);
  const pathsMore = approvalPathsMore(verdict.paths);
  const created = new Set<string>();
  const outbound = verdict.decision === 'deny' ? undefined : shellOutbound(input.command, verdict.statements, ctx, childEnv, gitExe, language, created);
  const places = placesOf(verdict.statements, cwd.cwd);
  const pushes = pushesOf(verdict.statements, verdict.reasonKeys);
  if (input.background === true && pushes.length) return { decision: 'deny', reasons: [guardText(language, 'shell.background_push')] };
  const beatPush = pushes.length && gitExe && verdict.decision !== 'deny' ? beatBranchPush(verdict.statements, isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project?.root ?? undefined }), cwd.cwd) : undefined;
  if (beatPush !== undefined) return { decision: 'deny', reasons: [guardText(language, WT_PUSH_BEAT, { cmd: beatPush })], reasonKeys: [WT_PUSH_BEAT] };
  // 直す実行（beat 8-6a D-11 の 1）: 裏のコマンド・push・通信・写しの外のパスは、判定役にも Pending にも回さずここで断る
  if (ctx.place?.kind === 'fix' && ctx.project?.root && verdict.decision !== 'deny') {
    const refused = fixShellRefusal({
      copy: ctx.project.root, cwd: cwd.cwd, command: input.command, background: input.background === true, statements: verdict.statements, paths: verdict.paths, writes: verdict.writes,
      reasonKeys: verdict.reasonKeys, askKinds: verdict.askKinds, fetched: verdict.fetched === true, pushes: pushes.length, sends: outbound?.kind === 'send',
    });
    if (refused) return { decision: 'deny', reasons: [guardText(language, refused.key, { cmd: refused.detail })], reasonKeys: [refused.key] };
  }
  const readPaths = [...new Set(verdict.paths.flatMap(p => (p.path ? [p.path] : [])))];
  const run = ctx.project?.root && verdict.decision === 'ask' ? productRunOf({
    root: ctx.project.root, verdict,
    which: (name, dir) => findExecutable(name, childEnv, dir, { powershell }),
    git: gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project.root }) : () => undefined,
    ownerHooks: () => !gitExe || ownerHooksPathSet(gitExe, ctx.paths.data),
  }) : undefined;
  const pushed = verdict.decision === 'ask' ? pushProtectOf({
    config: ctx.config, statements: verdict.statements, projectRoot: ctx.project?.root ?? undefined, productRoots: [],
    git: gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project?.root ?? undefined }) : () => undefined,
  }) : undefined;
  const runFacts = pushed ? { ownerReason: 'files' in pushed ? pendingText('en', 'owner_protected_push', { files: pushed.files.join('; ') }) : pendingText('en', 'owner_push_unchecked') }
    : run && 'run' in run ? { productRun: run.run } : run && 'secret' in run ? { ownerReason: pendingText('en', 'owner_secret_commit', { path: run.secret }) }
    : run && 'secretMessage' in run ? { ownerReason: pendingText('en', 'owner_secret_message') } : {};
  const effects = { writes: verdict.writes, cwd: cwd.cwd, readPaths, ...ruleShapeField(verdict.decision, verdict.statements, ctx.project?.root, outbound, { scripts: verdict.scripts, ownHooksDir: verdict.ownHooksDir, git: gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project?.root ?? undefined }) : undefined, ownerHooks: () => !gitExe || ownerHooksPathSet(gitExe, ctx.paths.data), config: ctx.config }), ...(outbound ? { outbound } : {}), ...(places.length ? { places } : {}), ...(pushes.length ? { pushes } : {}), ...(gitStagingOnly(verdict.statements) ? { gitStaging: true as const } : {}), ...(created.size ? { created: [...created].sort() } : {}) };
  const codeTouch = verdict.decision === 'deny' ? undefined : installTouchOf(verdict.statements, ctx.policy, cwd.cwd);
  if (codeTouch && !verdict.onceOnly) return { decision: 'ask', reasons: [guardText(language, 'code.self_touch', { markers: codeTouch }), ...verdict.reasons], reasonKeys: ['code.self_touch', ...verdict.reasonKeys], details, paths, pathsMore, askKinds: [...new Set([...verdict.askKinds, 'code' as const])], ...(verdict.fetched ? { fetched: true } : {}), ...effects };
  if (!verdict.onceOnly || verdict.decision === 'deny') return { decision: verdict.decision, reasons: verdict.reasons, reasonKeys: verdict.reasonKeys, details, paths, pathsMore, ...(verdict.decision === 'ask' ? { askKinds: verdict.askKinds } : {}), ...(verdict.fetched ? { fetched: true } : {}), ...effects, ...runFacts };
  const scope = filesScope(verdict.statements, verdict.reasonKeys, ctx.project?.root ?? ctx.workspace, verdict.scripts);
  const shown = judgeFilesOf({ scripts: verdict.scripts, inline: verdict.statements.flatMap(st => st.cwd === null ? [] : st.code.map(code => ({ code, cwd: st.cwd! }))), root: ctx.project?.root ?? ctx.workspace,
    writes: [...verdict.writes, ...verdict.paths.flatMap(p => (p.write && p.path ? [p.path] : []))], unshown: verdict.unshown ?? (scope.kind === 'owner' ? scope.why : undefined), rewrites: rewritesOf(verdict.statements, new Set(verdict.scripts)) });
  const peeked = [...new Set([...verdict.scripts, ...shown.read.map(file => file.path)])].map(file => peek(file, language));
  const cards = runCards(peeked, verdict.statements, verdict.scripts, verdict.reasonKeys, ctx.project?.root ?? ctx.workspace, ctx.policy, language);
  const peekTouch = codeTouch ?? installTouchOf([], ctx.policy, cwd.cwd, peeked.flatMap(p => p.content ?? []));
  const found = selfTouchMarkers(input.command, selfHostsOf(ctx.config), ctx.config.server, beatPortsOf(ctx), peeked.flatMap(p => p.content ?? []));
  const markers = [...found.strong, ...(peekTouch ? [peekTouch] : [])];
  const limited = verdict.limits ? [...verdict.reasons, guardText(language, 'code.limits')] : verdict.reasons;
  const base = found.weak.length ? [...limited, guardText(language, 'code.self_hint', { markers: found.weak.join(', ') })] : limited;
  const reasons = markers.length ? [guardText(language, 'code.self_touch', { markers: markers.join(', ') }), ...base] : base;
  const reasonKeys = [...(markers.length ? ['code.self_touch'] : []), ...verdict.reasonKeys];
  return {
    decision: verdict.decision, reasons, reasonKeys, details, paths, pathsMore, askKinds: verdict.askKinds, ...(verdict.ownHooksDir ? { ownHooksDir: verdict.ownHooksDir } : {}), ...(verdict.fetched ? { fetched: true } : {}), ...effects,
    ...(markers.length && 'productRun' in runFacts ? {} : runFacts),
    ...('problem' in shown.fact || (shown.fact.files.length > 0 && scope.kind === 'files') ? { judgeFiles: shown.fact } : {}),
    preview: cards.map(p => p.preview), bind: sha256([...cards.map(p => p.fingerprint), ...shown.read.map(file => file.fingerprint), ...hookFingerprints(verdict.ownHooksDir, language)].join('\n')),
  };
}

// 作業コピーの実行: git が作業コピーの置き場より上のリポジトリ（beat 自身など）を見つけないように
// 作業コピーの実行の git は、共通の .git で自動の片づけ（gc・maintenance）をしない（8-1 の NO_MAINTENANCE と同じ。本体の packed-refs などを書き換えないため）
function placeEnv(ctx: ToolContext, env: Record<string, string>): Record<string, string> {
  if (!ctx.place) return env;
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  const extra: Array<[string, string]> = [['gc.auto', '0'], ['maintenance.auto', 'false']];
  const out: Record<string, string> = { ...env, GIT_CEILING_DIRECTORIES: ctx.place.ceiling, GIT_CONFIG_COUNT: String(count + extra.length) };
  extra.forEach(([key, value], i) => { out[`GIT_CONFIG_KEY_${count + i}`] = key; out[`GIT_CONFIG_VALUE_${count + i}`] = value; });
  return out;
}

interface BackgroundRun { cwd: string; shell: ReturnType<typeof resolveShell>; child: ReturnType<typeof childEnvFor>; settings: AppConfig['tools']['shell'] }

async function runBackground(input: ShellInput, ctx: ToolContext, info: ExecuteInfo | undefined, run: BackgroundRun): Promise<ToolOutput> {
  const language = languageOf(ctx.config);
  const jobs = ctx.services?.background;
  const project = ctx.project;
  if (!jobs || !project?.root || info?.pushCheck) return { content: toolText(language, 'shell.bg_unavailable'), isError: true };
  const { cwd, shell, child, settings } = run;
  const ownerHooks = info?.approvedOnce === true ? info.check?.ownHooksDir : undefined;
  const gitRun = child.gitIsolated ? prepareGitRun({ dataDir: ctx.paths.data, env: child.env, ...(ownerHooks ? { ownerHooks } : {}), ...(child.gitExe ? { gitExe: child.gitExe } : {}) }) : undefined;
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; gitRun?.cleanup(); } };
  const check = info?.check;
  const fetched = info?.fetched === true || check?.fetched === true || (check?.decision === 'ask' && check.askKinds?.includes('egress') === true);
  let started: ReturnType<typeof jobs.start>;
  try {
    started = jobs.start({
      conversationId: ctx.conversationId, projectId: project.id, ...(ctx.task ? { taskId: ctx.task.id } : {}),
      command: input.command, cwd, file: shell.file, args: shell.args(input.command), env: placeEnv(ctx, { ...child.env, ...gitRun?.env }),
      ...(shell.stdin ? { stdin: shell.stdin(input.command) } : {}), fetched, ...(ctx.taint.tainted ? { tainted: true } : {}), onExit: cleanup,
    });
  } catch (error) {
    cleanup();
    return { content: toolText(language, 'shell.spawn_failed', { shell: shell.name, detail: (error as Error).message }), isError: true };
  }
  if ('refused' in started) {
    cleanup();
    if (started.refused === 'closed') return { content: toolText(language, 'shell.bg_closed'), isError: true };
    const list = started.running.length ? `\n${toolText(language, 'shell.bg_mine')}\n${jobLines(started.running, language)}` : '';
    return started.refused === 'conversation_limit'
      ? { content: toolText(language, 'shell.bg_limit_conversation', { max: started.running.length, list }), isError: true }
      : { content: toolText(language, 'shell.bg_limit_total', { max: started.running.length + started.elsewhere, elsewhere: started.elsewhere, list }), isError: true };
  }
  await jobs.wait(started.id, ctx.conversationId, BACKGROUND_SETTLE_SEC, ctx.signal);
  const read = jobs.read(started.id, ctx.conversationId);
  if (!read) return { content: toolText(language, 'shell.bg_closed'), isError: true };
  const mark = read.fetched ? { fetched: true } : {};
  if (read.state === 'running') {
    const cut = newest(read.text);
    const shown = cut.text.trimEnd();
    const skipped = cut.skipped + read.skipped;
    const parts = [
      ...(skipped > 0 ? [toolText(language, 'bg.skipped', { bytes: skipped.toLocaleString('en-US') })] : []),
      shown ? `${toolText(language, 'shell.bg_so_far')}\n${shown}` : toolText(language, 'shell.bg_none_yet'),
    ];
    return { content: shellTranscript(input.command, [toolText(language, 'shell.bg_started', { id: read.id, shell: shell.name, cwd }), notContained(read, language)].filter(Boolean).join(' '), parts), keepTail: true, ...mark };
  }
  if (read.spawnError !== undefined) {
    jobs.forget(read.id, ctx.conversationId);
    return { content: toolText(language, 'shell.spawn_failed', { shell: shell.name, detail: read.spawnError }), isError: true };
  }
  const seconds = (((read.endedAt ?? read.startedAt) - read.startedAt) / 1000).toFixed(1);
  const header = read.state === 'stopped'
    ? toolText(language, 'shell.bg_stopped_header', { shell: shell.name, cwd, state: jobState(read, language), seconds })
    : toolText(language, 'shell.header', { shell: shell.name, cwd, code: read.exitCode ?? '—', seconds });
  const held = Buffer.byteLength(read.text, 'utf8');
  const truncated = read.skipped > 0 || held > settings.outputCapBytes;
  const tail = truncated ? newest(read.text, Math.min(BACKGROUND_OUTPUT_CHARS, settings.outputCapBytes)).text : read.text;
  const parts: string[] = [];
  if (truncated) parts.push(toolText(language, 'bg.skipped', { bytes: (read.skipped + held - Buffer.byteLength(tail, 'utf8')).toLocaleString('en-US') }));
  if (tail.trim()) parts.push(tail.trimEnd());
  if (truncated) parts.push(toolText(language, 'shell.bg_full_log', { path: read.logPath }));
  else jobs.forget(read.id, ctx.conversationId);
  return {
    content: shellTranscript(input.command, header, parts),
    keepTail: true,
    isError: read.exitCode !== 0,
    ...(truncated ? { fullRef: read.logPath } : {}),
    ...(typeof read.exitCode === 'number' ? { exitCode: read.exitCode } : {}),
    ...mark,
  };
}

// 設定を渡せない説明（description）は「設定の上限」と言い、渡せる説明（describe）は maxTimeoutSec の秒数まで言う。入力の型の最大 3600 は、設定で上げられる限界であって、いまの上限ではない
const shellDescription = (maxTimeoutSec?: number): string => [
  'Run one shell command (PowerShell on Windows, bash on Linux). cwd must be inside an allowed folder (if omitted, the working folder).',
  'Do not use cd to move outside the allowed folders; set cwd instead. Sending data out, installing packages and operations that touch anything outside the allowed folders need the user\'s approval.',
  'Destructive operations and reading secrets cannot be run.',
  'Walking a large folder such as node_modules or .git with -Recurse or the like is slow (over 20 seconds for 15,000 files), and the result is too long to fit in the context. Exclude such folders, or narrow the scope with -Name, -Filter or -Depth.',
  'On Windows, PowerShell runs in constrained mode, so do not use .NET type syntax ([Math]::, [IO.File]::, [pscustomobject]), New-Object or Add-Type; write it with cmdlets and string methods.',
  'In Windows PowerShell 5.1, && and || do not exist (join commands with ;), and rm -rf fails (write Remove-Item -Recurse -Force).',
  'PowerShell cmdlets also resolve * ? [ ] in a quoted path as wildcards. To point at a file whose name contains [ ], use -LiteralPath.',
  'In Windows PowerShell, cmdlets that write, create, copy, move, rename or delete files (Set-Content, Out-File, Copy-Item, Move-Item, New-Item, Remove-Item and so on) and redirection (>) need the user\'s confirmation every time, even when the path is fixed. To write a file, use the file_write / file_edit tools, not the shell. Piping the result of Get-ChildItem -Filter into Select-String or Get-Content also needs confirmation every time (use -Include or Select-String -Path).',
  'Forms of curl or wget that save to a file (curl with -o or -O; wget in any form other than -O -) need the user\'s confirmation every time, even when the destination is fixed. When a curl URL contains { } [ ], add -g (without it, curl expands them, so confirmation is needed).',
  'For a long-running command (a dev server, a watcher, a long test run), set background: true and keep working. It goes through the same checks, waits about 2 seconds, then returns an id such as bg-3 with the output so far (if the command ends within those 2 seconds, you get the normal result instead). Read its later output with shell_output and stop it with shell_stop; the background commands of this conversation are listed in the system prompt.',
  `timeoutSec cannot go above the maximum set in the settings${maxTimeoutSec === undefined ? '' : ` (${maxTimeoutSec} s)`}; a larger value is lowered to that maximum and the result says so.`,
  'timeoutSec does not apply to a background command: it runs until it is stopped, this conversation is deleted or archived, the task ends, or beat stops. Background commands work only in a product\'s conversation or task, and git push cannot run in the background.',
  'Never put a command in the background yourself with &, nohup, start or Start-Process: beat could not see or stop it.',
  'A window or GUI program that a background command opens (a browser, an app) is closed together with it; background commands run with BROWSER=none, so dev servers do not open a browser (look at the page with the browser tools instead).',
].join(' ');

export const shellRun: ToolDef<ShellInput> = {
  name: 'shell_run',
  description: shellDescription(),
  describe: config => shellDescription(config.tools.shell.maxTimeoutSec),
  input: Type.Object({
    command: Type.String({ minLength: 1, maxLength: 8000 }),
    cwd: Type.Optional(Type.String({ maxLength: 1024 })),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    background: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  effect: 'exec',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: shellPreCheck,
  summarize: (input, language) => ({
    title: toolText(language, input.background === true ? 'summary.shell_background' : 'summary.shell'),
    body: input.command,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  }),
  async execute(input, ctx, info) {
    const cwd = resolveCwd(input, ctx);
    if ('problem' in cwd) return { content: cwd.problem, isError: true };
    const language = languageOf(ctx.config);
    const settings = ctx.config.tools.shell;
    const shell = resolveShell(settings.shell);
    const timeoutSec = Math.min(input.timeoutSec ?? settings.timeoutSec, settings.maxTimeoutSec);
    const child = childEnvFor(settings, cwd.cwd, shell.name === 'powershell' || shell.name === 'pwsh');
    if (input.background === true && ctx.fix) return { content: guardText(language, 'fix.background', { cmd: input.command.slice(0, 200) }), isError: true };
    const fixJob = ctx.fixJob;
    if (ctx.fix && !fixJob) return { content: guardText(language, 'fix.no_job', {}), isError: true };
    if (input.background === true) return runBackground(input, ctx, info, { cwd: cwd.cwd, shell, child, settings });
    const ownerHooks = info?.approvedOnce === true ? info.check?.ownHooksDir : undefined;
    const pushCheck = info?.pushCheck;
    const prePush = pushCheck ? { prePush: { tips: pushCheck.tips, node: process.execPath, ...(ownerHooks ? { ownerHooks } : {}) } } : {};
    const gitRun = child.gitIsolated ? prepareGitRun({ dataDir: ctx.paths.data, env: child.env, ...(ownerHooks ? { ownerHooks } : {}), ...prePush, ...(child.gitExe ? { gitExe: child.gitExe } : {}) }) : undefined;
    if (pushCheck?.required && gitRun?.prePushReady !== true) {
      gitRun?.cleanup();
      return { content: '', isError: true, pushCheckUnavailable: true };
    }
    let result;
    let pushRefused = false;
    try {
      result = await runProcess(shell.file, shell.args(input.command), {
        cwd: cwd.cwd, env: placeEnv(ctx, { ...child.env, ...gitRun?.env }), timeoutMs: timeoutSec * 1000, signal: ctx.signal,
        maxBytes: settings.outputCapBytes, tailBytes: Math.min(SHELL_TAIL_BYTES, settings.outputCapBytes), fullOutputDir: join(ctx.paths.data, 'tool_outputs'), outputId: `shell-${randomUUID()}`,
        ...(shell.stdin ? { input: shell.stdin(input.command) } : {}),
        ...(fixJob ? { onSpawn: (spawned: ChildProcess) => fixJob.add(spawned) } : {}),
      });
      pushRefused = gitRun?.refused?.() === true;
    } finally { gitRun?.cleanup(); }
    if (result.spawnError) return { content: toolText(language, 'shell.spawn_failed', { shell: shell.name, detail: result.spawnError }), isError: true };
    const header = toolText(language, 'shell.header', { shell: shell.name, cwd: cwd.cwd, code: result.exitCode ?? '—', seconds: (result.durationMs / 1000).toFixed(1) });
    const parts: string[] = [];
    const stdout = headAndTail(result.stdout, result.rest?.out, language);
    const stderr = headAndTail(result.stderr, result.rest?.err, language);
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
    if (result.truncated) parts.push(toolText(language, 'shell.truncated', { total: result.totalBytes.toLocaleString('en-US'), cap: settings.outputCapBytes.toLocaleString('en-US'), tail: result.fullOutputPath ? toolText(language, 'shell.truncated_tail', { path: result.fullOutputPath }) : '' }));
    if (result.timedOut) parts.push(toolText(language, 'shell.timeout', { seconds: timeoutSec }));
    if (input.timeoutSec !== undefined && input.timeoutSec > timeoutSec) parts.push(toolText(language, 'shell.timeout_lowered', { asked: input.timeoutSec, seconds: timeoutSec }));
    if (result.aborted) parts.push(toolText(language, 'shell.aborted'));
    return {
      content: shellTranscript(input.command, header, parts),
      keepTail: true,
      isError: result.timedOut || result.aborted || result.exitCode !== 0,
      ...(result.fullOutputPath ? { fullRef: result.fullOutputPath } : {}),
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(pushRefused ? { pushRefused } : {}),
    };
  },
};
