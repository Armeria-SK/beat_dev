import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pickVariant, VARIANTS } from '../web/src/ui/variants.ts';

// 試しのときだけの切り替え（p1-ui.md「/preview で触って決めること」）。b は ?v.<名前>=b のときだけ、
// しかも開発サーバーのときだけ。持ち主のビルドに b の側が入らないよう、b を使う所は必ず import.meta.env.DEV で囲む。
// T1・T2・T3・T7 は持ち主が a に決めた（2026-11-12）ので b を消した。残りは T6（トースト、1-4）と T4（はじめの設定、1-5b）。

const UI = join(import.meta.dirname, '..', 'web', 'src', 'ui');

test('ui/variants: ?v.<名前>=b のときだけ b、ほかの値・無い・別の名前は a', () => {
  assert.equal(pickVariant('toast', '?v.toast=b'), 'b');
  assert.equal(pickVariant('toast', '?x=1&v.toast=b'), 'b');
  assert.equal(pickVariant('toast', '?v.toast=a'), 'a');
  assert.equal(pickVariant('toast', '?v.toast=B'), 'a');
  assert.equal(pickVariant('toast', ''), 'a');
  assert.equal(pickVariant('toast', '?v.onboarding=b'), 'a');
  assert.deepEqual([...VARIANTS], ['toast', 'onboarding']);
});

test('ui/variants: b を選ぶ呼び出し（variant）は、どれも同じ行・同じ文の中で import.meta.env.DEV の後ろにある（いまは呼ぶ所が無くてもよい）', () => {
  const bad: string[] = [];
  const files = (readdirSync(UI, { recursive: true }) as string[]).filter(n => /\.tsx?$/u.test(n) && !/(^|[\\/])variants\.ts$/u.test(n));
  assert.ok(files.length >= 8, `${files.length} files`);
  for (const name of files) {
    const text = readFileSync(join(UI, name), 'utf8');
    for (const m of text.matchAll(/\bvariant\(/gu)) {
      const start = Math.max(text.lastIndexOf(';', m.index), text.lastIndexOf('{', m.index), text.lastIndexOf('}', m.index), text.lastIndexOf('\n', m.index)) + 1;
      const statement = text.slice(start, m.index);
      const guard = /import\.meta\.env\.DEV( && | \? )(.*)$/u.exec(statement);
      const onDevSide = guard !== null && !/\|\||\?\?|(^|[^?]):/u.test(guard[2]!);
      if (!onDevSide) bad.push(`${name}: ${statement.trim()}${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});
