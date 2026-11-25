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

// 鍵を伏せた [REDACTED] の印が、あとの URL の user の読み方（URL_USERINFO_PASSWORD）を切らない。
// 切れると、user に鍵がくっついた URL の password が、前は伏せていたのに出てしまう
const PASSWORD = 'hunter2pass';
const A16 = 'AAAAAAAAAAAAAAAA';

test('くっついた鍵: URL の user に鍵がくっついていても password は伏せる（redactSecrets）', () => {
  const cases: Array<[string, string]> = [
    [`postgres://xsk-proj-${A16}:${PASSWORD}@db/app`, 'postgres://x[REDACTED]:[REDACTED]@db/app'],
    [`redis://tokensk-ant-api03-${A16}:${PASSWORD}@cache`, 'redis://token[REDACTED]:[REDACTED]@cache'],
    [`ftp://userghp_${GH36}:${PASSWORD}@h/`, 'ftp://user[REDACTED]:[REDACTED]@h/'],
    [`postgres://sk-proj-${A16}:${PASSWORD}@db/app`, 'postgres://[REDACTED]:[REDACTED]@db/app'],
    [`amqp://sk-or-v1-${A16}:${PASSWORD}@mq`, 'amqp://[REDACTED]:[REDACTED]@mq'],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    assert.equal(out.includes(PASSWORD), false, `password が残っている: ${input} -> ${out}`);
    assert.equal(out.includes(A16), false, `鍵が残っている: ${input} -> ${out}`);
    assert.equal(out, expected, input);
  }
});

test('くっついた鍵: http(s) の URL は、sanitizeModelInputText だけでも user の鍵と password を残さない', () => {
  const out = sanitizeModelInputText(`see https://xsk-proj-${A16}:${PASSWORD}@db.example/app now`).text;
  assert.equal(out.includes(PASSWORD), false, out);
  assert.equal(out.includes(A16), false, out);
});

test('くっついた鍵: 鍵のない URL の読み方は今のまま（user:password は伏せ、host:port は変えない）', () => {
  assert.equal(redactSecrets('postgres://u:pw@h'), 'postgres://u:[REDACTED]@h');
  assert.equal(redactSecrets('postgres://u:pw@h/db?x=1'), 'postgres://u:[REDACTED]@h/db?x=1');
  assert.equal(redactSecrets('http://a:8080/b'), 'http://a:8080/b');
  assert.equal(redactSecrets('https://example.com:443/path'), 'https://example.com:443/path');
  assert.equal(redactSecrets('ssh://git@example.com:22/repo.git'), 'ssh://git@example.com:22/repo.git');
});

test('くっついた鍵: [REDACTED] が何度も続く入力でも時間は入力の長さに比例する（URL の user の読み方が崩れない）', () => {
  const R = '[REDACTED]';
  const inputs = [
    `postgres://${R.repeat(20_000)}`,
    `postgres://${R.repeat(20_000)}:`,
    `postgres://${R.repeat(20_000)}:pw`,
    R.repeat(40_000),
    `x://${R.repeat(40)}`.repeat(2_000),
    `postgres://${'a'.repeat(100)}${R}`.repeat(1_500),
  ];
  for (const input of inputs) {
    const start = performance.now();
    redactSecrets(input);
    const took = performance.now() - start;
    assert.ok(took < 2_000, `${input.length} 字に ${Math.round(took)}ms かかった`);
  }
});
