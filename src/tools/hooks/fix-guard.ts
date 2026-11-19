// beat 8-6a D-11 (1): 直す実行（その回だけの製品の写しで動く、人のいない実行）のシェルで、判定役にも Pending にも回さずに断る文。純粋な関数。
// 断るのは 4 つだけ: 裏のコマンド・切り離したプロセス / git push / 通信・取得（npx の仲間・名前引きも） / 写しの外に解けるパス（解けないものも）。残りは今の見張りの順（4 の形・判定役）に任せる
import { resolve } from 'node:path';
import { NPX_TOOLS } from './code-guard.ts';
import { LOOKUP } from './outbound.ts';
import type { StatementFacts } from './shell-facts.ts';
import { flatten, GIT_VARIABLE, insideCopy, LAUNCHERS, pathCandidates, stripProvider } from './worktree-git.ts';

export const FIX_BACKGROUND = 'fix.background';
export const FIX_PUSH = 'fix.push';
export const FIX_NETWORK = 'fix.network';
export const FIX_OUTSIDE = 'fix.outside';

export type FixKey = typeof FIX_BACKGROUND | typeof FIX_PUSH | typeof FIX_NETWORK | typeof FIX_OUTSIDE;

export interface FixShellFacts {
  // 写しのフォルダ（実体のパス）と、この呼び出しの作業フォルダ
  copy: string;
  cwd: string;
  command: string;
  background: boolean;
  statements: readonly StatementFacts[];
  // 見張りが見つけたパス（path が無いものは解けなかった）と、書く先
  paths: ReadonlyArray<{ input: string; path?: string | undefined }>;
  writes: readonly string[];
  reasonKeys: readonly string[];
  askKinds: readonly string[];
  // 見張りが「外の中身を持ち込む」と数えた（curl・git fetch / pull / clone・パッケージの導入など）
  fetched: boolean;
  // push の文の数（outbound.ts の pushesOf）と、外への送りに数えたか（outbound.ts の send）
  pushes: number;
  sends: boolean;
}

export interface FixRefusal { key: FixKey; detail: string }

// git の -C・--git-dir・--work-tree の値（次の語か = のあと）
const GIT_PLACE_FLAG = /^(?:-C|--git-dir|--work-tree)$/u;
const GIT_PLACE_EQ = /^--(?:git-dir|work-tree)=(.*)$/u;

// 裏に残る・切り離されたプロセスを起こす印（& / Start-Process / start / Start-Job / setsid / at / systemd-run / wsl など。code-guard.ts の SPAWNERS）
const DETACHING = new Set(['shape.background', 'code.spawn']);
// ジョブの外でプロセスを作らせる道（WMI の Win32_Process.Create・[wmiclass]）。起動役（wmic・Invoke-CimMethod・rundll32 など）は LAUNCHERS と code.launcher
const WMI_CREATE = /win32_process|\[wmiclass\]/iu;
// パッケージを取ってきて動かす・作る語（道具ごと）。npm は init <名前> も（npm init vite は create-vite を取ってくる）
// 入れる・上げる語（パッケージを取ってくる）も、オプションのあとに来ても見落とさないようここで見る
const FETCH_AND_RUN: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['exec', 'x', 'create', 'install', 'i', 'in', 'ci', 'add', 'update', 'up', 'upgrade', 'install-test', 'it', 'install-ci-test', 'cit']),
  pnpm: new Set(['dlx', 'create', 'install', 'i', 'add', 'update', 'up', 'upgrade', 'fetch']),
  yarn: new Set(['dlx', 'create', 'install', 'add', 'up', 'upgrade', 'upgrade-interactive']),
  bun: new Set(['x', 'create', 'install', 'i', 'add', 'a', 'update', 'upgrade']),
};
// 必ず値を取るオプション（その次の語は値で、サブコマンドではない）。値を取らないものを入れると次の語を見落とすので、確かなものだけ
const VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '--loglevel', '--registry', '--cache', '--userconfig', '--filter', '--dir', '--workspace-dir', '--cwd']);
// 1 文字のものは道具ごとに意味が違うので、大文字小文字を区別して道具ごとに（npm の -C は --prefix・-f は --force、pnpm の -C は --dir・-F は --filter、
// bun の -F は --filter。yarn の -C は --caret〔値を取らない〕なので入れない）
const SHORT_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['-C']), pnpm: new Set(['-C', '-F']), yarn: new Set(), bun: new Set(['-F']),
};
// ここで見つかれば、そのあとの語はサブコマンドではない（パッケージ・スクリプトの名前）
const OTHER_SUBCOMMANDS = new Set(['uninstall', 'remove', 'rm', 'un', 'r', 'run', 'run-script', 'test', 't', 'start', 'stop', 'restart',
  'ls', 'list', 'll', 'why', 'outdated', 'audit', 'pack', 'build', 'rebuild', 'version', 'view', 'info', 'config', 'link',
  'unlink', 'prune', 'dedupe', 'help', 'explain', 'fund', 'doctor', 'cache', 'exec', 'init', 'pm']);
