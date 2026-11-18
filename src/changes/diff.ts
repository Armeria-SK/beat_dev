import { closeSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withGit } from '../mesh/folders.ts';
import { parseNameStatus } from '../projects/diff-flags.ts';
import { lineDiff } from '../shared/line-delta.ts';
import { isInside, isSecretPath, windowsHazard } from '../tools/hooks/scope.ts';
import { KEEP_MAX_BYTES, readKept, type FileChangeRow } from './record.ts';

export type BaseKind = 'build' | 'commit' | 'records' | 'branch';
export interface ChangeBase { kind: BaseKind; ref: string | null; at: number | null }

// before / after: 中身、null = 無い、'unknown' = 取れない（控えが無い・リンクの先・別名）、'large' = 控えられる大きさ（5MB）を超えるので読まない
export type Content = Buffer | null | 'unknown' | 'large';
// mode: git の木の実行の印（100755 → 0o755）。無ければ書き戻すときに今のファイルの印のまま
export interface ChangeEntry { path: string; before: Content; after: Content; hidden: boolean; mode?: number | undefined }

export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  added: number;
  removed: number;
  hunks: string[][] | null;
  hidden: boolean;
  undo: boolean;
}

export const MAX_FILES = 200;
const HUNK_MAX_BYTES = 1024 * 1024;
const HUNK_MAX_LINES = 2000;
const CONTEXT = 3;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const WINDOWS = process.platform === 'win32';
const SHORT_NAME = /~\d/u;
export const foldPath = (path: string): string => (WINDOWS ? path.toLowerCase() : path);

const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};

export function safeRel(rel: string): boolean {
  if (!rel || rel.length > 4096 || /[\0\\�]/u.test(rel) || rel.startsWith('/') || /^[A-Za-z]:/u.test(rel) || windowsHazard(rel)) return false;
  return rel.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !(WINDOWS && (/[. ]$/u.test(part) || SHORT_NAME.test(part))));
}

export function hiddenPath(realRoot: string, rel: string, deny: readonly string[]): boolean {
  return !safeRel(rel) || isSecretPath(rel) || deny.some(dir => isInside(dir, join(realRoot, ...rel.split('/'))));
}

// その場所の名前が、ディスクの上の名前そのものか（Windows の短い名前 GIT~1 などの別名・大文字小文字の違いは別名として断る）
export function ownName(path: string, part: string): boolean {
  try { return foldPath(basename(realpathSync.native(path))) === foldPath(part); } catch { return false; }
}

function readUpTo(path: string, size: number): Buffer | 'unknown' | 'large' {
  if (size > KEEP_MAX_BYTES) return 'large';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(KEEP_MAX_BYTES + 1);
    let total = 0;
    for (let n = 1; n > 0 && total < buffer.length; total += n) n = readSync(fd, buffer, total, buffer.length - total, null);
    return total > KEEP_MAX_BYTES ? 'large' : buffer.subarray(0, total);
  } catch { return 'unknown'; } finally { if (fd !== undefined) closeSync(fd); }
}

// 製品のフォルダの中のファイルを、途中のリンク・ジャンクション・別名をたどらずに読む。5MB を超えるものは読まない
export function readCurrent(realRoot: string, rel: string): Content {
  if (!safeRel(rel)) return 'unknown';
  let path = realRoot;
  const parts = rel.split('/');
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const st = lstatOf(path);
    if (st === undefined) return null;
    if (st === null || st.isSymbolicLink() || !ownName(path, part)) return 'unknown';
    if (i < parts.length - 1 && !st.isDirectory()) return null;
    if (i === parts.length - 1) {
      if (!st.isFile()) return st.isDirectory() ? null : 'unknown';
      return readUpTo(path, st.size);
    }
  }
  return 'unknown';
}

const same = (a: Content, b: Content): boolean => (a === null && b === null) || (Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b));

const text = (bytes: Buffer): string | null => (bytes.length > HUNK_MAX_BYTES || bytes.includes(0) ? null : bytes.toString('utf8'));

export function hunksOf(before: string, after: string): { added: number; removed: number; hunks: string[][] | null } {
  const lines = lineDiff(before, after);
  const added = lines.filter(l => l.kind === 'add').length;
  const removed = lines.filter(l => l.kind === 'del').length;
  if (added + removed > HUNK_MAX_LINES) return { added, removed, hunks: null };
  const hunks: string[][] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const steps = lines.map(line => {
    const at = { old: oldLine, new: newLine };
    if (line.kind !== 'add') oldLine++;
    if (line.kind !== 'del') newLine++;
    return at;
  });
  while (i < lines.length) {
    if (lines[i]!.kind === 'same') { i++; continue; }
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    while (end < lines.length) {
      if (lines[end]!.kind !== 'same') { end++; continue; }
      let run = end;
      while (run < lines.length && lines[run]!.kind === 'same') run++;
      if (run >= lines.length || run - end > CONTEXT * 2) { end = Math.min(lines.length, end + CONTEXT); break; }
      end = run;
    }
    const part = lines.slice(start, end);
    const oldCount = part.filter(l => l.kind !== 'add').length;
    const newCount = part.filter(l => l.kind !== 'del').length;
    hunks.push([`@@ -${steps[start]!.old},${oldCount} +${steps[start]!.new},${newCount} @@`, ...part.map(l => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)]);
    i = end;
  }
  return { added, removed, hunks };
}

