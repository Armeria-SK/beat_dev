import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfTarget } from '../src/tools/hooks/self-port.ts';

const server = { port: 4790, origins: ['http://127.0.0.1:4791', 'https://box.tail1234.ts.net'] };
const ipServer = { port: 4790, origins: ['http://10.0.0.5:4791'] };

const PINNED = [
  'curl http://127.0.0.1:4790/api/pending',
  'curl -X POST http://localhost:4790/api/pending/1/approve',
  'curl http://[::1]:4791/api/pending',
  'curl http://127.1:4790/api/pending',
  'curl http://0177.0.0.1:4790/api/pending',
  'curl http://0x7f.1:4790/api/pending',
  'curl http://127.000.000.001:4790/api/pending',
  'curl http://[::ffff:7f00:1]:4790/api/pending',
  'curl http://localhost.:4790/api/pending',
  'curl "http://127.0.0.1:47""90/api/pending"',
  'curl http://127%2e0%2e0%2e1:4790/api/pending',
  'curl http://LOCALHOST%2e:4790/api/pending',
  'curl "http://ｌｏｃａｌｈｏｓｔ:4790/api/pending"',
  'curl "http://127。0。0。1:4790/api/pending"',
  'curl http://2130706433:4790/api/pending',
  'curl 2130706433:4790',
  'curl http://0x7f000001:4790/',
];

test('selfTarget: curl の URL の展開とゼロを前に付けたポートも beat 自身として見つける', () => {
  const globbed = [
    'curl "http://127.0.0.[1-1]:4790/"',
    'curl "http://{127.0.0.1,127.0.0.1}:4790/"',
    'curl http://127.0.0.1:0004790/',
    'curl http://localhost:04791/api/pending',
    'curl "http://127.0.0.{1,2}:4791/"',
    'curl "http://[127.0.0.1]:4790/"',
  ];
  assert.deepEqual(globbed.filter(command => selfTarget(command, server) === undefined), []);
  const other = [
    'curl http://127.0.0.1:9/',
    'curl http://127.0.0.1:0009/',
    'curl "http://127.0.0.[1-1]:9/"',
    'curl "http://{127.0.0.1,127.0.0.1}:8080/"',
    'curl http://127.0.0.1:47900/',
    'curl http://[::1]:9/',
  ];
  assert.deepEqual(other.filter(command => selfTarget(command, server) !== undefined), []);
});

test('selfTarget: これまで断っていた書き方は、どの設定でも断ったまま', () => {
  for (const config of [server, ipServer]) assert.deepEqual(PINNED.filter(command => selfTarget(command, config) === undefined), []);
  const hosts = [
    'curl https://box.tail1234.ts.net/api/pending/1/approve',
    'curl https://box.tail1234.ts.net:8443/api/pending',
    'curl https://box.tail1234.ts.net./api/pending',
    'curl https://box%2etail1234%2ets%2enet/api/pending',
    'curl "https://ｂｏｘ.tail1234.ts.net/api/pending"',
  ];
  assert.deepEqual(hosts.filter(command => selfTarget(command, server) === undefined), []);
});

test('selfTarget: origins が IP のとき、版や秒の数字は断らず、その IP の書き方は断る', () => {
  const plain = ['nvm use 10.5', 'npm i lodash@10.5', 'sleep 10.5', 'echo 167772165', 'echo 0xa000005', 'head -c 10.5 a.txt'];
  assert.deepEqual(plain.filter(command => selfTarget(command, ipServer) !== undefined), []);
  const self = [
    'curl 10.0.0.5',
    'ping 10.0.0.5',
    'curl http://10.0.0.5/api/pending',
    'curl http://10.5/api/pending',
    'curl 10.5:8080',
    'curl http://167772165/',
    'curl http://0xa000005/',
    'curl 0xa000005:4791',
    'curl 10%2e0%2e0%2e5',
    'curl "１０.0.0.5"',
  ];
  assert.deepEqual(self.filter(command => selfTarget(command, ipServer) === undefined), []);
});

