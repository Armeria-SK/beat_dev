// 許可の一覧で、文 1 つを判定する（security-self-api.md §11.1 の 5）。結果は 許す / ふつうの確かめ / 今回だけ / 止める と、理由と、調べるパス。
// 表は allowlist-tools.ts（bash・外部の道具）・allowlist-git.ts・allowlist-ps.ts（コマンドレット）。ここは、名前の決まり（C1）・外部の実体（C2）・代入（C8）・リダイレクト・形の印をまとめる。

import { Acc, PS_CD_SHORTCUTS, PS_QUALIFIED_CD, bashVarOk, envAssignOk, productEnvOk, psVarOk, worstLevel, type Level, type MatchCtx, type RepoInfo, type StatementResult } from './allowlist-core.ts';
import { runGit } from './allowlist-git.ts';
import { pipeBound } from './allowlist-pipe.ts';
import { cmdHostArgs, parsePs, psArgs, psCmdlet, runFindstr, runPsSimple, winArgs, withWildcard } from './allowlist-ps.ts';
import { toolFor } from './allowlist-tools.ts';
import { isPowerShell, lexShell, type LexFail, type Statement, type Word } from './shell-lex.ts';

export * from './allowlist-core.ts';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.+-]*$/u;
const BASH_SPECIAL = new Set(['[', '[[', ':']);
const NULL_SINK = /^(?:\/dev\/null|\$null|nul)$/iu;
// PowerShell から起こしてよい外部のプログラム（git・rg・tar・言語の道具は allowlist-tools.ts と同じ表）
const PS_EXTERNAL_TOOLS = new Set(['rg', 'tar', 'curl', 'node', 'nodejs', 'python', 'python3', 'py', 'deno', 'bun', 'go', 'cargo', 'rustc', 'tsc', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'gem', 'composer', 'pdm', 'hatch']);
const PS_SIMPLE = new Set(['whoami', 'hostname', 'ipconfig', 'tree', 'tree.com', 'where.exe']);
// パイプに文字だけを流す外部のプログラム
const isExternalText = (name: string): boolean => name === 'git' || name === 'findstr' || PS_EXTERNAL_TOOLS.has(name) || PS_SIMPLE.has(name);

export type { StatementResult, MatchCtx, RepoInfo, Level };

const SHAPES: Record<string, string> = {
  call: 'shape.call', dot_source: 'shape.dot_source', splat: 'shape.splat', function: 'shape.function', process_out: 'shape.process_out',
  pipe_stderr: 'shape.pipe_stderr', script_block: 'shape.script_block', replace_block: 'shape.replace_block',
};
function shapes(st: Statement, acc: Acc): void {
  for (const shape of st.shapes) {
    const [head, ...rest] = shape.split(':');
    const detail = rest.join(':');
    if (SHAPES[shape]) acc.add('once', SHAPES[shape] as 'shape.call', {}, false);
    else if (head === 'control') acc.add('once', 'shape.control', { name: detail || 'bash' }, false);
    else if (head === 'control_opaque') acc.add('once', 'shape.control_opaque', { name: detail }, false);
    else if (head === 'static') acc.add('once', 'shape.static', { name: detail }, false);
    else if (head === 'cast') acc.add('once', 'shape.cast', { name: detail }, false);
    else if (head === 'method') acc.add('once', 'shape.method', { name: detail }, false);
    else if (head === 'expr') acc.add('once', 'shape.expr', { name: detail }, false);
    else if (head === 'arith') acc.add('once', 'list.arith', { cmd: '$(( ))', detail }, false);
    else acc.add('once', 'list.shape', { detail: shape }, false);
  }
  if (st.background) acc.add('once', 'shape.background', {}, false);
}

function redirects(st: Statement, acc: Acc, ps: boolean): void {
  for (const r of st.redirects) {
    if (r.op === '<<' || r.op === '<<<' || r.op.endsWith('&') || !r.target) continue;
    if (NULL_SINK.test(r.target.text) && !r.target.dynamic) continue;
    // PowerShell の > は Out-File -FilePath と同じで、引用符つきでもワイルドカードを解決する
    const target = ps ? withWildcard(r.target) : r.target;
    if (r.op === '<') { acc.read(target); continue; }
    acc.write(target);
    // PowerShell のリダイレクトは書き込みなので、持ち主の許可でも外せず毎回確かめる（§11.13）
    if (ps) acc.add('once', 'list.ps_write', { cmd: r.op }, false);
  }
}

