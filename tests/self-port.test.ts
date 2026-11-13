import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfTarget } from '../src/tools/hooks/self-port.ts';

const server = { port: 4790, origins: ['http://127.0.0.1:4791', 'https://box.tail1234.ts.net'] };

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
  for (const config of [server]) assert.deepEqual(PINNED.filter(command => selfTarget(command, config) === undefined), []);
  const hosts = [
    'curl https://box.tail1234.ts.net/api/pending/1/approve',
    'curl https://box.tail1234.ts.net:8443/api/pending',
    'curl https://box.tail1234.ts.net./api/pending',
    'curl https://box%2etail1234%2ets%2enet/api/pending',
    'curl "https://ｂｏｘ.tail1234.ts.net/api/pending"',
  ];
  assert.deepEqual(hosts.filter(command => selfTarget(command, server) === undefined), []);
});
