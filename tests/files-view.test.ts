import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listFolder, MAX_NAMES, readFileView, REAL_VIEW_FS, type TreeRoot, type ViewFs } from '../src/projects/files-view.ts';
import { tempDir } from './helpers.ts';

// beat 8-5a（安全の審査の直し）: たどる途中・開く前後で段がジャンクションに入れ替わる形を、ファイルを触る口の差し替えで作る。
// 本物のジャンクションの入れ替えは時間の当たり外れになるので、各 syscall が何を返すかを台本にする

function folders(t: Parameters<typeof tempDir>[0]) {
  const base = realpathSync.native(tempDir(t));
  const inside = join(base, 'inside');
  const outside = join(base, 'outside');
  for (const dir of [inside, outside]) {
    mkdirSync(join(dir, 'a'), { recursive: true });
  }
  writeFileSync(join(inside, 'a', 'f.txt'), 'INSIDE');
  writeFileSync(join(outside, 'a', 'f.txt'), 'OUTSIDE');
  writeFileSync(join(outside, 'a', 'leak.txt'), 'x');
  return { inside, outside };
}

// path の lstat の n 回目（1 から）に何を返すかを決める。open は outsideOpen なら外のファイルを開く
function scripted(map: { lstat?: Record<string, (n: number) => string>; open?: Record<string, string>; names?: Record<string, string> }, after?: () => void): ViewFs & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    ...REAL_VIEW_FS,
    calls,
    lstat: path => {
      const n = (calls.get(path) ?? 0) + 1;
      calls.set(path, n);
      const to = map.lstat?.[path];
      return REAL_VIEW_FS.lstat(to ? to(n) : path);
    },
    open: path => REAL_VIEW_FS.open(map.open?.[path] ?? path),
    names: (path, max) => { const out = REAL_VIEW_FS.names(map.names?.[path] ?? path, max); after?.(); return out; },
  };
}

const view = (root: string, fs: ViewFs): TreeRoot => ({ root, deny: [], git: null, fs });

test('8-5a 競り合い: 最後の段の lstat が外の物を指し（途中の段が一瞬ジャンクション）、realpath は中を返し、開くと外 → 断る', async t => {
  const { inside, outside } = folders(t);
  const file = join(inside, 'a', 'f.txt');
  const fs = scripted({ lstat: { [file]: n => (n === 1 ? join(outside, 'a', 'f.txt') : file) }, open: { [file]: join(outside, 'a', 'f.txt') } });
  const out = await readFileView(view(inside, fs), 'a/f.txt');
  assert.equal(out, 'refused');
});

test('8-5a 競り合い: たどる間ずっと外の物を指していても（realpath の前後とも）、開いたあとたどり直して中の物なら断る', async t => {
  const { inside, outside } = folders(t);
  const file = join(inside, 'a', 'f.txt');
  const fs = scripted({ lstat: { [file]: n => (n <= 2 ? join(outside, 'a', 'f.txt') : file) }, open: { [file]: join(outside, 'a', 'f.txt') } });
  const out = await readFileView(view(inside, fs), 'a/f.txt');
  assert.equal(out, 'refused');
});

test('8-5a: 途中の段がリンクなら、realpath が中を返しても断る（段ごとの確かめ）', async t => {
  const { inside } = folders(t);
  const a = join(inside, 'a');
  const fs: ViewFs = { ...REAL_VIEW_FS, lstat: path => {
    const st = REAL_VIEW_FS.lstat(path);
    return path === a && st ? Object.assign(Object.create(st) as BigIntStats, { isSymbolicLink: () => true }) : st;
  } };
  assert.equal(await readFileView(view(inside, fs), 'a/f.txt'), 'refused');
  assert.equal(await listFolder(view(inside, fs), 'a'), 'refused');
  const honest = await readFileView(view(inside, REAL_VIEW_FS), 'a/f.txt');
  assert.ok(typeof honest !== 'string' && honest.text === 'INSIDE', '入れ替えが無ければ読める');
});

test('8-5a 競り合い: 一覧を読むあいだにフォルダが外に入れ替わったら断る（読んだあとにたどり直す）', async t => {
  const { inside, outside } = folders(t);
  const a = join(inside, 'a');
  let swapped = false;
  const fs = scripted({ lstat: { [a]: () => (swapped ? join(outside, 'a') : a) }, names: { [a]: join(outside, 'a') } }, () => { swapped = true; });
  assert.equal(await listFolder(view(inside, fs), 'a'), 'refused');
});

test('8-5a: 1 つのフォルダで読む名前は MAX_NAMES で止め、続きがあれば truncated', async t => {
  const { inside } = folders(t);
  const seen: number[] = [];
  const fs: ViewFs = { ...REAL_VIEW_FS, names: (path, max) => { seen.push(max); return { names: REAL_VIEW_FS.names(path, max).names, more: true }; } };
  const out = await listFolder(view(inside, fs), 'a');
  assert.ok(typeof out !== 'string');
  assert.deepEqual(seen, [MAX_NAMES]);
  assert.equal(out.truncated, true);
  assert.equal(out.ignoreChecked, true, 'git でない製品では確かめることが無い');
});

test('8-5a 競り合い: 開いたあとのたどり直しで、段の lstat は外・realpath のあとの lstat は中（たどり直しの途中でも入れ替わる）→ 断る', async t => {
  const { inside, outside } = folders(t);
  const file = join(inside, 'a', 'f.txt');
  const fs = scripted({ lstat: { [file]: n => (n === 3 ? join(outside, 'a', 'f.txt') : file) }, open: { [file]: join(outside, 'a', 'f.txt') } });
  assert.equal(await readFileView(view(inside, fs), 'a/f.txt'), 'refused');
});
