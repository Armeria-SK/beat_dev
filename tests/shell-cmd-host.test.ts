import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatements, noRepo } from '../src/tools/hooks/allowlist.ts';
import type { MatchCtx } from '../src/tools/hooks/allowlist-core.ts';
import type { ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

const ctx: MatchCtx = { shell: 'powershell', windows: true, repo: noRepo, selfHosts: [], external: (n: string) => ({ ok: true, ext: /^(?:npm|pnpm|yarn)$/u.test(n) ? '.cmd' : '.exe', detail: '' }), fileExists: (p: string) => /cmd\.exe$/iu.test(p) };
const keysOf = (command: string): string[] => classifyStatements(command, ctx).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));
const levelOf = (command: string) => classifyStatements(command, ctx).level;

test('PowerShell の cmd /c: 実行時に決まる引数は cmd.exe の記号を調べられないので止める。文字どおりの中身は前と同じ', () => {
  for (const c of ['cmd /c npm --version $a', 'cmd.exe /c npm --version $a', 'cmd /c "$X"', 'cmd /c (Get-Content n.txt)', 'C:\\Windows\\System32\\cmd.exe /c npm view $a', "& 'cmd' /c npm view $a"]) {
    assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  }
  for (const c of ['cmd /c "npm test"', 'cmd /c npm --version', 'cmd /c put']) assert.deepEqual(keysOf(c), ['once:list.command'], c);
});

test('PowerShell の Start-Process: 起こす先が .cmd・.bat なら、実行時に決まる引数と cmd.exe の記号を止める。ほかの先は前と同じ', () => {
  for (const c of ['Start-Process -FilePath npm.cmd -ArgumentList $a', 'Start-Process npm -ArgumentList "view", $a', "Start-Process -FilePath npm.cmd -ArgumentList 'x&y'", 'saps npm.cmd $a', 'Start-Process -FilePath C:\\tools\\run.bat -ArgumentList (Get-Content n.txt)', 'start npm -ArgumentList $a', 'Start-Process $p -ArgumentList $a', "Start-Process -FilePath npm -ArgumentList 'view', 'a|b'"]) {
    assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  }
  for (const c of ['Start-Process notepad', 'Start-Process notepad -ArgumentList $a', 'Start-Process npm -ArgumentList "run build"', "Start-Process -FilePath npm.cmd -ArgumentList 'view', 'left-pad' -Wait", 'Start-Process $p']) {
    assert.equal(levelOf(c), 'once', `${c}: ${keysOf(c).join(' ')}`);
  }
});

test('PowerShell の cmd: 文字どおりの cmd.exe の記号は、持ち主の許可の一覧では外せない今回だけの確かめにする（承認すれば動く）', t => {
  const ws = tempDir(t);
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: ws };
  const guard = (command: string, allow: string[]) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, language: 'en', allow });
  for (const [allow, c] of [[['cmd /c npm view'], "cmd /c npm view x '&' calc"], [['cmd /c'], 'cmd /c "npm view x & calc"'], [['cmd /c'], 'cmd /c "a && b"'], [['cmd /c npm view'], 'cmd /c npm view %X%'], [['cmd /c'], 'cmd /c "type a.txt > b.txt"'], [['cmd /c'], 'cmd /c "echo a | more"'], [['cmd /c'], 'cmd /c "echo ^& x"'], [['cmd'], 'Get-Content n.txt | cmd']] as const) {
    const v = guard(c, [...allow]);
    assert.notEqual(v.decision, 'allow', `${c}: ${v.reasons.join(' / ')}`);
    assert.notEqual(v.decision, 'deny', `${c}: ${v.reasons.join(' / ')}`);
    assert.ok(v.reasonKeys.includes('list.cmd_syntax'), `${c}: ${v.reasonKeys.join(' ')}`);
  }
  for (const [allow, c] of [[['cmd /c npm view'], 'cmd /c npm view left-pad'], [['cmd /c'], 'cmd /c "npm test"']] as const) assert.equal(guard(c, [...allow]).decision, 'allow', c);
  assert.deepEqual(keysOf('cmd /c "dir /b & echo done"'), ['once:list.command', 'once:list.cmd_syntax']);
});

test('PowerShell の Start-Process: パラメータの結び付きが読みきれない形は、起こす先と引数のどちらにもなりうるとして調べる', () => {
  for (const c of [
    'Start-Process -ArgumentList $a npm.cmd', "Start-Process -ArgumentList 'x&y' npm.cmd", 'Start-Process -ArgumentList "/c",$a cmd',
    "Start-Process -ea Stop npm.cmd 'x&y'", 'Start-Process -ErrorAction SilentlyContinue npm.cmd $a', 'Start-Process -Verbose npm.cmd $a', 'Start-Process -OutVariable o npm.cmd $a',
    'Start-Process -PSPath npm.cmd $a', 'Start-Process -nnw npm.cmd $a', 'Start-Process -Lup npm.cmd $a', 'Start-Process -vb npm.cmd $a', 'Start-Process -RunAs $c npm.cmd $a', 'Start-Process -RSO o.txt npm.cmd $a',
    'Start-Process @p', 'Start-Process npm.cmd @p', "Start-Process -FilePath 'npm.cmd ' 'x&y'", "Start-Process -FilePath 'npm.cmd.' -ArgumentList 'x&y'",
  ]) assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  for (const c of ['Start-Process -ArgumentList "run build" npm', 'Start-Process -Wait npm -ArgumentList test', 'Start-Process -WorkingDirectory sub npm.cmd test', 'Start-Process -ea Stop notepad', 'Start-Process -ArgumentList $a notepad']) {
    assert.equal(levelOf(c), 'once', `${c}: ${keysOf(c).join(' ')}`);
  }
});

test('PowerShell の Start-Process: -名前:値 の値はそのパラメータのもの。起こす先の候補にしない', () => {
  for (const c of ['Start-Process -Wait:1 npm.cmd $a', 'Start-Process -PassThru:1 npm.cmd $a', "Start-Process -Wait:1 cmd '/c calc & calc'", "Start-Process -NoNewWindow:1 npm.cmd 'x&y'", "Start-Process -UseNewEnvironment:1 npm.cmd 'x&y'", "Start-Process -LoadUserProfile:0 npm.cmd 'x&y'", "Start-Process -Wa:1 npm.cmd 'x&y'", 'Start-Process -FilePath:npm.cmd -ArgumentList:$a', "Start-Process -WorkingDirectory:sub npm.cmd 'x&y'"]) {
    assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  }
  for (const c of ['Start-Process -Wait:1 notepad $a', 'Start-Process -Wait:1 npm.cmd test']) assert.equal(levelOf(c), 'once', `${c}: ${keysOf(c).join(' ')}`);
});
