import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

test('PowerShell 5.1 の && と || の断りの文は、; で区切るか分けて呼ぶようモデルに勧める（判定は今までどおり拒否）', t => {
  const ws = join(tempDir(t), 'workspace');
  mkdirSync(ws, { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: realish(ws), mode: 'write' }], deny: [] };
  for (const op of ['&&', '||']) {
    const verdict = checkShellCommand(`git add -A ${op} git commit -m x`, realish(ws), { policy, outsideRoots: 'ask', shell: 'powershell', windows: true });
    assert.equal(verdict.decision, 'deny', op);
    const text = verdict.reasons.join('\n');
    assert.ok(text.includes(`this PowerShell (5.1) does not know ${op}`), text);
    assert.match(text, /separate the commands with ";"/u, text);
    assert.match(text, /separate calls/u, text);
  }
  const pwsh = checkShellCommand('git status && git status', realish(ws), { policy, outsideRoots: 'ask', shell: 'pwsh', windows: true });
  assert.ok(!pwsh.reasons.join('\n').includes('does not know'), pwsh.reasons.join('\n'));
});