function assignments(st: Statement, ps: boolean, acc: Acc, ctx: MatchCtx): void {
  for (const a of st.assigns) {
    const bareStatement = st.words.length === 0;
    if (ps) {
      const env = /^env:(.*)$/isu.exec(a.name);
      if (env ? !productEnvOk(env[1]!, a.value, ctx.productEnv, ctx.productEnvPath) : !psVarOk(a.name)) acc.add('once', 'list.env', { name: a.name }, false);
    } else if (bareStatement) {
      if (!bashVarOk(a.name)) acc.add('once', 'list.env', { name: a.name }, false);
    } else if (!envAssignOk(a.name, a.value)) acc.add('once', 'list.env', { name: a.name }, false);
  }
}

function loopVariable(st: Statement, acc: Acc): void {
  const raw = st.words[0]?.text;
  if (raw === undefined) return;
  const name = st.header === 'foreach' ? raw.replace(/^\$/u, '') : raw;
  const ok = st.header === 'foreach' ? !/^env:/iu.test(name) && psVarOk(name) : bashVarOk(name);
  if (!ok) acc.add('once', 'list.env', { name }, false);
}

function external(key: string, acc: Acc, ctx: MatchCtx): string {
  if (!ctx.external) return '.exe';
  const r = ctx.external(key);
  if (!r.ok) acc.add('once', 'list.external', { cmd: key, detail: r.detail }, false);
  return r.ext;
}

function runPs(key: string, exe: boolean, st: Statement, acc: Acc, ctx: MatchCtx): void {
  const words = st.words;
  if (!exe) {
    const spec = psCmdlet(key);
    if (spec) {
      const p = parsePs(spec, words, acc, ctx);
      spec.extra?.(p, acc, ctx, st);
      pipeBound(spec, p, st, acc, ctx, isExternalText);
      return;
    }
  }
  if (key === 'git' || PS_EXTERNAL_TOOLS.has(key) || key === 'findstr' || (PS_SIMPLE.has(exe && key === 'where' ? 'where.exe' : key))) {
    const ext = external(key, acc, ctx);
    const literalGlob = words.map(w => (w.glob ? { ...w, glob: false } : w));
    const simple = exe && key === 'where' ? 'where.exe' : key;
    if (key === 'git') runGit(literalGlob, acc, ctx);
    else if (key === 'findstr') runFindstr(literalGlob, acc, ctx);
    else if (PS_SIMPLE.has(simple)) runPsSimple(simple, literalGlob, acc, ctx);
    else toolFor(key)!.run(literalGlob, acc, ctx);
    if (ctx.windows) winArgs(key, words, ext, acc);
    else psArgs(key, words, acc);
    return;
  }
  acc.add('once', 'list.command', { cmd: words[0]!.text }, true);
  unlistedArgs(st, acc, ctx);
  psCdShape(st, acc, ctx);
}

function unlistedArgs(st: Statement, acc: Acc, ctx: MatchCtx): void {
  if (!ctx.windows) return;
  const name = st.words[0]!;
  const cmdTarget = (t: string): boolean => /\.(?:cmd|bat)$/iu.test(t)
    || (/[\\/:]/u.test(t) ? !(/\.(?:exe|com|ps1)$/iu.test(t) && ctx.fileExists?.(t) === true) : ['.cmd', '.bat'].includes(ctx.external?.(t.toLowerCase()).ext ?? '.exe'));
  const trimmed = name.text.replace(/[ .]+$/u, '') || name.text;
  if (name.dynamic || cmdTarget(name.text) || cmdTarget(trimmed)) winArgs(trimmed, st.words, '.cmd', acc);
  else cmdHostArgs(trimmed, st, cmdTarget, acc);
}

