import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// 画面は外から何も読み込まない（書体・画像・CSS）。web/src の CSS・.tsx と web/index.html に、外の URL を読む書き方が無いこと。

const WEB = join(import.meta.dirname, '..', 'web');

const REMOTE = [
  /url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//giu,
  /@import\s+(?:url\(\s*)?['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//giu,
  /<link\b[^>]*\bhref\s*=\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//giu,
  /fonts\.(?:googleapis|gstatic)\.com/giu,
];

function remoteLoads(text: string): string[] {
  return REMOTE.flatMap(pattern => [...text.matchAll(pattern)].map(m => m[0]));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(?:css|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

test('見張りの式が外の読み込みを見つける（見張りそのものの確かめ）', () => {
  assert.equal(remoteLoads('a { background: url(https://example.com/a.png) }').length, 1);
  assert.equal(remoteLoads("a { background: url( '//cdn.example/a.png') }").length, 1);
  assert.equal(remoteLoads('@import url("https://fonts.googleapis.com/css2?family=X");').length, 3);
  assert.equal(remoteLoads("@import 'http://example.com/x.css';").length, 1);
  assert.equal(remoteLoads('<link rel="stylesheet" href="https://example.com/x.css">').length, 1);
  assert.deepEqual(remoteLoads('a { background: url(data:image/png;base64,AAAA) } @import "./local.css"; <link href="/icon.svg">'), []);
});

test('web/src の CSS・.tsx と web/index.html に、外の URL を読む書き方が無い', () => {
  const files = [...walk(join(WEB, 'src')), join(WEB, 'index.html')];
  assert.ok(files.some(f => f.endsWith(join('ui', 'styles', 'bundle.css'))), '新しい画面の CSS を読めていない');
  assert.ok(files.some(f => f.endsWith(join('ui', 'main.tsx'))), '新しい画面の入口を読めていない');
  const hits = files.flatMap(file => remoteLoads(readFileSync(file, 'utf8')).map(hit => `${file.slice(WEB.length + 1)}: ${hit}`));
  assert.deepEqual(hits, []);
});
