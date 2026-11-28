import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDir, trackedTempDir } from './helpers.ts';

// backlog: beat-test-* の一時フォルダを直接作る 8 か所（app-setup・background-routes・browser-bench-collect・pending-pipeline・scout-sleep・
// shell-background・temp-cleanup・worktree）は、終了時の片付けに載っていなかった。試験が途中で落ちると中身入りのフォルダが一時置き場にたまる。
// tests/ では beat-test-* を helpers の tempDir か trackedTempDir でだけ作る（どちらもプロセスが終わるときの掃除に載る）。

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const HELPERS = join(TESTS, 'helpers.ts');
const DIRECT = /mkdtemp(?:Sync)?\([^;]*['"`]beat-test-/u;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(?:[cm]?[jt]s|tsx)$/u.test(name) ? [path] : [];
  });
}

test('bl-early tempdirs: tests/ の中で beat-test-* を片付けの外で直接作る所が無い（helpers.ts の trackedTempDir だけ）', () => {
  const direct = walk(TESTS).filter(file => file !== HELPERS && DIRECT.test(readFileSync(file, 'utf8')));
  assert.deepEqual(direct.map(file => relative(TESTS, file)), []);
  assert.match(readFileSync(HELPERS, 'utf8'), DIRECT, 'helpers.ts の trackedTempDir が作る');
});

test('bl-early tempdirs: trackedTempDir は beat-test-* のフォルダを作る（後片付けは呼ぶ側、取り残しはプロセスの終わりに掃除）', async () => {
  const dir = trackedTempDir();
  try {
    assert.ok(existsSync(dir));
    assert.match(basename(dir), /^beat-test-/u);
  } finally {
    await removeDir(dir);
  }
});
