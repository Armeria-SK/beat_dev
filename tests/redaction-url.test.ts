import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { RunEvent, ToolCall } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { REVIEW_WINDOW_CHARS, reviewWindow } from '../src/memory/review.ts';
import { isSensitiveEnvName, redactExact, redactJsonValue, redactSecrets } from '../src/shared/redaction.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';
import { toolRow } from '../web/src/ui/tool-row.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { CONVERSATION, startApp } from './app-setup.ts';
import { reply, type Script, withLoad } from './helpers.ts';

// 伏せ字（redactSecrets）が、URL の中の秘密（? と & と # のあとの名前、userinfo）と、別の「名前:」のうしろに続く秘密を伏せる。
// 道具に渡した引数は、会話にはそのまま保存し（モデルに戻す中身を変えない）、見せる所・書き出す所で伏せる

// 鍵らしい形（sk- など）だと、ほかの伏せ字の処理に隠れて漏れを見逃すので、どの形にも当たらない文字列を使う
const S1 = 'Qm7xLp2Vt9a';
const S2 = 'Hd4nRw8Kc3b';
const S3 = 'Jf6zTy1Ms5c';

test('伏せ字: 秘密でない「名前:」「名前=」のうしろに続く秘密も伏せる（前の名前が値ごと読み飛ばさない）', () => {
  assert.equal(redactSecrets(`Error: api_key=${S1}`), 'Error: api_key=[REDACTED]');
  assert.equal(redactSecrets(`note: password=${S1} end`), 'note: password=[REDACTED] end');
  assert.equal(redactSecrets(`url=https://x.example/p?v=1 token=${S1}`), 'url=https://x.example/p?v=1 token=[REDACTED]');
  const inJson = redactSecrets(`{"command":"curl -d password=${S1} https://a.example"}`);
  assert.equal(inJson.includes(S1), false, inJson);
  assert.equal(redactSecrets(`api_key=${S1}`), 'api_key=[REDACTED]');
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abcdefgh"'), 'curl -H "Authorization: [REDACTED]', '前からの形は変えない（画面が、道具の結果の写しをこの形で見つける）');
});

test('伏せ字: ふつうの文・URL・コマンドは変えない', () => {
  for (const plain of [
    'https://example.com/@user/x',
    'user@example.com',
    'npm test -- upload',
    'https://example.com:8080/x@y',
    'http://localhost:3000/search?q=a@b&page=2',
    'ssh://git@github.com/owner/repo.git',
    'https://user@host.example/repo.git',
    'https://example.com/list?sort=asc&page=2#section=3',
    'https://example.com/shop?postal_code=1000001&sort_key=price',
    'title: "my file" size=3',
    '{"command":"npm test -- upload","path":"docs/a.md"}',
    'see R&D=5 and Q&A',
    'at 12:30: done',
  ]) assert.equal(redactSecrets(plain), plain);
});

test('伏せ字: JSON の文字列の中に書かれた JSON（名前のあとが \\" になる形。二重に包んだ形も）の秘密を伏せる', () => {
  for (const text of [
    `curl -d '{\\"password\\":\\"${S1}\\"}' https://a.example`,
    `{\\n  \\"api_key\\": \\"${S1}\\"\\n}`,
    `{\\"note\\":\\"x\\",\\"client_secret\\":\\"${S1} ${S2}\\"}`,
    `{\\\\\\"token\\\\\\":\\\\\\"${S1}\\\\\\"}`,
  ]) {
    const out = redactSecrets(text);
    assert.equal(out.includes(S1) || out.includes(S2), false, out);
  }
  assert.equal(redactSecrets('{\\"name\\":\\"report\\",\\"path\\":\\"docs/a.md\\"}'), '{\\"name\\":\\"report\\",\\"path\\":\\"docs/a.md\\"}');
});

test('伏せ字（redactJsonValue）: 値をたどって、文字列は redactSecrets に通し、秘密の名前の下の値は丸ごと伏せる。形（JSON として読めること）は保つ', () => {
  const value = {
    password: S1, n: 1, ok: true, none: null,
    command: `curl -d '{"password":"${S2}"}' https://a.example`,
    content: `{\n  "api_key": "${S3}"\n}`,
    nested: [{ url: `https://x.example/p?token=${S1}&page=2`, auth: { user: 'a', pass: S2 } }],
    double: JSON.stringify({ inner: JSON.stringify({ secret: S3 }) }),
    path: 'docs/a.md',
  };
  const out = redactJsonValue(value) as typeof value;
  const text = JSON.stringify(out);
  for (const mark of [S1, S2, S3]) assert.equal(text.includes(mark), false, text);
  assert.deepEqual(JSON.parse(text), out);
  assert.equal(out.password, '[REDACTED]');
  assert.deepEqual([out.n, out.ok, out.none, out.path], [1, true, null, 'docs/a.md']);
  assert.equal(out.nested[0]!.url, 'https://x.example/p?token=[REDACTED]&page=2');
  assert.equal(out.nested[0]!.auth as unknown, '[REDACTED]');
  assert.equal(out.command, redactSecrets(value.command), '文字列の値は redactSecrets と同じ形（画面が道具の結果の写しと突き合わせる）');
  assert.equal(redactJsonValue(`raw ${S1} token=${S2}`), `raw ${S1} token=[REDACTED]`);
  let deep: unknown = S1;
  for (let i = 0; i < 5000; i++) deep = [deep];
  assert.equal(JSON.stringify(redactJsonValue(deep)).includes(S1), false, '深すぎる入れ子は、たどらずに伏せる');
});

