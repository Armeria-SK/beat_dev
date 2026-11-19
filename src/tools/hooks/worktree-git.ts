// beat 8-2 D-12: 作業コピー（linked worktree）のタスクで通す git。作業コピーは本体とブランチ・stash・設定・worktree の登録を分け合うので、
// それを変えない形だけを数え上げて通し、ほかは断る（判定役にも Pending にも回さない）。オプションも数え上げた表にあるものだけ通す。純粋な関数
import { isAbsolute, resolve } from 'node:path';
import { PUSH_FLAGS, READ as READ_SPECS, WRITE_FLAGS } from './allowlist-git.ts';
import type { StatementFacts } from './shell-facts.ts';
import { expandPath, isInside, realish } from './scope.ts';

export const WT_GIT_SHARED = 'wt.git_shared';
export const WT_WRITE_MAIN = 'wt.write_main';
export const WT_PUSH_BEAT = 'wt.push_beat';
// 本体のフォルダを名指す（読むだけかもしれない）・何を動かすか読めない・GIT_… の名前を含む
export const WT_MAIN_PATH = 'wt.main_path';
export const WT_OPAQUE = 'wt.opaque';
export const WT_GIT_ENV = 'wt.git_env';

// git の文があるコマンドで、作業コピーの外のパスを名指す
export const WT_OUTSIDE_PATH = 'wt.outside_path';

export interface WorktreeRefusal { key: typeof WT_GIT_SHARED | typeof WT_OPAQUE | typeof WT_GIT_ENV | typeof WT_MAIN_PATH; cmd: string; path?: string }

type Kind = 'b' | 's' | 'opt';
type Flags = ReadonlyMap<string, Kind>;

// 'name' / 'name:s' / 'name:n' / 'name:opt' / 'name:pat' の並び（allowlist-git.ts と同じ書き方）
function flagTable(spec: string, drop: readonly string[] = [], add = ''): Flags {
  const map = new Map<string, Kind>();
  const tokens = [...spec.split(/\s+/u).filter(t => t && !drop.includes(t.split(':')[0]!)), ...add.split(/\s+/u).filter(Boolean)];
  for (const token of tokens) {
    const [name, kind] = token.split(':') as [string, string | undefined];
    map.set(name, kind === undefined ? 'b' : kind === 'opt' ? 'opt' : 's');
  }
  return map;
}

