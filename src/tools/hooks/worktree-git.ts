// beat 8-2 D-12: 作業コピー（linked worktree）のタスクで通す git。作業コピーは本体とブランチ・stash・設定・worktree の登録を分け合うので、
// それを変えない形だけを数え上げて通し、ほかは断る（判定役にも Pending にも回さない）。純粋な関数
import { isAbsolute, resolve } from 'node:path';
import type { StatementFacts } from './shell-facts.ts';
import { isInside } from './scope.ts';

export const WT_GIT_SHARED = 'wt.git_shared';
export const WT_WRITE_MAIN = 'wt.write_main';
export const WT_PUSH_BEAT = 'wt.push_beat';

const READ = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'merge-base', 'name-rev',
  'show-ref', 'for-each-ref', 'count-objects', 'cherry', 'cat-file', 'grep', 'version', 'help', 'whatchanged', 'show-branch', 'check-ignore', 'check-attr', 'var',
]);
// 今のブランチの上で動く書く形（別のブランチへ移る形は下で断る）
const ON_BRANCH = new Set(['add', 'commit', 'rm', 'mv', 'restore', 'apply', 'am', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert']);
const GLOBAL_OK = new Set(['--no-pager', '-P', '--no-optional-locks']);
const CONFIG_READ = /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only|--null|-z|--local|--worktree|--type=\S+|--bool|--int|--path)$/u;
const BRANCH_LIST = /^(?:-a|--all|-r|--remotes|-v|-vv|--verbose|--list|-l|--show-current|--merged(?:=\S+)?|--no-merged(?:=\S+)?|--contains(?:=\S+)?|--no-contains(?:=\S+)?|--sort=\S+|--format=\S+|--color=never|--no-color|--column=never|--points-at=\S+|-n\d*)$/u;

export interface WorktreeGitPlace { worktree: string; productRoot: string; cwd: string }

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? st.unknownInner ?? [])]);

// 断る git の文（作業コピーのタスク）。通すなら undefined
export function worktreeGitRefusal(statements: readonly StatementFacts[], place: WorktreeGitPlace): string | undefined {
  for (const st of flatten(statements)) {
    if (st.program !== 'git') continue;
    const shown = st.words.map(w => w.text).join(' ').slice(0, 200);
    if (st.env.some(name => /^git_/iu.test(name))) return shown;
    const cwds = [...new Set([...(st.cwds ?? []), ...(st.cwd ? [st.cwd] : [])])];
    if (cwds.length === 0 || cwds.some(dir => !isInside(place.worktree, dir))) return shown;
    const at = st.gitGlobal.length + 1;
    const globals = st.words.slice(1, at);
    for (let i = 0; i < globals.length; i++) {
      const w = globals[i]!;
      if (w.dynamic) return shown;
      if (GLOBAL_OK.has(w.text)) continue;
      if (w.text === '-c' && /^user\.(?:name|email)=/iu.test(globals[i + 1]?.text ?? '')) { i++; continue; }
      if (w.text === '-C') {
        const dir = globals[i + 1];
        if (!dir || dir.dynamic) return shown;
        const base = cwds[0] ?? place.cwd;
        if (!isInside(place.worktree, isAbsolute(dir.text) ? resolve(dir.text) : resolve(base, dir.text))) return shown;
        i++;
        continue;
      }
      return shown;
    }
    const subWord = st.words[at];
    if (!subWord || subWord.dynamic) return shown;
    const sub = subWord.text.toLowerCase();
    const args = st.words.slice(at + 1);
    if (args.some(w => w.dynamic)) {
      if (!READ.has(sub) && !ON_BRANCH.has(sub)) return shown;
    }
    const texts = args.map(w => w.text);
    const flags = texts.filter(t => t.startsWith('-'));
    const positional = (() => {
      const dd = texts.indexOf('--');
      return (dd === -1 ? texts : texts.slice(0, dd)).filter(t => !t.startsWith('-'));
    })();
    if (READ.has(sub)) continue;
    if (ON_BRANCH.has(sub)) {
      // git rebase <upstream> <branch> は先に <branch> へ移る
      if (sub === 'rebase' && positional.length >= 2) return shown;
      continue;
    }
    switch (sub) {
      case 'checkout':
        // ファイルを戻す形（-- のあとにパス）だけ。ブランチを移る・作る形は断る
        if (texts.includes('--') && !flags.some(f => /^(?:-b|-B|--orphan|--detach)$/u.test(f))) continue;
        return shown;
      case 'branch':
        if (flags.every(f => BRANCH_LIST.test(f)) && (positional.length === 0 || flags.some(f => f === '--list' || f === '-l'))) continue;
        return shown;
      case 'tag':
        if (positional.length === 0 && flags.length === 0) continue;
        if (flags.some(f => f === '-l' || f === '--list') && flags.every(f => /^(?:-l|--list|-n\d*|--sort=\S+|--contains|--merged|--no-merged|--points-at|--format=\S+)$/u.test(f))) continue;
        return shown;
      case 'stash':
        if (positional[0] === 'list' || positional[0] === 'show') continue;
        return shown;
      case 'worktree':
        if (positional[0] === 'list') continue;
        return shown;
      case 'config':
        if (flags.every(f => CONFIG_READ.test(f)) && (flags.some(f => /^(?:--get|--get-all|--get-regexp|--list|-l)$/u.test(f)) || positional.length === 1)) continue;
        return shown;
      case 'reflog':
        if (positional.length === 0 || positional[0] === 'show') continue;
        return shown;
      case 'remote':
        if (positional.length === 0 || positional[0] === 'get-url' || positional[0] === 'show') continue;
        return shown;
      case 'notes':
        if (positional[0] === 'list' || positional[0] === 'show') continue;
        return shown;
      case 'fetch': case 'pull':
        if (positional[0] === '.' || positional.slice(1).some(t => t.includes(':'))) return shown;
        continue;
      case 'push':
        if (positional[0] === '.') return shown;
        continue;
      default:
        return shown;
    }
  }
  return undefined;
}

// 本体（productRoot）の中へ書く・消すパス
export function mainWrites(paths: readonly string[], place: Pick<WorktreeGitPlace, 'productRoot' | 'worktree'>): string[] {
  return paths.filter(p => isInside(place.productRoot, p) && !isInside(place.worktree, p));
}

// beat の作業ブランチ（refs/heads/beat/*）をまとめて送る・消しうる push（--all・--branches・--mirror・--prune・ワイルドカードの refspec・設定の matching / mirror）。名指しの push は今の決まりのまま
export function broadPush(statements: readonly StatementFacts[], config: { matching: boolean; mirror: boolean }): string | undefined {
  for (const st of flatten(statements)) {
    if (st.program !== 'git') continue;
    const at = st.gitGlobal.length + 1;
    if (st.words[at]?.text.toLowerCase() !== 'push') continue;
    const shown = st.words.map(w => w.text).join(' ').slice(0, 200);
    const args = st.words.slice(at + 1);
    if (args.some(w => w.dynamic)) return shown;
    const texts = args.map(w => w.text);
    if (texts.some(t => /^--(?:all|branches|mirror|prune)$/u.test(t))) return shown;
    const refs = texts.filter(t => !t.startsWith('-')).slice(1);
    if (refs.some(r => r.includes('*'))) return shown;
    if (refs.length === 0 && (config.matching || config.mirror)) return shown;
    if (config.mirror) return shown;
  }
  return undefined;
}
