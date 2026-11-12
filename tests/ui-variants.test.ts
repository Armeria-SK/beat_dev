import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pickVariant, VARIANTS } from '../web/src/ui/variants.ts';

// 試しのときだけの切り替え（p1-ui.md「/preview で触って決めること」）。b は ?v.<名前>=b のときだけ、
// しかも開発サーバーのときだけ。持ち主のビルドに b の側が入らないよう、b を使う所は必ず import.meta.env.DEV で囲む。

const UI = join(import.meta.dirname, '..', 'web', 'src', 'ui');

test('ui/variants: ?v.<名前>=b のときだけ b、ほかの値・無い・別の名前は a', () => {
  assert.equal(pickVariant('narrow', '?v.narrow=b'), 'b');
  assert.equal(pickVariant('narrow', '?x=1&v.narrow=b'), 'b');
  assert.equal(pickVariant('narrow', '?v.narrow=a'), 'a');
  assert.equal(pickVariant('narrow', '?v.narrow=B'), 'a');
  assert.equal(pickVariant('narrow', ''), 'a');
  assert.equal(pickVariant('narrow', '?v.agent=b'), 'a');
  assert.deepEqual([...VARIANTS], ['agent', 'narrow', 'motion', 'idle']);
});

test('ui/variants: b を選ぶ呼び出し（variant）と b の CSS の読み込みは、どれも import.meta.env.DEV の後ろにある', () => {
  const bad: string[] = [];
  let calls = 0;
  for (const name of readdirSync(UI).filter(n => /\.tsx?$/u.test(n) && n !== 'variants.ts')) {
    const text = readFileSync(join(UI, name), 'utf8');
    for (const m of text.matchAll(/\bvariant\(|variants-b\.css|B_IDLE_LINE/gu)) {
      const before = text.slice(Math.max(0, m.index - 120), m.index);
      if (/^import /mu.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index + 1))) continue;
      calls += 1;
      if (!/import\.meta\.env\.DEV(?: && | \? |\) void import\(')/u.test(before)) bad.push(`${name}: ${before.split('\n').at(-1)}${m[0]}`);
    }
  }
  assert.ok(calls >= 7, `${calls} 個しか見つからない`);
  assert.deepEqual(bad, []);
});