test('伏せ字: 空白のない長い入力（&token=x の並び、伏せたあとの ?token=[REDACTED]& の並び）でも、読む量が長さの 2 乗にならない', () => {
  // 2 乗のときは 1 MB で 1 分を超える。混んだ PC でも落ちないよう、上限は広く取る
  for (const unit of ['&token=x', '?token=[REDACTED]&', '&api_key=[REDACTED]', 'a?token=[REDACTED]"']) {
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const started = performance.now();
    const out = redactSecrets(text);
    const took = performance.now() - started;
    assert.ok(took < 10_000, `${unit}: ${Math.round(took)}ms`);
    assert.equal(out.includes('=x'), false);
  }
});

const LONG = `${S1}${S2}`;
const leaks = (text: string, ...marks: string[]): string[] => { const out = redactSecrets(text); return marks.filter(mark => out.includes(mark)).map(mark => `${mark} in ${out}`); };

const EXACT_ROWS: Array<{ name: string; hidden?: string[]; cases: Array<[string, string, string?]> }> = [
  { name: '伏せ字: URL の ? と & のあとの秘密の名前（access_token・api_key など）の値を伏せ、ほかの値は残す', cases: [
    [`https://x.example/p?access_token=${S1}&api_key=${S2}`, 'https://x.example/p?access_token=[REDACTED]&api_key=[REDACTED]'],
    [`GET /cb?page=2&access_token=${S1}&lang=ja`, 'GET /cb?page=2&access_token=[REDACTED]&lang=ja'],
    [`https://x.example/p?client_secret=${S1}&amp;refresh_token=${S2}`, 'https://x.example/p?client_secret=[REDACTED]&amp;refresh_token=[REDACTED]'],
    [`{"url":"https://x.example/p?token=${S1}&page=2"}`, '{"url":"https://x.example/p?token=[REDACTED]&page=2"}'],
    [`"https://x.example/p?a=1\\u0026token=${S1}"`, '"https://x.example/p?a=1\\u0026token=[REDACTED]"'],
    [`{\\"url\\":\\"https://x.example/p?token=${S1}\\"}`, '{\\"url\\":\\"https://x.example/p?token=[REDACTED]\\"}'],
  ] },
  { name: '伏せ字: URL の # のあと（#access_token=）と、URL でよく秘密を運ぶ名前（key・sig・signature・code）の値を伏せる', cases: [
    [`https://x.example/cb#access_token=${S1}&state=1`, 'https://x.example/cb#access_token=[REDACTED]&state=1'],
    [`https://x.example/p?key=${S1}${S2}&sig=${S2}${S3}&code=${S3}${S1}&v=3`, 'https://x.example/p?key=[REDACTED]&sig=[REDACTED]&code=[REDACTED]&v=3'],
    [`https://s3.example/o?X-Amz-Signature=${S1}&X-Amz-Date=20261112`, 'https://s3.example/o?X-Amz-Signature=[REDACTED]&X-Amz-Date=20261112'],
  ] },
  { name: '伏せ字: URL の userinfo のパスワードを、http 以外の接続先でも、名前が空でも伏せる', cases: [
    [`https://user:${S1}@host.example/x`, '[REDACTED]host.example/x'],
    [`postgres://svc:${S1}@db.example/app`, 'postgres://svc:[REDACTED]@db.example/app'],
    [`redis://:${S1}@db.example:6379`, 'redis://:[REDACTED]@db.example:6379'],
    [`https://:${S1}@host.example/x`, 'https://:[REDACTED]@host.example/x'],
  ] },
  { name: '伏せ字: 値が空白で分かれる形（Authorization: Basic …・--password …・curl -u user:pass・mysql -p…・Cookie: の行）', cases: [
    [`Authorization: Basic ${S1}`, 'Authorization: [REDACTED]'],
    [`Proxy-Authorization: Basic ${S1}\nHost: x`, 'Proxy-Authorization: [REDACTED]\nHost: x'],
    [`curl -H "Authorization: Basic ${S1}" https://a.example`, 'curl -H "Authorization: [REDACTED]" https://a.example'],
    [`tool --password ${S1} --api-key ${S2} run`, 'tool --password [REDACTED] --api-key [REDACTED] run'],
    [`New-Thing -Password "${S1} ${S2}" -Name x`, 'New-Thing -Password [REDACTED] -Name x'],
    [`curl -u admin:${S1} https://a.example`, 'curl -u admin:[REDACTED] https://a.example'],
    [`curl --user "admin:${S1}" https://a.example`, 'curl --user "admin:[REDACTED]" https://a.example'],
    [`mysql -u root -p${S1} app`, 'mysql -u root -p[REDACTED] app'],
    [`mysql -p"${S1} ${S2}" app`, 'mysql -p[REDACTED] app'],
    [`{"command":"tool --token ${S1}"}`, '{"command":"tool --token [REDACTED]"}', 'JSON の閉じの引用符は食わない'],
    [`{"command":"tool --token \\"${S1} ${S2}\\" x"}`, '{"command":"tool --token [REDACTED] x"}'],
    [`Cookie: a=1; sid=${S1}; theme=${S2}\nHost: x`, 'Cookie: [REDACTED]\nHost: x'],
    [`curl -H "Cookie: a=1; b=${S1}" https://a.example`, 'curl -H "Cookie: [REDACTED]" https://a.example'],
  ] },
  { name: '審査 1: Cookie の値が引用符つき・\\ 入りでも、前の版より多く残さない。JSON の閉じの引用符は食わない', cases: [
    ['Set-Cookie: sid="SECRETVAL"; Path=/', 'Set-Cookie: [REDACTED]'],
    ['< Set-Cookie: session="eyJhIjoxfQ.SECRETSIG"; HttpOnly; Path=/', '< Set-Cookie: [REDACTED]'],
    ['Cookie: sid=abc\\def; b=2', 'Cookie: [REDACTED]'],
    ['{"h":"Cookie: a=1; b=2"}', '{"h":"Cookie: [REDACTED]"}'],
    ['{"cookie": "abc", "n": 1}', '{"cookie": [REDACTED], "n": 1}'],
    ['{\\"h\\":\\"Cookie: abc\\"}', '{\\"h\\":\\"Cookie: [REDACTED]\\"}'],
  ] },
  { name: '審査 5: 値が次の行にあっても、次の行が字下げされていれば伏せる。行の頭から始まる次の行は食わない', cases: [
    ['Password:\n  hunter2secret', 'Password:\n  [REDACTED]'],
    ['secret:\r\n  abc', 'secret:\r\n  [REDACTED]'],
    ['Token:\nSECRETVALUE123', 'Token:\nSECRETVALUE123', '行の頭から始まる値は残る（分かっている漏れ）'],
    ['API_KEY=\nabc', 'API_KEY=\nabc'],
  ] },
  { name: '伏せ字: 名前の決まりに足した形（ハイフン入りのヘッダー名・apikey・passphrase・jwt・hmac・oauth_verifier・signing_key・PGPASSWORD・DB_PASS など）', hidden: [
    `X-Api-Key: ${S1}`, `x-auth-token: ${S1}`, `apikey=${S1}`, `APIKEY=${S1}`, `passphrase=${S1}`, `jwt=${S1}`, `hmac=${S1}`, `oauth_verifier=${S1}`, `signing_key=${S1}`,
    `PGPASSWORD=${S1} psql`, `DB_PASS=${S1}`, `MYSQL_PWD=${S1}`, `X-Amz-Credential: ${S1}`, `5-token=${S1}`, `--api-key=${S1}`,
  ], cases: [
    [`curl -H "X-Api-Key: ${S1}" https://a.example`, 'curl -H "X-Api-Key: [REDACTED] https://a.example'],
  ] },
  { name: '伏せ字: URL の中だけで秘密として扱う名前（pwd・pass・sid・otp・sessionId・;jsessionid=）と、名前の形（token[]=・data[token]=・%5F・%3D で包んだ URL・&#38; のあと）', hidden: [
    `https://x.example/p?pwd=${S1}`, `https://x.example/p?a=1&pass=${S1}`, `https://x.example/p?sid=${S1}`, `https://x.example/p?otp=${S1}`, `https://x.example/p?sessionId=${S1}`,
    `https://x.example/p;jsessionid=${S1}?a=1`, `https://x.example/p?token[]=${S1}`, `https://x.example/p?data[token]=${S1}`, `https://x.example/p?data%5Btoken%5D=${S1}`,
    `https://x.example/p?access%5Ftoken=${S1}`, `https://x.example/p?a=1&#38;token=${S1}`, `https://x.example/p?a=1&#x26;token=${S1}`, `https://x.example/p?a.b.token=${S1}`,
    `https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D${S1}%26state%3D1`,
  ], cases: [
    [`https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D${S1}%26state%3D1`, 'https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D[REDACTED]%26state%3D1'],
    [`https://x.example/p;jsessionid=${S1}&a=1`, 'https://x.example/p;jsessionid=[REDACTED]&a=1'],
  ] },
];

