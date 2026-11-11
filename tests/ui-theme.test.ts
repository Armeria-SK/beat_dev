import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyTheme, DEFAULT_THEME, readReducedMotion, readTheme, REDUCED_MOTION_KEY, saveReducedMotion, saveTheme, THEME_KEY, THEMES, type ThemeStorage,
} from '../web/src/ui/theme.ts';

// 新しい画面のテーマ（6 つ。初めは light）と「動きを減らす」の保存。保存はこのブラウザの localStorage（beat.theme / beat.reducedMotion）。

function memory(init: Record<string, string> = {}): ThemeStorage & { store: Map<string, string> } {
  const store = new Map(Object.entries(init));
  return { store, getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
}
const broken: ThemeStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

test('テーマはデザインの 6 つで、tokens.css のテーマの区切りと同じ並び', () => {
  assert.deepEqual([...THEMES], ['light', 'dusk', 'sand', 'mist', 'moss', 'ember']);
  const css = readFileSync(new URL('../web/src/ui/styles/tokens.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/:root\[data-theme="([a-z]+)"\]/gu)].map(m => m[1]);
  assert.deepEqual(blocks, THEMES.filter(theme => theme !== 'light'));
});

test('保存が無い・知らない値（古い画面の dark / auto を含む）・読めないときは light', () => {
  assert.equal(DEFAULT_THEME, 'light');
  assert.equal(readTheme(memory()), 'light');
  assert.equal(readTheme(undefined), 'light');
  assert.equal(readTheme(broken), 'light');
  for (const value of ['dark', 'auto', 'Dusk', '', 'light ']) assert.equal(readTheme(memory({ [THEME_KEY]: value })), 'light', value);
});

test('6 つのどれも保存して読み戻せる。キーは beat.theme で、古い画面の clive.theme は読まない', () => {
  for (const theme of THEMES) {
    const storage = memory({ 'clive.theme': 'dark' });
    saveTheme(storage, theme);
    assert.equal(storage.store.get('beat.theme'), theme);
    assert.equal(readTheme(storage), theme);
  }
  assert.equal(readTheme(memory({ 'clive.theme': 'dusk' })), 'light');
});

test('保存できないときも落ちない', () => {
  assert.doesNotThrow(() => saveTheme(broken, 'sand'));
  assert.doesNotThrow(() => saveReducedMotion(broken, true));
  assert.doesNotThrow(() => saveTheme(undefined, 'sand'));
});

test('動きを減らす: 初めは off、保存して読み戻せる、読めないときは off', () => {
  const storage = memory();
  assert.equal(readReducedMotion(storage), false);
  saveReducedMotion(storage, true);
  assert.equal(storage.store.get(REDUCED_MOTION_KEY), '1');
  assert.equal(readReducedMotion(storage), true);
  saveReducedMotion(storage, false);
  assert.equal(readReducedMotion(storage), false);
  assert.equal(readReducedMotion(broken), false);
});

test('applyTheme は data-theme を書き直す（古い画面の theme-init.js が書いた dark も）', () => {
  const root = { dataset: { theme: 'dark' } as DOMStringMap };
  applyTheme(root, 'ember');
  assert.equal(root.dataset.theme, 'ember');
  applyTheme(root, 'light');
  assert.equal(root.dataset.theme, 'light');
});
