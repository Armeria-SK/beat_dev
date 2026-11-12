import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
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
  const blocks = [...css.matchAll(/\[data-theme="([a-z]+)"\] \{/gu)].map(m => m[1]);
  assert.deepEqual(blocks, [...THEMES]);
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

function runInit(storage: { getItem: (key: string) => string | null }): string | undefined {
  const dataset: Record<string, string> = {};
  runInNewContext(readFileSync(new URL('../web/public/theme-init.js', import.meta.url), 'utf8'), { document: { documentElement: { dataset } }, localStorage: storage });
  return dataset.theme;
}

test('theme-init.js: 最初の描画の前に beat.theme を読む。6 つのどれでもなければ light（前の画面の clive.theme と OS の設定は見ない）', () => {
  for (const theme of THEMES) assert.equal(runInit(memory({ [THEME_KEY]: theme })), readTheme(memory({ [THEME_KEY]: theme })), theme);
  assert.equal(runInit(memory({ [THEME_KEY]: 'dusk' })), 'dusk');
  for (const value of ['dark', 'auto', '']) assert.equal(runInit(memory({ [THEME_KEY]: value })), 'light', value);
  assert.equal(runInit(memory({ 'clive.theme': 'dark' })), 'light');
  assert.equal(runInit(memory()), 'light');
  assert.equal(runInit(broken), 'light');
  assert.doesNotMatch(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), /name="color-scheme"/u);
});

test('applyTheme は data-theme を書き直す', () => {
  const root = { dataset: { theme: 'dark' } as DOMStringMap };
  applyTheme(root, 'ember');
  assert.equal(root.dataset.theme, 'ember');
  applyTheme(root, 'light');
  assert.equal(root.dataset.theme, 'light');
});
