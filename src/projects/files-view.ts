import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { isInside, isSecretPath, windowsHazard } from '../tools/hooks/scope.ts';

export type FileTree = 'product' | 'knowledge';
export type FileMark = 'M' | 'A';
export type FilesRefusal = 'bad_path' | 'refused' | 'missing' | 'not_dir' | 'not_file';

export interface FileEntry { name: string; path: string; kind: 'dir' | 'file'; mark?: FileMark; hidden?: true }
export interface FolderView { dir: string; entries: FileEntry[]; truncated: boolean }
export interface FileView { path: string; size: number; modifiedAt: number; mark: FileMark | null; hidden: boolean; binary: boolean; truncated: boolean; text: string | null }

// 見せる木の根。root は実体のパス（realpath）。deny の中は木に出さず、読ませない。git は製品が git のときだけ（.gitignore と M / A の印）
export interface TreeRoot { root: string; deny: readonly string[]; git: { dataDir: string } | null }

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_ENTRIES = 1000;
const MAX_PATH_CHARS = 4096;
const BINARY_PROBE = 8000;
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\\:*?"<>|]/u;
const SKIPPED = new Set(['.git', 'node_modules']);

const skipped = (name: string): boolean => SKIPPED.has(name.toLowerCase());

// 相対パスの文字だけを見る。'' は根。区切りは / だけ、. と .. と空の段・末尾の . と空白（Windows が黙って落とす名前）・ストリームやデバイスの名前は断る
export function relSegments(rel: string): string[] | 'bad_path' {
  if (rel === '') return [];
  if (rel.length > MAX_PATH_CHARS || UNSAFE_TEXT.test(rel) || rel.startsWith('/') || windowsHazard(rel)) return 'bad_path';
  const segs = rel.split('/');
  if (segs.some(seg => seg === '' || seg === '.' || seg === '..' || /[. ]$/u.test(seg))) return 'bad_path';
  return segs;
}

const lstatOf = (path: string): Stats | undefined => lstatSync(path, { throwIfNoEntry: false });

// 根から 1 段ずつ lstat でたどる。リンク・ジャンクションは段のどこにあっても断る。たどり終えたら実体のパスが、根と頼まれた名前を
// そのままつないだものと文字ごと同じかを見る（大文字小文字の違い・8.3 の短い名前など、同じ物を指す別の名前を断る）
function walk(view: TreeRoot, segs: readonly string[]): { abs: string; rel: string; stat: Stats } | FilesRefusal {
  if (segs.some(skipped)) return 'refused';
  const rel = segs.join('/');
  let abs = view.root;
  let stat: Stats | undefined;
  try {
    stat = lstatOf(abs);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return 'missing';
    for (const seg of segs) {
      if (!stat.isDirectory()) return 'missing';
      abs = join(abs, seg);
      stat = lstatOf(abs);
      if (!stat) return 'missing';
      if (stat.isSymbolicLink()) return 'refused';
    }
    if (realpathSync.native(abs) !== abs) return 'refused';
  } catch { return 'missing'; }
  if (view.deny.some(d => isInside(d, abs))) return 'refused';
  return { abs, rel, stat };
}

function gitOut(raw: Buffer | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw.toString('utf8').split('\0').filter(Boolean);
}

// 子の印。git status の -z の行は「XY パス」。?? と A は追加、ほかは変更。消えたファイルは木に出ないので印も無い
function marksOf(lines: readonly string[], prefix: string): Map<string, FileMark> {
  const out = new Map<string, FileMark>();
  for (const line of lines) {
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (!path.startsWith(prefix) || xy.includes('D')) continue;
    out.set(path.slice(prefix.length), xy === '??' || xy.includes('A') ? 'A' : 'M');
  }
  return out;
}

async function gitFacts(view: TreeRoot, rel: string, folder: boolean): Promise<{ ignored: string[]; status: string[] } | undefined> {
  if (!view.git) return undefined;
  const spec = rel ? ['--', rel] : [];
  return withGit(view.root, view.git.dataDir, async git => {
    const ignored = gitOut(await git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...(folder ? ['--directory'] : []), ...spec]));
    const status = gitOut(await git(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', ...spec]));
    return ignored && status ? { ignored: ignored.map(p => p.replace(/\/$/u, '')), status } : undefined;
  });
}

const byName = (a: FileEntry, b: FileEntry): number => (a.kind === b.kind ? (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.name < b.name ? -1 : 1) : a.kind === 'dir' ? -1 : 1);

export async function listFolder(view: TreeRoot, rel: string): Promise<FolderView | FilesRefusal> {
  const segs = relSegments(rel);
  if (segs === 'bad_path') return segs;
  const found = walk(view, segs);
  if (typeof found === 'string') return found;
  if (!found.stat.isDirectory()) return 'not_dir';
  if (segs.length && isSecretPath(found.rel)) return 'refused';
  const facts = await gitFacts(view, found.rel, true);
  if (facts?.ignored.some(p => p === found.rel || found.rel.startsWith(`${p}/`))) return 'refused';
  const prefix = found.rel ? `${found.rel}/` : '';
  const ignored = new Set(facts?.ignored.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)) ?? []);
  const marks = marksOf(facts?.status ?? [], prefix);
  let names: string[];
  try { names = readdirSync(found.abs); } catch { return 'missing'; }
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (skipped(name) || ignored.has(name)) continue;
    const abs = join(found.abs, name);
    const st = lstatOf(abs);
    if (!st || st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) continue;
    if (view.deny.some(d => isInside(d, abs))) continue;
    const path = prefix + name;
    const entry: FileEntry = { name, path, kind: st.isDirectory() ? 'dir' : 'file' };
    const mark = marks.get(name);
    if (mark && entry.kind === 'file') entry.mark = mark;
    if (isSecretPath(path)) entry.hidden = true;
    entries.push(entry);
  }
  entries.sort(byName);
  return { dir: found.rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

export async function readFileView(view: TreeRoot, rel: string): Promise<FileView | FilesRefusal> {
  const segs = relSegments(rel);
  if (segs === 'bad_path' || segs.length === 0) return 'bad_path';
  const found = walk(view, segs);
  if (typeof found === 'string') return found;
  if (!found.stat.isFile()) return 'not_file';
  const facts = await gitFacts(view, found.rel, false);
  if (facts?.ignored.length) return 'refused';
  const mark = marksOf(facts?.status ?? [], '').get(found.rel) ?? null;
  const base = { path: found.rel, size: found.stat.size, modifiedAt: Math.floor(found.stat.mtimeMs), mark };
  if (isSecretPath(found.rel)) return { ...base, hidden: true, binary: false, truncated: false, text: null };
  let fd: number;
  try { fd = openSync(found.abs, 'r'); } catch { return 'missing'; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== found.stat.ino || opened.dev !== found.stat.dev || opened.nlink !== 1) return 'refused';
    const want = Math.min(opened.size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (n === 0) break;
      got += n;
    }
    const bytes = buf.subarray(0, got);
    const truncated = opened.size > got;
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { ...base, size: opened.size, hidden: false, binary: true, truncated, text: null };
    let text = bytes.toString('utf8');
    if (truncated) text = text.replace(/�+$/u, '');
    return { ...base, size: opened.size, hidden: false, binary: false, truncated, text };
  } catch { return 'missing'; } finally { closeSync(fd); }
}