// 表に無い読むだけのサブコマンドは、オプションなしでだけ通す
const READ_EXTRA = ['version', 'help', 'whatchanged', 'show-branch', 'check-ignore', 'check-attr', 'var'];
const READ_FLAGS = new Map<string, { flags: Flags; numeric: boolean }>([
  ...Object.entries(READ_SPECS).map(([sub, spec]) => [sub, { flags: flagTable(spec.flags), numeric: spec.numeric === true }] as const),
  ...READ_EXTRA.map(sub => [sub, { flags: flagTable(''), numeric: false }] as const),
]);
// 今のブランチの上で動く書く形。ブランチを作る・移る・消すオプションは外す。merge / rebase の -s は戦略（任意のプログラム名）なので外す
const ON_BRANCH_DROP = ['-b', '-B', '--detach', '-d', '-D', '--rebase', '--no-rebase', '--list', '-l', '--include-untracked', '-k', '--keep-index'];
const ON_BRANCH = new Map<string, Flags>(['add', 'commit', 'rm', 'mv', 'restore', 'apply', 'am', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert']
  .map(sub => [sub, flagTable(WRITE_FLAGS, sub === 'merge' || sub === 'rebase' ? [...ON_BRANCH_DROP, '-s'] : ON_BRANCH_DROP, sub === 'commit' ? '-F:s --file:s --fixup:s' : sub === 'add' ? '-N --intent-to-add' : '')]));
// 共有の設定で自動の stash・ほかのブランチの書き換えをするもの（持ち主の設定で、ふつうの rebase / merge / pull が本体の stash やブランチを変える）
const AUTO_SHARED = /^(?:rebase\.updaterefs|rebase\.autostash|merge\.autostash|pull\.rebase)=(.*)$/u;
const CHECKOUT_FLAGS = flagTable('--ours --theirs -f --force -q --quiet');
// --depth・--deepen・--shallow-*・--unshallow・--update-shallow は共有の .git/shallow を書くので入れない
const FETCH_FLAGS = flagTable('-q --quiet -v --verbose --dry-run --no-tags');
const PULL_FLAGS = flagTable('-q --quiet -v --verbose --ff-only --ff --no-ff --no-edit --no-rebase');
// -u は共有の設定（branch.<名前>.merge）を書く。--all は beat のブランチも送る
const PUSH_TABLE = flagTable(PUSH_FLAGS, ['-u', '--set-upstream', '--all', '--force-with-lease'], '--force-with-lease:opt');
const STASH_READ = flagTable('-p --patch --stat --name-only --name-status --oneline');
const REFLOG_FLAGS = flagTable('-n:n --date:s --oneline');
const CONFIG_READ = /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only|--null|-z|--local|--worktree|--type=\S+|--bool|--int|--path)$/u;
const BRANCH_LIST = /^(?:-a|--all|-r|--remotes|-v|-vv|--verbose|--list|-l|--show-current|--merged(?:=\S+)?|--no-merged(?:=\S+)?|--contains(?:=\S+)?|--no-contains(?:=\S+)?|--sort=\S+|--format=\S+|--color=never|--no-color|--column=never|--points-at=\S+|-n\d*)$/u;
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
// 変数名 GIT_… をどこかで書く・渡す形（export・set・$env:・[Environment]・env など、どれでも）
const GIT_VARIABLE = /(?<![A-Za-z0-9_])GIT_[A-Za-z0-9_]+/iu;
// ほかの文を読み込む・評価する（中で git も環境も変えうる）。作業コピーの実行ではいつも断る
const EVALUATES = new Set(['.', 'source', 'eval', 'iex', 'invoke-expression', 'invoke-command', 'icm']);
// 環境を変えるもの。名前が変数・env: の場所を書く形は、何を変えるか読めない
const ENV_SETTERS = new Set(['export', 'set', 'declare', 'typeset', 'readonly', 'local', 'setx', 'env', 'set-item', 'si', 'new-item', 'ni', 'set-variable', 'sv', 'set-content', 'sc', 'add-content', 'ac', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni']);
const DOTNET_ENV = /SetEnvironmentVariable|\[\s*(?:System\.)?Environment\s*\]/iu;

export interface WorktreeGitPlace {
  worktree: string;
  productRoot: string;
  cwd: string;
  // コマンド全体の文（GIT_… の変数の設定を探す）
  command?: string;
  // PowerShell（スクリプトのファイルを同じプロセスで動かし、環境の変更が後の git に残る）
  powershell?: boolean;
  // 共有の設定に書いた宛先の名前（読めなければ undefined）
  remotes?: () => readonly string[] | undefined;
  // `git config --list` の出力（rebase / merge / pull の自動の設定を探す。読めなければ undefined）
  sharedConfig?: () => string | undefined;
}

interface Parsed { ok: boolean; pos: string[]; afterDd: string[]; seen: Set<string> }

// オプションを表で読む。表に無いオプション・値の要らないオプションに値を付けた形は ok: false
function parseArgs(texts: readonly string[], flags: Flags, numeric = false): Parsed {
  const out: Parsed = { ok: true, pos: [], afterDd: [], seen: new Set() };
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    if (t === '--') { out.afterDd.push(...texts.slice(i + 1)); break; }
    if (t === '-' || !t.startsWith('-')) { out.pos.push(t); continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const kind = flags.get(name);
      if (!kind || (kind === 'b' && eq !== -1)) return { ...out, ok: false };
      if (kind === 's' && eq === -1) { if (i + 1 >= texts.length) return { ...out, ok: false }; i++; }
      out.seen.add(name);
      continue;
    }
    if (numeric && /^-\d+$/u.test(t)) continue;
    const exact = flags.get(t);
    if (exact) {
      if (exact === 's') { if (i + 1 >= texts.length) return { ...out, ok: false }; i++; }
      out.seen.add(t);
      continue;
    }
    // まとめた短いオプション（-am "msg"・-n5）
    for (let j = 1; j < t.length; j++) {
      const name = `-${t[j]}`;
      const kind = flags.get(name);
      if (!kind) return { ...out, ok: false };
      out.seen.add(name);
      if (kind === 'b') continue;
      if (j === t.length - 1 && kind === 's') { if (i + 1 >= texts.length) return { ...out, ok: false }; i++; }
      break;
    }
  }
  return out;
}

const truthy = (value: string): boolean => /^(?:true|yes|on|1|merges|interactive|i)$/iu.test(value.trim());

// 書いたパスと実体のパスのどちらでも、作業コピーの中か
const insideCopy = (worktree: string, path: string): boolean => isInside(worktree, path) && isInside(realish(worktree), realish(path));

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? st.unknownInner ?? [])]);