// Python の、名前で取ってきて動かす・入れる道具
const PY_FETCH: Readonly<Record<string, (words: readonly string[]) => boolean>> = {
  uvx: () => true,
  uv: words => { const tool = words.indexOf('tool'); return tool >= 0 && words.slice(tool + 1).some(w => w === 'run' || w === 'install'); },
  pipx: words => words.some(w => w === 'run' || w === 'install'),
};

// オプションとその値を飛ばした語（-- の手前まで）
function plainWords(program: string, raw: readonly string[]): string[] {
  const out: string[] = [];
  const short = SHORT_VALUE_FLAGS[program];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]!.toLowerCase();
    if (w === '--') break;
    if (VALUE_FLAGS.has(w) || short?.has(raw[i]!)) { i++; continue; }
    if (!w.startsWith('-')) out.push(w);
  }
  return out;
}

// 名前だけで外へ出る文: npx の仲間、corepack（どの形でも道具を取ってくる）、パッケージを取ってきて動かす・作る文、名前を引く・届くかを見る文（宛先が字のままでも）。
// 値を取るオプションで位置がずれても見落とさないよう、ほかのサブコマンド（install・run など）が出るまでの -- より前の語をどれも見る
function reachesNetwork(st: StatementFacts): boolean {
  const program = st.program.toLowerCase();
  if (NPX_TOOLS.has(program) || LOOKUP.has(program) || program === 'corepack') return true;
  const words = plainWords(program, st.words.slice(1).map(w => w.text));
  const py = PY_FETCH[program];
  if (py) return py(words);
  const fetching = FETCH_AND_RUN[program];
  if (!fetching) return false;
  // 中身のない yarn（オプションだけも）は yarn install と同じ
  if (program === 'yarn' && words.length === 0) return true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (fetching.has(w)) return true;
    if (program === 'npm' && w === 'init') return i + 1 < words.length;
    if (OTHER_SUBCOMMANDS.has(w)) return false;
  }
  return false;
}

const startsOutsideJob = (st: StatementFacts): boolean => LAUNCHERS.has(st.program.toLowerCase()) || st.reasonKeys.includes('code.launcher');

export function fixShellRefusal(f: FixShellFacts): FixRefusal | undefined {
  const shown = f.command.trim().slice(0, 200);
  const all = flatten(f.statements);
  if (f.background || f.reasonKeys.some(key => DETACHING.has(key)) || all.some(st => st.reasonKeys.some(key => DETACHING.has(key)))) return { key: FIX_BACKGROUND, detail: shown };
  if (f.reasonKeys.includes('code.launcher') || all.some(startsOutsideJob) || WMI_CREATE.test(f.command)) return { key: FIX_BACKGROUND, detail: shown };
  if (f.pushes > 0) return { key: FIX_PUSH, detail: shown };
  if (f.fetched || f.sends || f.askKinds.includes('egress') || all.some(reachesNetwork)) return { key: FIX_NETWORK, detail: shown };
  // GIT_DIR・GIT_WORK_TREE などは git を写しの外のリポジトリへ向けられる。名前がどこにあっても断る
  if (GIT_VARIABLE.test(f.command) || all.some(st => st.env.some(name => /^(?:env:)?git_/iu.test(name)))) return { key: FIX_OUTSIDE, detail: shown };
  const outside = (path: string): boolean => !insideCopy(f.copy, stripProvider(path));
  for (const st of all) {
    // 作業フォルダが決められない文・写しの外で動く文（cd ..）・動かすものが変数の文
    if (st.programDynamic || st.cwd === null || [...(st.cwds ?? []), st.cwd].some(outside)) return { key: FIX_OUTSIDE, detail: shown };
    const globals = st.words.slice(1, st.gitGlobal.length + 1);
    for (let i = 0; i < globals.length; i++) {
      const w = globals[i]!;
      const eq = GIT_PLACE_EQ.exec(w.text);
      const value = eq ? { text: eq[1]!, dynamic: w.dynamic } : GIT_PLACE_FLAG.test(w.text) ? globals[i + 1] : undefined;
      if (!eq && !GIT_PLACE_FLAG.test(w.text)) continue;
      // 値が変数・~・$ を含む（広げ方を決めない）か、作業フォルダから解いて写しの外なら断る
      if (!value || value.dynamic || /[~$%]/u.test(value.text) || outside(resolve(st.cwd, stripProvider(value.text)))) return { key: FIX_OUTSIDE, detail: shown };
    }
  }
  const unresolved = f.paths.find(p => !p.path);
  if (unresolved) return { key: FIX_OUTSIDE, detail: unresolved.input };
  const away = [...f.paths.map(p => p.path!), ...f.writes].find(outside)
    ?? pathCandidates(f.command, f.statements, f.cwd).find(outside);
  return away === undefined ? undefined : { key: FIX_OUTSIDE, detail: away };
}
