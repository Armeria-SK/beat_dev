import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { RunEvent, ToolCall } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { transcriptOf } from '../src/memory/review.ts';
import { isSensitiveEnvName, redactJsonValue, redactSecrets } from '../src/shared/redaction.ts';
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

test('伏せ字: URL の ? と & のあとの秘密の名前（access_token・api_key など）の値を伏せ、ほかの値は残す', () => {
  assert.equal(redactSecrets(`https://x.example/p?access_token=${S1}&api_key=${S2}`), 'https://x.example/p?access_token=[REDACTED]&api_key=[REDACTED]');
  assert.equal(redactSecrets(`GET /cb?page=2&access_token=${S1}&lang=ja`), 'GET /cb?page=2&access_token=[REDACTED]&lang=ja');
  assert.equal(redactSecrets(`https://x.example/p?client_secret=${S1}&amp;refresh_token=${S2}`), 'https://x.example/p?client_secret=[REDACTED]&amp;refresh_token=[REDACTED]');
  assert.equal(redactSecrets(`{"url":"https://x.example/p?token=${S1}&page=2"}`), '{"url":"https://x.example/p?token=[REDACTED]&page=2"}');
  assert.equal(redactSecrets(`"https://x.example/p?a=1\\u0026token=${S1}"`), '"https://x.example/p?a=1\\u0026token=[REDACTED]"');
  assert.equal(redactSecrets(`{\\"url\\":\\"https://x.example/p?token=${S1}\\"}`), '{\\"url\\":\\"https://x.example/p?token=[REDACTED]\\"}');
});

test('伏せ字: URL の # のあと（#access_token=）と、URL でよく秘密を運ぶ名前（key・sig・signature・code）の値を伏せる', () => {
  assert.equal(redactSecrets(`https://x.example/cb#access_token=${S1}&state=1`), 'https://x.example/cb#access_token=[REDACTED]&state=1');
  assert.equal(redactSecrets(`https://x.example/p?key=${S1}${S2}&sig=${S2}${S3}&code=${S3}${S1}&v=3`), 'https://x.example/p?key=[REDACTED]&sig=[REDACTED]&code=[REDACTED]&v=3');
  assert.equal(redactSecrets(`https://s3.example/o?X-Amz-Signature=${S1}&X-Amz-Date=20261112`), 'https://s3.example/o?X-Amz-Signature=[REDACTED]&X-Amz-Date=20261112');
});

