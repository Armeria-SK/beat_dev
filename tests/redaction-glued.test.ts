import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactJsonValue, redactSecrets, sanitizeModelInputText } from '../src/shared/redaction.ts';

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

// くっついた鍵の形は、名前で値を伏せる決まり（代入・旗・URL の引数名・JSON の鍵）が名前を読んだあとに当てる。
// 先に当てると、`task-proj-db-password` のような名前の `sk-proj-db-password` の所を食べて、名前で伏せる決まりが働かず、値が出る
const VALUE = 'hunter2pass';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

test('くっついた鍵: 名前の中に sk-proj- などを含む名前でも、名前で伏せる決まりが値を伏せる（代入・旗・URL の引数名・JSON の鍵）', () => {
  const cases: Array<[string, string]> = [
    [`task-proj-db-password=${VALUE}`, 'ta[REDACTED]=[REDACTED]'],
    [`--task-proj-access-token ${VALUE}`, '--ta[REDACTED] [REDACTED]'],
    [`https://h/cb?task-proj-api-token=${VALUE}&x=1`, 'https://h/cb?ta[REDACTED]=[REDACTED]&x=1'],
    [`{"desk-ant-api-secret": "${VALUE}"}`, '{"de[REDACTED]": [REDACTED]}'],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    assert.equal(out.includes(VALUE), false, `値が残っている: ${input} -> ${out}`);
    assert.equal(out, expected, input);
  }
});

test('くっついた鍵: 名前 × 書き方のどの組み合わせでも、値は残らない', () => {
  const heads = ['task-proj-', 'desk-ant-', 'disk-proj-', 'task-svcacct-', 'xsk-ant-', 'my-task-proj-'];
  const tails = ['db-password', 'access-token', 'api-token', 'api-secret', 'client-secret', 'auth-token'];
  const shapes: Array<(name: string) => string> = [
    name => `${name}=${VALUE}`,
    name => `${name}: ${VALUE}`,
    name => `export ${name}=${VALUE} && run`,
    name => `--${name} ${VALUE}`,
    name => `--${name}=${VALUE}`,
    name => `curl https://h/cb?${name}=${VALUE}&x=1`,
    name => `https://h/cb?x=1&${name}=${VALUE}#frag`,
    name => `{"${name}": "${VALUE}"}`,
    name => `{"a": 1, "${name}":"${VALUE}"}`,
  ];
  let checked = 0;
  for (const head of heads) {
    for (const tail of tails) {
      for (const shape of shapes) {
        const input = shape(`${head}${tail}`);
        const out = redactSecrets(input);
        assert.equal(out.includes(VALUE), false, `値が残っている: ${input} -> ${out}`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, heads.length * tails.length * shapes.length);
  const asJson = JSON.stringify(redactJsonValue({ 'task-proj-db-password': VALUE, nested: { 'desk-ant-api-secret': VALUE } }));
  assert.equal(asJson.includes(VALUE), false, asJson);
});

test('くっついた鍵: JWT の頭に鍵の頭がくっついていても、JWT の中身（payload・署名）は残らない', () => {
  const payload = JWT.split('.')[1]!;
  const signature = JWT.split('.')[2]!;
  const cases: Array<[string, string]> = [
    [`xsk-proj-${JWT}`, 'xsk-proj-[REDACTED]'],
    [`task-ant-${JWT}`, 'task-ant-[REDACTED]'],
    [`see tokensk-ant-api03-${JWT} end`, 'see tokensk-ant-api03-[REDACTED] end'],
    [`xsk-svcacct-${JWT}`, 'xsk-svcacct-[REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    assert.equal(out.includes(payload), false, `payload が残っている: ${out}`);
    assert.equal(out.includes(signature), false, `署名が残っている: ${out}`);
    assert.equal(out, expected, input);
    const sanitized = sanitizeModelInputText(input);
    assert.equal(sanitized.text.includes(payload), false, sanitized.text);
    assert.equal(sanitized.text.includes(signature), false, sanitized.text);
    assert.ok(sanitized.redaction_count >= 1, '数は残る（断る確かめが働く）');
  }
});

test('くっついた鍵: sanitizeModelInputText だけでも、くっついた鍵を伏せて数に入れる（断る確かめが働く）', () => {
  assert.deepEqual(sanitizeModelInputText(`xsk-ant-api03-${TAIL}`), { text: 'x[REDACTED]', redaction_count: 1 });
  assert.deepEqual(sanitizeModelInputText(`Bearer abc12345 and tokensk-proj-${TAIL} and xghp_${GH36}`), { text: '[REDACTED] and token[REDACTED] and x[REDACTED]', redaction_count: 3 });
  assert.equal(sanitizeModelInputText(`task-proj-db-password=${VALUE}`).redaction_count, 1, '名前に sk-proj- を含む語も、数えて断る向き（伏せる側）は今のまま');
  assert.equal(sanitizeModelInputText('plain text with task-ant-abc and disk-partition-tool').redaction_count, 0);
  assert.equal(redactSecrets(`line one\nxsk-proj-${TAIL}\nline three`, [], { keepLines: true }), 'line one\nx[REDACTED]\nline three');
});

// 広げた URL の読み方（user に [REDACTED] の印が入っていても読む）は、今までの伏せ方がすべて終わったあとの最後にだけ当てる。
// 先に当てると、あとの伏せ方が読む文字（`token=@value` の代入など）を password として食べてしまい、その先の値が残る
test('くっついた鍵: 広げた URL の読み方が、あとの伏せ方の読む文字を食べない（今までの出力に足すだけ）', () => {
  assert.equal(redactSecrets('a://sk-AAAAAAAAAA:token=@value12345 x'), 'a://[REDACTED]:token=[REDACTED] x');
  const nested = redactSecrets('a://sk-AAAAAAAAAA:zz://u:pw@SECRETPART@y');
  assert.equal(nested.includes('SECRETPART'), false, nested);
  assert.equal(nested.includes('pw@'), false, nested);
  assert.equal(nested, 'a://[REDACTED]:[REDACTED]@y');
  assert.equal(redactSecrets('a://sk-AAAAAAAAAA:pw@h'), 'a://[REDACTED]:[REDACTED]@h', '今までは password が残っていた形。広げた読み方が、最後に足す');
});

test('くっついた鍵: 鍵の無い URL の出力は、今までの出力と同じ（user に印が無ければ広げた読み方は何も足さない）', () => {
  const sameAsBefore: Array<[string, string]> = [
    ['a://u:pw@h', 'a://u:[REDACTED]@h'],
    ['a://u:pw@h:99/x', 'a://u:[REDACTED]@h:99/x'],
    ['https://a:8080@x', '[REDACTED]x'],
    ['a://u:@h', 'a://u:@h'],
    ['x://user:p@ss@host/db', 'x://user:[REDACTED]@host/db'],
    ['a://:pw@h', 'a://:[REDACTED]@h'],
    ['ftp://anon:anon@ftp.example.com/pub', 'ftp://anon:[REDACTED]@ftp.example.com/pub'],
    ['redis://:s3cr3t@cache:6379/0', 'redis://:[REDACTED]@cache:6379/0'],
    ['a://u:token=@value12345 x', 'a://u:[REDACTED]@value12345 x'],
    ['see a://u:pw@h and b://v:qq@i', 'see a://u:[REDACTED]@h and b://v:[REDACTED]@i'],
    ['postgres://u:pw%40x@h/db', 'postgres://u:[REDACTED]@h/db'],
  ];
  for (const [input, expected] of sameAsBefore) assert.equal(redactSecrets(input), expected, input);
});
