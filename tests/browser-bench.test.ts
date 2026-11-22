import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedBaseRoot, busyPort, checkBase, parseRunArgs } from '../scripts/browser-bench/run.ts';
import { APP_ROOT } from '../src/paths.ts';

// browser-rethink P0 の物差しの流し役: 前の beat が残っているポートでは、起動する前に断る（頼みを別のデータへ送らない）。
// 引数の確かめは何も起動しない関数を直接呼ぶ。流し役そのものを動かす試験は 1 つだけで、偽の鍵を渡す（確かめが壊れても、お金のかかる実行にならない）

const freshBase = (t: { after: (fn: () => void) => void }): string => {
  const base = join(allowedBaseRoot(), `browser-bench-test-${randomBytes(4).toString('hex')}`);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};

async function dummyBeat(t: { after: (fn: () => Promise<void>) => void }): Promise<number> {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/projects' ? '{"projects":[]}' : '{}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  return (server.address() as AddressInfo).port;
}

test('決まったポート・作業場所の tmp の外・数でない --minutes は、引数の確かめで断る', t => {
  const base = freshBase(t);
  const args = (...extra: string[]) => ['--base', base, '--name', 'a', ...extra];
  for (const port of ['4777', '4797', '80', 'x']) assert.throws(() => parseRunArgs(args('--port', port)), /--port/);
  for (const minutes of ['soon', '0', '500']) assert.throws(() => parseRunArgs(args('--minutes', minutes)), /--minutes/);
  assert.throws(() => parseRunArgs(['--base', join(APP_ROOT, 'data'), '--name', 'a']), /must be under/);
  assert.throws(() => parseRunArgs(['--base', base, '--name', 'Bad Name']), /usage/);
  assert.deepEqual(parseRunArgs(args()), { base, name: 'a', port: 4787, minutes: 45, model: 'claude-sonnet-5-5' });
  assert.match(checkBase(join(allowedBaseRoot(), 'worktrees', 'w')) ?? '', /must be under/);
  assert.equal(existsSync(base), false);
});

test('待ち受けのあるポートを見分ける', async t => {
  const port = await dummyBeat(t);
  assert.equal(await busyPort([port]), port);
});

test('ポートで何かが待ち受けていれば、流し役はフォルダも beat も作らずに断る', async t => {
  const port = await dummyBeat(t);
  const base = freshBase(t);
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-dummy-not-a-key' };
  delete env.BEAT_DATA_DIR;
  const r = spawnSync(process.execPath, ['scripts/browser-bench/run.ts', '--base', base, '--name', 'busy', '--port', String(port)], { cwd: APP_ROOT, encoding: 'utf8', timeout: 60_000, env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`port ${port} is already in use`));
  assert.equal(existsSync(join(base, 'busy')), false);
});