const shownOf = (st: StatementFacts): string => st.words.map(w => w.text).join(' ').slice(0, 200);

// PowerShell のプロバイダの頭（FileSystem::・Microsoft.PowerShell.Core\FileSystem::）を外す
export const stripProvider = (p: string): string => p.replace(/^.*?FileSystem::/iu, '');

// シェルと同じに ~・$HOME・$PWD などを広げて解く。広げられなければ undefined
const expandedPath = (text: string, base: string): string | undefined => {
  const e = expandPath(stripProvider(text), base);
  return 'path' in e ? e.path : undefined;
};

// git を別の名前で呼ぶもの（git-lfs・git-receive-pack・libexec の git-*・scalar）。名前は小文字・.exe なし
const GIT_LIKE = /^(?:git-.+|scalar)$/u;
export const isGitProgram = (program: string): boolean => program === 'git' || GIT_LIKE.test(program);
// 中の命令を shell-facts が読めない起動役（code-guard の LAUNCHERS も）
const LAUNCHERS = new Set(['conhost', 'wt', 'wmic', 'invoke-cimmethod', 'icim', 'invoke-wmimethod', 'iwmi', 'script', 'flock', 'forfiles',
  'rundll32', 'regsvr32', 'installutil', 'regasm', 'regsvcs', 'cmstp', 'msiexec', 'bitsadmin', 'schtasks', 'runas']);
// 中の命令を別の作業フォルダで動かすオプション（値が作業コピーの中と決まらなければ断る）。find の -execdir は見つけたファイルごとのフォルダ
// PowerShell は引数の名前の一意な頭を受け付ける（-wo・-WO で -WorkingDirectory）
const PARAM_PREFIX = (name: string, full: string): boolean => name.length >= 2 && full.startsWith(name);
function launchDirs(st: StatementFacts): { words: Array<{ text: string; dynamic: boolean } | undefined>; always?: boolean } {
  const p = st.program.toLowerCase();
  const ws = st.words;
  // オプションの値（次の語・--opt=値・-opt:値・-C値）。変数の語でも頭がオプションなら値を変数として返す
  const valueOf = (match: (t: string) => boolean): Array<{ text: string; dynamic: boolean } | undefined> => {
    const out: Array<{ text: string; dynamic: boolean } | undefined> = [];
    ws.forEach((w, i) => {
      if (i === 0) return;
      const eq = /^(-{1,2}[A-Za-z-]+)[=:](.*)$/u.exec(w.text);
      const short = /^(-[A-Za-z])(.+)$/u.exec(w.text);
      if (eq && match(eq[1]!)) out.push(eq[2] === '' ? ws[i + 1] : { text: eq[2]!, dynamic: w.dynamic });
      else if (match(w.text)) out.push(ws[i + 1]);
      else if (short && match(short[1]!)) out.push({ text: short[2]!, dynamic: w.dynamic });
    });
    return out;
  };
  if (p === 'find') return { words: [], always: ws.some(w => /^-(?:execdir|okdir)$/u.test(w.text)) };
  if (p === 'env') return { words: valueOf(t => t === '-C' || t === '--chdir') };
  if (p === 'wsl') return { words: [], always: ws.some(w => w.text === '--cd' || w.text.startsWith('--cd=')) };
  if (p === 'start-process' || p === 'saps' || p === 'start') return { words: valueOf(t => /^-[A-Za-z]+$/u.test(t) && PARAM_PREFIX(t.slice(1).toLowerCase(), 'workingdirectory')) };
  if (p === 'powershell' || p === 'pwsh') return { words: valueOf(t => /^[-/][A-Za-z]+$/u.test(t) && (t.slice(1).toLowerCase() === 'wd' || PARAM_PREFIX(t.slice(1).toLowerCase(), 'workingdirectory'))) };
  if (p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'npx' || p === 'make') return { words: valueOf(t => ['--prefix', '-C', '--dir', '--cwd', '--directory'].includes(t)) };
  return { words: [] };
}

