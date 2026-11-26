// 外の実行役の返事の前後で比べる、.git の中の状態の指紋（beat auth-runtime AR-9）。
// 実行役は .git の中も書ける。フックと設定は後でコマンドを動かし、info/exclude・skip-worktree・サブモジュールは変わったファイルを beat の目から隠せる。
// projects/worktree.ts の mainGitPrint（タスクの作業コピー用）と違い、ここは実行役が書いたものを疑って読む: リンク・ジャンクションは先を読まず、ファイルは大きさに上限を置き、
// フォルダは見る数に上限を置き、ネットワークの先（UNC）は見ない。1 つずつ lstat でたどり、途中にリンクがあれば止まる。
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { findGitDir } from '../tools/hooks/git-repo.ts';
import { isRemotePath } from '../tools/hooks/remote-path.ts';
import { ownName, readUpTo } from './diff.ts';

// git: git で読めたか。links: リンク・ジャンクションだった所（先は読んでいない）
export interface GitPrint {
  git: boolean;
  head: string;
  branch: string;
  refs: string;
  stash: string;
  index: string;
  config: string;
  hooks: string;
  worktrees: string;
  exclude: string;
  modules: string;
  links: string[];
}

const FILE_CAP = 1024 * 1024;
const SMALL_CAP = 4096;
const ENTRY_CAP = 400;
const MODULE_CAP = 50;
const MODULE_DIRS_CAP = 200;
const MODULE_DEPTH_CAP = 6;
const CHILD_CAP = 200;
const WORKTREE_CAP = 100;
const DEPTH_CAP = 3;
// 変わったら守りに当たる印にする所: 後でコマンドを動かせる（config・hooks・modules）、変わったファイルを隠せる（exclude・index・link）
export const GIT_ALERT_PARTS: ReadonlySet<string> = new Set(['config', 'hooks', 'modules', 'exclude', 'index', 'link']);

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : null;
  }
};
const linkText = (path: string): string => { try { return sha(readlinkSync(path)); } catch { return 'unreadable'; } };

type Seen =
  | { kind: 'absent' }
  | { kind: 'link'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; size: number; mtimeMs: number; ctimeMs: number; ino: number }
  | { kind: 'other'; path: string };

// base の下の parts を 1 つずつ lstat でたどる（リンク・別名があればそこで止まり、先へは進まない）。base 自身は信じる
function walk(base: string, parts: readonly string[]): Seen {
  let path = base;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const st = lstatOf(path);
    if (st === undefined) return { kind: 'absent' };
    if (st === null) return { kind: 'other', path };
    if (st.isSymbolicLink() || !ownName(path, part)) return { kind: 'link', path };
    if (i === parts.length - 1) return st.isDirectory() ? { kind: 'dir', path } : st.isFile() ? { kind: 'file', path, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino } : { kind: 'other', path };
    if (!st.isDirectory()) return { kind: 'absent' };
  }
  return { kind: 'dir', path: base };
}

function digestOf(seen: Seen, label: string, links: string[]): string {
  if (seen.kind === 'absent') return 'none';
  if (seen.kind === 'link') { links.push(label); return `link:${linkText(seen.path)}`; }
  if (seen.kind !== 'file') return seen.kind;
  if (seen.size > FILE_CAP) return `big:${seen.size}:${seen.mtimeMs}:${seen.ctimeMs}:${seen.ino}`;
  const bytes = readUpTo(seen.path, seen.size);
  return Buffer.isBuffer(bytes) ? `file:${sha(bytes)}` : 'unreadable';
}

function smallText(seen: Seen): string {
  if (seen.kind !== 'file' || seen.size > SMALL_CAP) return '';
  const bytes = readUpTo(seen.path, seen.size);
  return Buffer.isBuffer(bytes) ? bytes.toString('utf8').trim() : '';
}

interface Budget { left: number }

// git が動かすフックの名前。数の上限を超える埋め草のファイルで後ろに押し出されても、この名前は必ず見る
const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push',
  'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change',
];

