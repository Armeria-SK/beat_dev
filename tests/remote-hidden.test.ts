import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN_URL, recordedUrls, type Remote } from '../src/projects/remotes.ts';
import { pushProblem, type PushEnv } from '../src/tools/hooks/push-target.ts';
import type { StatementFacts } from '../src/tools/hooks/shell-guard.ts';
import { trustedOf } from '../src/tools/pipeline.ts';
import type { ToolContext } from '../src/tools/types.ts';

// 「(hidden)」は、見せないという印であって、本物の送り先ではない。控えの送り先として数えない

const word = (text: string) => ({ text, dynamic: false, glob: false });
const push = (cwd = '/prod'): StatementFacts => ({
  program: 'git', programDynamic: false, programOdd: false, words: ['git', 'push', 'origin'].map(word), urls: [], env: [], gitGlobal: [], code: [], codeDynamic: false, stdin: false, shapes: [],
  reasonKeys: [], deletes: false, targets: [], writes: [], cwd,
});
const envOf = (remotes: readonly Remote[], urls: readonly string[]): PushEnv => ({ remotes, pushUrls: () => urls, pushRemote: () => 'origin' });

test('(hidden) 審査: git push の宛先の照らしは、控えの (hidden) を本物の宛先として数えない', () => {
  const clean: Remote[] = [{ name: 'origin', url: 'https://host.example/a/b.git', pushUrl: null }];
  assert.equal(pushProblem(push(), 1, [], envOf(clean, ['https://host.example/a/b.git'])), undefined, '前提: 控えと同じ宛先は通る');
  // いまの git の設定の宛先が、たまたま「(hidden)」という名前のローカルの道でも、控えの「見せない」印とは照らさない
  const hidden: Remote[] = [{ name: 'origin', url: HIDDEN_URL, pushUrl: null }];
  assert.deepEqual(pushProblem(push(), 1, [], envOf(hidden, [HIDDEN_URL])), { key: 'send.push_target', remote: 'origin' });
  const hiddenPush: Remote[] = [{ name: 'origin', url: 'https://host.example/a/b.git', pushUrl: HIDDEN_URL }];
  assert.deepEqual(pushProblem(push(), 1, [], envOf(hiddenPush, [HIDDEN_URL])), { key: 'send.push_target', remote: 'origin' }, 'pushUrl の (hidden) も同じ');
  assert.equal(pushProblem(push(), 1, [], envOf(hiddenPush, ['https://host.example/a/b.git'])), undefined, '控えの他の宛先はそのまま使える');
});

test('(hidden) 審査: 判定役へ渡す「信用する宛先」に、(hidden) を入れない', () => {
  const ctx = (remotes: readonly Remote[]): ToolContext => ({ project: { id: 'p1', root: '/prod' }, services: { projects: { get: () => ({ remotes: JSON.stringify(remotes) }) } } }) as unknown as ToolContext;
  const remotes: Remote[] = [
    { name: 'origin', url: 'https://host.example/a/b.git', pushUrl: HIDDEN_URL },
    { name: 'odd', url: HIDDEN_URL, pushUrl: null },
    { name: 'mirror', url: 'git@host.example:a/b.git', pushUrl: null },
  ];
  assert.deepEqual(trustedOf(ctx(remotes)), ['https://host.example/a/b.git', 'git@host.example:a/b.git']);
  assert.deepEqual(trustedOf(ctx([{ name: 'odd', url: HIDDEN_URL, pushUrl: null }])), []);
});

test('(hidden) 審査: recordedUrls は url と pushUrl の並びから (hidden) だけを落とす', () => {
  assert.deepEqual(recordedUrls([{ name: 'a', url: 'u1', pushUrl: 'u2' }, { name: 'b', url: HIDDEN_URL, pushUrl: HIDDEN_URL }, { name: 'c', url: 'u3', pushUrl: null }]), ['u1', 'u2', 'u3']);
});
