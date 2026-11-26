import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerKeysOf, REASON_ORDER } from '../src/tools/hooks/decision-order.ts';
import { outboundOf, type OutboundEnv } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { npmRcRunsCode } from '../src/tools/hooks/tool-config.ts';
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

test('L72 の今の線: コードを動かす項目のある .npmrc があると npm -v は list.npm_rc（今回だけ・code）で判定役の段。.npmrc が無ければ、無害な .npmrc だけでも許す', t => {
  const root = realish(tempDir(t));
  mkdirSync(join(root, 'sub'));
  const verdict = (command: string) => {
    const checked = checkShellCommand(command, root, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
    return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds };
  };
  assert.equal(verdict('npm -v').decision, 'allow');
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  assert.equal(verdict('npm -v').decision, 'allow', '無害な .npmrc（registry だけ）');
  writeFileSync(join(root, '.npmrc'), 'script-shell=./evil.sh\nnode-options=--require ./evil.js\n');
  const dangerous = verdict('npm -v');
  assert.equal(dangerous.decision, 'ask');
  assert.deepEqual(dangerous.keys, ['list.npm_rc']);
  assert.ok(dangerous.kinds.includes('code'));
  assert.equal(REASON_ORDER.get('list.npm_rc'), 5);
});

const npmVerdict = (root: string, command: string, cwd: string = root) => {
  const checked = checkShellCommand(command, cwd, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
  return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds, text: JSON.stringify(checked) };
};

// A project .npmrc that only has registry, auth lines and comments does not make `npm -v` ask. The token value is never read into a reason
const HARMLESS_RC: Record<string, string> = {
  registry: 'registry=https://registry.npmjs.org/\n',
  scoped: '@acme:registry=https://npm.example.com/\n//npm.example.com/:_authToken=npm_SECRETVALUE123\nalways-auth=true\n',
  flags: 'save-exact=true\nengine-strict = true\nlegacy-peer-deps=true\nfund=false\n',
  comments: '# nothing here\n; nor here\nregistry=https://registry.npmjs.org/\r\n',
};
// Every form that names a program or a module npm would run, or that is not a plain key, keeps asking
const CODE_RC: Record<string, string> = {
  'script-shell': 'script-shell=./evil.sh\n',
  'node-options': 'node-options=--require ./evil.js\n',
  'onload-script': 'onload-script=./evil.js\n',
  'with a harmless line': 'registry=https://r.example/\nscript-shell=./evil.sh\n',
  'upper case and underscore': 'Script_Shell=./evil.sh\n',
  'spaces around': '   script-shell   =   ./evil.sh\n',
  'no value': 'script-shell\n',
  'quoted key': '"script-shell"=./evil.sh\n',
  'section header': '[x]\nscript-shell=./evil.sh\n',
  'array key': 'script-shell[]=./evil.sh\n',
  'expanded key': '${KEY}=./evil.sh\n',
  'byte order mark': '﻿node-options=--require ./evil.js\n',
};

test('L72 (b): コードを動かす項目の無い .npmrc（registry・認証・コメントだけ）では npm -v・npm --version を聞かない。トークンの値は理由にも出ない', t => {
  for (const [name, body] of Object.entries(HARMLESS_RC)) {
    const root = realish(tempDir(t));
    writeFileSync(join(root, '.npmrc'), body);
    for (const command of ['npm -v', 'npm --version']) {
      const v = npmVerdict(root, command);
      assert.equal(v.decision, 'allow', `${name}: ${command}: ${v.keys.join(',')}`);
      assert.ok(!v.text.includes('SECRETVALUE'), name);
    }
  }
});

test('L72 (b): コードを動かす項目（script-shell・node-options・onload-script）や、素直な名前でない行がある .npmrc では npm -v を今も聞く（list.npm_rc・今回だけ・code）', t => {
  for (const [name, body] of Object.entries(CODE_RC)) {
    const root = realish(tempDir(t));
    writeFileSync(join(root, '.npmrc'), body);
    for (const command of ['npm -v', 'npm --version']) {
      const v = npmVerdict(root, command);
      assert.equal(v.decision, 'ask', `${name}: ${command}`);
      assert.deepEqual(v.keys, ['list.npm_rc'], `${name}: ${command}`);
      assert.ok(v.kinds.includes('code'), name);
    }
    assert.equal(npmRcRunsCode(join(root, '.npmrc')), true, name);
  }
  for (const [name, body] of Object.entries(HARMLESS_RC)) {
    const root = realish(tempDir(t));
    writeFileSync(join(root, '.npmrc'), body);
    assert.equal(npmRcRunsCode(join(root, '.npmrc')), false, name);
  }
});

test('L72 (b): 緩めるのは npm -v・npm --version だけ。ほかの npm（ls・view・test・install・-v に別の語）は、無害な .npmrc でも今のまま list.npm_rc で聞く', t => {
  const root = realish(tempDir(t));
  writeFileSync(join(root, '.npmrc'), HARMLESS_RC.scoped!);
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node t.js"}}');
  for (const command of ['npm ls', 'npm view left-pad', 'npm outdated', 'npm test', 'npm run test', 'npm install', 'npm -v --json', 'npm --version --foo']) {
    const v = npmVerdict(root, command);
    assert.equal(v.decision, 'ask', command);
    assert.ok(v.keys.includes('list.npm_rc'), `${command}: ${v.keys.join(',')}`);
  }
});

test('L72 (b): 近くの .npmrc が無害でも、上のフォルダの .npmrc にコードを動かす項目があれば、npm -v を聞く（npm がどの .npmrc を読むか決めきれない）', t => {
  const root = realish(tempDir(t));
  const child = join(root, 'child');
  mkdirSync(child);
  writeFileSync(join(root, '.npmrc'), 'script-shell=./evil.sh\n');
  writeFileSync(join(child, '.npmrc'), 'registry=https://r.example/\n');
  const near = npmVerdict(root, 'npm -v', child);
  assert.equal(near.decision, 'ask');
  assert.deepEqual(near.keys, ['list.npm_rc']);
  assert.equal(npmVerdict(root, 'cd child && npm -v').decision, 'ask');
  writeFileSync(join(root, '.npmrc'), 'registry=https://r.example/\n');
  assert.equal(npmVerdict(root, 'npm -v', child).decision, 'allow');
});

test('L72 (b): .npmrc を読めない・決められない形は聞く（行き先が変数の cd・同じコマンドで先に .npmrc を書く・大きすぎる）', t => {
  const root = realish(tempDir(t));
  writeFileSync(join(root, '.npmrc'), 'registry=https://r.example/\n');
  assert.equal(npmVerdict(root, 'npm -v').decision, 'allow');
  assert.deepEqual(npmVerdict(root, 'cd $WHERE; npm -v').keys.filter(k => k.startsWith('list.npm_rc')), ['list.npm_rc_unknown']);
  assert.deepEqual(npmVerdict(root, 'echo x > .npmrc; npm -v').keys.filter(k => k.startsWith('list.npm_rc')), ['list.npm_rc_unknown']);
  writeFileSync(join(root, '.npmrc'), `registry=https://r.example/\n#${'x'.repeat(1_100_000)}\n`);
  assert.deepEqual(npmVerdict(root, 'npm -v').keys, ['list.npm_rc']);
  assert.equal(npmRcRunsCode(join(realish(tempDir(t)), 'missing', '.npmrc')), false, '.npmrc がどこにも無ければ、コードを動かすとは言わない');
});
