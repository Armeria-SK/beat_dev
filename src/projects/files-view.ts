import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { isInside, isSecretPath, windowsHazard } from '../tools/hooks/scope.ts';

export type FileTree = 'product' | 'knowledge';
export type FileMark = 'M' | 'A';
export type FilesRefusal = 'bad_path' | 'refused' | 'missing' | 'not_dir' | 'not_file' | 'unchecked';

export interface FileEntry { name: string; path: string; kind: 'dir' | 'file'; mark?: FileMark; hidden?: true }
// ignoreChecked: false は git の製品で .gitignore を確かめられなかったとき（一覧は出すが、ファイルの中身は読ませない）
export interface FolderView { dir: string; entries: FileEntry[]; truncated: boolean; ignoreChecked: boolean }
export interface FileView { path: string; size: number; modifiedAt: number; mark: FileMark | null; hidden: boolean; binary: boolean; truncated: boolean; text: string | null }

// ファイルを触る口。試験では差し替えて、たどる途中でジャンクションに入れ替わる形を作る
export interface ViewFs {
  lstat: (path: string) => BigIntStats | undefined;
  realpath: (path: string) => string;
  names: (path: string, max: number) => { names: string[]; more: boolean };
  open: (path: string) => number;
  fstat: (fd: number) => BigIntStats;
  read: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
  close: (fd: number) => void;
}

const WINDOWS = process.platform === 'win32';

export const REAL_VIEW_FS: ViewFs = {
  lstat: path => lstatSync(path, { bigint: true, throwIfNoEntry: false }),
  realpath: path => realpathSync.native(path),
  names: (path, max) => {
    const dir = opendirSync(path);
    try {
      const names: string[] = [];
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (names.length >= max) return { names, more: true };
        names.push(entry.name);
      }
      return { names, more: false };
    } finally { dir.closeSync(); }
  },
  open: path => openSync(path, WINDOWS ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  fstat: fd => fstatSync(fd, { bigint: true }),
  read: (fd, buf, offset, length, position) => readSync(fd, buf, offset, length, position),
  close: fd => closeSync(fd),
};

// 見せる木の根。root は実体のパス（realpath）。deny の中は木に出さず、読ませない。git は製品が git のときだけ（.gitignore と M / A の印）
export interface TreeRoot { root: string; deny: readonly string[]; git: { dataDir: string } | null; fs?: ViewFs }

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_ENTRIES = 1000;
// 1 つのフォルダで読む名前の上限（ここで止めてから lstat する。大きなフォルダでサーバーを止めない）
export const MAX_NAMES = 5000;
const MAX_PATH_CHARS = 4096;
const BINARY_PROBE = 8000;
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\\:*?"<>|]/u;
const SKIPPED = new Set(['.git', 'node_modules']);
// 道具の isSecretPath に足して、この欄だけで中身を出さない名前
const VIEWER_SECRETS = [
  /(?:^|\/)(?:credentials|service[-_]?account)[^/]*\.json$/iu,
  /(?:^|\/)(?:_netrc|\.envrc|\.pgpass|\.yarnrc\.yml|\.vault-token|\.s3cfg|\.boto)$/iu,
  /\.ppk$/iu,
  /(?:^|\/)id_(?:ecdsa|ed25519)_sk(?:\.pub)?$/iu,
  /\.tfvars(?:\.json)?$/iu,
  /\.tfstate(?:\.backup)?$/iu,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/iu,
];

const skipped = (name: string): boolean => SKIPPED.has(name.toLowerCase());
export const secretName = (rel: string): boolean => isSecretPath(rel) || VIEWER_SECRETS.some(re => re.test(rel));
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.ino === b.ino && a.dev === b.dev;

// 相対パスの文字だけを見る。'' は根。区切りは / だけ、. と .. と空の段・末尾の . と空白（Windows が黙って落とす名前）・ストリームやデバイスの名前は断る
export function relSegments(rel: string): string[] | 'bad_path' {
  if (rel === '') return [];
  if (rel.length > MAX_PATH_CHARS || UNSAFE_TEXT.test(rel) || rel.startsWith('/') || windowsHazard(rel)) return 'bad_path';
  const segs = rel.split('/');
  if (segs.some(seg => seg === '' || seg === '.' || seg === '..' || /[. ]$/u.test(seg))) return 'bad_path';
  return segs;
}