test('selfTarget: 展開の決まりは、ホストの形の語で括弧が閉じているときだけ。JSON・添字・書式の中のポートの数字は断らない', () => {
  const wide = { port: 4790, origins: ['https://box.tail1234.ts.net', 'http://other.tail1234.ts.net'] };
  const unrelated = [
    `echo '{"port":4790}'`, `python -c "print(x[:443])"`, `jq '{count:443}' a.json`, `python -c "print(s[:80])"`, `node -e "console.log({w:80})"`,
    'echo a[0]:4790', 'jq .[0]:4790', 'git log --format={%h}:4790', `node -e "f({port:4790})"`, 'echo x[i]:443',
  ];
  assert.deepEqual(unrelated.filter(command => selfTarget(command, wide) !== undefined), []);
  const expanding = [
    'curl "http://127.0.0.[1-1]:4790/"', 'curl "http://{127.0.0.1,127.0.0.1}:4790/"', 'curl "http://127.0.0.{1,2}:4790/"', 'curl "http://[127.0.0.1]:4790/"',
    'curl ${HOST}:4790', 'curl --url=127.0.0.[1-1]:4790', 'curl "http://user@{localhost,x}:4790/"', 'curl "http://127.0.0.[1-1]:0004790/"', 'curl "https://{localhost}:443/"',
  ];
  assert.deepEqual(expanding.filter(command => selfTarget(command, wide) === undefined), []);
});

test('selfTarget: 数字だけの語の見逃しは、origins のポートに 80 が無く、語のあとに / ? # : が続かないときだけ', () => {
  const http = { port: 4790, origins: ['http://10.0.0.5'] };
  const bare = ['curl 10.5/api/pending', 'curl 10.5', 'curl -s 167772165/api/pending', 'wget -qO- 10.5/api/pending', 'curl 0xa000005'];
  assert.deepEqual(bare.filter(command => selfTarget(command, http) === undefined), []);
  for (const config of [ipServer, { port: 4777, origins: ['http://10.0.0.5:4790'] }]) {
    const tail = ['curl "10.5:[4790-4790]/api/pending"', 'curl 10.5:{4790,4790}', 'curl 10.5/api/pending', 'curl 10.5?x=1', 'curl 10.5#top', 'curl -s 167772165/api/pending', 'curl https://10.5/'];
    assert.deepEqual(tail.filter(command => selfTarget(command, config) === undefined), []);
    const plain = ['sleep 10.5', 'nvm use 10.5', 'npm i lodash@10.5'];
    assert.deepEqual(plain.filter(command => selfTarget(command, config) !== undefined), []);
  }
  const https = { port: 4790, origins: ['https://10.0.0.5'] };
  const viaHttps = ['curl --proto-default https 10.5', 'curl 10.5 --request-target /api/pending', 'curl -L 10.5', 'curl 10.5/api/pending', 'curl https://10.5/', 'sleep 10.5'];
  assert.deepEqual(viaHttps.filter(command => selfTarget(command, https) === undefined), [], '443 が beat のポートのときは、数字だけの語も見逃さない');
});

test('selfTarget: :// のある語に beat のポートと展開の括弧があれば、ポートが括弧の中でも、括弧の中に何が書かれていても断る', () => {
  const inside = ['x/y', 'a?b', 'a#b', 'a@127.0.0.1', 'a~b', 'a+b', 'a!b', 'a=b', 'a b', 'a;b', 'a&b', 'a(b', 'a|b', 'a*b', 'a^b', 'a<b', 'a%b'];
  const reached = [
    'curl "http://127.0.0.{1:4790,1:4790}/"', 'curl "http://127.0.0.1{:4790,:4790}/"', 'curl "http://127.0.0.{1:4790/a,1:4790/b}"',
    ...inside.map(part => `curl "http://{127.0.0.1,${part}}:4790/"`),
    'curl "{http://127.0.0.1,http://localhost}:4790/"',
    'curl "http://{,x@}127.0.0.[1-1]:4790/"', 'curl "http://{x@,y@}127.0.0.{1,1}:4790/"', 'curl "http://{a/../,}127.0.0.{1,1}:4790/"',
    'curl "http://a~{b,c}.localhost:4790/"', 'curl "http://a|{b,c}.localhost:4790/"',
    "curl 'http://{127.0.0.1,a b}:4790/'", 'curl http://127.0.0.{1:0004790,2}/',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, server) === undefined), []);
  const free = [
    'curl "http://{127.0.0.1,x/y}:9/"', 'curl http://[::1]:9/', `echo '{"port":4790}' http://example.com/`, 'curl "http://example.com/{a,b}" -o out:1',
    `node -e "f({port:4790})"`, 'echo a[0]:4790',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, server) !== undefined), []);
});