// 断る文（作業コピーのタスク）と、その理由の鍵。通すなら undefined
export function worktreeGitRefusal(statements: readonly StatementFacts[], place: WorktreeGitPlace): WorktreeRefusal | undefined {
  const all = flatten(statements);
  // 動かすプログラムが変数・式から決まる文、ほかの文を読み込む・評価する文、中の命令を読めない起動役（コードが変数の -c・-Command・--eval も）、
  // 中の命令を作業コピーの外かもしれないフォルダで動かす文は、git かもしれないので断る（中を読めない）
  const opaque = all.find(st => st.programDynamic || st.programOdd || EVALUATES.has(st.program.toLowerCase())
    || LAUNCHERS.has(st.program.toLowerCase()) || st.reasonKeys.includes('code.launcher')
    || (st.inner === null && st.unknownInner === undefined) || st.codeDynamic
    || (() => { const d = launchDirs(st); return d.always === true || d.words.some(w => !w || w.dynamic || !insideDir(place, w.text, st)); })());
  if (opaque) return { key: WT_OPAQUE, cmd: shownOf(opaque) || opaque.program };
  // 作業コピーの外（cd で本体へ移ったあと）か、決められないフォルダで動く文は断る（git の文は gitRefusal が数える）
  const away = all.filter(st => st.program !== '' && !isGitProgram(st.program) && (st.cwd === null || [...(st.cwds ?? []), st.cwd].some(dir => !insideCopy(place.worktree, dir))));
  if (away.length) {
    const dirsOf = (st: StatementFacts): string[] => [...(st.cwds ?? []), ...(st.cwd === null ? [] : [st.cwd])];
    const inMain = away.find(st => dirsOf(st).some(dir => mainWrites([dir], place).length > 0));
    if (inMain) return { key: WT_MAIN_PATH, cmd: shownOf(inMain), path: dirsOf(inMain).find(dir => mainWrites([dir], place).length > 0)! };
    return { key: WT_OPAQUE, cmd: shownOf(away[0]!) };
  }
  const gits = all.filter(st => isGitProgram(st.program));
  if (gits.length === 0) return undefined;
  const command = place.command ?? '';
  const envSetter = all.find(st => (ENV_SETTERS.has(st.program.toLowerCase()) && st.words.slice(1).some(w => w.dynamic || /(?:^|[^A-Za-z0-9_])env:/iu.test(w.text)))
    // PowerShell のスクリプトのファイル（. を付けなくても同じプロセスで動く）
    || (place.powershell === true && st.program !== 'git' && /[/\\]|\.ps(?:m?1|d1)$/iu.test(st.words[0]?.text ?? '')));
  // env: のドライブを名前で書く形（Set-Item "env:$n"・New-Item -Path env:）は、$env:NAME の形と違って何を変えるか読めない
  if (envSetter || DOTNET_ENV.test(command) || (place.powershell === true && /(?<![$\w])env:/iu.test(command))) return { key: WT_OPAQUE, cmd: envSetter ? shownOf(envSetter) : command.slice(0, 200) };
  // GIT_… の名前は、git の引数の文字（-m "… GIT_DIR …"）でも断る。数えて通す形は、読めない書き方（エスケープ・.NET の呼び出し）を開けてしまう
  const assigns = all.find(st => st.env.some(name => /^(?:env:)?git_/iu.test(name)) || st.words.some(w => GIT_VARIABLE.test(w.text)));
  if (assigns || GIT_VARIABLE.test(command)) return { key: WT_GIT_ENV, cmd: assigns ? shownOf(assigns) || assigns.env.join(' ') : command.slice(0, 200) };
  for (const st of gits) {
    const refused = gitRefusal(st, place);
    if (refused !== undefined) return { key: WT_GIT_SHARED, cmd: refused };
  }
  return undefined;
}

