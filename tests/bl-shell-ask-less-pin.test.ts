import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerKeysOf, REASON_ORDER } from '../src/tools/hooks/decision-order.ts';
import { outboundOf, type OutboundEnv } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const ENV: OutboundEnv = { isTracked: () => false, isClean: () => false, isCreated: () => false, pushUrls: () => undefined, pushRemote: () => undefined };

function repoRig(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = realish(tempDir(t));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', 'feature');
  const verdict = (command: string) => {
    const checked = checkShellCommand(command, root, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
    const out = outboundOf({ tool: 'shell', statements: checked.statements }, ENV);
    return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds, outbound: out?.kind ?? 'none' };
  };
  return { root, verdict };
}

test('L72 の今の線を固定する: 製品の外の git switch / git checkout <ブランチ> を聞いているのは list.git_moves（今回だけ・code）と list.git_write（確かめ）で、どちらも判定役の段（持ち主へは行かない）', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = repoRig(t);
  for (const command of ['git switch feature', 'git checkout feature', 'git checkout -b topic', 'git switch -c topic']) {
    const v = r.verdict(command);
    assert.equal(v.decision, 'ask', command);
    assert.deepEqual([...v.keys].sort(), ['list.git_moves', 'list.git_write'], command);
    assert.ok(v.kinds.includes('code') && v.kinds.includes('git_write'), `${command}: ${v.kinds.join(',')}`);
    assert.equal(v.outbound, 'none', `${command}: ファイルを捨てない形は送る・消すに数えない`);
    assert.deepEqual(v.keys.map(k => REASON_ORDER.get(k)), [5, 5], `${command}: 判定役の段`);
    assert.deepEqual(ownerKeysOf(v.keys), [], `${command}: 持ち主の鍵は無い`);
  }
});

test('L72 の対照: ファイルを捨てる形（checkout -- . ・reset --hard ・-f ・--discard-changes ・パスを書いた checkout）は、ブランチの切り替えの確かめに加えて「消す」（持ち主へ）になる', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = repoRig(t);
  for (const command of ['git checkout -- .', 'git checkout .', 'git checkout feature -- a.txt', 'git checkout a.txt', 'git checkout -f feature', 'git switch -f feature', 'git switch --discard-changes feature', 'git reset --hard', 'git restore a.txt']) {
    const v = r.verdict(command);
    assert.equal(v.decision, 'ask', command);
    assert.equal(v.outbound, 'delete', command);
  }
});

test('L72 の今の線: 設定が変なリポジトリ（core.fsmonitor）での git switch は、持ち主の鍵（list.git_config）で持ち主へ行く', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = repoRig(t);
  execFileSync('git', ['config', 'core.fsmonitor', './evil.sh'], { cwd: r.root });
  const v = r.verdict('git switch feature');
  assert.equal(v.decision, 'ask');
  assert.deepEqual(ownerKeysOf(v.keys), ['list.git_config']);
});

test('L72 の今の線: 製品の外の .npmrc があると npm -v は list.npm_rc（今回だけ・code）で判定役の段。.npmrc が無ければ許す', t => {
  const root = realish(tempDir(t));
  mkdirSync(join(root, 'sub'));
  const verdict = (command: string) => {
    const checked = checkShellCommand(command, root, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
    return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds };
  };
  assert.equal(verdict('npm -v').decision, 'allow');
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const harmless = verdict('npm -v');
  assert.equal(harmless.decision, 'ask');
  assert.deepEqual(harmless.keys, ['list.npm_rc']);
  assert.ok(harmless.kinds.includes('code'));
  assert.equal(REASON_ORDER.get('list.npm_rc'), 5);
  writeFileSync(join(root, '.npmrc'), 'script-shell=./evil.sh\nnode-options=--require ./evil.js\n');
  const dangerous = verdict('npm -v');
  assert.equal(dangerous.decision, 'ask');
  assert.deepEqual(dangerous.keys, ['list.npm_rc']);
});

test('L72 (b) の目標（未着手: 根は allowlist-tools.ts と tool-config.ts で、B5 の持ち場の外）: コードを動かす項目の無い .npmrc では npm -v を聞かない', { todo: 'B5 の持ち場の外: src/tools/hooks/allowlist-tools.ts:620 の langInfo が .npmrc の中身を読まずに聞いている' }, t => {
  const root = realish(tempDir(t));
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const checked = checkShellCommand('npm -v', root, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
  assert.equal(checked.decision, 'allow');
});