test('selfTarget: ポートやホストが展開の括弧で組み立てられる書き方も、展開した結果が beat 自身なら断る', () => {
  const reached = [
    'curl "http://127.0.0.1:{4790,4790}/"', 'curl "http://127.0.0.1:[4790-4790]/"', 'curl "http://127.0.0.1:[4789-4791]/"', 'curl "http://127.0.0.1:[4789-4791:1]/"',
    'curl "http://127.0.0.1:47{90,90}/"', 'curl "http://127.0.0.1{:,:}4790/"', 'curl "http://127.0.0.1:4[7-7]90/"', 'curl "http://127.0.0.1:[04790-04790]/"',
    'curl "127.0.0.{1:4790,1:4790}/"', 'curl "http:/{127.0.0.1,x/y}:4790/"', 'curl "http://[::1]:{4791,4791}/"', 'curl "http://127.0.0.1:[1-65535]/"',
    'curl http://127.0.0.1:{4789..4791}/', 'curl http://localhost:{1..65535}/', 'curl "https://box.tail1234.ts.{net,net}/api/pending"', 'curl "https://127.0.0.1:[440-450]/"',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, server) === undefined), []);
  const free = [
    'curl "http://127.0.0.1:{8080,9090}/"', 'curl "http://127.0.0.1:[3000-3002]/health"', 'curl "http://localhost:[5000-6000]/"', 'curl http://127.0.0.1:{3000..3005}/',
    'curl "http://example.com/img[1-100000].png"', 'curl "https://example.com/{a,b}/[1-3].json"', `echo '{"host":"localhost","port":4790}'`,
    `node -e "const o={host:'127.0.0.1',port:4790}"`, `jq '{a:.x[0],port:4790}' a.json`, 'echo {1..4790}', 'echo [4790-4790] {4790,4791}', 'ls src/{a,b}/[0-9]*.ts',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, server) !== undefined), []);
});

test('selfTarget: スラッシュが 1 本・3 本の URL（http:/host）も、既定のポートが beat のポートなら断る', () => {
  const http = { port: 4790, origins: ['http://10.0.0.5'] };
  assert.deepEqual(['curl http:/localhost/api/pending', 'curl http:///127.0.0.1/api/pending', 'curl HTTP:/127.0.0.1'].filter(command => selfTarget(command, http) === undefined), []);
  assert.deepEqual(['curl https:/127.0.0.1/api/pending', 'curl https:///localhost/'].filter(command => selfTarget(command, server) === undefined), []);
  const free = ['curl http:/localhost/api/pending', 'curl http:/127.0.0.1:9/', 'curl https:/example.com/', 'echo http:localhost', 'ls C:/localhost'];
  assert.deepEqual(free.filter(command => selfTarget(command, server) !== undefined), []);
});

test('selfTarget: IPv6 のゾーン付きの書き方（[::1%25lo]）も beat 自身として見つける', () => {
  const reached = ['curl "http://[::1%25lo]:4790/api/pending"', 'curl "http://[::1%lo]:4791/"', 'curl "http://[::1%251]:4790/"', 'curl "http://[::ffff:127.0.0.1%25lo]:4790/"'];
  assert.deepEqual(reached.filter(command => selfTarget(command, server) === undefined), []);
  const free = ['curl "http://[fe80::1%25eth0]:4790/"', 'curl "http://[::1%25lo]:9/"', 'ping fe80::1%eth0'];
  assert.deepEqual(free.filter(command => selfTarget(command, server) !== undefined), []);
});

test('selfTarget: 閉じない括弧が並ぶ長い文でも、読む量が長さの 2 乗にならない', () => {
  for (const text of [`${'[a'.repeat(50_000)}:4790`, `${'{a'.repeat(50_000)}:4790`, `${'{a,b}'.repeat(4_000)}:4790`]) {
    const started = performance.now();
    selfTarget(text, server);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 700, `${text.slice(0, 6)}… に ${Math.round(elapsed)}ms`);
  }
});