// 文のフォルダから広げて解いたパスが作業コピーの中か
const insideDir = (place: Pick<WorktreeGitPlace, 'worktree' | 'cwd'>, text: string, st: StatementFacts): boolean => {
  const path = expandedPath(text, st.cwd ?? place.cwd);
  return st.cwd !== null && path !== undefined && insideCopy(place.worktree, path);
};

function gitRefusal(st: StatementFacts, place: WorktreeGitPlace): string | undefined {
  const shown = shownOf(st);
  // git-lfs・scalar などは、何を書くか数え上げていない
  if (st.program !== 'git') return shown;
  if (st.cwd === null) return shown;
  const cwds = [...new Set([...(st.cwds ?? []), st.cwd])];
  if (cwds.some(dir => !insideCopy(place.worktree, dir))) return shown;
  const at = st.gitGlobal.length + 1;
  const globals = st.words.slice(1, at);
  for (let i = 0; i < globals.length; i++) {
    const w = globals[i]!;
    if (w.dynamic) return shown;
    if (w.text === '--no-pager' || w.text === '-P' || w.text === '--no-optional-locks') continue;
    if (w.text === '-c' && !globals[i + 1]?.dynamic && /^user\.(?:name|email)=[^\r\n]*$/iu.test(globals[i + 1]?.text ?? '')) { i++; continue; }
    if (w.text === '-C') {
      const dir = globals[i + 1];
      if (!dir || dir.dynamic) return shown;
      if (!insideDir(place, dir.text, st)) return shown;
      i++;
      continue;
    }
    return shown;
  }
  const subWord = st.words[at];
  if (!subWord || subWord.dynamic) return shown;
  const args = st.words.slice(at + 1);
  // 変数の引数は、何になるか（オプションか、ブランチか）決められない
  if (args.some(w => w.dynamic)) return shown;
  const sub = subWord.text.toLowerCase();
  const texts = args.map(w => w.text);
  const read = READ_FLAGS.get(sub);
  if (read) return parseArgs(texts, read.flags, read.numeric).ok ? undefined : shown;
  const onBranch = ON_BRANCH.get(sub);
  if (onBranch) {
    const p = parseArgs(texts, onBranch, true);
    if (!p.ok) return shown;
    // git rebase <upstream> <branch> は先に <branch> へ移る（-- のあとも数える）
    if (sub === 'rebase' && p.pos.length + p.afterDd.length >= 2) return shown;
    if ((sub === 'rebase' || sub === 'merge') && autoShared(place)) return shown;
    return undefined;
  }
  return refusedOther(sub, texts, place) ? shown : undefined;
}

function autoShared(place: WorktreeGitPlace): boolean {
  const config = place.sharedConfig?.();
  if (config === undefined) return true;
  return config.split(/\r?\n/u).some(line => { const m = AUTO_SHARED.exec(line.trim().toLowerCase()); return m !== null && truthy(m[1]!); });
}

function remoteOk(place: WorktreeGitPlace, remote: string | undefined): boolean {
  if (remote === undefined) return true;
  if (!REMOTE_NAME.test(remote)) return false;
  const names = place.remotes?.();
  return names !== undefined && names.includes(remote);
}

