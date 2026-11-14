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