for (const row of EXACT_ROWS) {
  test(row.name, () => {
    for (const text of row.hidden ?? []) assert.deepEqual(leaks(text, S1), [], text);
    for (const [input, expected, why] of row.cases) assert.equal(redactSecrets(input), expected, why);
  });
}

test('伏せ字: URL の値の途中に \\/ や引用符があっても、うしろの部分を残さない。JSON の閉じの引用符・& のあとの値・閉じかっこは残す', () => {
  assert.equal(redactSecrets(`{"url":"https:\\/\\/x.example\\/p?token=${S1}\\/${S2}&page=2"}`), '{"url":"https:\\/\\/x.example\\/p?token=[REDACTED]&page=2"}');
  for (const quote of ['"', "'", '`', '<', '>']) assert.equal(redactSecrets(`see x?token=${S1}${quote}${S2} end`), 'see x?token=[REDACTED] end', quote);
  assert.equal(redactSecrets(`<a href="/p?token=${S1}">Link</a>`), '<a href="/p?token=[REDACTED]">Link</a>');
  assert.equal(redactSecrets(`{"url":"https://x.example/p?token=${S1}","n":1}`), '{"url":"https://x.example/p?token=[REDACTED]","n":1}');
  assert.equal(redactSecrets(`[link](https://x.example/p?token=${S1}) next`), '[link](https://x.example/p?token=[REDACTED]) next');
  assert.equal(redactSecrets(`\`https://x.example/p?token=${S1}\`を開く`), '`https://x.example/p?token=[REDACTED]`を開く');
});

