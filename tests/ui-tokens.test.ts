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

// tokens.css の規則を、ブラウザと同じ決まり（セレクタの強さ → 書いた順、変数は親から受け継ぐ）で読む。
// 読めるセレクタは :root、[data-theme="x"]、:root[data-theme="x"] だけ（ほかは落とす）。
interface Rule { selectors: string[]; decls: Map<string, string> }
interface Node { root: boolean; theme?: string }

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^}]*)\}/gu)].map(m => ({
  selectors: m[1]!.split(',').map(s => s.trim()),
  decls: new Map([...m[2]!.matchAll(/(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/gu)].map(d => [d[1]!, d[2]!.trim()])),
}));

function strength(selector: string, node: Node): number | undefined {
  const m = /^(:root)?(?:\[data-theme="([a-z]+)"\])?$/u.exec(selector);
  assert.ok(m && (m[1] || m[2]), `読めないセレクタ: ${selector}`);
  if ((m[1] && !node.root) || (m[2] && node.theme !== m[2])) return undefined;
  return (m[1] ? 1 : 0) + (m[2] ? 1 : 0);
}

function resolveVars(chain: readonly Node[]): Map<string, string> {
  let vars = new Map<string, string>();
  for (const node of chain) {
    const hits = rules.flatMap((rule, order) => {
      const best = Math.max(-1, ...rule.selectors.map(s => strength(s, node) ?? -1));
      return best < 0 ? [] : [{ rule, best, order }];
    }).sort((a, b) => a.best - b.best || a.order - b.order);
    vars = new Map(vars);
    for (const { rule } of hits) for (const [k, v] of rule.decls) vars.set(k, v);
  }
  return vars;
}

const root = resolveVars([{ root: true }]);
const themeTokens = (theme: string): Map<string, string> => resolveVars([{ root: true, theme }]);
const themeRule = (theme: string): Rule => {
  const found = rules.filter(rule => rule.selectors.includes(`[data-theme="${theme}"]`));
  assert.equal(found.length, 1, `[data-theme="${theme}"] だけで選ぶ規則が 1 つではない`);
  return found[0]!;
};

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

test('どのテーマも [data-theme="<名前>"] だけで選ぶ規則を 1 つ持ち（light は :root も）、どれも同じトークンの名前の組を書く', () => {
  const themed = [...themeRule('light').decls.keys()].sort();
  assert.ok(themeRule('light').selectors.includes(':root'), 'light の規則が :root も選んでいない');
  for (const theme of THEMES) assert.deepEqual([...themeRule(theme).decls.keys()].sort(), themed, theme);
});

test('テーマは要素ごとに効く: どのテーマのページの中でも、data-theme の付いた要素（Settings のテーマの見本）はそのテーマの色になる', () => {
  for (const page of THEMES) {
    for (const swatch of THEMES) {
      const vars = resolveVars([{ root: true, theme: page }, { root: false, theme: swatch }]);
      for (const name of ['--ground', '--pulse', '--ink', 'color-scheme']) assert.equal(vars.get(name), themeTokens(swatch).get(name), `${page} のページの ${swatch} の見本の ${name}`);
    }
  }
  assert.equal(resolveVars([{ root: true, theme: 'dusk' }, { root: false }]).get('--ground'), themeTokens('dusk').get('--ground'), 'data-theme の無い子はページのテーマを受け継ぐ');
});

test('ページ（html）のテーマ: data-theme が無い・知らない値（古い画面の dark）なら light、6 つのどれかならそのテーマ', () => {
  assert.equal(resolveVars([{ root: true }]).get('--ground'), '#f3f3ee');
  assert.equal(resolveVars([{ root: true, theme: 'dark' }]).get('--ground'), '#f3f3ee');
  assert.equal(themeTokens('ember').get('--ground'), '#1e1a16');
  assert.equal(themeTokens('dusk').get('--ground'), '#161a26');
  for (const theme of THEMES) assert.ok(themeTokens(theme).has('--space-4') && themeTokens(theme).has('--font-sans'), `${theme} で決まった値のトークンが読めない`);
});

test('どのテーマも light の写しではない（地・文字・強調の色が light と違い、テーマどうしも同じ組にならない）', () => {
  const core = ['--ground', '--surface', '--ink', '--pulse', '--pulse-soft'];
  const seen = new Map<string, string>();
  for (const theme of THEMES) {
    const tokens = themeTokens(theme);
    const key = core.map(name => color(tokens, `var(${name})`).join(',')).join('|');
    assert.equal(seen.get(key), undefined, `${theme} が ${seen.get(key)} と同じ色の組`);
    seen.set(key, theme);
    if (theme !== 'light') for (const name of ['--ground', '--pulse']) assert.notEqual(tokens.get(name), root.get(name), `${theme} の ${name} が light と同じ`);
  }
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