function refusedOther(sub: string, texts: readonly string[], place: WorktreeGitPlace): boolean {
  const flags = texts.filter(t => t.startsWith('-'));
  const positional = texts.filter(t => t !== '--' && !t.startsWith('-'));
  switch (sub) {
    case 'checkout': {
      // ファイルを戻す形（-- のあとにパスが 1 つ以上）だけ。ブランチを移る・作る形は断る
      const p = parseArgs(texts, CHECKOUT_FLAGS);
      return !p.ok || p.afterDd.length === 0 || p.pos.length > 1;
    }
    case 'branch':
      return !(flags.every(f => BRANCH_LIST.test(f)) && (positional.length === 0 || flags.some(f => f === '--list' || f === '-l')));
    case 'tag':
      if (positional.length === 0 && flags.length === 0) return false;
      return !(flags.some(f => f === '-l' || f === '--list') && flags.every(f => /^(?:-l|--list|-n\d*|--sort=\S+|--contains|--merged|--no-merged|--points-at|--format=\S+)$/u.test(f)));
    case 'stash': {
      const [what, ...rest] = texts;
      return !((what === 'list' || what === 'show') && parseArgs(rest, STASH_READ).ok);
    }
    case 'worktree':
      return !(texts[0] === 'list' && texts.slice(1).every(t => t === '--porcelain' || t === '-v' || t === '--verbose'));
    case 'config':
      return !(flags.every(f => CONFIG_READ.test(f)) && (flags.some(f => /^(?:--get|--get-all|--get-regexp|--list|-l)$/u.test(f)) || positional.length === 1));
    case 'reflog': {
      const rest = texts[0] === 'show' ? texts.slice(1) : texts;
      const p = parseArgs(rest, REFLOG_FLAGS, true);
      return !p.ok || p.pos.some(t => !/^[A-Za-z0-9_./~^@{}-]+$/u.test(t)) || (texts[0] !== 'show' && p.pos.length > 0 && !/^(?:HEAD|@)/u.test(p.pos[0]!));
    }
    case 'remote':
      return !(texts.length === 0 || (texts.length === 1 && (texts[0] === '-v' || texts[0] === '--verbose'))
        || (texts[0] === 'get-url' && texts.slice(1).every(t => t === '--push' || t === '--all' || REMOTE_NAME.test(t)))
        || (texts[0] === 'show' && texts.slice(1).every(t => t === '-n' || REMOTE_NAME.test(t))));
    case 'notes':
      return !((texts[0] === 'list' || texts[0] === 'show') && texts.slice(1).every(t => !t.startsWith('-')));
    case 'fetch': case 'pull': {
      const p = parseArgs(texts, sub === 'fetch' ? FETCH_FLAGS : PULL_FLAGS);
      const [remote, ...refs] = [...p.pos, ...p.afterDd];
      if (!p.ok || !remoteOk(place, remote)) return true;
      // 参照の書き先（: の入った refspec・+ で始まる強制）は断る
      if (refs.some(r => r.includes(':') || r.startsWith('+'))) return true;
      return sub === 'pull' && autoShared(place);
    }
    case 'push': {
      const p = parseArgs(texts, PUSH_TABLE);
      const [remote] = [...p.pos, ...p.afterDd];
      return !p.ok || !remoteOk(place, remote);
    }
    default:
      return true;
  }
}

// 本体（productRoot）の中へ書く・消すパス。書いたパスと実体のパスの両方で見る（作業コピーの中のジャンクション・8.3 の短い名前）
export function mainWrites(paths: readonly string[], place: Pick<WorktreeGitPlace, 'productRoot' | 'worktree'>): string[] {
  const realMain = realish(place.productRoot);
  return paths.map(stripProvider).filter(p => {
    const real = realish(p);
    const inMain = isInside(place.productRoot, p) || isInside(realMain, real);
    return inMain && !(isInside(place.worktree, p) && isInside(realish(place.worktree), real) && !isInside(realMain, real));
  });
}

// git（git-lfs なども）の文があるコマンドで、見張りが見つけたパスのうち作業コピーの外か、決められないもの
export function gitWithOutsidePath(statements: readonly StatementFacts[], paths: ReadonlyArray<{ input: string; path?: string | undefined }>, place: Pick<WorktreeGitPlace, 'worktree'>): string | undefined {
  if (!flatten(statements).some(st => isGitProgram(st.program))) return undefined;
  return paths.find(p => !p.path || !insideCopy(place.worktree, stripProvider(p.path)))?.input;
}

// リンク・ジャンクションを作る文のうち、先が作業コピーの中と決まらないもの（先が変数・本体・外）。作ったリンクを通して本体へ書けるので断る
export function linkOutOfCopy(statements: readonly StatementFacts[], place: Pick<WorktreeGitPlace, 'worktree' | 'cwd'>): string | undefined {
  for (const st of flatten(statements)) {
    const p = st.program.toLowerCase();
    const ws = st.words.slice(1);
    let targets: Array<{ text: string; dynamic: boolean } | undefined> = [];
    if (p === 'new-item' || p === 'ni') {
      if (!ws.some(w => w.dynamic || /symbolic|junction|hardlink/iu.test(w.text))) continue;
      ws.forEach((w, i) => { if (/^-(?:t|ta|tar|targ|targe|target|value|va|val|valu)$/iu.test(w.text)) targets.push(ws[i + 1]); else { const m = /^-(?:target|value):(.+)$/iu.exec(w.text); if (m) targets.push({ text: m[1]!, dynamic: w.dynamic }); } });
      if (targets.length === 0) targets = [undefined];
    } else if (p === 'mklink') {
      targets = [ws.filter(w => !/^\/[a-z]$/iu.test(w.text)).at(-1)];
    } else if (p === 'ln') {
      // ハードリンクも中身を分け合うので、-s の有無によらず見る
      targets = [ws.find(w => w.dynamic || !w.text.startsWith('-'))];
    } else continue;
    if (targets.some(w => !w || w.dynamic || !insideDir(place, w.text, st))) return shownOf(st);
  }
  return undefined;
}

