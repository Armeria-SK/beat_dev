import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireInstanceLock, LOCK_FILE } from '../src/instance-lock.ts';
import { tempDir } from './helpers.ts';

async function liveProcess(t: Parameters<typeof tempDir>[0]): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill(); });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child.pid!;
}

const MINUTE = 60_000;
const BOOT = 1_800_000_000_000;

test('錠: 時計の合わせ直しで起動の時刻が 25 分ずれても、動いている beat の錠は取り直さない。31 分以上ずれたら別の起動の錠として取り直す', async t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const other = await liveProcess(t);
  assert.equal(acquireInstanceLock(dir, { pid: other, bootTime: () => BOOT }).held, true);
  for (const drift of [10 * MINUTE, 25 * MINUTE, -25 * MINUTE]) {
    assert.deepEqual(acquireInstanceLock(dir, { bootTime: () => BOOT + drift }), { held: false, path: join(dir, LOCK_FILE), pid: other }, `${drift / MINUTE} 分のずれは同じ起動`);
  }
  const later = acquireInstanceLock(dir, { bootTime: () => BOOT + 31 * MINUTE });
  assert.equal(later.held, true, '31 分あとの起動なら、前の起動の錠');
  assert.equal(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0], String(process.pid));
});
