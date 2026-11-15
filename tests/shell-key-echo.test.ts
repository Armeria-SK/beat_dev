import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/shared/redaction.ts';
import { shellTranscript } from '../src/tools/builtin/shell.ts';

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
const HEADER = '(bash, cwd: /w, exit code: 1, 0.1 s)';
const shown = (command: string, body: string[]): string => redactSecrets(shellTranscript(command, HEADER, body));

test('shell の結果: コマンドに秘密鍵の BEGIN の印があっても、本物の見出し（終了コード）は伏せ字に食われず、出力の鍵は伏せる', () => {
  const text = shown(`grep -A3 -- "${BEGIN}" deploy/id_rsa`, [`${BEGIN}\n${BODY}\n${END}\n\n(bash, cwd: /w, exit code: 0, 0.1 s)`]);
  assert.ok(text.includes(HEADER), text);
  assert.ok(!text.includes(BODY), text);
  assert.ok(!text.includes('PRIVATE KEY'), text);
  assert.ok(text.startsWith('$ grep -A3 -- "[REDACTED]" deploy/id_rsa\n\n'), text);
});

test('shell の結果: コマンドに BEGIN の印があり、出力が BEGIN なしで鍵の中身と END を出すときも、中身は今までどおり伏せる', () => {
  const text = shown(`awk '/${BEGIN}/{f=1;next} f' id_rsa`, [`${BODY}\n${END}\nafter`, `[stderr]\nwarn`]);
  assert.ok(text.includes(HEADER), text);
  assert.ok(!text.includes(BODY), text);
  assert.ok(text.endsWith('\nafter\n\n[stderr]\nwarn'), text);
});

test('shell の結果: コマンドに鍵そのもの（BEGIN から END まで）があれば写しの中で伏せ、出力はそのまま', () => {
  const command = `printf '%s' "${BEGIN}\n${BODY}\n${END}" > k.pem`;
  const text = shown(command, [`${BODY.slice(0, 4)} plain output\n\n${END}`]);
  assert.ok(text.includes(HEADER), text);
  assert.ok(!text.includes(BODY), text);
  assert.ok(text.includes('plain output'), text);
  const raw = shellTranscript(command, HEADER, [`${BODY.slice(0, 4)} plain output\n${END}`]);
  assert.ok(raw.endsWith(`\n\n${BODY.slice(0, 4)} plain output\n${END}`), raw);
});

test('shell の結果: 印の無いコマンドは、今までと同じ並び（写し・見出し・出力）', () => {
  assert.equal(shellTranscript('echo hi', HEADER, ['hi', '[stderr]\nwarn']), `$ echo hi\n\n${HEADER}\n\nhi\n\n[stderr]\nwarn`);
  assert.equal(shellTranscript('true', HEADER, []), `$ true\n\n${HEADER}`);
  const text = shown(`grep -c -- "${BEGIN}" f`, ['0']);
  assert.equal(text, `$ grep -c -- "[REDACTED]" f\n\n${HEADER}\n\n0`);
});