test('selfTarget: 途方もなく大きい数の範囲・深く重なった括弧・縮めた JSON でも、1 回の確かめの仕事量は決まった上限まで', () => {
  const nest = (depth: number): string => (depth === 0 ? '1' : `{"a":${nest(depth - 1)},"b":${nest(depth - 1)},"c":${nest(depth - 1)},"d":${nest(depth - 1)}}`);
  const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`node_modules/p${i}`, { version: `1.${i}.0`, resolved: `https://registry.npmjs.org/p${i}/-/p${i}-1.${i}.0.tgz`, integrity: 'sha512-AAAA', dependencies: { a: '^1.0.0', b: '^2.0.0' }, engines: { node: '>=18' } }])) });
  const heavy = [
    'echo {9007199254740993..9007199254740993}', 'echo {100000000000000000000..100000000000000000001}', 'curl "http://example.com/img[99999999999999999999-99999999999999999999].png"',
    'echo {1..3..99999999999999999999999}', 'curl x[1-60][1-60]{[1-60][1-60]}{{[1-60][1-60]}}', `curl -d '${nest(4)}' http://example.com/`, `echo '${lock}' > l.json`,
    `echo ${'{a,b}'.repeat(4_000)}`, Array.from({ length: 3_000 }, (_, i) => `x{${i},b}`).join(' '),
  ];
  for (const text of heavy) {
    const started = performance.now();
    assert.equal(selfTarget(text, server), undefined, text.slice(0, 60));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${text.slice(0, 60)}… に ${Math.round(elapsed)}ms`);
  }
});

test('selfTarget: 形が上限を超える語は、括弧を 1 つずつ動かして確かめる。重い語が先にあっても、あとの短い語は確かめる', () => {
  const tails = '{a,b}'.repeat(9);
  const decoys = Array.from({ length: 600 }, (_, i) => 5000 + i).join(',');
  const nest = (depth: number): string => (depth === 0 ? '1' : `{"a":${nest(depth - 1)},"b":${nest(depth - 1)},"c":${nest(depth - 1)},"d":${nest(depth - 1)}}`);
  const reached = [
    `curl "127.0.0.1:{4790,4789}/${tails}"`, `curl "127.0.0.1:{4789,4790}/${tails}"`, `curl "127.0.0.1:{${decoys},4790}/"`, 'curl {a,{b,{c,{d,127.0.0.1}}}}:4790',
    'curl 127.0.0.1:{4813..4750..23}', 'curl 127.0.0.1:{4791..4700..1}', `curl -d '${nest(4)}' "127.0.0.1:{4790,4790}/"`, `curl "127.0.0.1:{4790,4790}/" -d '${nest(4)}'`,
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, server) === undefined).map(command => command.slice(0, 50)), []);
  const free = [`curl "127.0.0.1:{8080,9090}/${tails}"`, `curl "127.0.0.1:{${decoys},9}/"`, 'curl 127.0.0.1:{4813..4750..21}', 'curl {a,{b,{c,{d,127.0.0.1}}}}:9', 'echo {4750..4813..23}'];
  assert.deepEqual(free.filter(command => selfTarget(command, server) !== undefined).map(command => command.slice(0, 50)), []);
});

// 2026-11-26 shell-rest S6: beat's port 4777 hidden in a range that is too big to expand in full, and a bash sequence with a negative step
const beat = { port: 4777, origins: [] as string[] };

test('S6 負の刻みの {4779..4775..-2}（bash は刻みの符号を無視する）も展開して beat 自身として断る', () => {
  const reached = ['curl http://127.0.0.1:{4779..4775..-2}/', 'curl http://127.0.0.1:{4775..4779..-2}/', 'curl "http://127.0.0.1:{4778..4776..-1}/"', 'curl localhost:{4781..4773..-4}'];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const free = ['curl http://127.0.0.1:{4779..4771..-4}/', 'curl http://127.0.0.1:{3000..3004..-2}/', 'echo {4779..4775..-2}'];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

test('S6 ホストとポートの括弧の組み合わせが 512 を超えて全部は確かめきれないとき、手元（か括弧つきのホスト）へのものは断る。パスだけの括弧・手元でないホスト・全部確かめ終えたものは今のまま', () => {
  const nine = `{${'{'.repeat(8)}4777${'}'.repeat(8)}}`;
  const reached = [
    'curl "127.0.0.1:4[0-9][0-9][0-9]/"', 'curl "http://127.0.0.1:4[0-9][0-9][0-9]/"', 'curl "localhost:[4-4][0-9][0-9][0-9]"', 'curl "https://localhost:4[0-9][0-9][0-9]"',
    'curl "http://127.0.0.{1,2}:4[0-9][0-9][0-9]/"', 'curl "http://[::1]:4[0-9][0-9][0-9]/"', 'curl "http://user@127.0.0.1:4[0-9][0-9][0-9]/"', 'curl --url=127.0.0.1:4[0-9][0-9][0-9]',
    'curl "{127.0.0.1,localhost}:4[0-9][0-9][0-9]"', 'curl "http://{a,b}[0-9][0-9][0-9][0-9]:[0-9][0-9][0-9]/"', `curl "127.0.0.1:${nine}"`,
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const free = [
    'curl "http://127.0.0.1:3000/p/[000-999]/[a-z].png"', 'curl "example.com:[1-9][0-9][0-9][0-9]"', 'curl "http://example.com:[1-9][0-9][0-9][0-9]/"',
    'curl "http://127.0.0.1:3000/[a-z][a-z][a-z][a-z]/x"', 'curl "http://127.0.0.1:{3000,3001}/[a-z][a-z][a-z][a-z]/x"', 'curl "http://127.0.0.1:4[0-9]/"',
    'curl "http://example.com/img[0-9][0-9][0-9][0-9]-{a,b,c}.png"', 'echo {a,b}{c,d}[0-9][0-9][0-9][0-9]x', 'ls [a-z][a-z][a-z][a-z]',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

// 2026-11-26 shell-rest 差し戻し: 展開の括弧の中に隠れた : や @、スキームだけで決まる既定ポート、2 回目の確かめが 1 回目の仕事量を食わないこと
test('S6 展開の括弧の中に隠れた : や @ でホストとポートが決まる書き方も、全部は確かめきれないなら断る。全部確かめ終えたものと JSON は今のまま', () => {
  const reached = [
    'curl "127.0.0.1{:4,:5}[0-9][0-9][0-9]/api/pending"', 'curl 127.0.0.1{:4,:5}{0..9}{0..9}{0..9}/api/pending', 'wget 127.0.0.1{:4,:5}{0..9}{0..9}{0..9}',
    'curl "localhost{:}[0-9][0-9][0-9][0-9]"', 'curl "http://example.com:{x@127.0.0.1:4,y}[0-9][0-9][0-9]/"',
    'curl "{127.0.0.1:4,x}[0-9][0-9][0-9]"', 'curl --url="127.0.0.1{:4,:5}[0-9][0-9][0-9]"', 'curl "https://u:{p@127.0.0.1:4,q}[0-9][0-9][0-9]/"',
    'curl "http://example.com:{x@127.0.0.1:4777,y}/"',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const objects = Array.from({ length: 12 }, (_, i) => `{"id":${i},"v":${i * 2}}`).join(',');
  const free = [
    'curl "http://example.com:{a,b}[0-9][0-9][0-9]/"', 'curl "http://example.com:{80,81}[0-9][0-9][0-9]/x"', 'curl "http://example.com:{x@127.0.0.1:4,y}1/"', 'curl "127.0.0.1{:4,:5}1"',
    `curl -d '[${objects}]' http://example.com/api`, `curl -d "[${objects.replaceAll('"', '\\"')}]" http://example.com/api`, `echo '{"a":{"b":1,"c":2},"d":{"e":3,"f":4}}'`,
    `curl -d'[${objects}]' http://example.com/api`, `curl --data-raw='[${objects}]' http://example.com/api`,
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

test('S6 beat に着くのがスキームの既定ポート（http なら 80）だけのときも、ホストの括弧を展開して確かめる', () => {
  const viaDefault = { port: 4777, origins: ['http://localhost'] };
  const tails = '/{a,b}'.repeat(9);
  assert.deepEqual([`curl 'http://{x,l}{x,o}calhost${tails}'`, `curl --url='http://{x,l}{x,o}calhost${tails}'`].filter(command => selfTarget(command, viaDefault) === undefined), []);
  const free = [`curl 'http://{x,y}{x,o}calhost${tails}'`, `curl 'https://{x,l}{x,o}calhost${tails}'`, `curl 'http://{x,l}{x,o}calhosts${tails}'`];
  assert.deepEqual(free.filter(command => selfTarget(command, viaDefault) !== undefined), []);
});

test('S6 全部は確かめきれない語が先にあっても、あとの語の 1 回目の確かめの仕事量は減らない', () => {
  const nums = Array.from({ length: 400 }, (_, i) => i + 1).join(',');
  const swell = Array.from({ length: 39 }, (_, i) => `a${i}`).join(',');
  const heavy = `curl example.com:{${nums}}{${nums}}`;
  // 前の語の「ホスト:ポート」の 2 回目の確かめに仕事量を食われると、あとの語の 1 回目が仕事量不足で途中になる。あとの語が 2 回目の確かめで拾えない形（先頭が x/ の先）でも断る
  const reached = [`${heavy} 127.0.0.1{${swell},:}4777/${'p'.repeat(3300)}`, `${heavy} x/127.0.0.1{${swell},:}4777/${'p'.repeat(3300)}`];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined).map(command => command.slice(-40)), []);
});

