import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStatements, noRepo, type MatchCtx } from '../src/tools/hooks/allowlist.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import type { ShellKind } from '../src/tools/hooks/shell-lex.ts';
import { tempDir } from './helpers.ts';

const winCtx = (shell: ShellKind): MatchCtx => ({
  shell, windows: true, repo: noRepo, selfHosts: [],
  external: (n: string) => ({ ok: true, ext: /^(?:npm|pnpm|yarn)$/u.test(n) ? '.cmd' : '.exe', detail: '' }),
  fileExists: (p: string) => /(?:cmd|conhost)\.exe$/iu.test(p),
});
const keysOf = (command: string, shell: ShellKind = 'powershell'): string[] => classifyStatements(command, winCtx(shell)).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put('SOUL.md'); put('notes.md'); put('skills/a/SKILL.md'); put('docs/readme.md'); put('.env', 'SECRET=1');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell', extra: Partial<ShellGuardOptions> = {}) =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', language: 'en', allow: ['ln', 'cp', 'cmd', 'mklink', 'fsutil', 'gsudo', 'conhost'], ...extra });
  return { bash: (c: string) => run(c, 'bash'), ps: (c: string) => run(c, 'powershell') };
}

test('179: conhost から起こす cmd の中身も、cmd /c と同じ調べを受ける（実行時に決まる引数は止め、cmd の記号は今回だけ）', () => {
  for (const c of [
    'conhost cmd /c npm view $a', 'conhost.exe cmd /c npm view $a', 'C:\\Windows\\System32\\conhost.exe cmd /c npm view $a', 'conhost --headless cmd /c npm view $a',
    'conhost --width $w cmd /c "x & y"', 'conhost npm $a', 'conhost build.bat "a&b"', 'conhost $p $a', 'Start-Process conhost -ArgumentList "cmd /c $a"', "Start-Process conhost -ArgumentList 'cmd /c x&y'",
  ]) assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  for (const c of ['conhost cmd /c "npm view x & calc"', 'conhost.exe cmd /c "a && b"', 'conhost --headless cmd /c "echo a > b.txt"']) {
    assert.ok(keysOf(c).includes('once:list.cmd_syntax'), `${c}: ${keysOf(c).join(' ')}`);
    assert.ok(!keysOf(c).includes('deny:list.winargs'), c);
  }
  assert.ok(keysOf('Get-Content n.txt | conhost cmd').includes('once:list.cmd_syntax'));
});

