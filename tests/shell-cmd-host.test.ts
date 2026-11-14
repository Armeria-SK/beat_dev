import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatements, noRepo } from '../src/tools/hooks/allowlist.ts';
import type { MatchCtx } from '../src/tools/hooks/allowlist-core.ts';

const ctx: MatchCtx = { shell: 'powershell', windows: true, repo: noRepo, selfHosts: [], external: (n: string) => ({ ok: true, ext: /^(?:npm|pnpm|yarn)$/u.test(n) ? '.cmd' : '.exe', detail: '' }), fileExists: (p: string) => /cmd\.exe$/iu.test(p) };
const keysOf = (command: string): string[] => classifyStatements(command, ctx).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));
const levelOf = (command: string) => classifyStatements(command, ctx).level;

test('PowerShell の cmd /c: 実行時に決まる引数は cmd.exe の記号を調べられないので止める。文字どおりの中身は前と同じ', () => {
  for (const c of ['cmd /c npm --version $a', 'cmd.exe /c npm --version $a', 'cmd /c "$X"', 'cmd /c (Get-Content n.txt)', 'C:\\Windows\\System32\\cmd.exe /c npm view $a', "& 'cmd' /c npm view $a"]) {
    assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  }
  for (const c of ['cmd /c "npm test"', 'cmd /c npm --version', 'cmd /c "dir /b & echo done"', 'cmd /c put']) assert.deepEqual(keysOf(c), ['once:list.command'], c);
});

test('PowerShell の Start-Process: 起こす先が .cmd・.bat なら、実行時に決まる引数と cmd.exe の記号を止める。ほかの先は前と同じ', () => {
  for (const c of ['Start-Process -FilePath npm.cmd -ArgumentList $a', 'Start-Process npm -ArgumentList "view", $a', "Start-Process -FilePath npm.cmd -ArgumentList 'x&y'", 'saps npm.cmd $a', 'Start-Process -FilePath C:\\tools\\run.bat -ArgumentList (Get-Content n.txt)', 'start npm -ArgumentList $a', 'Start-Process $p -ArgumentList $a', "Start-Process -FilePath npm -ArgumentList 'view', 'a|b'"]) {
    assert.ok(keysOf(c).includes('deny:list.winargs'), `${c}: ${keysOf(c).join(' ')}`);
  }
  for (const c of ['Start-Process notepad', 'Start-Process notepad -ArgumentList $a', 'Start-Process npm -ArgumentList "run build"', "Start-Process -FilePath npm.cmd -ArgumentList 'view', 'left-pad' -Wait", 'Start-Process $p']) {
    assert.equal(levelOf(c), 'once', `${c}: ${keysOf(c).join(' ')}`);
  }
});
