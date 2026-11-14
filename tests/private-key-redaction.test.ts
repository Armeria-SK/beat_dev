import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, sanitizeModelInputText } from '../src/shared/redaction.ts';

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const LINE1 = 'FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEY0001';
const LINE2 = 'NOTAREALKEYNOTAREALKEYNOTAREALKEYNOTAREALKEYNOTAREALKEYNOTAREAL0002';
const LINE3 = 'TESTONLYTESTONLYTESTONLYTESTONLYTESTONLYTESTONLYTESTONLYTESTONL0003';

const hidden = (text: string): void => {
  for (const line of [LINE1, LINE2, LINE3]) assert.ok(!text.includes(line), text);
  assert.ok(!text.includes('PRIVATE KEY'), text);
};

test('秘密鍵: END の無い BEGIN（head -3 の出力）でも中身を伏せ、空行のあとの文は残す', () => {
  const text = redactSecrets(`$ head -3 id_rsa\n\n${BEGIN}\n${LINE1}\n${LINE2}\n\n[stderr]\nwarn`);
  hidden(text);
  assert.equal(text, '$ head -3 id_rsa\n\n[REDACTED]\n\n[stderr]\nwarn');
});

test('秘密鍵: 文の終わりで切れた BEGIN と中身（END なし）は終わりまで伏せる', () => {
  const out = sanitizeModelInputText(`Here is the key:\n${BEGIN}\n${LINE1}\n${LINE2}`);
  hidden(out.text);
  assert.equal(out.text, 'Here is the key:\n[REDACTED]');
  assert.equal(out.redaction_count, 1);
});

test('秘密鍵: BEGIN と同じ行に続く中身（END なし）も伏せる', () => {
  const text = redactSecrets(`grep -A2 BEGIN id_rsa: ${BEGIN} ${LINE1} ${LINE2}\n\nafter`);
  hidden(text);
  assert.equal(text, 'grep -A2 BEGIN id_rsa: [REDACTED]\n\nafter');
});

test('秘密鍵: 暗号化した鍵の見出し（Proc-Type・DEK-Info）と空行のあとの中身も、END が無くても伏せる', () => {
  const text = redactSecrets(`${BEGIN}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00000000000000000000000000000000\n\n${LINE1}\n${LINE2}\n\nafter`);
  hidden(text);
  assert.equal(text, '[REDACTED]\n\nafter');
});

test('秘密鍵: BEGIN の無い中身 + END（tail の出力）は、その段落の中身を伏せ、前の段落は残す', () => {
  const text = redactSecrets(`$ tail -3 id_rsa\n\n(bash, cwd: /w, exit code: 0, 0.1 s)\n\n${LINE2}\n${LINE3}\n${END}\nafter`);
  hidden(text);
  assert.equal(text, '$ tail -3 id_rsa\n\n(bash, cwd: /w, exit code: 0, 0.1 s)\n\n[REDACTED]\nafter');
});

test('秘密鍵: CRLF の改行でも、END の無い鍵と BEGIN の無い鍵を伏せる', () => {
  const open = redactSecrets(`${BEGIN}\r\n${LINE1}\r\n${LINE2}\r\n\r\nafter`);
  hidden(open);
  assert.equal(open, '[REDACTED]\r\n\r\nafter');
  const tail = redactSecrets(`before\r\n\r\n${LINE2}\r\n${END}\r\nafter`);
  hidden(tail);
  assert.equal(tail, 'before\r\n\r\n[REDACTED]\r\nafter');
});

test('秘密鍵: そろった鍵は今までどおり 1 つに伏せ、前後の文は残す', () => {
  const out = sanitizeModelInputText(`before\n${BEGIN}\n${LINE1}\n${END}\nafter`);
  assert.equal(out.text, 'before\n[REDACTED]\nafter');
  assert.equal(out.redaction_count, 1);
});

test('秘密鍵: 印の無いふつうの文はそのまま。印を書いただけのコードは、その段落だけを伏せる', () => {
  const plain = 'const key = readFileSync(path);\n\nMIIE is how an RSA key often starts, and END is a word.';
  assert.equal(redactSecrets(plain), plain);
  const code = `const begin = '${BEGIN}';\nconst x = 1;\n\nfunction next() { return 2; }`;
  assert.equal(redactSecrets(code), "const begin = '[REDACTED]\n\nfunction next() { return 2; }");
});

test('秘密鍵: END の無い鍵が 2 つ続いても（head で 2 つのファイル）、2 つ目の BEGIN と中身も伏せる', () => {
  const out = sanitizeModelInputText(`==> a.txt <==\n${BEGIN}\n${LINE1}\n${LINE2}\n\n==> b.txt <==\n${BEGIN}\n${LINE3}\n${LINE1}x`);
  hidden(out.text);
  assert.equal(out.text, '==> a.txt <==\n[REDACTED]\n\n==> b.txt <==\n[REDACTED]');
  assert.equal(out.redaction_count, 2);
});

test('秘密鍵: 差分の中で空の文脈の行をはさんで END の無い鍵が 2 つあっても、どちらの中身も伏せる', () => {
  const text = redactSecrets(`@@ -1,7 +1,7 @@\n-${BEGIN}\n-${LINE1}\n \n+${BEGIN}\n+${LINE2}\n+${LINE3}`);
  hidden(text);
  assert.equal(text, '@@ -1,7 +1,7 @@\n-[REDACTED]\n \n+[REDACTED]');
});

test('秘密鍵: 印を 1 つ書いただけの文も、伏せた 1 件として数える（注意深い向き。記録や計画の書き込みの関門は、これを鍵らしい文として断る）', () => {
  for (const marker of [BEGIN, END]) {
    const out = sanitizeModelInputText(`The file starts with ${marker}`);
    assert.equal(out.redaction_count, 1, marker);
    assert.ok(!out.text.includes('PRIVATE KEY'), out.text);
  }
});