// 2026-11-26 shell-rest 差し戻し 2: 空白を含む引用符の文（bash -c "curl …"・eval "…"）の中のホスト:ポート。縮めた JSON の除外は、文字列をシェルが読み直すときは効かない
test('S6 引用符で囲んだ文（bash -c "curl …"・eval "…"）の中のホスト:ポートも、空白などで分けた語ごとに 2 回目の確かめをする', () => {
  const reached = [
    'bash -c "curl 127.0.0.1:4[0-9][0-9][0-9]/api/pending"', 'bash -c "curl http://127.0.0.1:4[0-9][0-9][0-9]/api"', 'bash -c "curl 127.0.0.1{:4,:5}{0..9}{0..9}{0..9}/api/pending"',
    'sh -c "curl 127.0.0.1:4{0..9}{0..9}{0..9}"', 'pwsh -c "curl.exe 127.0.0.1:4[0-9][0-9][0-9]/api"', 'eval "curl 127.0.0.1{:4,:5}{0..9}{0..9}{0..9}/api"',
    `bash -c 'curl "127.0.0.1:4[0-9][0-9][0-9]"'`, 'bash -c "cd /x && curl 127.0.0.1:4[0-9][0-9][0-9]"', 'bash -c "echo hi;curl 127.0.0.1:4[0-9][0-9][0-9]"',
    'bash -c "curl -s -o /dev/null {127.0.0.1:4,x}[0-9][0-9][0-9]"', 'bash -c "curl --url=127.0.0.1:4[0-9][0-9][0-9]"',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const free = [
    'bash -c "curl http://example.com:[1-9][0-9][0-9][0-9]/"', 'bash -c "curl http://127.0.0.1:3[0-9]/x"', 'bash -c "echo {a,b}{c,d}[0-9][0-9][0-9][0-9]x"',
    'bash -c "curl http://example.com/{a,b}/[0-9][0-9][0-9][0-9]"', 'bash -c "curl localhost:3000/[a-z][a-z][a-z][a-z]/x"', 'bash -c "curl 127.0.0.1{:4,:5}1"',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

test('S6 縮めた JSON の本文でも、eval・シェルの -c・シェルへの pipe など、文字列をシェルが読み直すときは括弧の展開に読まれるので 2 回目の確かめを外さない', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `"z${i}":{"a":1,"b":2}`).join(',');
  const json = `{"x":1,"http":{"y":1,"//127.0.0.1":{${filler},"4777/api/pending?":{"q":1,"r":2}}}}`;
  const reached = [`eval echo '${json}'`, `eval curl '${json}'`, `eval curl -d '${json}'`, `echo curl '${json}' | bash`, `bash -c 'curl '"'${json}'"`, `echo curl '${json}' | sh`, `source <(echo curl '${json}')`];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined).map(command => command.slice(0, 40)), []);
  const free = [`curl -d '${json}' http://example.com/`, `echo '${json}' > l.json`, `curl --data-raw='${json}' http://example.com/api`, `node -e "console.log(1)" && curl -d '${json}' http://example.com/`];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined).map(command => command.slice(0, 40)), []);
});