export function present(entries: readonly ChangeEntry[], options: { undo: boolean }): ChangedFile[] {
  return entries.map(entry => {
    const status = entry.before === null ? 'added' as const : entry.after === null ? 'deleted' as const : 'modified' as const;
    if (entry.hidden) return { path: entry.path, status, added: 0, removed: 0, hunks: null, hidden: true, undo: false };
    const undo = options.undo && (entry.before === null || Buffer.isBuffer(entry.before)) && (entry.after === null || Buffer.isBuffer(entry.after));
    const left = entry.before === null ? '' : Buffer.isBuffer(entry.before) ? text(entry.before) : null;
    const right = entry.after === null ? '' : Buffer.isBuffer(entry.after) ? text(entry.after) : null;
    if (left === null || right === null) return { path: entry.path, status, added: 0, removed: 0, hunks: null, hidden: false, undo };
    return { path: entry.path, status, ...hunksOf(left, right), hidden: false, undo };
  });
}

type Git = (args: string[]) => Promise<Buffer | null>;

interface TreeItem { mode: string; oid: string; size: number }

async function treeOf(git: Git, oid: string): Promise<Map<string, TreeItem> | null> {
  const out = await git(['ls-tree', '-r', '-z', '-l', '--full-tree', oid]);
  if (!out) return null;
  const map = new Map<string, TreeItem>();
  for (const line of out.toString('utf8').split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob, size] = line.slice(0, tab).split(/ +/u);
    if (type === 'blob' && mode && blob && OID.test(blob)) map.set(line.slice(tab + 1), { mode, oid: blob, size: /^\d+$/u.test(size ?? '') ? Number(size) : Infinity });
  }
  return map;
}

const regularBlob = (mode: string): boolean => mode === '100644' || mode === '100755';
const modeOf = (item: TreeItem | undefined): number | undefined => (item?.mode === '100755' ? 0o755 : item?.mode === '100644' ? 0o644 : undefined);

// 大きさを先に見て、控えられる大きさを超える中身は取り出さない
async function blobOf(git: Git, item: TreeItem): Promise<Content> {
  if (!regularBlob(item.mode)) return 'unknown';
  if (item.size > KEEP_MAX_BYTES) return 'large';
  return (await git(['cat-file', 'blob', item.oid])) ?? 'unknown';
}

const CRLF = Buffer.from('\r\n');

// git の取り出し（--filters）は、この PC の改行の設定で CRLF にすることがある。作業の木のファイルの改行に合う方を元の中身にする
// （改行だけを書き換える Undo にしない）。今のファイルが無ければ、git が取り出すときの形
export function lineEndingsLike(after: Content, filtered: Buffer, raw: Buffer): Buffer {
  if (!Buffer.isBuffer(after) || !after.includes(0x0a)) return filtered;
  const wants = after.includes(CRLF);
  if (filtered.includes(CRLF) === wants) return filtered;
  return raw.includes(CRLF) === wants ? raw : filtered;
}

export type GitResult = { ok: true; base: ChangeBase; entries: ChangeEntry[]; more: number } | { ok: false; reason: 'git_unusable' | 'no_base' | 'failed' };