test('179: conhost の止めと今回だけは、持ち主の許可の一覧に conhost があっても外れない（実際のガードで）', t => {
  const f = fixture(t);
  for (const c of ['conhost cmd /c npm view $a', 'conhost.exe --headless cmd /c npm view $a']) {
    const v = f.ps(c);
    assert.equal(v.decision, 'deny', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
    assert.ok(v.reasonKeys.includes('list.winargs'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  const syntax = f.ps('conhost cmd /c "npm view x & calc"');
  assert.equal(syntax.decision, 'ask');
  assert.equal(syntax.onceOnly, true);
  assert.ok(syntax.reasonKeys.includes('list.cmd_syntax'), syntax.reasonKeys.join(' '));
});

test('179: conhost の今までの扱いは変えない（cmd の記号も実行時の引数も無い形は今回だけのまま）', () => {
  for (const c of ['conhost cmd /c npm --version', 'conhost cmd /c "npm test"', 'conhost --width 80 cmd /c put', 'conhost git status', 'conhost notepad', 'conhost $p', 'conhost git log $x', 'Start-Process notepad -ArgumentList $a']) {
    assert.deepEqual(keysOf(c), ['once:list.command'], c);
  }
});

test('179: powershell -c の中の cmd は、中身が書いてあれば前から調べられている（実行時に決まる引数は止める）', t => {
  const f = fixture(t);
  for (const c of ["powershell -c 'cmd /c npm view $a'", "pwsh -Command 'cmd /c npm view $a'", "powershell -NoProfile -c 'cmd /c npm view $a'"]) {
    const v = f.ps(c);
    assert.equal(v.decision, 'deny', `${c}: ${v.decision}`);
    assert.ok(v.reasonKeys.includes('list.winargs'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  assert.notEqual(f.ps("powershell -c 'cmd /c npm view left-pad'").decision, 'deny');
});

test('180: gsudo は sudo と同じに断る（持ち主の許可の一覧に書いても、名前の書き方を変えても）', t => {
  const f = fixture(t);
  for (const c of ['gsudo ls', 'gsudo.exe ls', 'GSUDO ls', 'C:\\tools\\gsudo.exe ls', '& gsudo ls', "& 'gsudo' ls", 'try { gsudo ls } catch { }', 'ls; gsudo ls', 'Get-Date | gsudo cat']) {
    assert.ok(keysOf(c).includes('deny:guard.elevate'), `${c}: ${keysOf(c).join(' ')}`);
    const v = f.ps(c);
    assert.equal(v.decision, 'deny', `${c}: ${v.decision}`);
    assert.ok(v.reasonKeys.includes('guard.elevate'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  for (const c of ['gsudo ls', '"gsudo" ls', '/usr/bin/gsudo ls', 'env gsudo ls', 'nohup gsudo ls', 'ls && gsudo ls', 'xargs gsudo ls']) {
    const v = f.bash(c);
    assert.equal(v.decision, 'deny', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
    assert.ok(v.reasonKeys.includes('guard.elevate'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  assert.equal(f.bash('sudo ls').decision, 'deny');
  assert.ok(!keysOf('Get-Content gsudo.txt').includes('deny:guard.elevate'));
  assert.ok(!keysOf('echo gsudo').includes('deny:guard.elevate'));
  assert.ok(!keysOf('git log --grep gsudo').includes('deny:guard.elevate'));
});

test('181: リンクを作るコマンドは、リンクのもととリンクの名前も書き込み先として調べる（守るファイルを指すなら持ち主の許可が要る）', t => {
  const f = fixture(t);
  const persona = (v: { reasonKeys: string[] }) => v.reasonKeys.includes('guard.write_persona');
  const skill = (v: { reasonKeys: string[] }) => v.reasonKeys.includes('guard.write_skill');
  for (const c of ['ln SOUL.md link', 'ln -s SOUL.md link', 'ln -sf notes.md SOUL.md', 'ln -- SOUL.md link', 'cp -l SOUL.md link', 'cp --link SOUL.md link', 'cp -s SOUL.md link', 'cp --symbolic-link SOUL.md link', 'cp --sy SOUL.md link', '"ln" SOUL.md link', "'ln' -s SOUL.md link", '/bin/ln SOUL.md link', 'ln -n SOUL.md link', 'ln SOUL.md']) {
    const v = f.bash(c);
    assert.ok(persona(v), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
    assert.ok(v.paths.some(p => p.write && /SOUL\.md$/u.test(p.input)), `${c}: ${JSON.stringify(v.paths)}`);
  }
  for (const c of ['ln -t skills notes.md', 'ln --target-directory=skills notes.md', 'ln -tskills notes.md', 'ln -sft skills notes.md', 'cp -l -t skills notes.md']) {
    const v = f.bash(c);
    assert.ok(skill(v), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  for (const c of [
    'cmd /c mklink /H link SOUL.md', 'cmd /c mklink link SOUL.md', 'cmd /c "mklink /H link SOUL.md"', 'cmd /c "(mklink /H link SOUL.md)"', 'cmd /c "@mklink /J SOUL.md docs"',
    'cmd /c "( call mklink /H link SOUL.md )"', 'fsutil hardlink create link SOUL.md', 'fsutil hardlink create SOUL.md notes.md', 'fsutil.exe hardlink create link SOUL.md',
  ]) {
    const v = f.ps(c);
    assert.ok(persona(v), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  const hard = f.ps('fsutil hardlink create link SOUL.md');
  assert.ok(hard.paths.some(p => p.write && p.input === 'SOUL.md'), JSON.stringify(hard.paths));
  const secret = f.bash('ln -s .env link');
  assert.equal(secret.decision, 'deny');
});

test('181: cp でフォルダごとハードリンクする形（cp -al）は、フォルダの下の守るファイルまで書き込みとして調べる', t => {
  const f = fixture(t);
  for (const c of ['cp -al . backup', 'cp -rl . backup', 'cp -a -l . backup', 'cp --link --recursive . backup', 'cp -al -t backup .', 'cp -rs . backup']) {
    const v = f.bash(c);
    assert.ok(v.reasonKeys.includes('list.write_ancestor'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  for (const c of ['cp -al skills skills2', 'cp -rl docs backup']) {
    const v = f.bash(c);
    assert.equal(v.onceOnly, true, c);
  }
  assert.ok(!f.bash('cp -l notes.md backup2').reasonKeys.includes('list.write_ancestor'));
  assert.ok(!f.bash('cp -r . backup3').reasonKeys.includes('list.form'));
});

test('181: リンクを作らない形・守るファイルに触れない形は、今までの確かめのまま', t => {
  const f = fixture(t);
  for (const c of ['ln notes.md link', 'ln -s notes.md link', 'cp -l notes.md link', 'cp --link notes.md link']) {
    const v = f.bash(c);
    assert.equal(v.decision, 'ask', c);
    assert.equal(v.onceOnly, true, c);
    assert.deepEqual(v.reasonKeys, ['list.form'], c);
  }
  for (const c of ['cmd /c mklink /H link notes.md', 'fsutil hardlink create link notes.md']) {
    const v = f.ps(c);
    assert.equal(v.decision, 'ask', c);
    assert.ok(!v.reasonKeys.includes('guard.write_persona'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  assert.equal(f.ps('fsutil hardlink list SOUL.md').reasonKeys.includes('guard.write_persona'), false);
  assert.equal(f.ps('fsutil fsinfo drives').decision, 'allow');
  for (const c of ['cp notes.md copy.md', 'cp -r skills skills2']) assert.ok(!f.bash(c).reasonKeys.includes('list.form'), c);
  assert.equal(f.bash('cp notes.md copy.md').decision, 'allow');
});