// 2026-11-26 shell-rest 差し戻し 3: ホストが , や = の直後にある語、刻みが大きすぎて並べられない範囲、2 回目の確かめの仕事量の上限、JSON の除外と文字列の読み直し
test('S6 ホストが , や = の直後にある書き方（PowerShell の配列・変数への代入・here-string）も、括弧を全部は確かめきれないなら断る。手元でないホストは今のまま', () => {
  const reached = [
    'Start-Process curl.exe -ArgumentList "-s","127.0.0.1:4[0-9][0-9][0-9]/api/pending" -NoNewWindow -Wait', 'Start-Process curl.exe "-s","127.0.0.1:4[0-9][0-9][0-9]/api/pending"',
    'Start-Process curl.exe -ArgumentList:"-s","127.0.0.1:4[0-9][0-9][0-9]/api/pending"', 'Start-Process curl.exe -ArgumentList:"127.0.0.1:4[0-9][0-9][0-9]/api/pending"', `start curl.exe -ArgumentList '-s','127.0.0.1:4[0-9][0-9][0-9]/api/pending'`,
    `saps curl.exe -ArgumentList '-s','127.0.0.1:4[0-9][0-9][0-9]/api/pending'`, `Start-Process -FilePath curl.exe -ArgumentList '-s','http://127.0.0.1:4[0-9][0-9][0-9]/api/pending'`,
    `Start-Process wget.exe -ArgumentList '-qO-','127.0.0.1:4[0-9][0-9][0-9]/api/pending'`, 'Start-Process curl.exe -ArgumentList "-s","127.0.0.1:{4,5}{0..9}{0..9}{0..9}/api/pending"',
    `Invoke-Command -ScriptBlock { Start-Process curl.exe -ArgumentList '-s','127.0.0.1:4[0-9][0-9][0-9]/api/pending' }`,
    'Start-Process curl.exe -ArgumentList "-s","127.0.0.1:{5,4}{8,7}{8,7}{8,7}/api/pending?q={1..64..-1}"',
    'U=127.0.0.1:{5,4}{8,7}{8,7}{8,7}/{1..64..-1}; curl $U', 'U=127.0.0.1:{5,4}{8,7}{8,7}{8,7}/{1..64..-1}; curl "$U"', 'export U=http://127.0.0.1:{5,4}{8,7}{8,7}{8,7}/{1..64..-1}; curl $U',
    'U=127.0.0.1:4[0-9][0-9][0-9]/api/pending; curl $U', 'curl -K- <<< "url=127.0.0.1:4[0-9][0-9][0-9]/api/pending"', 'curl --config - <<< "url = http://localhost:4[0-9][0-9][0-9]/api/pending"',
    'Start-Process curl.exe -ArgumentList "-s","{","127.0.0.1:4[0-9][0-9][0-9]/api/pending"',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const free = [
    'Start-Process curl.exe -ArgumentList "-s","http://example.com:[1-9][0-9][0-9][0-9]/"', 'Start-Process curl.exe -ArgumentList "-s","http://example.com/p[0-9][0-9][0-9][0-9]"',
    'U=example.com:{1..64}{1..64}; curl $U', 'curl -K- <<< "url=http://example.com:[1-9][0-9][0-9][0-9]/"', 'Start-Process curl.exe -ArgumentList "-s","127.0.0.1:3000/p[0-9][0-9][0-9][0-9]"',
    'Start-Process curl.exe -ArgumentList "-s","-o","a[0-9][0-9][0-9][0-9].html","http://example.com/"',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

test('S6 , や = で分ける前の語もそのまま確かめる（ユーザー情報に , や = があっても、スキームの既定ポートだけで beat に着く書き方を見逃さない）', () => {
  const viaDefault = { port: 4777, origins: ['http://localhost'] };
  const tails = '/{a,b}'.repeat(9);
  const reached = [`curl 'http://u,v@{x,l}{x,o}calhost${tails}'`, `curl 'http://u=v@{x,l}{x,o}calhost${tails}'`, `curl 'http://u,v=w@{x,l}{x,o}calhost${tails}'`];
  assert.deepEqual(reached.filter(command => selfTarget(command, viaDefault) === undefined), []);
  assert.deepEqual([`curl 'http://u,v@{x,y}{x,o}calhost${tails}'`].filter(command => selfTarget(command, viaDefault) !== undefined), []);
});

test('S6 刻みや端が大きすぎて並べられない範囲は、並べずに通さず、手元のホストに付いていれば断る（正の刻みも、負の刻みも、桁の多い端も）。手元でないホスト・ホストの後ろの範囲は今のまま', () => {
  const reached = [
    'curl 127.0.0.1:{4777..4777..-9007199254740993}/api/pending', 'curl 127.0.0.1:{4777..99999999999..-99999999999}/api/pending', 'curl http://localhost:{4777..4777..-99999999999999999}/api/pending',
    'curl 127.0.0.1:{4777..12345678901..-12345678901}/api/pending', 'wget -qO- 127.0.0.1:{4777..4777..-9007199254740993}/api/pending',
    'curl 127.0.0.1:{4777..4777..9007199254740993}/api/pending', 'curl 127.0.0.1:{4777..99999999999..99999999999}/api/pending', 'curl 127.0.0.1:{0000000000000000000000000000004777..4777}/api/pending',
    'curl http://127.0.0.1:{4777..4777..-9007199254740993}/', 'Start-Process curl.exe -ArgumentList "-s","127.0.0.1:{4777..4777..-9007199254740993}/api/pending"',
  ];
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined), []);
  const free = [
    'curl http://127.0.0.1:3000/{1..99999999999..-1}', 'curl http://example.com:{4777..4777..-9007199254740993}/', 'echo {4777..4777..-9007199254740993}', 'curl http://127.0.0.1:3000/{1..99999999999}',
    'curl http://127.0.0.1:3000/{a..z..-9007199254740993}',
  ];
  assert.deepEqual(free.filter(command => selfTarget(command, beat) !== undefined), []);
});

// 2 回目の確かめは、1 つの語に使える仕事量（20,000）と、全部の語で使える仕事量（200,000）に上限がある。上限が効いているかは、あとの語が確かめきれずに断られるかで見る
test('S6 2 回目の確かめの仕事量: 1 つの語は上限までしか使えず、全部の語の合計にも上限があって、尽きたあとの手元の語は断る', () => {
  const heavy = (id: number, items: number, width: number): string => `{${Array.from({ length: items }, (_, i) => `${id}${String(i).padStart(3, '0')}`.padEnd(width, '7')).join(',')}}`;
  const victim = `127.0.0.1:{3000,3001}/${'p'.repeat(400_000)}`;
  // 1 つの語（20,000 まで）が、あとの語の分の仕事量を食わない
  const one = `curl example.com:${heavy(1, 400, 250)}/${'p'.repeat(1_000)} ${victim}`;
  assert.equal(selfTarget(one, beat), undefined);
  // 語が積み重なって全部の合計（200,000）を使い切ったあとの手元の語は、確かめきれないので断る
  const many = Array.from({ length: 14 }, (_, i) => `example.com:${heavy(i + 2, 400, 25)}/${'p'.repeat(500)}`).join(' ');
  assert.notEqual(selfTarget(`curl ${many} ${victim}`, beat), undefined);
});

test('S6 1 つの語の「ホスト:ポート」が 20,000 の仕事量では広げきれないとき、手元のホストなら断る。広げきれる語・手元でないホストは今のまま', () => {
  const ports = (last: string): string => `{${[...Array.from({ length: 400 }, (_, i) => `${1000 + i}`.padEnd(30, '0')), last].join(',')}}`;
  const pad = 'p'.repeat(1_000);
  assert.notEqual(selfTarget(`curl 127.0.0.1:${ports('4777')}/${pad}`, beat), undefined);
  assert.equal(selfTarget(`curl example.com:${ports('4777')}/${pad}`, beat), undefined);
  assert.equal(selfTarget(`curl 127.0.0.1:{3000,3001}/${'p'.repeat(310_000)}`, beat), undefined);
  assert.notEqual(selfTarget(`curl 127.0.0.1:{4776,4777}/${'p'.repeat(310_000)}`, beat), undefined);
});

test('S6 同じ語が JSON の引用と JSON でない書き方の両方で出てくるときは、JSON としては除外しない。JSON の中に bash・eval という文字があるだけでは、文字列を読み直すとは数えない', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `"z${i}":{"a":1,"b":2}`).join(',');
  const json = `{"x":1,"http":{"y":1,"//127.0.0.1":{${filler},"4777/api/pending?":{"q":1,"r":2}}}}`;
  assert.notEqual(selfTarget(`curl -d '${json}' http://example.com/; echo ${json}`, beat), undefined);
  assert.notEqual(selfTarget(`echo ${json}; curl -d '${json}' http://example.com/`, beat), undefined);
  const shells = json.replace('{"x":1,', '{"x":1,"shell":"bash","run":"eval","cmd":"powershell",');
  assert.equal(selfTarget(`curl -d '${shells}' http://example.com/`, beat), undefined);
  assert.equal(selfTarget(`curl -d '${shells}' http://example.com/refresh`, beat), undefined);
});

