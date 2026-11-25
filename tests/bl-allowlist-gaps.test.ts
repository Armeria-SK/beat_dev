import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStatements, noRepo, type MatchCtx } from '../src/tools/hooks/allowlist.ts';
import { fixShellRefusal } from '../src/tools/hooks/fix-guard.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import type { ShellKind } from '../src/tools/hooks/shell-lex.ts';
import { worktreeGitRefusal } from '../src/tools/hooks/worktree-git.ts';
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
  return { ws, bash: (c: string) => run(c, 'bash'), ps: (c: string) => run(c, 'powershell'), strict: (c: string, shell: 'bash' | 'powershell') => run(c, shell, { outsideRoots: 'deny' }) };
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

test('181: GNU の長いオプションは、略した綴りと --名前=値 でもリンクの確かめをすり抜けない', t => {
  const f = fixture(t);
  for (const c of ['cp --link --rec . backup', 'cp --li --ar . backup', 'cp -al --target=backup .', 'cp -al --targ backup .', 'cp -al --target-dir=backup .', 'cp --link --recurs . backup', 'cp --link --arch . backup']) {
    const v = f.bash(c);
    assert.ok(v.reasonKeys.includes('list.write_ancestor'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  for (const c of ['ln --target=skills notes.md', 'ln --targ=skills notes.md', 'ln --target-directory=skills notes.md', 'ln --bogus=skills notes.md', 'cp --link --reflink=skills notes.md link', 'ln --target skills notes.md']) {
    const v = f.bash(c);
    assert.ok(v.reasonKeys.includes('guard.write_skill'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  assert.ok(!f.bash('cp --link --rec docs backup').reasonKeys.includes('guard.write_skill'));
  assert.deepEqual(f.bash('ln --symbolic --force notes.md link').reasonKeys, ['list.form']);
});

test('179: conhost の中身（cmd・gsudo・sudo・リンクのもと）も、cmd /c を直に書いたときと同じ確かめを受ける', t => {
  const f = fixture(t);
  for (const c of ['conhost cmd /c mklink /H x SOUL.md', 'conhost.exe --headless cmd /c mklink /H x SOUL.md', 'conhost cmd /c "mklink /H x SOUL.md"']) {
    const v = f.ps(c);
    assert.ok(v.reasonKeys.includes('guard.write_persona'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  for (const c of ['conhost gsudo ls', 'conhost sudo ls', 'conhost.exe gsudo.exe ls', 'conhost --headless sudo ls', 'conhost -- gsudo ls']) {
    for (const v of [f.ps(c), f.bash(c)]) {
      assert.equal(v.decision, 'deny', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
      assert.ok(v.reasonKeys.includes('guard.elevate'), `${c}: ${v.reasonKeys.join(' ')}`);
    }
  }
  assert.ok(f.bash('conhost ln SOUL.md link').reasonKeys.includes('guard.write_persona'));
  for (const c of ['conhost git push origin main', 'conhost --headless git push --force', 'conhost -- git push', 'conhost cmd /c git push']) {
    for (const v of [f.ps(c), f.bash(c)]) {
      assert.equal(v.decision, 'ask', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
      assert.ok(v.reasonKeys.includes('list.git_push'), `${c}: ${v.reasonKeys.join(' ')}`);
    }
  }
});

test('179: conhost の中を読めるようにしても、作業コピーのタスクと自動の直しでは conhost を今までどおり断る（wt.opaque・fix.background）', t => {
  const f = fixture(t);
  const place = { worktree: f.ws, productRoot: join(f.ws, '..', 'main'), cwd: f.ws, powershell: true };
  for (const c of ['conhost git status', 'conhost.exe --headless git status', 'conhost cmd /c npm view x', 'conhost notepad', 'conhost git push origin main', 'conhost -- git status']) {
    const v = f.ps(c);
    assert.ok(v.statements.some(st => st.inner !== undefined && st.inner !== null), `${c}: 中身が読まれていない`);
    assert.equal(worktreeGitRefusal(v.statements, { ...place, command: c })?.key, 'wt.opaque', c);
    const fix = fixShellRefusal({ copy: f.ws, cwd: f.ws, command: c, background: false, statements: v.statements, paths: v.paths, writes: v.writes, reasonKeys: v.reasonKeys, askKinds: v.askKinds, fetched: false, pushes: 0, sends: false });
    assert.equal(fix?.key, 'fix.background', c);
  }
});

test('179: conhost の起こす先や引数が実行時に決まるときは、持ち主の許可の一覧に conhost があっても通さない（PowerShell・bash）', t => {
  const f = fixture(t);
  const rows: Array<[string, string]> = [
    ["$p = 'gsudo'; conhost $p cmd", 'p=gsudo; conhost $p cmd'], ['conhost $p cmd', 'conhost $p cmd'], ['conhost --headless $p ls', 'conhost --headless $p ls'], ['conhost cmd /c npm view $a', 'conhost cmd /c npm view $a'],
  ];
  for (const [ps, bash] of rows) {
    for (const [c, v] of [[ps, f.ps(ps)], [bash, f.bash(bash)]] as const) {
      assert.notEqual(v.decision, 'allow', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
      assert.ok(v.decision === 'deny' || v.reasonKeys.includes('code.wrapped_unknown'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
    }
  }
  for (const [c, v] of [['conhost git status $x', f.ps('conhost git status $x')], ['conhost git status $x', f.bash('conhost git status $x')], ['conhost git @a', f.ps('conhost git @a')]] as const) {
    assert.ok(v.reasonKeys.includes('code.wrapped_unknown'), `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  const splat = f.ps('conhost @a');
  assert.equal(splat.decision, 'deny');
  assert.ok(splat.reasonKeys.includes('list.winargs'), splat.reasonKeys.join(' '));
  assert.equal(f.ps('Start-Process @a').decision, 'deny');
});

test('180: gsudo の名前の終わりの . と空白（Windows が落とす）も同じに断る', t => {
  const f = fixture(t);
  for (const c of ['gsudo. ls', 'gsudo.exe. ls', "& 'C:\\tools\\gsudo.exe.' ls", 'gsudo.exe.. ls', "& 'gsudo ' ls"]) {
    assert.ok(keysOf(c).includes('deny:guard.elevate'), `${c}: ${keysOf(c).join(' ')}`);
    const v = f.ps(c);
    assert.equal(v.decision, 'deny', `${c}: ${v.decision} ${v.reasonKeys.join(' ')}`);
  }
  assert.ok(!keysOf('gsudo-helper ls').includes('deny:guard.elevate'));
});

test('181: 外のパスを指すリンクは、書き込み先として外の確かめ（guard.touches_outside・outside_write）を受ける。tools.outsideRoots が deny なら断る', t => {
  const f = fixture(t);
  const moved: Array<[string, 'bash' | 'ps']> = [
    ['ln -s /usr/bin/python3 py', 'bash'], ['ln -s ../other/file x', 'bash'], ['ln -s C:/Windows/System32/notepad.exe np', 'bash'], ['ln /usr/bin/python3 py', 'bash'], ['ln -sf /etc/hosts hosts', 'bash'],
    ['ln -t /tmp notes.md', 'bash'], ['ln -s notes.md /tmp/outlink', 'bash'], ['cp -s /usr/bin/python3 py', 'bash'],
    ['cmd /c mklink /J nm C:/Users/x/cache', 'ps'], ['cmd /c mklink nm C:/Users/x/cache.txt', 'ps'], ['fsutil hardlink create link C:/Windows/notepad.exe', 'ps'],
  ];
  for (const [c, kind] of moved) {
    const run = kind === 'bash' ? f.bash : f.ps;
    const v = run(c);
    assert.ok(v.reasonKeys.includes('guard.touches_outside'), `${c}: ${v.reasonKeys.join(' ')}`);
    assert.ok(v.askKinds.includes('outside_write'), `${c}: ${v.askKinds.join(' ')}`);
    const strict = f.strict(c, kind === 'bash' ? 'bash' : 'powershell');
    assert.equal(strict.decision, 'deny', `${c}: ${strict.decision}`);
  }
  for (const c of ['ln -s notes.md link', 'ln -s ./docs d2', 'ln notes.md link2']) {
    const v = f.bash(c);
    assert.ok(!v.reasonKeys.includes('guard.touches_outside'), `${c}: ${v.reasonKeys.join(' ')}`);
    assert.notEqual(f.strict(c, 'bash').decision, 'deny', c);
  }
});
