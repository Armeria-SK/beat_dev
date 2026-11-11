import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// 画面は外から何も読み込まない（書体・画像・CSS）。web/src の CSS・.ts・.tsx と web/index.html に、外の URL を読む書き方が無いこと（コメントは除く）。

const WEB = join(import.meta.dirname, '..', 'web');

const REMOTE_URL = String.raw`(?:[a-z][a-z0-9+.-]*:)?\/\/`;
const REMOTE = [
  new RegExp(String.raw`url\(\s*['"]?\s*${REMOTE_URL}`, 'giu'),
  new RegExp(String.raw`@import\s+(?:url\(\s*)?['"]?\s*${REMOTE_URL}`, 'giu'),
  new RegExp(String.raw`\b(?:src|href|srcSet|srcset|poster|data)\s*=\s*\{?\s*['"\x60]\s*${REMOTE_URL}`, 'giu'),
  /fonts\.(?:googleapis|gstatic)\.com/giu,
];

function withoutComments(text: string, script: boolean): string {
  const blocks = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/<!--[\s\S]*?-->/gu, '');
  if (!script) return blocks;
  return blocks.split(/\r?\n/u).filter(line => !/^\s*\/\//u.test(line)).join('\n');
}

function remoteLoads(text: string, script = false): string[] {
  const code = withoutComments(text, script);
  return REMOTE.flatMap(pattern => [...code.matchAll(pattern)].map(m => m[0]));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(?:css|tsx?)$/u.test(entry.name) ? [path] : [];
  });
}

test('見張りの式が外の読み込みを見つける（見張りそのものの確かめ）', () => {
  assert.equal(remoteLoads('a { background: url(https://example.com/a.png) }').length, 1);
  assert.equal(remoteLoads("a { background: url( '//cdn.example/a.png') }").length, 1);
  assert.equal(remoteLoads('@import url("https://fonts.googleapis.com/css2?family=X");').length, 3);
  assert.equal(remoteLoads("@import 'http://example.com/x.css';").length, 1);
  assert.equal(remoteLoads('<link rel="stylesheet" href="https://example.com/x.css">').length, 1);
  assert.equal(remoteLoads('<img src="https://example.com/a.png" alt="" />').length, 1);
  assert.equal(remoteLoads('a { background: url(//cdn.example/a.png) }').length, 1);
  assert.equal(remoteLoads('a { background: url( //cdn.example/a.png) }').length, 1);
  assert.equal(remoteLoads('@import url(//cdn.example/x.css);').length, 2);
  assert.equal(remoteLoads("<img src={'//cdn.example/a.png'} />", true).length, 1);
  assert.equal(remoteLoads('const el = <a href=`http://example.com`>x</a>;', true).length, 1);
  assert.equal(remoteLoads('const css = `a { background: url(//cdn.example/a.png) }`;', true).length, 1);
  assert.deepEqual(remoteLoads([
    'a { background: url(data:image/png;base64,AAAA) } @import "./local.css"; <link href="/icon.svg">',
    '/* @import url("https://example.com/x.css"); */',
  ].join('\n')), []);
  assert.deepEqual(remoteLoads([
    '<img src={src} /> <a href={href}>x</a>',
    '// <img src="https://example.com/in-a-comment.png">',
    '/* @import url("https://example.com/x.css"); */',
    "const placeholder = 'https://…';",
  ].join('\n'), true), []);
});

test('web/src の CSS・.ts・.tsx と web/index.html に、外の URL を読む書き方が無い', () => {
  const files = [...walk(join(WEB, 'src')), join(WEB, 'index.html')];
  assert.ok(files.some(f => f.endsWith(join('ui', 'styles', 'bundle.css'))), '新しい画面の CSS を読めていない');
  assert.ok(files.some(f => f.endsWith(join('ui', 'main.tsx'))), '新しい画面の入口を読めていない');
  assert.ok(files.some(f => f.endsWith(join('ui', 'theme.ts'))), '.ts を読めていない');
  const hits = files.flatMap(file => remoteLoads(readFileSync(file, 'utf8'), /\.tsx?$/u.test(file)).map(hit => `${file.slice(WEB.length + 1)}: ${hit}`));
  assert.deepEqual(hits, []);
});