// フォルダの中身: ふつうのファイルは大きさ上限つきで中身ごと、下のフォルダは深さと数に上限を置いてたどる、リンクは先を読まない、ほかの種類は種類だけ
function treeDigest(dir: string, label: string, links: string[], budget: Budget, depth: number, skipSample: boolean): string {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return 'unreadable'; }
  const out: string[] = [];
  for (const name of names) {
    if (skipSample && name.endsWith('.sample')) continue;
    if (budget.left <= 0) { out.push('many'); break; }
    budget.left -= 1;
    const path = join(dir, name);
    const st = lstatOf(path);
    if (!st) out.push(`${name} gone`);
    else if (st.isSymbolicLink()) { links.push(`${label}/${name}`); out.push(`${name} link ${linkText(path)}`); }
    else if (st.isFile()) out.push(`${name} ${digestOf({ kind: 'file', path, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino }, label, links)}`);
    else if (st.isDirectory()) out.push(`${name} dir ${depth < DEPTH_CAP ? sha(treeDigest(path, `${label}/${name}`, links, budget, depth + 1, false)) : 'deep'}`);
    else out.push(`${name} special`);
  }
  return out.join('\n');
}

// fixed: 決まった名前のフックを数の上限と別に必ず見る（この製品の .git/hooks だけ。サブモジュールごとに 24 個 × 1MiB を同期で読ませないため、サブモジュールのフックは上限の中だけ）
function hooksDigest(base: string, parts: readonly string[], links: string[], budget: Budget, fixed: boolean): string {
  const seen = walk(base, parts);
  if (seen.kind !== 'dir') return digestOf(seen, parts.join('/'), links);
  const named = fixed ? HOOK_NAMES.map(name => `${name} ${digestOf(walk(seen.path, [name]), `${parts.join('/')}/${name}`, links)}`).join('\n') : '';
  return sha(`${named}\n${treeDigest(seen.path, parts.join('/'), links, budget, 0, true)}`);
}

const sortedNames = (dir: string): string[] | undefined => { try { return readdirSync(dir).sort(); } catch { return undefined; } };

function worktreesDigest(common: string, links: string[]): string {
  const seen = walk(common, ['worktrees']);
  if (seen.kind !== 'dir') return digestOf(seen, 'worktrees', links);
  const names = sortedNames(seen.path);
  if (!names) return 'unreadable';
  const parts = names.slice(0, WORKTREE_CAP).map(name => `${name} ${digestOf(walk(common, ['worktrees', name, 'gitdir']), `worktrees/${name}/gitdir`, links)}`);
  return sha(`${parts.join('\n')}${names.length > WORKTREE_CAP ? '\nmany' : ''}`);
}

// .git/modules の下。サブモジュールのフォルダの名前は、ふつうそのパス（vendor/x）なので、何段にもなる。HEAD か config を持つフォルダをサブモジュールのフォルダとして、その config とフック（と、その中の modules）を見る。
// それ以外のフォルダは中へ進む。見るフォルダの数・サブモジュールの数・深さ・1 つのフォルダで見る名前の数に上限を置き、超えたら「many」を指紋に入れる
function modulesDigest(common: string, links: string[], budget: Budget): string {
  const top = walk(common, ['modules']);
  if (top.kind !== 'dir') return digestOf(top, 'modules', links);
  const out: string[] = [];
  const count = { dirs: 0, modules: 0, many: false };
  const visit = (rel: readonly string[]): void => {
    if (count.dirs >= MODULE_DIRS_CAP) { count.many = true; return; }
    count.dirs += 1;
    const names = sortedNames(join(common, 'modules', ...rel));
    if (!names) { out.push(`${rel.join('/')} unreadable`); return; }
    if (names.length > CHILD_CAP) count.many = true;
    for (const name of names.slice(0, CHILD_CAP)) {
      const here = [...rel, name];
      const label = here.join('/');
      const entry = walk(common, ['modules', ...here]);
      if (entry.kind !== 'dir') { out.push(`${label} ${digestOf(entry, `modules/${label}`, links)}`); continue; }
      if (!['config', 'HEAD'].some(file => walk(common, ['modules', ...here, file]).kind === 'file')) {
        if (here.length < MODULE_DEPTH_CAP) visit(here); else out.push(`${label} deep`);
        continue;
      }
      if (count.modules >= MODULE_CAP) { count.many = true; continue; }
      count.modules += 1;
      out.push([label, digestOf(walk(common, ['modules', ...here, 'config']), `modules/${label}/config`, links), hooksDigest(common, ['modules', ...here, 'hooks'], links, budget, false)].join(' '));
      if (here.length < MODULE_DEPTH_CAP && walk(common, ['modules', ...here, 'modules']).kind === 'dir') visit([...here, 'modules']);
    }
  };
  visit([]);
  return sha(`${out.join('\n')}${count.many ? '\nmany' : ''}`);
}

// skip-worktree・assume-unchanged の印の付いた索引の項目（git status が見ないので、付くと変わったファイルが隠れる）。印の付いたものだけを指紋にする
function flagDigest(buffer: Buffer): string {
  const flagged = buffer.toString('utf8').split('\0').filter(entry => /^[a-zS] /u.test(entry));
  return flagged.length ? `${flagged.length}:${sha(flagged.join('\0'))}` : '0';
}

