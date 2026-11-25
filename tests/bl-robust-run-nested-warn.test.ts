import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { CreatedFiles } from '../src/projects/created.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const NESTED = /inside another git repository/u;

test('別の git の中の作業フォルダ: 同じフォルダで何度実行しても WARN は 1 行。別のフォルダはそれぞれ 1 行', { skip: !gitAvailable }, async t => {
  const parent = realpathSync.native(tempDir(t));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: parent }).status, 0);
  const shop = join(parent, 'shop');
  const blog = join(parent, 'blog');
  mkdirSync(shop);
  mkdirSync(blog);
  const logs: string[] = [];
  const kv = new KV(openDatabase(':memory:', MIGRATIONS));
  t.after(() => kv.db.close());
  const created = new CreatedFiles({ kv, dataDir: parent, log: line => { logs.push(line); } });
  const scope = { kind: 'conv' as const, id: 'c1' };
  const warnings = (): string[] => logs.filter(line => NESTED.test(line));

  for (const runId of ['r1', 'r2', 'r3']) {
    await created.begin(runId, scope, shop);
    await created.end(runId);
  }
  assert.equal(warnings().length, 1, logs.join('\n'));
  assert.ok(warnings()[0]!.startsWith('[WARN] '));
  assert.ok(warnings()[0]!.includes(shop), '何度も出さない代わりに、どのフォルダかを 1 回で分かるようにする');

  await created.begin('r4', scope, blog);
  await created.end('r4');
  await created.begin('r5', scope, shop);
  await created.end('r5');
  assert.equal(warnings().length, 2, '別のフォルダは別に 1 回。前のフォルダはもう出さない');
  assert.ok(warnings()[1]!.includes(blog));
});
