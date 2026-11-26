import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStatements, noRepo } from '../src/tools/hooks/allowlist.ts';
import { ownerKeysOf, REASON_ORDER } from '../src/tools/hooks/decision-order.ts';
import { outboundOf, type OutboundEnv } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { npmRcHarmless } from '../src/tools/hooks/tool-config.ts';
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

test('L72 の今の線: .npmrc に表にない項目（prefix・script-shell など）があると npm -v は list.npm_rc（今回だけ・code）で判定役の段。.npmrc が無ければ、無害な項目だけの .npmrc でも許す', t => {
  const root = realish(tempDir(t));
  mkdirSync(join(root, 'sub'));
  const verdict = (command: string) => {
    const checked = checkShellCommand(command, root, { shell: 'bash', windows: false, outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
    return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds };
  };
  assert.equal(verdict('npm -v').decision, 'allow');
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  assert.equal(verdict('npm -v').decision, 'allow', '無害な .npmrc（registry だけ）');
  writeFileSync(join(root, '.npmrc'), 'prefix=.\nscript-shell=./evil.sh\nnode-options=--require ./evil.js\n');
  const dangerous = verdict('npm -v');
  assert.equal(dangerous.decision, 'ask');
  assert.deepEqual(dangerous.keys, ['list.npm_rc']);
  assert.ok(dangerous.kinds.includes('code'));
  assert.equal(REASON_ORDER.get('list.npm_rc'), 5);
});

const npmVerdict = (root: string, command: string, cwd: string = root, shell: 'bash' | 'powershell' = 'bash') => {
  const checked = checkShellCommand(command, cwd, { shell, windows: shell === 'powershell', outsideRoots: 'ask', policy: { roots: [{ path: root, mode: 'write' }], deny: [] } });
  return { decision: checked.decision, keys: checked.reasonKeys, kinds: checked.askKinds, text: JSON.stringify(checked) };
};

// npm -v は、名前を確かめ済みの無害な項目（registry・認証・いくつかの旗）と空行・コメントだけの .npmrc では聞かない。トークンの値は読まず、理由にも出ない
const HARMLESS_RC: Record<string, string> = {
  registry: 'registry=https://registry.npmjs.org/\n',
  scoped: '@acme:registry=https://npm.example.com/\n//npm.example.com/:_authToken=npm_SECRETVALUE123\n//npm.example.com/:_auth=Zm9v\n//npm.example.com/:username=u\n//npm.example.com/:_password=cGFzcw==\n//npm.example.com/:email=a@b.example\nalways-auth=true\n',
  'host with port and path': '//localhost:4873/org/team/:_authToken=npm_SECRETVALUE123\n',
  flags: 'save-exact=true\nsave-prefix=~\nengine-strict = true\nfund=false\naudit=false\nprogress=false\nloglevel=warn\nstrict-ssl=true\n',
  comments: '# nothing here\n; nor here\nregistry=https://registry.npmjs.org/\r\n',
  'lone CR between harmless lines': 'registry=https://registry.npmjs.org/\rfund=false\n',
};
// 表にない名前・素直でない形は、何であっても聞く（実機で、prefix・userconfig・globalconfig は npm.cmd の起動でリポジトリのコードを動かすと確かめた）
const NOT_HARMLESS_RC: Record<string, string> = {
  prefix: 'prefix=.\n',
  'prefix to a folder': 'prefix=./tools\n',
  userconfig: 'userconfig=./rc2\n',
  globalconfig: 'globalconfig=./rc2\n',
  cafile: 'cafile=./ca.pem\n',
  'script-shell': 'script-shell=./evil.sh\n',
  'node-options': 'node-options=--require ./evil.js\n',
  'onload-script': 'onload-script=./evil.js\n',
  'unknown key': 'some-new-key=1\n',
  'a flag that is not on the list': 'legacy-peer-deps=true\n',
  'with a harmless line': 'registry=https://r.example/\nprefix=.\n',
  'upper case': 'Prefix=.\n',
  'upper case of a listed key': 'Registry=https://r.example/\n',
  'underscore for a dash': 'save_exact=true\n',
  'spaces around': '   prefix   =   .\n',
  'no value': 'prefix\n',
  'quoted key': '"prefix"=.\n',
  'single quoted key': "'prefix'=.\n",
  'section header': '[x]\nprefix=.\n',
  'array key': 'prefix[]=.\n',
  'expanded key': '${KEY}=.\n',
  'byte order mark': '﻿prefix=.\n',
  'lone CR hides a key': 'registry=https://r.example/\rprefix=.\n',
  'lone CR after a comment': '# note\rprefix=.\n',
  CRLF: 'registry=https://r.example/\r\nprefix=.\r\n',
  'auth key with another suffix': '//npm.example.com/:prefix=.\n',
  'scope key with another suffix': '@acme:prefix=.\n',
  'inline comment in the key': 'prefix;x=.\n',
};

test('L72 (b): 無害と確かめた項目の名前だけの .npmrc（registry・認証・いくつかの旗・コメント）では npm -v・npm --version を聞かない。トークンの値は理由にも出ない', t => {
  for (const [name, body] of Object.entries(HARMLESS_RC)) {
    const root = realish(tempDir(t));
    writeFileSync(join(root, '.npmrc'), body);
    for (const command of ['npm -v', 'npm --version']) {
      for (const shell of ['bash', 'powershell'] as const) {
        const v = npmVerdict(root, command, root, shell);
        assert.equal(v.decision, 'allow', `${name}: ${command} (${shell}): ${v.keys.join(',')}`);
        assert.ok(!v.text.includes('SECRETVALUE'), name);
      }
    }
    assert.equal(npmRcHarmless([join(root, '.npmrc')]), true, name);
  }
});

test('L72 (b): 表にない項目（prefix・userconfig・globalconfig・cafile・知らない名前）や素直でない行（引用符・節・[] ・${}・BOM・改行の CR だけ）が 1 つでもある .npmrc では、npm -v を今も聞く（list.npm_rc・今回だけ・code）', t => {
  for (const [name, body] of Object.entries(NOT_HARMLESS_RC)) {
    const root = realish(tempDir(t));
    writeFileSync(join(root, '.npmrc'), body);
    for (const command of ['npm -v', 'npm --version']) {
      for (const shell of ['bash', 'powershell'] as const) {
        const v = npmVerdict(root, command, root, shell);
        assert.equal(v.decision, 'ask', `${name}: ${command} (${shell})`);
        assert.deepEqual(v.keys, ['list.npm_rc'], `${name}: ${command} (${shell})`);
        assert.ok(v.kinds.includes('code'), name);
      }
    }
    assert.equal(npmRcHarmless([join(root, '.npmrc')]), false, name);
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

test('L72 (b): 近くの .npmrc が無害でも、上のフォルダの .npmrc に表にない項目があれば、npm -v を聞く（npm がどの .npmrc を読むか決めきれない）', t => {
  const root = realish(tempDir(t));
  const child = join(root, 'child');
  mkdirSync(child);
  writeFileSync(join(root, '.npmrc'), 'prefix=.\n');
  writeFileSync(join(child, '.npmrc'), 'registry=https://r.example/\n');
  const near = npmVerdict(root, 'npm -v', child);
  assert.equal(near.decision, 'ask');
  assert.deepEqual(near.keys, ['list.npm_rc']);
  assert.equal(npmVerdict(root, 'cd child && npm -v').decision, 'ask');
  writeFileSync(join(root, '.npmrc'), 'registry=https://r.example/\n');
  assert.equal(npmVerdict(root, 'npm -v', child).decision, 'allow');
});

test('L72 (b): cd した先の .npmrc も数える。入口の .npmrc が無害でも、cd 先の .npmrc に表にない項目があれば npm -v を聞く（入口の側に cd しなければ聞かない）', t => {
  const root = realish(tempDir(t));
  const child = join(root, 'child');
  mkdirSync(child);
  writeFileSync(join(root, '.npmrc'), 'registry=https://r.example/\n');
  writeFileSync(join(child, '.npmrc'), 'prefix=.\n');
  for (const command of ['cd child && npm -v', 'cd child; npm --version', 'pushd child && npm -v', 'cd child && cd .. && npm -v']) {
    const v = npmVerdict(root, command);
    assert.equal(v.decision, 'ask', command);
    assert.ok(v.keys.includes('list.npm_rc'), `${command}: ${v.keys.join(',')}`);
  }
  assert.equal(npmVerdict(root, 'cd child; npm -v', root, 'powershell').decision, 'ask', 'PowerShell でも同じ');
  assert.equal(npmVerdict(root, 'Set-Location child; npm --version', root, 'powershell').decision, 'ask', 'Set-Location でも同じ');
  assert.equal(npmVerdict(root, 'npm -v').decision, 'allow', 'cd しなければ、入口の .npmrc だけが読まれる');
  assert.equal(npmVerdict(root, 'npm -v', child).decision, 'ask', 'cd 先から始めても同じ');
  writeFileSync(join(child, '.npmrc'), 'registry=https://c.example/\n');
  assert.equal(npmVerdict(root, 'cd child && npm -v').decision, 'allow', 'どちらも無害なら聞かない');
});

test('L72 (b): .npmrc を読めない・決められない形は聞く（行き先が変数の cd・同じコマンドで先に .npmrc を書く・大きすぎる）', t => {
  const root = realish(tempDir(t));
  writeFileSync(join(root, '.npmrc'), 'registry=https://r.example/\n');
  assert.equal(npmVerdict(root, 'npm -v').decision, 'allow');
  assert.deepEqual(npmVerdict(root, 'cd $WHERE; npm -v').keys.filter(k => k.startsWith('list.npm_rc')), ['list.npm_rc_unknown']);
  assert.deepEqual(npmVerdict(root, 'echo x > .npmrc; npm -v').keys.filter(k => k.startsWith('list.npm_rc')), ['list.npm_rc_unknown']);
  writeFileSync(join(root, '.npmrc'), `registry=https://r.example/\n#${'x'.repeat(1_100_000)}\n`);
  assert.deepEqual(npmVerdict(root, 'npm -v').keys, ['list.npm_rc']);
  assert.equal(npmRcHarmless([join(realish(tempDir(t)), 'missing', '.npmrc')]), true, '.npmrc がどこにも無ければ、読まれるものが無い');
});

test('L72 (b): 許可の表（allowlist-tools.ts）は、渡された harmless が true のときだけ npm -v・--version を許す（未設定・false は聞く）', () => {
  const levelWith = (command: string, rc: { file: string; harmless?: boolean }) =>
    classifyStatements(command, { shell: 'bash', windows: false, repo: noRepo, selfHosts: [], toolConfig: tool => (tool === 'npm' ? rc : undefined) }).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));
  const file = '/h/.npmrc';
  for (const form of ['npm -v', 'npm --version']) {
    assert.deepEqual(levelWith(form, { file, harmless: true }), [], `${form} harmless:true`);
    assert.deepEqual(levelWith(form, { file, harmless: false }), ['once:list.npm_rc'], `${form} harmless:false`);
    assert.deepEqual(levelWith(form, { file }), ['once:list.npm_rc'], `${form} harmless 未設定`);
  }
  assert.ok(levelWith('npm ls', { file, harmless: true }).includes('once:list.npm_rc'));
  assert.ok(levelWith('npm -v --json', { file, harmless: true }).includes('once:list.npm_rc'));
});