test('伏せ字: URL の userinfo で、パスワードに生の @ / ? があっても残さない。パスワードなしの長いトークンも伏せる', () => {
  assert.deepEqual(leaks(`https://user:${S1}@${S2}@host.example/x`, S1, S2), []);
  assert.equal(redactSecrets(`postgres://svc:${S1}@${S2}@db.example/app`), 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(redactSecrets(`postgres://svc:${S1}/${S2}@db.example/app`), 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(redactSecrets(`postgres://svc:${S1}?${S2}@db.example/app`), 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(redactSecrets(`git clone https://${LONG}@github.com/o/r.git`), 'git clone https://[REDACTED]@github.com/o/r.git');
});

test('伏せ字: 伏せすぎない（短い code・key、token_type、コードの断片、ポートつきの URL、uid:gid、終わりの行）', () => {
  for (const plain of [
    'https://x.example/p?code=JP', 'https://x.example/p?code=200&key=value', 'https://x.example/p#key=1', 'token_type=bearer', '{"token_type":"bearer","token_count":12}',
    'a?key=1:2', 'foo&code=1', '[link](#code=1)', 'x;key=1', 'pass=3 fail=0', 'pwd: /home/me', 'sid=5', 'session_id: abc', 'max_tokens: 4096', 'auth_url=https://x.example/login',
    'http://[::1]:8080/a@b', 'file://C:/Users/me/a@b.txt', 'docker://registry:5000/img@sha256:abc', 'docker run -u 1000:1000 img', 'git push -u origin main', 'sort -u file',
    'mkdir -p a/b', 'ssh -p22 host', 'mysql -P3306 -h db', 'tar -pxf a.tar', 'use --verbose to see more', 'sort-key: price', 'https://user@host.example/repo.git',
  ]) assert.equal(redactSecrets(plain), plain);
  assert.equal(redactSecrets(`$ run --password=\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)`), '$ run --password=\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)', '値なしで終わる名前は、次の行を食わない');
  assert.equal(redactSecrets('password=\nnext line'), 'password=\nnext line');
});

const parses = (text: string): boolean => { try { JSON.parse(text); return true; } catch { return false; } };

test('審査 2・3: -u と mysql -p と --flag は、JSON の中の JSON・次の鍵を壊さない', () => {
  const user = redactSecrets(JSON.stringify({ result: JSON.stringify({ cmd: 'curl -u bob:hunter2', y: 1 }) }));
  assert.deepEqual([parses(user), user.includes('hunter2')], [true, false], user);
  const mysql = redactSecrets(JSON.stringify({ result: JSON.stringify({ cmd: 'mysql -uroot -phunter2', y: 1 }) }));
  assert.deepEqual([parses(mysql), mysql.includes('hunter2')], [true, false], mysql);
  for (const text of ['{"cmd":"mysql -u root -p","next":"v"}', '{"cmd":"--token ","next":"v"}']) assert.equal(redactSecrets(text), text);
});

test('審査 4: userinfo の 2 つ目の読み方は、ポートのあとの引用符・カンマ・かっこをまたいで、うしろの @ まで食わない', () => {
  for (const text of ['{"a":"http://h:3000","b":"https://c.d/e","mail":"x@y.z"}', 'origins=http://a:3000,https://b/c,me@x.com', 'see (http://a:3000) and https://b/c me@x.com', 'http://a:3000']) {
    assert.equal(redactSecrets(text), text);
  }
});

test('審査 6: シェルの子に渡す環境変数は、種類・場所を言う名前（…_URL・…_TYPE など）でも、秘密の名前なら渡さない', () => {
  const names = ['AUTH_URL', 'BASIC_AUTH_URL', 'MONGO_AUTH_URI', 'HTTP_PROXY_AUTH_ENDPOINT', 'COOKIE_TTL', 'SESSION_COOKIE_EXPIRES', 'PASSWD_TYPE', 'AUTHORIZATION_TYPE'];
  const source = Object.fromEntries([...names, 'PLAIN_NAME'].map(name => [name, 'v']));
  assert.deepEqual(Object.keys(scrubEnv([...names, 'PLAIN_NAME'], source)).filter(k => k !== 'NoDefaultCurrentDirectoryInExePath'), ['PLAIN_NAME']);
  for (const name of names) assert.equal(isSensitiveEnvName(name), true, name);
});

test('伏せ字（redactJsonValue）: 鍵の名前に空白・. ・[] が入る形、名前と値が別々の所にある形も伏せる。短い文字列はそのまま', () => {
  const out = redactJsonValue({
    'password ': S1, 'x.password': S1, 'data[token]': S1, header: { name: 'password', value: S1 }, env: [{ key: 'API_KEY', value: S1 }],
    headers: [['Authorization', `Basic ${S1}`], ['Accept', 'text/html']], plain: { name: 'title', value: 'hello world' }, tiny: ['a', 'bc', 'k=v'], 'x.path': 'docs/a.md',
  }) as Record<string, unknown>;
  assert.equal(JSON.stringify(out).includes(S1), false, JSON.stringify(out));
  assert.deepEqual(out.header, { name: 'password', value: '[REDACTED]' });
  assert.deepEqual(out.headers, [['Authorization', '[REDACTED]'], ['Accept', 'text/html']]);
  assert.deepEqual([out.plain, out.tiny, out['x.path']], [{ name: 'title', value: 'hello world' }, ['a', 'bc', 'k=v'], 'docs/a.md']);
  assert.equal(redactJsonValue('jwt=x'), 'jwt=[REDACTED]', '短くても = を含む文字列は伏せ字に通す');
});

test('伏せ字: 足した形（ハイフンの並び・--flag の並び・-u・mysql・userinfo・%3D）でも、読む量が長さの 2 乗にならない', () => {
  for (const unit of ['a-', '-', '--password ', '--password "', '-u a', 'mysql ', 'a://b:c/', 'a://b:c', 'https://aaaaaaaaaaaaaaaaaaaaaaaa', '%26a', '?a[b]', 'Cookie: a ', 'Authorization: Basic ', ';a=b"c']) {
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const started = performance.now();
    redactSecrets(text);
    const took = performance.now() - started;
    assert.ok(took < 10_000, `${unit}: ${Math.round(took)}ms`);
  }
  const started = performance.now();
  redactJsonValue(Array.from({ length: 200_000 }, () => 'ab'));
  assert.ok(performance.now() - started < 10_000);
});

test('タスクの実行中の Pending の通知: 本文に入る秘密を伏せる', async t => {
  const s = await startApp(t);
  const task = s.app.tasks.create({ title: 'Needs approval', origin: 'user', actor: 'user' });
  const conversation = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(task.id, 30 * 60_000, conversation.id));
  const body = `curl "https://x.example/p?access_token=${S1}" -d password=${S2}`;
  const row = await s.app.pending.park({ tool: 'shell_run', input: { command: body }, cwd: s.app.paths.data, kind: 'judge', reason: body, check: { decision: 'ask', reasons: [body] }, runId: 'r', runKind: 'task', conversationId: conversation.id, taskId: task.id });
  const note = s.app.notifications.list().find(n => n.kind === 'approval_needed');
  assert.ok(note);
  assert.equal(note.body, `#${row.id} curl "https://x.example/p?access_token=[REDACTED]" -d password=[REDACTED]`);
});

const echoTool: ToolDef = {
  name: 'echo_args', description: 'echo', effect: 'read', allowedIn: ['chat', 'task', 'review'],
  input: Type.Object({ url: Type.String(), remote: Type.String(), command: Type.String(), content: Type.String(), password: Type.String() }, { additionalProperties: false }),
  async execute() { return { content: 'done' }; },
};

function callTool(args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: 'call_secret_1', name: 'echo_args', arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' };
  };
}

test('道具に渡した引数の秘密: 会話にはそのまま保存してモデルに戻し、メッセージの API・tool.call の出来事・道具の記録では伏せる。履歴の道具と振り返りには引数が出ない', async t => {
  const s = await startApp(t, { tools: [echoTool], configure: config => { config.memory.review = false; } });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const args = {
    url: `https://files.example/dl?access_token=${S1}&page=2#access_token=${S2}`,
    remote: `postgres://svc:${S3}@db.example/app`,
    command: `curl -d '{"password":"${S1}${S2}"}' https://a.example`,
    content: `{\n  "api_key": "${S3}"\n}`,
    password: S2,
  };
  const marks = [S1, S2, S3];
  const clean = (text: string, where: string) => { for (const mark of marks) assert.equal(text.includes(mark), false, `${where}: ${text}`); };
  s.adapter().scripts.push(callTool(args), reply('終わりました'));
  const outcome = s.app.engine.send(CONVERSATION, 'ファイルを取ってきて');
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result.ok, JSON.stringify(result));

  const stored = s.app.conversations.messages(CONVERSATION);
  const saved = stored.find(m => m.message.role === 'assistant' && m.message.toolCalls?.length);
  assert.deepEqual(saved?.message.role === 'assistant' ? saved.message.toolCalls?.[0]?.arguments : undefined, args, '会話には引数をそのまま保存する');
  const replayed = JSON.stringify(s.adapter().calls[1]!.messages);
  for (const mark of marks) assert.equal(replayed.includes(mark), true, 'モデルに戻す発言は伏せない');

  const listing = await (await s.api(`/api/conversations/${CONVERSATION}/messages`)).json() as { messages: Array<{ toolCalls?: Array<{ name: string; input: string }> }> };
  const shown = listing.messages.flatMap(m => m.toolCalls ?? []);
  assert.equal(shown.length, 1);
  clean(JSON.stringify(listing), 'GET /api/conversations/:id/messages');
  const parsed = JSON.parse(shown[0]!.input) as typeof args;
  assert.equal(parsed.url, 'https://files.example/dl?access_token=[REDACTED]&page=2#access_token=[REDACTED]');
  assert.equal(parsed.remote, 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(parsed.password, '[REDACTED]');
  assert.equal(parsed.content.split('\n').length, 3, '行の数は変えない（画面が +n −m を数える）');

  const called = events.filter(e => e.type === 'tool.call');
  assert.equal(called.length, 1);
  clean(JSON.stringify(called), 'tool.call の出来事');
  const live = called[0]!.type === 'tool.call' ? called[0]!.input : '';
  assert.deepEqual(JSON.parse(live), parsed, 'tool.call の出来事も、同じ読める JSON');

  // 新しい画面の行（ui/tool-row）: 伏せた入力から対象を読め、道具の結果の写し（$ 伏せたコマンド）と突き合わせて終了コードを読める
  const echo = `$ ${redactSecrets(args.command)}\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)`;
  const row = toolRow('shell_run', shown[0]!.input, { text: echo, isError: false });
  assert.deepEqual(row.meta, { kind: 'exit', code: '0', seconds: '0.2' });
  assert.equal(row.target.includes('curl -d'), true, row.target);
  clean(row.target, 'ui/tool-row の対象');
  clean(await (await s.api('/api/tool-calls')).text(), 'GET /api/tool-calls');

  clean(JSON.stringify(readHistory(s.app.db, CONVERSATION)), '履歴を読む道具（readHistory）');
  for (const mark of marks) assert.deepEqual(searchHistory(s.app.db, mark), [], '履歴を探す道具（searchHistory）');
  assert.deepEqual(await (await s.api(`/api/history?q=${S3}`)).json(), { hits: [] }, 'GET /api/history');
  clean(reviewWindow(stored, { maxChars: REVIEW_WINDOW_CHARS }).transcript, '振り返りに渡す会話の写し（reviewWindow）');
});

// 伏せたい値が URL に入る形は、符号化する側（ブラウザの URL・フォームの送信・PHP・Python・ページの JS）で違う。
// 記号の 1 文字ずつが、そのままか %XX（16 進の大文字・小文字）で、空白は %20 か + で書かれたものを、同じ値として伏せる
test('伏せ字（exact）: URL に入った値は、符号化の仕方（そのまま・%XX・空白は %20 と +・16 進の大文字小文字）が違っても、同じ値として伏せる', () => {
  const cases: Array<[string, string[]]> = [
    ["a b!c(d)e*f'g", ['a%20b!c(d)e*f%27g', 'a+b%21c%28d%29e%2Af%27g', 'a%20b!c(d)e*f\'g', 'a%20b%21c%28d%29e%2Af%27g', 'a%20b%21c%28d%29e%2af%27g', "a b!c(d)e*f'g"]],
    ['P@ss word', ['P@ss%20word', 'P%40ss+word', 'P%40ss%20word', 'P@ss+word']],
    ['a/b c!d', ['a/b%20c!d', 'a%2Fb+c%21d', 'a%2fb%20c!d', 'a/b+c%21d']],
    ['日本 語?x=1&y', ['日本%20語%3Fx%3D1%26y', '%E6%97%A5%E6%9C%AC+%E8%AA%9E?x=1&y', '%e6%97%a5%e6%9c%ac%20%e8%aa%9e%3fx%3d1%26y']],
  ];
  for (const [value, forms] of cases) {
    for (const form of forms) assert.equal(redactSecrets(`http://localhost:5173/after?q=${form}&z=1`, [value]), 'http://localhost:5173/after?q=[REDACTED]&z=1', `${value} / ${form}`);
  }
});

test('伏せ字（exact）: 符号化の幅を広げても、ほかの文字・短い断片・英数字だけの値は今までどおり（余計に伏せない・取りこぼさない）', () => {
  assert.equal(redactSecrets('before a b!c after', ['a b!c']), 'before [REDACTED] after');
  assert.equal(redactSecrets('q=a%20b!d', ['a b!c']), 'q=a%20b!d', '1 文字違えば伏せない');
  assert.equal(redactSecrets('q=axb!c', ['a b!c']), 'q=axb!c', '空白の所に別の文字なら伏せない');
  assert.equal(redactSecrets(`x ${S1} y %41%42 ${S1.toLowerCase()}`, [S1]), 'x [REDACTED] y %41%42 ' + S1.toLowerCase(), '英数字だけの値は、そのままの形だけ（大文字小文字も区別する）');
  assert.equal(redactSecrets('{"k":"a\\"b c"}', ['a"b c']), '{"k":"[REDACTED]"}', 'JSON の書き方も今までどおり');
  assert.equal(redactSecrets('a\n  b', ['a b']), '[REDACTED]', '空白の並びが違っても伏せる（今までどおり）');
});

test('伏せ字（exact）: 同じ鍵の組み立ては使い回す（呼ぶたびに正規表現を作り直さない）。古いものから捨てて数を守り、捨てたあとも同じに伏せる', () => {
  const Original = globalThis.RegExp;
  let made = 0;
  globalThis.RegExp = new Proxy(Original, { construct(target, args, newTarget) { made += 1; return Reflect.construct(target, args, newTarget); } });
  try {
    const secrets = ['first-secret!x', "second secret 'y'", 'third%secret+z'];
    const input = `a ${secrets[0]} b ${secrets[1]} c ${secrets[2]}`;
    const first = redactExact(input, secrets);
    assert.equal(first, 'a [REDACTED] b [REDACTED] c [REDACTED]');
    const built = made;
    assert.ok(built >= secrets.length, `1 回目は組み立てる: ${built}`);
    for (let i = 0; i < 5; i += 1) assert.equal(redactExact(input, secrets), first);
    assert.equal(made, built, '2 回目からは作り直さない');
    for (let i = 0; i < 1100; i += 1) redactExact('x', [`filler-${i}-abcd`]);
    const before = made;
    assert.equal(redactExact(input, secrets), first, '捨てられたあとも同じに伏せる');
    assert.ok(made > before, '上限（1024）を超えた分は古いものから捨てるので、最初の鍵は作り直す');
    const again = made;
    redactExact(input, secrets);
    assert.equal(made, again, '作り直したあとはまた使い回す');
  } finally { globalThis.RegExp = Original; }
});

test('伏せ字（exact）: 4 文字以下の数字だけの値は、要素の番号（e1234）の中を伏せない。ほかの場所・長い数字・数字以外の値は今までどおり', () => {
  assert.equal(redactSecrets('ref e1234 / [e1234] / x1234 / 1234 / port:1234 / ee1234', ['1234']), 'ref e1234 / [e1234] / x[REDACTED] / [REDACTED] / port:[REDACTED] / ee[REDACTED]');
  assert.equal(redactSecrets('e123456 and 123456', ['123456']), 'e[REDACTED] and [REDACTED]', '5 文字以上は要素の番号にならないので、そのまま伏せる');
  assert.equal(redactSecrets('e1234 and e1234', ['e1234']), '[REDACTED] and [REDACTED]', '値そのものが e で始まるときは伏せる');
  assert.equal(redactSecrets('ref e12ab and 12ab', ['12ab']), 'ref e[REDACTED] and [REDACTED]', '数字だけでない値は、e の後ろでも伏せる');
});

test('伏せ字: 振り返りに渡す道具の呼び出し（reviewWindow の skill）は、値に " が入っていても password を丸ごと伏せる', () => {
  const stored = [{ id: 1, role: 'assistant', text: '入れます', message: { role: 'assistant', toolCalls: [{ name: 'browser_type', arguments: { ref: 'e2', password: 'Pa"ss-9876' } }] } }] as any;
  const transcript = reviewWindow(stored, { maxChars: REVIEW_WINDOW_CHARS }, undefined, 'skill').transcript;
  assert.ok(transcript.includes('browser_type'), transcript);
  assert.ok(!transcript.includes('ss-9876') && !transcript.includes('Pa"'), transcript);
});

test('伏せ字: JSON の文字列の中の \\" は閉じの引用符でない（読めない引数の元の文・ログの JSON でも、値の後ろ半分を残さない）。引用符が閉じていなければ今までどおり', () => {
  assert.equal(redactSecrets('{"password":"Pa\\"ss-9876","ref":"e2"}'), '{"password":[REDACTED],"ref":"e2"}');
  assert.equal(redactSecrets('{"api_key":"sk\\"-abc","next":"v"}'), '{"api_key":[REDACTED],"next":"v"}');
  assert.equal(redactSecrets('token="a\\"b" other="c"'), 'token=[REDACTED] other="c"');
  assert.equal(redactSecrets('{"command":"x --password \\"abc\\" y"}'), '{"command":"x --password [REDACTED] y"}', '二重に包んだ形は今までどおり');
  assert.equal(redactSecrets('password="abc\n"x"'), 'password=[REDACTED]\n"x"', '行をまたいで読まない');
  assert.equal(redactSecrets('{"password":"Pa\\\\"}, "next":"v"'), '{"password":[REDACTED]}, "next":"v"', '値の終わりの \\\\ は引用符を守らない');
  const raw = '{"ref":"e2","password":"Pa\\"ss-9876"';
  assert.ok(!JSON.stringify(redactJsonValue(raw)).includes('ss-9876'), '読めない引数の元の文（call.raw）');
});

test('伏せ字: 値がバックスラッシュで終わる引用符つきの代入（Windows のパス）でも、同じ行・次の行のあとの名前・旗の値を残さない', () => {
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  const cases: Array<[string, string, string]> = [
    [`--password-file="C:${BS}pw${BS}" --token="tok_ABCDEFGHIJ123"`, '--password-file=[REDACTED] --token=[REDACTED]', '旗の形の代入が続く'],
    [`$env:PASSWORD_FILE="C:${BS}creds${BS}"; $env:API_TOKEN="Zx9q8w7e6r5tAbC"`, '$env:PASSWORD_FILE=[REDACTED]; $env:API_TOKEN=[REDACTED]', 'PowerShell の環境変数'],
    [`password="abc${BS}" token="def1234567"`, 'password=[REDACTED] token=[REDACTED]', '空白で続く'],
    [`secret: "C:${BS}dir${BS}", api_key: "AKIAQWERTYUIOPAS"`, 'secret: [REDACTED], api_key: [REDACTED]', 'YAML 風'],
    [`PASSWORD="C:${BS}a${BS}" SECRET="Zq12345678" TOKEN="Tk98765432"`, 'PASSWORD=[REDACTED] SECRET=[REDACTED] TOKEN=[REDACTED]', '3 つ並ぶ'],
    [`password: "abc${BS}"${NL}token: "def1234567"`, `password: [REDACTED]${NL}token: [REDACTED]`, '次の行'],
    [`password="abc${BS}"token":"x1234567890"`, 'password=[REDACTED]token":[REDACTED]', '次の名前が引用符の直前から始まり、: は範囲の外'],
    [`password="C:${BS}pw${BS}" --token "tok7654321ABC"`, 'password=[REDACTED] --token [REDACTED]', '次が旗'],
    [`password="C:${BS}pw${BS}" mysql -h x -p"Secret99999"`, 'password=[REDACTED] mysql -h x -p[REDACTED]', '次が mysql の -p'],
    [`password="C:${BS}pw${BS}" curl -u "admin:Secret77777" http://x`, 'password=[REDACTED] curl -u "admin:[REDACTED]" http://x', '次が -u のユーザー:パスワード'],
    [`{"password":"C:${BS}pw${BS}","token":"tok_ABCDEFGHIJ123"}`, '{"password":[REDACTED],"token":[REDACTED]}', '壊れた JSON でも次の値は残さない'],
    [`password="Pa${BS}"ss-9876" token="def1234567"`, 'password=[REDACTED] token=[REDACTED]', '値の中の引用符は今までの直しどおり閉じとみなさない'],
  ];
  for (const [input, expected, name] of cases) assert.equal(redactSecrets(input), expected, name);
});

test('伏せ字: バックスラッシュで終わる値のあとに秘密でない名前の代入だけが続くときは、次の引用符まで伏せる（記録した伏せすぎ。値は残さない）', () => {
  const BS = String.fromCharCode(92);
  assert.equal(redactSecrets(`password="abc${BS}" name="x"`), 'password=[REDACTED]x"');
});

test('伏せ字: 振り返りに渡す道具の呼び出しは、password が配列でも丸ごと伏せる（redactJsonValue を通す）', () => {
  const stored = [{ id: 1, role: 'assistant', text: '入れます', message: { role: 'assistant', toolCalls: [{ name: 'browser_type', arguments: { ref: 'e2', password: ['aaaa-1111', 'bbbb-2222'] } }] } }] as any;
  const transcript = reviewWindow(stored, { maxChars: REVIEW_WINDOW_CHARS }, undefined, 'skill').transcript;
  assert.ok(transcript.includes('browser_type'), transcript);
  assert.ok(!transcript.includes('aaaa-1111') && !transcript.includes('bbbb-2222'), transcript);
});

test('伏せ字（exact）: 要素の番号が 5 桁（e14819）でも、4 文字以下の数字の値は番号の中を伏せない。e の前に語の字があれば伏せる', () => {
  assert.equal(redactSecrets('e14819 e14820 e14821 e14822', ['4821']), 'e14819 e14820 e14821 e14822');
  assert.equal(redactSecrets('e4821 / 4821 / x4821 / e 4821 / ee4821 / a4821', ['4821']), 'e4821 / [REDACTED] / x[REDACTED] / e [REDACTED] / ee[REDACTED] / a[REDACTED]');
  assert.equal(redactSecrets('e1234567', ['4567']), 'e1234567', 'e のあとの数字が 3 桁のあとの位置は伏せない');
  assert.equal(redactSecrets('e123456789', ['6789']), 'e123456789', 'e のあとの数字が 5 桁のあとの位置は伏せない（上限）');
  assert.equal(redactSecrets('e1234567890 and 7890', ['7890']), 'e123456[REDACTED] and [REDACTED]', 'e のあとの数字が 6 桁以上のあとの位置は伏せる');
});

test('伏せ字（exact）: 値の中の空白（スペース・タブ・改行）を JSON の \\u0020・\\u0009・\\u000A・\\u000D で書いた写しも伏せる', () => {
  const BS = String.fromCharCode(92);
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  assert.equal(redactSecrets(`x Zq${BS}u0020Leak-55 y`, ['Zq Leak-55']), 'x [REDACTED] y');
  assert.equal(redactSecrets(`x Zq${BS}u0009Leak-56 y`, [`Zq${TAB}Leak-56`]), 'x [REDACTED] y');
  assert.equal(redactSecrets(`x Zq${BS}u000aLeak-57 Zq${BS}u000ALeak-57 Zq${BS}u000dLeak-57 Zq${BS}u000DLeak-57 y`, [`Zq${LF}Leak-57`]), 'x [REDACTED] [REDACTED] [REDACTED] [REDACTED] y');
  assert.equal(redactSecrets(`x Zq${BS}u0021Leak-58 y`, ['Zq Leak-58']), `x Zq${BS}u0021Leak-58 y`, '空白でない字の u エスケープは空白の代わりにならない');
});

test('伏せ字（exact）: JSON の書き方（\\uXXXX は 16 進の大文字・小文字どちらでも、\\/ も）で書かれた値も伏せる。英数字だけの値は今までどおり', () => {
  const BS = String.fromCharCode(92);
  assert.equal(redactSecrets(`x P${BS}u0040ss-Leak-77 y`, ['P@ss-Leak-77']), 'x [REDACTED] y');
  assert.equal(redactSecrets(`x Zq${BS}u007ELeak-99 Zq${BS}u007eLeak-99 y`, ['Zq~Leak-99']), 'x [REDACTED] [REDACTED] y');
  assert.equal(redactSecrets(`x a${BS}/b-Leak-88 a/b-Leak-88 a${BS}u002Fb-Leak-88 y`, ['a/b-Leak-88']), 'x [REDACTED] [REDACTED] [REDACTED] y');
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(redactSecrets(`x Zq${emoji}Leak-77 Zq${BS}ud83d${BS}ude00Leak-77 Zq${BS}uD83D${BS}uDE00Leak-77 y`, [`Zq${emoji}Leak-77`]), 'x [REDACTED] [REDACTED] [REDACTED] y', '16 進が 2 つ続く形（BMP の外の字）も、大文字・小文字どちらでも');
  assert.equal(redactSecrets(`x Zq${BS}ud83dLeak-77 y`, [`Zq${emoji}Leak-77`]), `x Zq${BS}ud83dLeak-77 y`, '2 つ目が欠けた形は伏せない');
  assert.equal(redactSecrets(`x a${BS}u0062 y`, ['abc12345']), `x a${BS}u0062 y`, '別の値は伏せない');
  assert.equal(redactSecrets(`x P${BS}u0041ss-Leak-77`, ['PAss-Leak-77']), `x P${BS}u0041ss-Leak-77`, '英数字を \\u で書いた形は、今までどおり伏せない（記録した穴）');
});
