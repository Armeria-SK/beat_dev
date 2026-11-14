import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const ws = realish(tempDir(t));
  writeFileSync(join(ws, 'build.ps1'), 'Write-Output 1');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(ws, 'skills') };
  return (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, language: 'en' });
}

test('PowerShell: 中を開かない囲み（try・while・function など）のあとは、.ps1・.exe のパスを「ある」とみなさない', t => {
  const ps = fixture(t);
  assert.ok(!ps("./build.ps1 'a b'").reasonKeys.includes('list.winargs'), '囲みが無ければ、あるファイルの .ps1 は cmd.exe の調べを当てない');
  for (const before of ['try { Remove-Item build.ps1 } catch { }', 'while ($false) { Set-Location .. }', 'function f { Remove-Item build.ps1 }', 'switch (1) { 1 { Set-Location .. } }']) {
    const v = ps(`${before}; ./build.ps1 'a b'`);
    assert.ok(v.reasonKeys.includes('list.winargs'), `${before}: ${v.reasonKeys.join(' ')}`);
    assert.equal(v.decision, 'deny', before);
  }
  assert.ok(!ps("if ($true) { Write-Output 1 }; ./build.ps1 'a b'").reasonKeys.includes('list.winargs'), '中を開く if は前と同じ');
});
