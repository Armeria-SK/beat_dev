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

test('名前の形: 字数の上限は種類ごと（似ているもの 60、機能と選択肢 80）\u3002全角も NFKC のあとの 1 字で数える', () => {
  assert.equal(codeOf(() => checkLabel('similar', 'a'.repeat(60))), 'ok');
  assert.equal(codeOf(() => checkLabel('similar', 'a'.repeat(61))), 'label_long');
  assert.equal(codeOf(() => checkLabel('feature', 'あ'.repeat(80))), 'ok');
  assert.equal(codeOf(() => checkLabel('feature', 'あ'.repeat(81))), 'label_long');
  assert.equal(codeOf(() => checkLabel('choice', 'b'.repeat(81))), 'label_long');
});

test('名前の形: 全角の記号も NFKC のあとで確かめる（＄・；・｜・＜）', () => {
  for (const label of ['run ＄(x)', 'a；b', 'a｜b', '＜script']) assert.notEqual(codeOf(() => checkLabel('feature', label)), 'ok', label);
});

test('名前の形: URL やドメインらしい形を断る（パスの始まり・スキーム・@ホスト・//ホスト・パスつき IPv4・全角の句点）', () => {
  const cases = [
    'example.com?x=1', 'example.com#top', 'example.com:8080', `example.com${String.fromCharCode(92)}path`,
    'mailto:me', 'javascript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:c', 'ms-settings:privacy',
    'mail user@evil.example', 'go //evil', '10.0.0.1/admin', '192.168.1.1:80/x', 'example\u3002com/x', 'example\u3002com?x',
  ];
  for (const label of cases) for (const kind of ['similar', 'feature'] as const) assert.equal(codeOf(() => checkLabel(kind, label)), 'label_url', `${kind} ${JSON.stringify(label)}`);
});

test('名前の形: 裸のドメイン（よくある TLD）は機能と選択肢の名前だけで断り、似ているものと部品の名前（ASP.NET・Socket.IO・draw.io）は通す', () => {
  for (const label of ['visit evil.com', 'Sync with notes.io', 'see x.ai', 'Get it at shop.co', 'open bad.xyz', 'site.jp', 'notes\u3002com']) {
    assert.equal(codeOf(() => checkLabel('feature', label)), 'label_url', label);
    assert.equal(codeOf(() => checkLabel('choice', label)), 'label_url', label);
  }
  for (const label of ['ASP.NET', 'Socket.IO', 'draw.io', 'Vue.js', 'evil.com']) {
    assert.equal(codeOf(() => checkLabel('similar', label)), 'ok', label);
    assert.equal(codeOf(() => checkLabel('library', label)), 'ok', label);
  }
  for (const label of ['Export to PDF', 'Node.js support', 'Step 2. Configure', 'v1.2 format']) assert.equal(codeOf(() => checkLabel('feature', label)), 'ok', label);
});

test('名前の形: 見えない文字（私用領域・サロゲート・未割り当て・異体字セレクタ・ハングルの埋め字・点字の空白）を断る', () => {
  for (const label of ['a\u{E000}b', 'a\uD800b', 'a\u{0378}b', 'a\u{E0100}b', 'a\u3164b', 'a\u1160b', 'a\u2800b', 'a\u{E0041}b', 'a\u115Fb', 'a\u034Fb', 'a\uFE00b', 'a\u17B4b']) {
    assert.equal(codeOf(() => checkLabel('feature', label)), 'label_control', JSON.stringify(label));
  }
});

test('名前の形: = でつないだ鍵らしい代入（api_key=…・token=…）は断り、「Password: …」のような見出しの形の名前は通す', () => {
  for (const label of ['api_key=abcd1234efgh', 'token=0123456789abcdef', 'Set api_key=abcd1234efgh here']) assert.equal(codeOf(() => checkLabel('feature', label)), 'label_secret', label);
  for (const label of ['Auth: OAuth login', 'Password: reset by email', 'Token: refresh on expiry', 'Cookie: consent banner', 'Login with --password flag', 'Theme=dark mode']) assert.equal(codeOf(() => checkLabel('feature', label)), 'ok', label);
});

test('名前の形: 語のあとの「:」「?」「#」は、続けて文字があるときだけ URL とみなす（ふつうの名前は通す）', () => {
  for (const label of ['Data: import', 'File: export to PDF', 'Git: commit history', 'HTTP: client', 'Use Node.js?', 'Python 3.12?', 'Node.js: support', 'v1.10: new API']) {
    assert.equal(codeOf(() => checkLabel('feature', label)), 'ok', label);
  }
  for (const label of ['example.com?x=1', 'example.com#top', 'example.com:8080', `example.com${String.fromCharCode(92)}path`, 'example.com/x', 'data:text/html', 'git:repo']) {
    assert.equal(codeOf(() => checkLabel('similar', label)), 'label_url', label);
  }
});

test('名前の形: 裸のドメインの決まりは機能の名前と問いだけで、選択肢（option）には効かない', () => {
  for (const label of ['Socket.IO', 'ASP.NET Core', 'draw.io export']) {
    assert.equal(codeOf(() => checkLabel('option', label)), 'ok', label);
    assert.equal(codeOf(() => checkLabel('choice', label)), 'label_url', label);
    assert.equal(codeOf(() => checkLabel('feature', label)), 'label_url', label);
  }
  assert.equal(codeOf(() => checkLabel('option', 'example.com/x')), 'label_url');
});
