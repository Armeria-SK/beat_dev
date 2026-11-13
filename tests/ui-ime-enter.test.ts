import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const UI = join(import.meta.dirname, '..', 'web', 'src', 'ui');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function unguardedEnter(text: string): number[] {
  const lines = text.split(/\r?\n/u);
  const out: number[] = [];
  lines.forEach((line, index) => {
    if (!/key [!=]== 'Enter'/u.test(line)) return;
    if (/ctrlKey|metaKey|key === ' '/u.test(line)) return;
    const near = lines.slice(Math.max(0, index - 5), index + 1).join('\n');
    if (!/isComposing\(/u.test(near)) out.push(index + 1);
  });
  return out;
}

test('ui: 文字を打つ欄の Enter は、日本語の変換中なら何もしない（変換を確定する Enter で保存・送信しない）', () => {
  const misses = tsxFiles(UI).flatMap(file => unguardedEnter(readFileSync(file, 'utf8')).map(line => `${relative(UI, file)}:${line}`));
  assert.deepEqual(misses, []);
});

test('ui: 変換中の見張りは、確かめの無い Enter を見つけ、Ctrl+Enter とボタンの Enter・Space は数えない', () => {
  assert.deepEqual(unguardedEnter("onKeyDown={e => { if (e.key === 'Enter') save(); }}"), [1]);
  assert.deepEqual(unguardedEnter("onKeyDown={e => { if (e.key === 'Enter' && !isComposing(e)) save(); }}"), []);
  assert.deepEqual(unguardedEnter("if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();"), []);
  assert.deepEqual(unguardedEnter("if (e.key === 'Enter' || e.key === ' ') toggle();"), []);
  assert.deepEqual(unguardedEnter("onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); }}"), [1]);
});
