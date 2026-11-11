import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { THEMES } from '../web/src/ui/theme.ts';

// 新しい画面のトークン（web/src/ui/styles/tokens.css。plans/beat/Design/tokens.json から作ったもの）の見張り。
// 測るのは、6 テーマのそれぞれで、文字の色と下の面の組の濃さの比（4.5:1 以上）。色の値は #rrggbb と var(--名前) だけを読み、ほかの書き方は落とす。

type Rgb = [number, number, number];

const UI_STYLES = new URL('../web/src/ui/styles/', import.meta.url);
const css = readFileSync(new URL('tokens.css', UI_STYLES), 'utf8').replace(/\r/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '');

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `tokens.css に ${selector} が無い`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/gu)].map(m => [m[1]!, m[2]!.trim()]));
}

const root = block(':root');
const themeTokens = (theme: string): Map<string, string> => (theme === 'light' ? root : new Map([...root, ...block(`:root[data-theme="${theme}"]`)]));

function color(tokens: Map<string, string>, expr: string, depth = 0): Rgb {
  assert.ok(depth < 10, `循環している: ${expr}`);
  const hex = /^#([0-9a-f]{6})$/iu.exec(expr);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const ref = /^var\((--[a-z0-9-]+)\)$/u.exec(expr);
  if (ref) {
    const value = tokens.get(ref[1]!);
    assert.ok(value, `${ref[1]} が定義されていない`);
    return color(tokens, value, depth + 1);
  }
  throw new Error(`読めない値: ${expr}`);
}

const luminance = (c: Rgb): number => {
  const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast =(a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const PAIRS: ReadonlyArray<[string, string]> = [
  ...['ink', 'ink-soft', 'ink-mute'].flatMap(ink => ['ground', 'surface', 'surface-sunk'].map(ground => [ink, ground] as [string, string])),
  ['on-pulse', 'pulse'],
  ['pulse-ink', 'pulse-soft'],
];

for (const theme of THEMES) {
  test(`${theme}: 文字の色と下の面の組がどれも 4.5:1 以上`, () => {
    const tokens = themeTokens(theme);
    const low = PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(color(tokens, `var(--${fg})`), color(tokens, `var(--${bg})`)) }))
      .filter(r => r.ratio < 4.5).map(r => `${r.pair}: ${r.ratio.toFixed(2)}`);
    assert.deepEqual(low, []);
  });
}

test('どのテーマも同じトークンの名前を持ち、テーマの区切りは color の値だけを替える', () => {
  const themed = [...block(':root[data-theme="dusk"]').keys()].sort();
  for (const theme of THEMES.filter(t => t !== 'light')) assert.deepEqual([...block(`:root[data-theme="${theme}"]`).keys()].sort(), themed, theme);
  for (const name of themed) assert.ok(root.has(name), `${name} が :root に無い`);
});

test('color-scheme: dusk と ember は dark、ほかは light（ふだんの入力欄やスクロールバーの色）', () => {
  for (const theme of THEMES) assert.equal(themeTokens(theme).get('color-scheme'), theme === 'dusk' || theme === 'ember' ? 'dark' : 'light', theme);
});

test('書体はシステムの書体だけ（デザインの書体の名前を含まない）', () => {
  assert.equal(root.get('--font-display'), 'Georgia, Cambria, "Yu Mincho", serif');
  assert.equal(root.get('--font-sans'), '"Segoe UI", "Yu Gothic UI", Meiryo, sans-serif');
  assert.equal(root.get('--font-mono'), 'Consolas, "Yu Gothic UI", monospace');
  assert.doesNotMatch(css, /Instrument Serif|Hanken Grotesk|JetBrains Mono/u);
});

test('ui/ の CSS は色を直書きしない（#色 と rgb( / hsl( はトークンの定義のファイルだけ）', () => {
  const hits: string[] = [];
  for (const name of readdirSync(UI_STYLES).filter(n => n.endsWith('.css') && n !== 'tokens.css')) {
    const text = readFileSync(join(fileURLToPath(UI_STYLES), name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const m of text.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/giu)) hits.push(`${name}: ${m[0]}`);
  }
  assert.deepEqual(hits, []);
});
