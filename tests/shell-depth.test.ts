import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'x');
  writeFileSync(join(ws, 'SOUL.md'), 'persona');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md')], skillsDir: join(ws, 'skills') };
  const ps = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, language: 'en' });
  return { ps };
}

const wrap = (inner: string) => `Get-ChildItem src | ForEach-Object { if ($_.Length -gt 0) { if ($_.Name.EndsWith('.ts')) { $n = @($_.Name.Split('.')).Count; if ($n -gt 1) { ${inner} } } } }`;

test('入れ子の深さ: 読むだけの深い PowerShell は確かめなしで通る', t => {
  const { ps } = fixture(t);
  const v = ps(wrap('Write-Output ($_.Name.ToUpper())'));
  assert.equal(v.decision, 'allow', v.reasons.join(' / '));
  const join = ps("$x = (Get-ChildItem src | ForEach-Object { if ($_.Name.EndsWith('.ts')) { $_.Name.ToUpper() } }) -join ','; $x");
  assert.equal(join.decision, 'allow', join.reasons.join(' / '));
});

test('入れ子の深さ: 深い所の書き込み・消すは、浅い所と同じに判定される', t => {
  const { ps } = fixture(t);
  for (const inner of ['Remove-Item src/a.ts', 'Set-Content SOUL.md x', 'Invoke-WebRequest https://example.com -OutFile src/a.ts', 'Invoke-Expression $n', "node -e 'console.log(1)'", '& ./src/a.ts']) {
    const shallow = ps(inner);
    const deep = ps(wrap(inner));
    assert.notEqual(shallow.decision, 'allow', inner);
    assert.equal(deep.decision, shallow.decision, inner);
    assert.equal(deep.onceOnly, shallow.onceOnly, inner);
  }
});

test('入れ子の深さ: 線より深いものは今までどおり断り、理由に線の段数が出る', t => {
  const { ps } = fixture(t);
  const v = ps(`(((((((((Get-Date)))))))))`);
  assert.equal(v.decision, 'deny');
  assert.ok(v.reasons.some(r => r.includes('nesting is deeper than 8 levels')), v.reasons.join(' / '));
});