interface GitDirs { gitdir: string; common: string }

// .git のフォルダ、または gitdir: の行のファイル。どちらも commondir を含めて、git と beat 自身の確かめ（findGitDir。withGit が通すもの）と同じ読み方をする（読み方が違うと、git が使う先と別の所を見てしまう）。
// 壊れている・ネットワークの先・リンクを通る形なら見ない
function gitDirs(root: string): GitDirs | undefined {
  const dot = lstatOf(join(root, '.git'));
  if (!dot || !(dot.isDirectory() || dot.isFile())) return undefined;
  const found = findGitDir(root);
  if (!found || found.broken) return undefined;
  if (dot.isDirectory() && resolve(found.gitDir) !== resolve(root, '.git')) return undefined;
  return { gitdir: found.gitDir, common: found.commonDir };
}

export async function readGitPrint(root: string, dataDir: string): Promise<GitPrint | undefined> {
  const dirs = gitDirs(root);
  if (!dirs) return undefined;
  const fromGit = await withGit(root, dataDir, async git => {
    const text = async (args: string[]): Promise<string> => (await git(args))?.toString('utf8').trim() ?? '';
    const refs = (await text(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n')
      .filter(line => line && !/^refs\/(?:heads\/beat\/|beat\/|remotes\/)/u.test(line)).join('\n');
    const flagged = await git(['ls-files', '-v', '-z']);
    return {
      head: await text(['rev-parse', '-q', '--verify', 'HEAD']), branch: await text(['symbolic-ref', '-q', 'HEAD']), refs,
      stash: await text(['reflog', 'show', '--format=%H', 'refs/stash', '--']), index: flagged ? flagDigest(flagged) : 'unreadable',
    };
  });
  const { gitdir, common } = dirs;
  const links: string[] = [];
  const budget: Budget = { left: ENTRY_CAP };
  const config = sha([
    digestOf(walk(common, ['config']), 'config', links),
    digestOf(walk(gitdir, ['config.worktree']), 'config.worktree', links),
    gitdir === common ? '' : digestOf(walk(common, ['config.worktree']), 'config.worktree', links),
    digestOf(walk(gitdir, ['commondir']), 'commondir', links),
  ].join('|'));
  const hooks = hooksDigest(common, ['hooks'], links, budget, true);
  const exclude = digestOf(walk(common, ['info', 'exclude']), 'info/exclude', links);
  const worktrees = worktreesDigest(common, links);
  const modules = modulesDigest(common, links, budget);
  return {
    git: fromGit !== undefined, head: fromGit?.head ?? '', branch: fromGit?.branch ?? '', refs: fromGit?.refs ?? '', stash: fromGit?.stash ?? '', index: fromGit?.index ?? '',
    config, hooks, worktrees, exclude, modules, links: [...new Set(links)].sort(),
  };
}

// 変わった所。前は git で読めて後で読めなくなったら git（設定を変えて見えなくした場合も伝える）。リンクは、後に新しく現れたものだけ
export const gitChanges = (before: GitPrint, after: GitPrint): string[] => [
  ...(before.git && after.git ? (['branch', 'head', 'refs', 'stash', 'index'] as const).filter(key => before[key] !== after[key]) : before.git && !after.git ? ['git'] : []),
  ...(['config', 'hooks', 'worktrees', 'exclude', 'modules'] as const).filter(key => before[key] !== after[key]),
  ...(after.links.some(link => !before.links.includes(link)) ? ['link'] : []),
];

// サブモジュールの今の HEAD（git status は --ignore-submodules=all で見ないので、ここで読む）。中のリポジトリには git を動かさない。リンクは通らず、ネットワークの先は見ない
export function submoduleHead(realRoot: string, path: string): string {
  const parts = path.split('/');
  const dot = walk(realRoot, [...parts, '.git']);
  if (dot.kind === 'absent') return 'none';
  if (dot.kind === 'dir') return smallText(walk(realRoot, [...parts, '.git', 'HEAD'])) || 'none';
  if (dot.kind !== 'file') return dot.kind;
  const line = /^gitdir:\s*(.+?)\s*$/mu.exec(smallText(dot));
  if (!line) return 'odd';
  const gitdir = resolve(dirname(dot.path), line[1]!);
  if (isRemotePath(line[1]!) || isRemotePath(gitdir)) return 'remote';
  return smallText(walk(gitdir, ['HEAD'])) || 'none';
}
