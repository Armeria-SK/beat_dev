import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { findChecks, type FindOptions } from '../src/projects/check-find.ts';
import { removeDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');

function scratch(t: TestContext): string {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'tmp', 'bl-small-misc-python-'));
  t.after(() => removeDir(dir));
  return dir;
}

function appAlias(t: TestContext, target: string[]): string {
  const base = scratch(t);
  const dir = join(base, 'Microsoft', 'WindowsApps');
  const real = join(base, 'Program Files', 'WindowsApps', ...target);
  mkdirSync(dir, { recursive: true });
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(dir, 'python.exe'), 'junction');
  rmdirSync(real);
  return dir;
}

const search = (...dirs: string[]): FindOptions => ({ env: { PATH: dirs.join(';'), PATHEXT: '.EXE' }, windows: true });
const STUB = ['Microsoft.DesktopAppInstaller_1.29.379.0_x64__8wekyb3d8bbwe', 'AppInstallerPythonRedirector.exe'];
const STORE_PYTHON = ['PythonSoftwareFoundation.Python.3.13_3.13.2800.0_x64__qbz5n2kfra8p0', 'python3.13.exe'];

test('find python: Store から入れた本物の Python の別名（先が Python のパッケージ）は stub と見なさず、python -m pytest を選ぶ', t => {
  const folder = join(scratch(t), 'site');
  mkdirSync(folder);
  writeFileSync(join(folder, 'pytest.ini'), '');
  const found = findChecks(folder, search(appAlias(t, STORE_PYTHON)));
  assert.deepEqual(found.commands.map(c => c.command), ['python -m pytest']);
  assert.equal(found.none, undefined);
});

test('find python: Python が入っていないときの別名（先が AppInstallerPythonRedirector.exe）は今までどおり stub で、理由を none に書く', t => {
  const folder = join(scratch(t), 'site');
  mkdirSync(folder);
  writeFileSync(join(folder, 'pytest.ini'), '');
  const stub = findChecks(folder, search(appAlias(t, STUB)));
  assert.deepEqual(stub.commands, []);
  assert.match(stub.none ?? '', /WindowsApps/u);
  const upper = findChecks(folder, search(appAlias(t, ['Microsoft.DesktopAppInstaller_1.0_x64__8wekyb3d8bbwe', 'APPINSTALLERPYTHONREDIRECTOR.EXE'])));
  assert.deepEqual(upper.commands, [], 'file names on Windows are not case sensitive');
});
