import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewJson } from '../src/shared/json-preview.ts';
import { redactJsonValue } from '../src/shared/redaction.ts';

function shown(value: unknown, max: number): any {
  const text = previewJson(value, max);
  assert.ok(text.length <= max, `${text.length} > ${max}`);
  return JSON.parse(text);
}

const loneHigh = (text: string) => [...text].some(ch => { const code = ch.charCodeAt(0); return ch.length === 1 && code >= 0xd800 && code <= 0xdbff; });

test('B1: 収まる入力はそのまま', () => {
  const value = { path: 'a.txt', content: 'short' };
  assert.equal(previewJson(value, 4000), JSON.stringify(value));
});

test('B1: 50 KB の content を縮めても JSON のまま。短い欄（path・command・url・query・name）は残る', () => {
  const value = { path: 'src/very/deep/file.ts', command: 'npm test', url: 'https://example.com/a', query: 'q', name: 'n', content: 'x'.repeat(50_000) };
  const back = shown(value, 4000);
  assert.deepEqual([back.path, back.command, back.url, back.query, back.name], [value.path, value.command, value.url, value.query, value.name]);
  assert.match(back.content, /^x+…$/u);
  assert.ok(back.content.length > 3500, '残りの量は content に使う');
  assert.equal(shown(value, 2000).path, value.path);
});

test('B1: 中くらいの文字列が多くても、長いものから縮める', () => {
  const value = { label: 'keep me', parts: Array.from({ length: 40 }, (_, i) => `${i}:${'y'.repeat(300)}`) };
  const back = shown(value, 2000);
  assert.equal(back.label, 'keep me');
  assert.equal(back.parts.length, 40);
  assert.ok(back.parts.every((p: string) => p.endsWith('…')));
});

test('B1: 長い配列と多いキーは、残りの数の印をつけて切る', () => {
  const arr = shown({ path: 'p', items: Array.from({ length: 5000 }, (_, i) => i) }, 2000);
  assert.equal(arr.path, 'p');
  assert.match(arr.items.at(-1), /^… \d+ more$/u);
  const obj = shown(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])), 2000);
  assert.match(obj['…'], /^\d+ more$/u);
});

test('B1: 深い入れ子でも JSON のまま', () => {
  let deep: unknown = 'z'.repeat(5000);
  for (let i = 0; i < 90; i++) deep = { level: i, child: deep, pad: 'w'.repeat(50) };
  shown(deep, 2000);
  shown(deep, 4000);
});

test('B1: 切れ目のサロゲートペア・日本語・バックスラッシュと二重引用符を含む値でも JSON のまま', () => {
  for (let max = 1990; max < 2010; max++) {
    const back = shown({ path: 'a', odd: `a${'😀'.repeat(3000)}`, even: '😀'.repeat(3000) }, max);
    assert.equal(loneHigh(back.odd) || loneHigh(back.even), false, '片割れのサロゲートを残さない');
  }
  const back = shown({ path: 'a', content: '日本語\\"\n'.repeat(3000) }, 2000);
  assert.equal(back.path, 'a');
  shown('\\"'.repeat(5000), 2000);
});

test('B1: 鍵らしいオブジェクトのキーも伏せる（縮めてもキーは残るので）', () => {
  const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789';
  const text = previewJson(redactJsonValue({ content: 'c'.repeat(10_000), env: { [token]: 'v', path: 'p' } }), 2000);
  assert.ok(!text.includes('ghp_'), text.slice(-200));
  assert.deepEqual(JSON.parse(text).env, { '[REDACTED]': 'v', path: 'p' });
  const two = redactJsonValue({ [token]: 'one', [`${token}9`]: 'two' });
  assert.deepEqual(two, { '[REDACTED]': 'one', '[REDACTED] (2)': 'two' }, '伏せたキーが重なっても値を落とさない');
  const literal = redactJsonValue({ '[REDACTED]': 'literal', [token]: 'hidden-value', '[REDACTED] (2)': 'also' }) as Record<string, string>;
  assert.deepEqual(Object.values(literal).sort(), ['also', 'hidden-value', 'literal'], '入力にもとからある同じ名前のキーも落とさない');
  assert.equal(literal['[REDACTED]'], 'literal');
  assert.ok(!JSON.stringify(literal).includes('ghp_'));
});

test('B1: どうしても収まらないときは JSON の文字列', () => {
  assert.equal(JSON.parse(previewJson({ ['k'.repeat(100)]: 1 }, 10)), '…');
});
