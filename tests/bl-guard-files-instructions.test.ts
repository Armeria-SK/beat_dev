import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './helpers.ts';

const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const INSTRUCTIONS = pathToFileURL(fileURLToPath(new URL('../src/projects/instructions.ts', import.meta.url))).href;

const O_NOFOLLOW = 0x20000;
const O_NONBLOCK = 0x800;

// 子のプロセスで process.platform を linux に見せ、O_NOFOLLOW・O_NONBLOCK の値を差し込んで読み込む（Windows の node には無い）。
// openSync に渡る目印だけを記録し、本当に開くときは 'r' に替える（Windows で動かすため）
function openFlagsSeen(root: string, platform: 'linux' | 'win32'): { text: string | undefined; seen: unknown[] } {
  const script = [
    "import fs from 'node:fs';", "import { syncBuiltinESMExports } from 'node:module';",
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
    `Object.defineProperty(fs.constants, 'O_NOFOLLOW', { value: ${O_NOFOLLOW}, configurable: true });`,
    `Object.defineProperty(fs.constants, 'O_NONBLOCK', { value: ${O_NONBLOCK}, configurable: true });`,
    'const real = fs.openSync;',
    'const seen = [];',
    "fs.openSync = (path, flags, ...rest) => { if (String(path) === process.env.BL_FILE) seen.push(flags); return real(path, 'r', ...rest); };",
    'syncBuiltinESMExports();',
    `const { readInstructions } = await import(${JSON.stringify(INSTRUCTIONS)});`,
    'const found = readInstructions(process.env.BL_ROOT, 2000);',
    'process.stdout.write(JSON.stringify({ text: found?.text, seen }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, BL_ROOT: root, BL_FILE: join(root, 'AGENTS.md') } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { text: string | undefined; seen: unknown[] };
}

test('162: Windows 以外では、指示ファイルを O_NOFOLLOW と O_NONBLOCK 付きで開く（lstat のあとにリンクや FIFO に替えられても、たどらず・待たない）', t => {
  const root = tempDir(t);
  writeFileSync(join(root, 'AGENTS.md'), 'RULES');
  const got = openFlagsSeen(root, 'linux');
  assert.equal(got.text, 'RULES');
  assert.equal(got.seen.length, 1);
  const flags = got.seen[0];
  assert.equal(typeof flags, 'number');
  assert.equal((flags as number) & O_NOFOLLOW, O_NOFOLLOW);
  assert.equal((flags as number) & O_NONBLOCK, O_NONBLOCK);
});

test('162: Windows には O_NOFOLLOW が無いので、今までどおり読み取りの目印 r で開き、開いたあとの確かめに任せる', t => {
  const root = tempDir(t);
  writeFileSync(join(root, 'AGENTS.md'), 'RULES');
  const got = openFlagsSeen(root, 'win32');
  assert.equal(got.text, 'RULES');
  assert.deepEqual(got.seen, ['r']);
});
