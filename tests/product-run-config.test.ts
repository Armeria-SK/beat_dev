import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { productRunOf } from '../src/tools/hooks/product-run.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

function product(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'test_a.py'), '');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(base, 'skills') };
  return (command: string): string | undefined => {
    const verdict = checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
    if (verdict.decision !== 'ask') return undefined;
    const result = productRunOf({ root, verdict, which: () => undefined, ownerHooks: () => false, git: () => undefined });
    return result && 'run' in result ? result.run : undefined;
  };
}

test('pytest・tox: 製品のフォルダにその実行役の設定（節）があるときだけ順 4。節の無い設定や conftest.py だけでは、上のフォルダの設定を拾いうるので順 4 にしない', t => {
  const cases: Array<[Record<string, string>, string, string | undefined]> = [
    [{ 'pytest.ini': '' }, 'pytest tests', 'product-code'],
    [{ '.pytest.ini': '' }, 'pytest tests', 'product-code'],
    [{ 'pyproject.toml': '[project]\r\nname = "x"\r\n\r\n[tool.pytest.ini_options]\r\naddopts = "-q"\r\n' }, 'pytest tests', 'product-code'],
    [{ 'tox.ini': '[tox]\nenvlist = py\n\n[pytest]\naddopts = -q\n' }, 'pytest tests', 'product-code'],
    [{ 'setup.cfg': '[metadata]\nname = x\n[tool:pytest]\n' }, 'pytest tests', 'product-code'],
    [{ 'conftest.py': '' }, 'pytest tests', undefined],
    [{ 'pyproject.toml': '[project]\nname = "x"\n# [tool.pytest.ini_options]\n' }, 'pytest tests', undefined],
    [{ 'tox.ini': '[tox]\nenvlist = py\n' }, 'pytest tests', undefined],
    [{ 'setup.cfg': '[metadata]\nname = x\n' }, 'pytest tests', undefined],
    [{ 'tox.ini': '[tox]\nenvlist = py\n' }, 'tox', 'product-code'],
    [{ 'pyproject.toml': '[tool.tox]\nlegacy_tox_ini = ""\n' }, 'tox', 'product-code'],
    [{ 'setup.cfg': '[tox:tox]\nenvlist = py\n' }, 'tox', 'product-code'],
    [{ 'pyproject.toml': '[project]\nname = "x"\n' }, 'tox', undefined],
    [{ 'setup.cfg': '[tool:pytest]\n' }, 'tox', undefined],
  ];
  const wrong = cases.flatMap(([files, command, want]) => {
    const got = product(t, files)(command);
    return got === want ? [] : [`${Object.keys(files).join(',')} / ${command}: ${got} (want ${want})`];
  });
  assert.deepEqual(wrong, []);
});

function productRun(t: { after: (fn: () => void) => void }, files: Record<string, string>, shell: 'bash' | 'powershell') {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(base, 'skills') };
  return (command: string): string | undefined => {
    const verdict = checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell' });
    if (verdict.decision !== 'ask') return undefined;
    const result = productRunOf({ root, verdict, which: () => undefined, ownerHooks: () => false, git: () => undefined });
    return result && 'run' in result ? result.run : undefined;
  };
}

test('self-run P1 1a: node の決まった旗のあとのファイルが製品の中なら順 4。製品の外・決まっていない旗は順 4 にしない', t => {
  const run = productRun(t, { 'package.json': '{}', 'scripts/e2e.ts': '' }, 'bash');
  for (const c of ['node --disable-warning=ExperimentalWarning scripts/e2e.ts', 'node --no-warnings --enable-source-maps scripts/e2e.ts', 'node scripts/e2e.ts']) assert.equal(run(c), 'product-code', c);
  for (const c of ['node --no-warnings ../x.ts', 'node --watch scripts/e2e.ts', 'node --require ./scripts/e2e.ts scripts/e2e.ts', 'node --import ./scripts/e2e.ts scripts/e2e.ts']) assert.equal(run(c), undefined, c);
});