// 根から 1 段ずつ lstat でたどる。リンク・ジャンクションは段のどこにあっても断る。たどり終えたら実体のパスが、根と頼まれた名前を
// そのままつないだものと文字ごと同じかを見る（大文字小文字の違い・8.3 の短い名前など、同じ物を指す別の名前を断る）。
// realpath のあとにもう一度 lstat し、前の lstat と同じ物でなければ断る（途中の段を入れ替えられた）
function walk(view: TreeRoot, segs: readonly string[]): { abs: string; rel: string; stat: BigIntStats } | FilesRefusal {
  const fs = view.fs ?? REAL_VIEW_FS;
  let abs = view.root;
  let stat: BigIntStats | undefined;
  try {
    stat = fs.lstat(abs);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return 'missing';
    for (const seg of segs) {
      if (!stat.isDirectory()) return 'missing';
      abs = join(abs, seg);
      stat = fs.lstat(abs);
      if (!stat) return 'missing';
      if (stat.isSymbolicLink()) return 'refused';
    }
    if (fs.realpath(abs) !== abs) return 'refused';
    const after = fs.lstat(abs);
    if (!after || after.isSymbolicLink() || !sameFile(after, stat)) return 'refused';
  } catch { return 'missing'; }
  if (view.deny.some(d => isInside(d, abs))) return 'refused';
  return { abs, rel: segs.join('/'), stat };
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

// 文字で確かめた rel だけで git に聞く（ファイルをたどる前に済ませ、たどってから開くまでのあいだに await を置かない）
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
  const fs = view.fs ?? REAL_VIEW_FS;
  const segs = relSegments(rel);
  if (segs === 'bad_path') return segs;
  if (segs.some(skipped)) return 'refused';
  const facts = await gitFacts(view, segs.join('/'), true);
  const found = walk(view, segs);
  if (typeof found === 'string') return found;
  if (!found.stat.isDirectory()) return 'not_dir';
  if (segs.length && secretName(found.rel)) return 'refused';
  if (facts?.ignored.some(p => p === found.rel || found.rel.startsWith(`${p}/`))) return 'refused';
  const prefix = found.rel ? `${found.rel}/` : '';
  const ignored = new Set(facts?.ignored.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)) ?? []);
  const marks = marksOf(facts?.status ?? [], prefix);
  let read: { names: string[]; more: boolean };
  try { read = fs.names(found.abs, MAX_NAMES); } catch { return 'missing'; }
  const entries: FileEntry[] = [];
  for (const name of read.names) {
    if (skipped(name) || ignored.has(name)) continue;
    const abs = join(found.abs, name);
    let st: BigIntStats | undefined;
    try { st = fs.lstat(abs); } catch { continue; }
    if (!st || st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) continue;
    if (view.deny.some(d => isInside(d, abs))) continue;
    const path = prefix + name;
    const entry: FileEntry = { name, path, kind: st.isDirectory() ? 'dir' : 'file' };
    const mark = marks.get(name);
    if (mark && entry.kind === 'file') entry.mark = mark;
    if (secretName(path)) entry.hidden = true;
    entries.push(entry);
  }
  const again = walk(view, segs);
  if (typeof again === 'string' || !sameFile(again.stat, found.stat)) return 'refused';
  entries.sort(byName);
  return { dir: found.rel, entries: entries.slice(0, MAX_ENTRIES), truncated: read.more || entries.length > MAX_ENTRIES, ignoreChecked: !view.git || facts !== undefined };
}

export async function readFileView(view: TreeRoot, rel: string): Promise<FileView | FilesRefusal> {
  const fs = view.fs ?? REAL_VIEW_FS;
  const segs = relSegments(rel);
  if (segs === 'bad_path' || segs.length === 0) return 'bad_path';
  if (segs.some(skipped)) return 'refused';
  const facts = await gitFacts(view, segs.join('/'), false);
  const found = walk(view, segs);
  if (typeof found === 'string') return found;
  if (!found.stat.isFile()) return 'not_file';
  if (view.git && !facts) return 'unchecked';
  if (facts?.ignored.length) return 'refused';
  const mark = marksOf(facts?.status ?? [], '').get(found.rel) ?? null;
  const base = { path: found.rel, size: Number(found.stat.size), modifiedAt: Number(found.stat.mtimeMs), mark };
  if (secretName(found.rel)) return { ...base, hidden: true, binary: false, truncated: false, text: null };
  let fd: number;
  try { fd = fs.open(found.abs); } catch { return 'missing'; }
  try {
    const opened = fs.fstat(fd);
    if (!opened.isFile() || opened.nlink !== 1n) return 'refused';
    const again = walk(view, segs);
    if (typeof again === 'string' || !sameFile(again.stat, opened)) return 'refused';
    const size = Number(opened.size);
    const want = Math.min(size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.read(fd, buf, got, want - got, got);
      if (n === 0) break;
      got += n;
    }
    const bytes = buf.subarray(0, got);
    const truncated = size > got;
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { ...base, size, hidden: false, binary: true, truncated, text: null };
    let text = bytes.toString('utf8');
    if (truncated) text = text.replace(/�+$/u, '');
    return { ...base, size, hidden: false, binary: false, truncated, text };
  } catch { return 'missing'; } finally { fs.close(fd); }
}
