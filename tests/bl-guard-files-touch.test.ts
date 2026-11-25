import assert from 'node:assert/strict';
import fs, { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { installTouchOf } from '../src/tools/hooks/protected-touch.ts';
import type { ScopePolicy } from '../src/tools/hooks/scope.ts';
import type { StatementFacts } from '../src/tools/hooks/shell-facts.ts';
import { tempDir } from './helpers.ts';

const statement = (code: string[], cwd: string, over: Partial<StatementFacts> = {}): StatementFacts => ({ program: 'node', code, cwd, cwds: [cwd], words: [], ...over }) as unknown as StatementFacts;

function layout(t: { after: (fn: () => void | Promise<void>) => void }) {
  const base = realpathSync.native(tempDir(t));
  const work = join(base, 'work');
  const guard = join(base, 'guard');
  const denied = join(base, 'denied');
  for (const dir of [work, guard, denied, join(base, 'denied2')]) mkdirSync(dir, { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: work, mode: 'write' }], deny: [denied, join(base, 'denied2')], guarded: { roots: [guard] } };
  return { base, work, guard, denied, policy };
}

// 442: 答えは変えずに、同じ名前・同じフォルダを何度も調べ直さない

test('442: 守る場所・断る場所を指す名前は、今までと同じに見つかる（先に出た名前が先。リンク越しも）', t => {
  const { base, work, guard, denied, policy } = layout(t);
  assert.equal(installTouchOf([], policy, work, ['hello world', `x ${join(guard, 'a.txt')} y`]), join(guard, 'a.txt'));
  assert.equal(installTouchOf([], policy, work, [`${join(denied, 'k')}`, `${join(guard, 'a.txt')}`]), join(denied, 'k'), '先に出た名前が先');
  assert.equal(installTouchOf([], policy, work, [`${join(guard, 'a.txt')}`, `${join(denied, 'k')}`]), join(guard, 'a.txt'));
  assert.equal(installTouchOf([], policy, work, ['../guard/b.txt']), resolve(work, '../guard/b.txt'), '作業フォルダからの相対');
  assert.equal(installTouchOf([statement(['sub/../../denied2/z'], work)], policy, work), join(base, 'denied2', 'z'), '文のコードの中の名前');
  assert.equal(installTouchOf([statement(['q'], join(base, 'elsewhere'), { cwds: [guard] })], policy, work), join(guard, 'q'), '文が動きうる別の作業フォルダ');
  symlinkSync(guard, join(work, 'viaLink'), 'junction');
  assert.equal(installTouchOf([], policy, work, ['viaLink/inside.txt']), join(work, 'viaLink', 'inside.txt'), 'リンクの先が守る場所');
  symlinkSync(denied, join(work, 'viaDeny'), 'junction');
  assert.equal(installTouchOf([], policy, work, ['viaDeny']), join(work, 'viaDeny'), 'リンクの先が断る場所');
});

test('442: 守る場所にも断る場所にも当たらない名前は、記号ばかりでも・何度出ても undefined のまま', t => {
  const { work, policy } = layout(t);
  assert.equal(installTouchOf([], policy, work, ['hello', '!!! @@@ ### --- === +++ ~~~ ???', 'src/a.ts docs/b.md', '']), undefined);
  assert.equal(installTouchOf([], policy, work), undefined);
});

test('442: 記号の多い行が 4,000 行あっても、実体のパスを求める回数は名前や行の数で増えない', t => {
  const { work, guard, policy } = layout(t);
  const line = '!@#$%^&*-=+~|;:<>?/\\.. !!! @@@ ### $$$ %%% ^^^ &&& *** --- ==== +++ ~~~ ??? ... ,,, ::: ';
  const lines = Array.from({ length: 4000 }, (_, i) => `${line}${i % 5 === 0 ? `n${i}` : ''}`);
  let calls = 0;
  let exists = 0;
  const realExists = fs.existsSync;
  t.mock.method(realpathSync, 'native', (p: unknown) => { calls++; return String(p); });
  t.mock.method(fs, 'existsSync', (p: fs.PathLike) => { exists++; return realExists(p); });
  syncBuiltinESMExports();
  try {
    assert.equal(installTouchOf([], policy, work, lines), undefined);
    assert.ok(calls <= 10, `実体のパスを求めた回数 ${calls}`);
    assert.ok(exists <= 2_000, `あるかを見た回数 ${exists}（同じ名前は 1 回だけ。名前の数は 800 ほど）`);
    calls = 0;
    exists = 0;
    assert.equal(installTouchOf([], policy, work, [...lines, `${join(guard, 'late.txt')}`]), join(guard, 'late.txt'), '最後の名前でも見つかる');
    assert.ok(calls <= 10, `実体のパスを求めた回数 ${calls}（最後に守る場所）`);
    assert.ok(exists <= 2_000, `あるかを見た回数 ${exists}（最後に守る場所）`);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