// cd..・cd\（組み込みの関数）とモジュール名つきの Set-Location は、理由は今までどおり（知らないコマンド）のまま、作業フォルダだけ追う。
// Microsoft.PowerShell.Management 以外のモジュール名は、そのコマンドが無ければ失敗して動かないので「かもしれない」
function psCdShape(st: Statement, acc: Acc, ctx: MatchCtx): void {
  const name = st.words[0]!;
  if (name.dynamic) return;
  const short = PS_CD_SHORTCUTS.get(name.text.toLowerCase());
  if (short !== undefined) { acc.cwd = { word: { text: short, dynamic: false, glob: false, quoted: false, home: false, kind: 'plain' } }; return; }
  const qualified = PS_QUALIFIED_CD.exec(name.text);
  if (!qualified) return;
  const cd = matchStatement({ ...st, words: [{ ...name, text: qualified[2]! }, ...st.words.slice(1)] }, ctx).cwd;
  if (cd) acc.cwd = qualified[1]!.toLowerCase() === 'microsoft.powershell.management' ? cd : { ...cd, maybe: true };
}

interface LinkForm { detail: string; operands: Word[]; deep?: Word[] }

const ELEVATORS: ReadonlySet<string> = new Set(['gsudo']);
const commandBase = (w: Word): string => (w.dynamic || w.kind !== 'plain' ? '' : (w.text.split(/[\\/]/u).pop() ?? '').replace(/[ .]+$/u, '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/u, ''));
const longOption = (text: string, name: string, min: number): boolean => {
  const head = text.split('=', 1)[0]!;
  return head.length >= min && name.startsWith(head);
};

function operandsOf(args: readonly Word[]): Word[] {
  const out: Word[] = [];
  let ended = false;
  for (const w of args) {
    if (w.kind !== 'plain') continue;
    if (ended || w.dynamic || !w.text.startsWith('-') || w.text === '-') { out.push(w); continue; }
    if (w.text === '--') { ended = true; continue; }
    const attached = /^--[^=]+=(.+)$/su.exec(w.text) ?? /^-[A-Za-z]*?t(.+)$/su.exec(w.text);
    if (attached) out.push({ ...w, text: attached[1]! });
  }
  return out;
}

function linkFormOf(key: string, words: readonly Word[], ps: boolean): LinkForm | undefined {
  const args = words.slice(1);
  if (key === 'ln') return { detail: key, operands: operandsOf(args) };
  if (key === 'mklink') return { detail: key, operands: args.filter(w => w.kind === 'plain' && (w.dynamic || !/^\/[A-Za-z]$/u.test(w.text))) };
  if (key === 'cmd') {
    const at = args.findIndex(w => /^\/[ckr]/iu.test(w.text));
    if (at < 0 || args.slice(at).some(w => w.dynamic)) return undefined;
    const tokens = [args[at]!.text.slice(2), ...args.slice(at + 1).map(w => w.text)].join(' ').split(/\s+/u).map(t => t.replace(/^["@(]+|"+$/gu, '')).filter(Boolean);
    while (tokens[0]?.toLowerCase() === 'call') tokens.shift();
    const inner = tokens.map((text): Word => ({ text, dynamic: false, glob: false, quoted: false, home: false, kind: 'plain' }));
    const form = inner[0] ? linkFormOf(inner[0].text.toLowerCase().replace(/\.exe$/u, ''), inner, false) : undefined;
    return form && { ...form, operands: form.operands.map(w => ({ ...w, text: w.text.replace(/\)+$/u, '') })).filter(w => w.text !== '') };
  }
  if (key === 'fsutil') {
    const at = args.findIndex(w => w.dynamic || w.text.toLowerCase() === 'hardlink');
    if (at < 0) return undefined;
    const sub = args[at + 1];
    const listing = sub !== undefined && !sub.dynamic && sub.text.toLowerCase() === 'list';
    return { detail: args[at]!.text, operands: listing ? [] : args.slice(at + 1).filter(w => w.kind === 'plain' && (w.dynamic || w.text.toLowerCase() !== 'create')) };
  }
  if (key === 'cp' && !ps) {
    const flag = args.find(w => !w.dynamic && ((w.text.length >= 3 && '--link'.startsWith(w.text)) || (w.text.length >= 4 && '--symbolic-link'.startsWith(w.text)) || /^-[A-Za-z]*[ls]/u.test(w.text)))?.text;
    if (flag === undefined) return undefined;
    const operands = operandsOf(args);
    const tree = args.some(w => !w.dynamic && (longOption(w.text, '--recursive', 5) || longOption(w.text, '--archive', 4) || (/^-[A-Za-z]*[rRa]/u.test(w.text) && !w.text.startsWith('--'))));
    const targeted = args.some(w => !w.dynamic && (longOption(w.text, '--target-directory', 3) || (/^-[A-Za-z]*t/u.test(w.text) && !w.text.startsWith('--'))));
    return { detail: flag, operands, deep: tree ? (targeted ? operands : operands.slice(0, -1)) : [] };
  }
  return undefined;
}

function addLink(acc: Acc, key: string, text: string, words: readonly Word[], ps: boolean): void {
  const link = linkFormOf(key, words, ps);
  if (link === undefined) return;
  acc.add('once', 'list.form', { cmd: text, detail: link.detail }, false);
  for (const w of link.operands) acc.write(w, link.deep?.includes(w) ?? false);
}

export function matchStatement(st: Statement, ctx: MatchCtx): StatementResult {
  const acc = new Acc();
  acc.strict = st.inBlock === true;
  const ps = isPowerShell(ctx.shell);
  const first = st.words[0];
  const quotedName = ps && st.kind === 'command' && first !== undefined && first.kind === 'plain' && first.quoted && !first.dynamic && !first.home && NAME_RE.test(first.text) && st.shapes.includes('call');
  shapes(st, acc);
  redirects(st, acc, ps);
  if (st.kind === 'control') {
    if (st.header === 'for' || st.header === 'foreach') loopVariable(st, acc);
    if (st.header === 'for') for (const w of st.words.slice(2)) if (w.glob) acc.read(w);
    if (st.header === 'switch') for (const w of st.words.slice(1)) acc.read(w);
    return acc.result();
  }
  assignments(st, ps, acc, ctx);
  if (st.kind === 'assign' || st.kind === 'expr' || st.words.length === 0) return acc.result();

  const name = st.words[0]!;
  const text = name.text;
  const base = commandBase(name);
  if (ELEVATORS.has(base)) acc.add('deny', 'guard.elevate', {}, false);
  const named = quotedName || (name.kind === 'plain' && !name.dynamic && !name.quoted && !name.home && (NAME_RE.test(text) || (ps ? text === '%' || text === '?' : BASH_SPECIAL.has(text)) || text === 'tree.com' || text === 'where.exe'));
  if (!named) {
    acc.add('once', 'list.command', { cmd: text }, true);
    addLink(acc, base, text, st.words, ps);
    if (ps) { unlistedArgs(st, acc, ctx); psCdShape(st, acc, ctx); }
    return acc.result();
  }
  let key = ctx.windows || ps ? text.toLowerCase() : text;
  let exe = false;
  if (ctx.windows && key.endsWith('.exe') && key !== 'where.exe') { key = key.slice(0, -4); exe = true; }
  addLink(acc, key, text, st.words, ps);
  if (ps) { runPs(key, exe, st, acc, ctx); return acc.result(); }

  if (key === 'git') {
    external(key, acc, ctx);
    runGit(st.words, acc, ctx);
    return acc.result();
  }
  const tool = toolFor(key);
  if (!tool) { acc.add('once', 'list.command', { cmd: text }, true); return acc.result(); }
  if (!tool.builtin) external(key, acc, ctx);
  tool.run(st.words, acc, ctx);
  return acc.result();
}

// ── 文をまとめた判定（テストと shell-guard から）──
export interface Classified { level: Level; lex?: LexFail; results: StatementResult[]; statements: Statement[] }
export function classifyStatements(command: string, ctx: MatchCtx): Classified {
  const lexed = lexShell(command, ctx.shell);
  if (!lexed.ok) return { level: 'deny', lex: lexed.fail, results: [], statements: [] };
  ctx.beforeStatements?.(lexed.statements);
  const results = lexed.statements.map((st, index) => {
    ctx.beforeStatement?.(st, index);
    const result = matchStatement(st, ctx);
    ctx.afterStatement?.(result, st);
    return result;
  });
  return { level: results.reduce<Level>((l, r) => worstLevel(l, r.level), 'allow'), results, statements: lexed.statements };
}

export const noRepo = (): RepoInfo => ({ found: false, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false, hooksDir: '', remotes: [], localRemotes: [] });
export type { Word };
