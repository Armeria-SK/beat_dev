import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDir } from './helpers.ts';

// 試験の後片付け（removeDir）: Windows で、ほかのプロセスがしばらく開いているファイルがあっても消し切る。開いたままなら落ちる
const WIN = process.platform === 'win32';

async function holdOpen(file: string, ms: number): Promise<ChildProcess> {
  const script = `$f = [System.IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => { if (String(chunk).includes('held')) resolve(); });
    child.on('exit', code => reject(new Error(`powershell exited early (${code})`)));
  });
  return child;
}

const exited = (child: ChildProcess) => new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.on('exit', () => resolve()); });

test('removeDir: 少しのあいだ開かれているファイル（EPERM）があっても、閉じたあとに消し切る', { skip: !WIN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-test-'));
  writeFileSync(join(dir, 'held.log'), 'x');
  const child = await holdOpen(join(dir, 'held.log'), 800);
  try {
    await removeDir(dir);
    assert.equal(existsSync(dir), false);
  } finally {
    await exited(child);
    await removeDir(dir);
  }
});

test('removeDir: 待つ時間を過ぎても開いたままなら、EPERM のまま落ちる（取り残しを隠さない）', { skip: !WIN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-test-'));
  writeFileSync(join(dir, 'held.log'), 'x');
  const child = await holdOpen(join(dir, 'held.log'), 5000);
  try {
    await assert.rejects(removeDir(dir, 300), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
    assert.equal(existsSync(join(dir, 'held.log')), true);
  } finally {
    child.kill();
    await exited(child);
    await removeDir(dir);
  }
});
