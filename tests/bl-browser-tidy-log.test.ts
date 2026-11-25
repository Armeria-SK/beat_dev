import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackgroundJobs } from '../src/tools/shell/background.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

// 前の起動の bg-*.log の掃除（backlog L102）。「前の起動」は、この beat が始まる前に最後に書かれたもの

const HOUR_S = 3600;
const launchedAt = (): number => Date.now() - process.uptime() * 1000;
const longAgo = (): Date => new Date(launchedAt() - HOUR_S * 1000);

function put(dir: string, name: string, old: boolean): string {
  const file = join(dir, name);
  writeFileSync(file, 'old output\n');
  if (old) utimesSync(file, longAgo(), longAgo());
  return file;
}

test('起動のときに、前の起動が残した bg-*.log を消す。この起動で書かれた分・ほかの名前のファイルは消さない', t => {
  const dir = tempDir(t);
  const logs = join(dir, 'tool_outputs');
  mkdirSync(logs, { recursive: true });
  const previous = [put(logs, 'bg-c1-1-aaaaaaaa.log', true), put(logs, 'bg-0f4e9c3a-8d1b-4c6e-9a77-1b2c3d4e5f60-12-0badcafe.log', true)];
  const fresh = put(logs, 'bg-c1-2-bbbbbbbb.log', false);
  const others = [put(logs, 'shell-1234.txt', true), put(logs, 'bg-notes.log', true), put(logs, 'bg-c1-3-cccccccc.log.bak', true)];
  const jobs = new BackgroundJobs({ logDir: logs });
  t.after(() => jobs.closeAll());
  for (const file of previous) assert.equal(existsSync(file), false, `前の起動の分が消える: ${file}`);
  assert.equal(existsSync(fresh), true, 'この起動が始まってからできた分は残す');
  for (const file of others) assert.equal(existsSync(file), true, `bg-*.log の形でないものは触らない: ${file}`);
});

test('ログのフォルダが無くても起動は止まらない', t => {
  const dir = tempDir(t);
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs') });
  t.after(() => jobs.closeAll());
  assert.deepEqual(jobs.list(), []);
});

test('動いている裏のコマンドのログは、あとから別の BackgroundJobs が作られても消さない（この起動のもの）', async t => {
  const dir = tempDir(t);
  const logs = join(dir, 'tool_outputs');
  mkdirSync(logs, { recursive: true });
  const old = put(logs, 'bg-c1-9-aaaaaaaa.log', true);
  const jobs = new BackgroundJobs({ logDir: logs });
  try {
    assert.equal(existsSync(old), false);
    const started = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node -e <script>', cwd: dir, file: process.execPath, args: ['-e', "console.log('RUNNING'); setInterval(() => {}, 1000);"], env: scrubEnv(), fetched: false });
    assert.ok('id' in started, JSON.stringify(started));
    const logPath = jobs.get(started.id)!.logPath;
    const end = Date.now() + 15_000;
    while (!existsSync(logPath)) {
      assert.ok(Date.now() < end, 'ログのファイルができない');
      await new Promise(r => setTimeout(r, 50));
    }
    new BackgroundJobs({ logDir: logs }).closeAll();
    assert.equal(existsSync(logPath), true, '動いているコマンドのログは残る');
  } finally {
    jobs.closeAll();
    await new Promise(r => setTimeout(r, 300));
  }
});
