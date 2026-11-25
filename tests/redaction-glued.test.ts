import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, sanitizeModelInputText } from '../src/shared/redaction.ts';

// 伏せ字の形の鍵が、前に語の文字がくっついていても残らない（`x` + `sk-ant-api03-…`）。
// ふつうの語（disk-…・task-…）は今のまま伏せない。
// 鍵らしい形の見本は、実在しない作り物（長さと頭だけ本物の形）を使う

const TAIL = 'abcdefghijkl';
const GH36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

test('くっついた鍵: 前に語の文字がある sk-ant- / sk-proj- / sk-or-v1- / sk-svcacct- の鍵を伏せる', () => {
  for (const head of ['sk-ant-api03-', 'sk-proj-', 'sk-or-v1-', 'sk-svcacct-']) {
    for (const glue of ['x', 'token', 'key=', 'abc']) {
      const input = `${glue}${head}${TAIL}`;
      const out = redactSecrets(input);
      assert.equal(out.includes(TAIL), false, `${input} -> ${out}`);
      assert.equal(out.includes('[REDACTED]'), true, `${input} -> ${out}`);
    }
  }
  assert.equal(redactSecrets(`xsk-ant-api03-${TAIL}`), 'x[REDACTED]', 'くっついた前の文字は残る');
  assert.equal(redactSecrets(`tokensk-proj-${TAIL}`), 'token[REDACTED]');
});

test('くっついた鍵: 前に語の文字がある ghp_ などの 36 字以上の鍵を伏せる', () => {
  for (const kind of ['p', 'o', 'u', 's', 'r']) {
    const input = `xgh${kind}_${GH36}`;
    const out = redactSecrets(input);
    assert.equal(out.includes(GH36.slice(4)), false, `${input} -> ${out}`);
    assert.equal(out, 'x[REDACTED]');
  }
  assert.equal(sanitizeModelInputText(`xghp_${GH36}`).redaction_count, 1);
});

test('くっついた鍵: 今伏せている形（頭に境目がある鍵）は今のまま伏せる', () => {
  assert.equal(redactSecrets(`sk-ant-api03-${TAIL}`), '[REDACTED]');
  assert.equal(redactSecrets(`key sk-proj-${TAIL} end`), 'key [REDACTED] end');
  assert.equal(redactSecrets(`ghp_${GH36.slice(0, 20)}`), '[REDACTED]', '20 字の ghp_ は今まで伏せていた');
  assert.equal(redactSecrets(`x sk-ant-api03-${TAIL}`), 'x [REDACTED]');
  assert.equal(redactSecrets(`sk-${TAIL}`), '[REDACTED]');
  assert.equal(redactSecrets(`or-v1-${TAIL}`), '[REDACTED]');
});

test('くっついた鍵: ふつうの語・短すぎる形は伏せない', () => {
  const plain = [
    'disk-partition-tool',
    'task-runner-config',
    'ghp_short',
    'xghp_short',
    'xghp_' + GH36.slice(0, 20),
    'risk-assessment-report',
    'desk-lamp-setup',
    'mask-ant-config',
    'task-ant-abc',
    'task-ant-api03',
    'task-ant-colony',
    'task-proj-config',
    'tusk-project-plan',
    'asksk-ant',
    'xsk-ant-short',
    'xsk-proj-abc',
    'basksk-proj-12',
    'ask-or-v1',
    'tasksk-svcacct-1',
    'The sk-ant prefix is used by one vendor.',
  ];
  for (const text of plain) assert.equal(redactSecrets(text), text, text);
});

test('くっついた鍵: ふつうの文の中の sk で終わる語・sk- を含む語は今のまま', () => {
  const text = 'Run the disk check, then the task list; ask the risk team about the desk-side tasks and ghp_ prefixes.';
  assert.equal(redactSecrets(text), text);
  assert.equal(sanitizeModelInputText(text).redaction_count, 0);
});