// コマンドに書かれたパスらしい字句（相対・引用の中・key=value の右も）を文のフォルダから解き、本体の中を指すものがあれば返す。
// 見張りが中を読めない書き手（tar -C・unzip -d・node -e など）も、本体を名指せば断る。読むだけの形も含む
export function namesMain(command: string, statements: readonly StatementFacts[], place: Pick<WorktreeGitPlace, 'productRoot' | 'worktree' | 'cwd'>): string | undefined {
  const all = flatten(statements);
  const bases = [...new Set([place.cwd, ...all.flatMap(st => [...(st.cwds ?? []), ...(st.cwd === null ? [] : [st.cwd])])])];
  const texts = [command, ...all.flatMap(st => st.words.map(w => w.text))];
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split(/[\s"'`;|&()<>,={}[\]]+/u)) {
      if (!raw || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) || /^[^/\\:]+@[^/\\:]+:/u.test(raw)) continue;
      for (const t of [raw, raw.replace(/^-[A-Za-z]/u, '')]) {
        if (/[/\\]/u.test(t) || /^\.\.?$/u.test(t) || /^[A-Za-z]:/u.test(t) || /^~$|^\$(?:HOME|PWD|env:USERPROFILE)$/iu.test(t)) tokens.add(t);
      }
    }
  }
  for (const raw of tokens) {
    const t = stripProvider(raw);
    // Git Bash の /d/... は D:/... のこと
    const msys = process.platform === 'win32' ? /^\/([A-Za-z])(\/.*)?$/u.exec(t) : null;
    const absolute = isAbsolute(t) || /^[A-Za-z]:/u.test(t);
    // ~・$HOME・$PWD はシェルと同じに広げる（広げられない字句は書いたまま解く）
    const candidates = [...(absolute ? [resolve(t)] : bases.flatMap(base => [resolve(base, t), ...(/[~$%]/u.test(t) ? [expandedPath(t, base)].filter((p): p is string => p !== undefined) : [])])),
      ...(msys ? [resolve(`${msys[1]}:${msys[2] ?? '/'}`)] : [])];
    for (const p of candidates) {
      if (mainWrites([p], place).length) return p;
    }
  }
  return undefined;
}

// beat の作業ブランチ（refs/heads/beat/*）をまとめて送る・消しうる push（--all・--branches・--mirror・--prune とその短い書き方・ワイルドカードの refspec・設定の matching / mirror）。名指しの push は今の決まりのまま
const BROAD = ['all', 'branches', 'mirror', 'prune'];
export function broadPush(statements: readonly StatementFacts[], config: { matching: boolean; mirror: boolean }): string | undefined {
  for (const st of flatten(statements)) {
    if (st.program !== 'git') continue;
    const at = st.gitGlobal.length + 1;
    if (st.words[at]?.text.toLowerCase() !== 'push') continue;
    const shown = st.words.map(w => w.text).join(' ').slice(0, 200);
    const args = st.words.slice(at + 1);
    if (args.some(w => w.dynamic)) return shown;
    const texts = args.map(w => w.text);
    // git は長いオプションの一意な頭だけでも受け付ける（--mirr・--al）
    if (texts.some(t => { const m = /^--([a-z-]+)(?:=|$)/u.exec(t); return m !== null && BROAD.some(b => b.startsWith(m[1]!)); })) return shown;
    const refs = texts.filter(t => t !== '--' && !t.startsWith('-')).slice(1);
    if (refs.some(r => r.includes('*'))) return shown;
    if (refs.length === 0 && (config.matching || config.mirror)) return shown;
    if (config.mirror) return shown;
  }
  return undefined;
}