test('S6 JSON の外にシェルの名前（rbash・mksh・ksh93・oksh・posh・yash・ash・bash5・bash-5.2・sh5・/bin/bash・$SHELL・env bash）があれば、文字列を読み直すので JSON の除外を外す', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `"z${i}":{"a":1,"b":2}`).join(',');
  const json = `{"x":1,"http":{"y":1,"//127.0.0.1":{${filler},"4777/api/pending?":{"q":1,"r":2}}}}`;
  const names = ['rbash', 'mksh', 'ksh93', 'oksh', 'loksh', 'pdksh', 'lksh', 'posh', 'yash', 'ash', 'bash5', 'zsh5', 'bash-5.2', 'sh5', '/bin/bash', '/usr/bin/env bash', 'dash.exe', '$SHELL', '"${SHELL}"', 'fish', 'csh'];
  const reached = names.map(name => `echo curl '${json}' | ${name}`);
  assert.deepEqual(reached.filter(command => selfTarget(command, beat) === undefined).map(command => command.slice(-30)), []);
  assert.deepEqual(['rbash', 'ksh93'].map(name => `${name} -c 'curl '"'${json}'"`).filter(command => selfTarget(command, beat) === undefined).map(command => command.slice(0, 20)), []);
});

test('S6 JSON が何万語あっても、シェルの読み直しがあるかの確かめは語の数に 2 乗では増えない', () => {
  const words = Array.from({ length: 40_000 }, (_, i) => `'{"id":${i},"v":{"a":${i * 2},"b":[1,2]}}'`).join(' ');
  const started = performance.now();
  assert.equal(selfTarget(`curl -d ${words} http://example.com/`, beat), undefined);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `${Math.round(elapsed)}ms`);
});