// git の元（前の Build の始まり・前のコミット）と、いまの作業の木を比べる。パスは git の出力（-z）からだけ取る
export async function gitEntries(realRoot: string, dataDir: string, base: { kind: 'build'; task: string } | { kind: 'commit' }, deny: readonly string[], only?: ReadonlySet<string>): Promise<GitResult> {
  const result = await withGit(realRoot, dataDir, async (git): Promise<GitResult> => {
    const ref = base.kind === 'build' ? `refs/beat/snapshots/${base.task}^{commit}` : 'HEAD^{commit}';
    const oid = (await git(['rev-parse', '--verify', '-q', ref]))?.toString('utf8').trim() ?? '';
    if (!OID.test(oid)) return { ok: false, reason: 'no_base' };
    const time = Number((await git(['show', '-s', '--format=%ct', oid]))?.toString('utf8').trim());
    const tree = await treeOf(git, oid);
    const listed = await git(['diff', '--name-status', '-z', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', oid, '--']);
    const untracked = await git(['ls-files', '-z', '-o', '--exclude-standard']);
    if (!tree || !listed || !untracked) return { ok: false, reason: 'failed' };
    const paths = new Set<string>();
    for (const entry of parseNameStatus(listed.toString('utf8'))) paths.add(entry.path);
    for (const path of untracked.toString('utf8').split('\0')) if (path && !path.endsWith('/')) paths.add(path);
    const sorted = [...paths].filter(path => !only || only.has(path)).sort();
    const entries: ChangeEntry[] = [];
    for (const path of sorted.slice(0, MAX_FILES)) {
      const blob = tree.get(path);
      const hidden = hiddenPath(realRoot, path, deny);
      if (hidden) {
        const there = lstatOf(join(realRoot, ...path.split('/'))) !== undefined;
        if (blob || there) entries.push({ path, before: blob ? 'unknown' : null, after: there ? 'unknown' : null, hidden: true });
        continue;
      }
      const after = readCurrent(realRoot, path);
      let before: Content = null;
      if (blob) {
        const raw = await blobOf(git, blob);
        const filtered = Buffer.isBuffer(raw) ? (await git(['cat-file', '--filters', `--path=${path}`, blob.oid])) ?? raw : null;
        before = Buffer.isBuffer(raw) && filtered ? lineEndingsLike(after, filtered, raw) : raw;
        if (Buffer.isBuffer(raw) && filtered && (same(raw, after) || same(filtered, after))) continue;
      }
      if (same(before, after)) continue;
      entries.push({ path, before, after, hidden: false, mode: modeOf(blob) });
    }
    return { ok: true, base: { kind: base.kind, ref: oid, at: Number.isFinite(time) && time > 0 ? time * 1000 : null }, entries, more: Math.max(0, sorted.length - MAX_FILES) };
  });
  return result ?? { ok: false, reason: 'git_unusable' };
}

// beat のファイルの道具の記録から: 範囲の中でいちばん古い記録の前の中身と、いまの中身を比べる。本体の記録（place が NULL）だけ
export function recordEntries(db: DatabaseSync, dir: string, projectId: string, realRoot: string, scope: { task?: string | undefined; conversation?: string | undefined }, deny: readonly string[], only?: ReadonlySet<string>): { base: ChangeBase; entries: ChangeEntry[]; more: number } {
  const where = ["project_id = ?", 'place IS NULL', "action IN ('create', 'modify')"];
  const args: string[] = [projectId];
  if (scope.task) { where.push('task_id = ?'); args.push(scope.task); }
  if (scope.conversation) { where.push('conversation_id = ?'); args.push(scope.conversation); }
  const rows = db.prepare(`SELECT * FROM file_changes WHERE ${where.join(' AND ')} ORDER BY id`).all(...args) as unknown as FileChangeRow[];
  const first = new Map<string, FileChangeRow>();
  for (const row of rows) if (!first.has(foldPath(row.path))) first.set(foldPath(row.path), row);
  const sorted = [...first.values()].map(row => row.path).filter(path => !only || only.has(path)).sort();
  const entries: ChangeEntry[] = [];
  for (const path of sorted.slice(0, MAX_FILES)) {
    const row = first.get(foldPath(path))!;
    if (hiddenPath(realRoot, path, deny)) {
      const there = lstatOf(join(realRoot, ...path.split('/'))) !== undefined;
      entries.push({ path, before: row.action === 'create' ? null : 'unknown', after: there ? 'unknown' : null, hidden: true });
      continue;
    }
    const before: Content = row.action === 'create' ? null : row.kept === 1 && row.before_hash ? readKept(dir, projectId, row.before_hash) ?? 'unknown' : 'unknown';
    const after = readCurrent(realRoot, path);
    if (same(before, after)) continue;
    entries.push({ path, before, after, hidden: false });
  }
  return { base: { kind: 'records', ref: null, at: rows[0]?.created_at ?? null }, entries, more: Math.max(0, sorted.length - MAX_FILES) };
}

// worktree のブランチ: 元のコミットとブランチの先端を比べる（読むだけ）
export async function branchEntries(realRoot: string, dataDir: string, branch: string, baseOid: string, deny: readonly string[]): Promise<GitResult> {
  if (!OID.test(baseOid)) return { ok: false, reason: 'no_base' };
  const result = await withGit(realRoot, dataDir, async (git): Promise<GitResult> => {
    const tip = (await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]))?.toString('utf8').trim() ?? '';
    if (!OID.test(tip)) return { ok: false, reason: 'no_base' };
    const time = Number((await git(['show', '-s', '--format=%ct', baseOid]))?.toString('utf8').trim());
    const left = await treeOf(git, baseOid);
    const right = await treeOf(git, tip);
    if (!left || !right) return { ok: false, reason: 'failed' };
    const sorted = [...new Set([...left.keys(), ...right.keys()])].filter(path => left.get(path)?.oid !== right.get(path)?.oid).sort();
    const entries: ChangeEntry[] = [];
    const blob = async (item: TreeItem | undefined): Promise<Content> => (!item ? null : blobOf(git, item));
    for (const path of sorted.slice(0, MAX_FILES)) {
      if (hiddenPath(realRoot, path, deny)) { entries.push({ path, before: left.has(path) ? 'unknown' : null, after: right.has(path) ? 'unknown' : null, hidden: true }); continue; }
      entries.push({ path, before: await blob(left.get(path)), after: await blob(right.get(path)), hidden: false });
    }
    return { ok: true, base: { kind: 'branch', ref: baseOid, at: Number.isFinite(time) && time > 0 ? time * 1000 : null }, entries, more: Math.max(0, sorted.length - MAX_FILES) };
  });
  return result ?? { ok: false, reason: 'git_unusable' };
}
