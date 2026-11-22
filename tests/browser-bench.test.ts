import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedBaseRoot, checkBase } from '../scripts/browser-bench/run.ts';
import { APP_ROOT } from '../src/paths.ts';

// browser-rethink P0 の物差しの流し役: 前の beat が残っているポートでは、起動する前に断る（頼みを別のデータへ送らない）

const runScript = (args: string[]) => spawnSync(process.execPath, ['scripts/browser-bench/run.ts', ...args], { cwd: APP_ROOT, encoding: 'utf8', timeout: 60_000 });

test('ポートで何かが待ち受けていれば、フォルダも beat も作らずに断る', async t => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/projects' ? '{"projects":[]}' : '{}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  const base = join(allowedBaseRoot(), `browser-bench-test-${randomBytes(4).toString('hex')}`);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const r = runScript(['--base', base, '--name', 'busy', '--port', String(port)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`port ${port} is already in use`));
  assert.equal(existsSync(join(base, 'busy')), false);
});

test('決まったポート・作業場所の tmp の外・数でない --minutes は断る', () => {
  for (const port of ['4777', '4797', 'x']) assert.notEqual(runScript(['--base', join(allowedBaseRoot(), 'x'), '--name', 'a', '--port', port]).status, 0);
  assert.match(runScript(['--base', join(allowedBaseRoot(), 'x'), '--name', 'a', '--minutes', 'soon']).stderr, /--minutes/);
  assert.match(checkBase(join(APP_ROOT, 'data')) ?? '', /must be under/);
  assert.match(checkBase(join(allowedBaseRoot(), 'worktrees', 'w')) ?? '', /must be under/);
  assert.equal(checkBase(join(allowedBaseRoot(), 'browser-rethink')), undefined);
});
