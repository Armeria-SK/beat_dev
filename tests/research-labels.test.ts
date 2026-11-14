import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLabel, ResearchError } from '../src/research/labels.ts';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (error) { if (error instanceof ResearchError) return error.code; throw error; }
  return 'ok';
};

test('名前の形: ふつうの名前は通り、NFKC にそろえて前後の空白を外した形を返す', () => {
  assert.equal(checkLabel('feature', '  Markdown preview  '), 'Markdown preview');
  assert.equal(checkLabel('feature', 'Ｔａｂｌｅ ｅｄｉｔｏｒ'), 'Table editor');
  assert.equal(checkLabel('similar', 'Node.js'), 'Node.js');
  assert.equal(checkLabel('feature', 'Export to PDF (A4)'), 'Export to PDF (A4)');
  assert.equal(checkLabel('choice', 'C#'), 'C#');
  assert.equal(checkLabel('feature', '見出しの目次'), '見出しの目次');
});

test('名前の形: 外れを 1 つずつ断る（URL・ドメイン・$( )・改行・制御文字・コード・Markdown のリンクと見出し・HTML・鍵らしい文字）', () => {
  const cases: Array<[string, string]> = [
    ['See https://example.com', 'label_url'],
    ['open example.com/install', 'label_url'],
    ['www.example', 'label_url'],
    ['run $(curl x)', 'label_shell'],
    ['a; rm -rf', 'label_shell'],
    ['a | b', 'label_shell'],
    ['a && b', 'label_shell'],
    ['write > file', 'label_shell'],
    ['line one\nline two', 'label_lines'],
    ['line one\rline two', 'label_lines'],
    ['line one\u2028two', 'label_lines'],
    ['bell\u0007', 'label_control'],
    ['hidden\u200Btext', 'label_control'],
    ['right\u202Eleft', 'label_control'],
    ['use `rm`', 'label_code'],
    ['~~~ fence', 'label_code'],
    ['[click](x)', 'label_markup'],
    ['# Heading', 'label_markup'],
    ['<b>bold', 'label_markup'],
    ['key sk-ant-test-0000000000000000', 'label_secret'],
    ['   ', 'label_empty'],
  ];
  for (const [label, code] of cases) assert.equal(codeOf(() => checkLabel('feature', label)), code, JSON.stringify(label));
});

test('名前の形: 字数の上限は種類ごと（似ているもの 60、機能と選択肢 80）。全角も NFKC のあとの 1 字で数える', () => {
  assert.equal(codeOf(() => checkLabel('similar', 'a'.repeat(60))), 'ok');
  assert.equal(codeOf(() => checkLabel('similar', 'a'.repeat(61))), 'label_long');
  assert.equal(codeOf(() => checkLabel('feature', 'あ'.repeat(80))), 'ok');
  assert.equal(codeOf(() => checkLabel('feature', 'あ'.repeat(81))), 'label_long');
  assert.equal(codeOf(() => checkLabel('choice', 'b'.repeat(81))), 'label_long');
});

test('名前の形: 全角の記号も NFKC のあとで確かめる（＄・；・｜・＜）', () => {
  for (const label of ['run ＄(x)', 'a；b', 'a｜b', '＜script']) assert.notEqual(codeOf(() => checkLabel('feature', label)), 'ok', label);
});