test('伏せ字: URL の userinfo のパスワードを、http 以外の接続先でも、名前が空でも伏せる', () => {
  assert.equal(redactSecrets(`https://user:${S1}@host.example/x`), '[REDACTED]host.example/x');
  assert.equal(redactSecrets(`postgres://svc:${S1}@db.example/app`), 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(redactSecrets(`redis://:${S1}@db.example:6379`), 'redis://:[REDACTED]@db.example:6379');
  assert.equal(redactSecrets(`https://:${S1}@host.example/x`), 'https://:[REDACTED]@host.example/x');
});

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

test('伏せ字: URL の値の途中に \\/ や引用符があっても、うしろの部分を残さない。JSON の閉じの引用符・& のあとの値・閉じかっこは残す', () => {
  assert.equal(redactSecrets(`{"url":"https:\\/\\/x.example\\/p?token=${S1}\\/${S2}&page=2"}`), '{"url":"https:\\/\\/x.example\\/p?token=[REDACTED]&page=2"}');
  for (const quote of ['"', "'", '`', '<', '>']) assert.equal(redactSecrets(`see x?token=${S1}${quote}${S2} end`), 'see x?token=[REDACTED] end', quote);
  assert.equal(redactSecrets(`<a href="/p?token=${S1}">Link</a>`), '<a href="/p?token=[REDACTED]">Link</a>');
  assert.equal(redactSecrets(`{"url":"https://x.example/p?token=${S1}","n":1}`), '{"url":"https://x.example/p?token=[REDACTED]","n":1}');
  assert.equal(redactSecrets(`[link](https://x.example/p?token=${S1}) next`), '[link](https://x.example/p?token=[REDACTED]) next');
  assert.equal(redactSecrets(`\`https://x.example/p?token=${S1}\`を開く`), '`https://x.example/p?token=[REDACTED]`を開く');
});

test('伏せ字: 名前の決まりに足した形（ハイフン入りのヘッダー名・apikey・passphrase・jwt・hmac・oauth_verifier・signing_key・PGPASSWORD・DB_PASS など）', () => {
  for (const text of [
    `X-Api-Key: ${S1}`, `x-auth-token: ${S1}`, `apikey=${S1}`, `APIKEY=${S1}`, `passphrase=${S1}`, `jwt=${S1}`, `hmac=${S1}`, `oauth_verifier=${S1}`, `signing_key=${S1}`,
    `PGPASSWORD=${S1} psql`, `DB_PASS=${S1}`, `MYSQL_PWD=${S1}`, `X-Amz-Credential: ${S1}`, `5-token=${S1}`, `--api-key=${S1}`,
  ]) assert.deepEqual(leaks(text, S1), [], text);
  assert.equal(redactSecrets(`curl -H "X-Api-Key: ${S1}" https://a.example`), 'curl -H "X-Api-Key: [REDACTED] https://a.example');
});

test('伏せ字: URL の中だけで秘密として扱う名前（pwd・pass・sid・otp・sessionId・;jsessionid=）と、名前の形（token[]=・data[token]=・%5F・%3D で包んだ URL・&#38; のあと）', () => {
  for (const text of [
    `https://x.example/p?pwd=${S1}`, `https://x.example/p?a=1&pass=${S1}`, `https://x.example/p?sid=${S1}`, `https://x.example/p?otp=${S1}`, `https://x.example/p?sessionId=${S1}`,
    `https://x.example/p;jsessionid=${S1}?a=1`, `https://x.example/p?token[]=${S1}`, `https://x.example/p?data[token]=${S1}`, `https://x.example/p?data%5Btoken%5D=${S1}`,
    `https://x.example/p?access%5Ftoken=${S1}`, `https://x.example/p?a=1&#38;token=${S1}`, `https://x.example/p?a=1&#x26;token=${S1}`, `https://x.example/p?a.b.token=${S1}`,
    `https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D${S1}%26state%3D1`,
  ]) assert.deepEqual(leaks(text, S1), [], text);
  assert.equal(redactSecrets(`https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D${S1}%26state%3D1`), 'https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Faccess_token%3D[REDACTED]%26state%3D1');
  assert.equal(redactSecrets(`https://x.example/p;jsessionid=${S1}&a=1`), 'https://x.example/p;jsessionid=[REDACTED]&a=1');
});

test('伏せ字: 値が空白で分かれる形（Authorization: Basic …・--password …・curl -u user:pass・mysql -p…・Cookie: の行）', () => {
  assert.equal(redactSecrets(`Authorization: Basic ${S1}`), 'Authorization: [REDACTED]');
  assert.equal(redactSecrets(`Proxy-Authorization: Basic ${S1}\nHost: x`), 'Proxy-Authorization: [REDACTED]\nHost: x');
  assert.equal(redactSecrets(`curl -H "Authorization: Basic ${S1}" https://a.example`), 'curl -H "Authorization: [REDACTED]" https://a.example');
  assert.equal(redactSecrets(`tool --password ${S1} --api-key ${S2} run`), 'tool --password [REDACTED] --api-key [REDACTED] run');
  assert.equal(redactSecrets(`New-Thing -Password "${S1} ${S2}" -Name x`), 'New-Thing -Password [REDACTED] -Name x');
  assert.equal(redactSecrets(`curl -u admin:${S1} https://a.example`), 'curl -u admin:[REDACTED] https://a.example');
  assert.equal(redactSecrets(`curl --user "admin:${S1}" https://a.example`), 'curl --user "admin:[REDACTED]" https://a.example');
  assert.equal(redactSecrets(`mysql -u root -p${S1} app`), 'mysql -u root -p[REDACTED] app');
  assert.equal(redactSecrets(`mysql -p"${S1} ${S2}" app`), 'mysql -p[REDACTED] app');
  assert.equal(redactSecrets(`{"command":"tool --token ${S1}"}`), '{"command":"tool --token [REDACTED]"}', 'JSON の閉じの引用符は食わない');
  assert.equal(redactSecrets(`{"command":"tool --token \\"${S1} ${S2}\\" x"}`), '{"command":"tool --token [REDACTED] x"}');
  assert.equal(redactSecrets(`Cookie: a=1; sid=${S1}; theme=${S2}\nHost: x`), 'Cookie: [REDACTED]\nHost: x');
  assert.equal(redactSecrets(`curl -H "Cookie: a=1; b=${S1}" https://a.example`), 'curl -H "Cookie: [REDACTED]" https://a.example');
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

test('審査 1: Cookie の値が引用符つき・\\ 入りでも、前の版より多く残さない。JSON の閉じの引用符は食わない', () => {
  assert.equal(redactSecrets('Set-Cookie: sid="SECRETVAL"; Path=/'), 'Set-Cookie: [REDACTED]');
  assert.equal(redactSecrets('< Set-Cookie: session="eyJhIjoxfQ.SECRETSIG"; HttpOnly; Path=/'), '< Set-Cookie: [REDACTED]');
  assert.equal(redactSecrets('Cookie: sid=abc\\def; b=2'), 'Cookie: [REDACTED]');
  assert.equal(redactSecrets('{"h":"Cookie: a=1; b=2"}'), '{"h":"Cookie: [REDACTED]"}');
  assert.equal(redactSecrets('{"cookie": "abc", "n": 1}'), '{"cookie": [REDACTED], "n": 1}');
  assert.equal(redactSecrets('{\\"h\\":\\"Cookie: abc\\"}'), '{\\"h\\":\\"Cookie: [REDACTED]\\"}');
});

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

test('審査 5: 値が次の行にあっても、次の行が字下げされていれば伏せる。行の頭から始まる次の行は食わない', () => {
  assert.equal(redactSecrets('Password:\n  hunter2secret'), 'Password:\n  [REDACTED]');
  assert.equal(redactSecrets('secret:\r\n  abc'), 'secret:\r\n  [REDACTED]');
  assert.equal(redactSecrets('Token:\nSECRETVALUE123'), 'Token:\nSECRETVALUE123', '行の頭から始まる値は残る（分かっている漏れ）');
  assert.equal(redactSecrets('API_KEY=\nabc'), 'API_KEY=\nabc');
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
  clean(transcriptOf(stored), '振り返りに渡す会話の写し（transcriptOf）');
});
