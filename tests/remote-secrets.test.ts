import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HIDDEN_URL, readRemotes, withoutSecrets } from '../src/projects/remotes.ts';
import { tempDir } from './helpers.ts';

const ORDINARY: ReadonlyArray<readonly [string, string]> = [
  ['https://host.example/a/b.git', 'https://host.example/a/b.git'],
  ['https://user:pw@host.example/a/b.git', 'https://host.example/a/b.git'],
  ['https://token@host.example/a/b.git', 'https://host.example/a/b.git'],
  ['https://user:p@ss@host.example/a/b.git', 'https://host.example/a/b.git'],
  ['https://host.example/a/b.git?x=1#frag', 'https://host.example/a/b.git'],
  ['https://host.example:8443/a/b.git', 'https://host.example:8443/a/b.git'],
  ['https://host.example/@scope/b.git', 'https://host.example/@scope/b.git'],
  ['https://localhost:3000/@scope/b.git', 'https://localhost:3000/@scope/b.git'],
  ['https://[::1]:8443/a/b.git', 'https://[::1]:8443/a/b.git'],
  ['ssh://git@host.example/a/b.git', 'ssh://host.example/a/b.git'],
  ['ssh://git@host.example:2222/a/b.git', 'ssh://host.example:2222/a/b.git'],
  ['file:///srv/git/a.git', 'file:///srv/git/a.git'],
  ['git@host.example:a/b.git', 'git@host.example:a/b.git'],
  ['host.example:a/b.git', 'host.example:a/b.git'],
  ['user:pw@host.example:a/b.git', 'host.example:a/b.git'],
  ['C:/repos/a@b', 'C:/repos/a@b'],
  ['C:\\repos\\a@b', 'C:\\repos\\a@b'],
  ['/srv/git/a@b.git', '/srv/git/a@b.git'],
  ['../sibling.git', '../sibling.git'],
];

const REVIEWED: ReadonlyArray<readonly [string, string]> = [
  ['https://git.example:8443/o/r.git?user=me@corp.example&private_token=SECRETTOKEN', 'https://git.example:8443/o/r.git'],
  ['https://evil.example:443/x@github.com/owner/repo.git', 'https://evil.example:443/x@github.com/owner/repo.git'],
  ['evil.example:x@github.com:owner/repo.git', HIDDEN_URL],
  ['https://git.example:8443/org/pkg@1.0.git', 'https://git.example:8443/org/pkg@1.0.git'],
  ['https://u@host/a?x@y/SECRET', HIDDEN_URL],
  ['https://u@host.example/a?x@y/SECRET', 'https://host.example/a'],
];

const UNCLEAR: readonly string[] = [
  'https://user:pa/ss@host.example/a/b.git',
  'https://user:pa#ss@host.example/a/b.git',
  'https://user:pa?ss@host.example/a/b.git',
  'https://user:p@ss/w#rd@host.example/a/b.git',
  'ssh://git:pa/ss@host.example:2222/a/b.git',
  'john.doe:pw@host.example:a/b.git',
  'user:pa/ss@host.example:a/b.git',
  'https://SECRET/x@host/a.git',
  'https://SECRET?x@host/a.git',
  '  https://u:SECRET@host/a',
  '//u:SECRET@host/a',
  'https:///u:SECRET@host/a',
  'u/x:SECRET@host:a',
  'u@host:a/b?token=SECRET',
  'https://ghp_SECRET/x@host.example/a.git',
];

test('送り先の URL: ふつうの形は、利用者の部分と ? 以降だけを落とす', () => {
  for (const [url, shown] of ORDINARY) assert.equal(withoutSecrets(url), shown, url);
});

test('送り先の URL: 落とすのはホストの前の部分だけ。パスや ? 以降の @ で、ホストを取り違えない', () => {
  for (const [url, shown] of REVIEWED) assert.equal(withoutSecrets(url), shown, url);
});

test('送り先の URL: どこまでが利用者の部分か決められない形は、当て推量で切らずに丸ごと隠す', () => {
  for (const url of UNCLEAR) assert.equal(withoutSecrets(url), HIDDEN_URL, url);
});

test('送り先の URL: 設定ファイルから読んだ remote に、? 以降の鍵も、取り違えたホストも残らない', t => {
  const root = tempDir(t);
  const git = join(root, '.git');
  mkdirSync(join(git, 'objects'), { recursive: true });
  mkdirSync(join(git, 'refs'), { recursive: true });
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(git, 'config'), [
    '[remote "a"]', '\turl = "https://git.example:8443/o/r.git?user=me@corp.example&private_token=SECRETTOKEN"',
    '[remote "b"]', '\turl = https://evil.example:443/x@github.com/owner/repo.git',
    '[remote "c"]', '\turl = evil.example:x@github.com:owner/repo.git',
    '[remote "d"]', '\turl = https://user:pa/ss@host.example/a/b.git',
    '',
  ].join('\n'));
  const remotes = readRemotes(root);
  assert.deepEqual(remotes.map(r => [r.name, r.url]), [
    ['a', 'https://git.example:8443/o/r.git'],
    ['b', 'https://evil.example:443/x@github.com/owner/repo.git'],
    ['c', HIDDEN_URL],
    ['d', HIDDEN_URL],
  ]);
  assert.equal(/SECRETTOKEN|pa\/ss/u.test(JSON.stringify(remotes)), false);
});
