import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 持ち主が許した包むコマンド（nohup・timeout・nice・cmd /c など）でも、中で動くコマンドは直接書いたときと同じ確かめを受ける

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'main.ts'), 'x');
  writeFileSync(join(ws, 'SOUL.md'), 'x');
  const outsideDir = realish(join(base, 'outside'));
  mkdirSync(outsideDir, { recursive: true });
  const outside = join(outsideDir, 'CLAUDE.md').split('\\').join('/');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell', allow: string[], extra: Partial<ShellGuardOptions> = {}): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', allow, ...extra });
  return { ws, outside, outsideDir: outsideDir.split('\\').join('/'), run };
}

const show = (v: ShellVerdict): string => `${v.decision} [${v.reasonKeys.join(', ')}]`;

function assertLikeDirect(wrappedV: ShellVerdict, directV: ShellVerdict, label: string): void {
  assert.notEqual(wrappedV.decision, 'allow', `${label}: ${show(wrappedV)}`);
  assert.equal(wrappedV.decision, directV.decision, `${label}: ${show(wrappedV)} / direct ${show(directV)}`);
  for (const key of directV.reasonKeys) assert.ok(wrappedV.reasonKeys.includes(key), `${label}: ${key} missing in ${show(wrappedV)}`);
}

test('許した nohup で外のフォルダを消す: 直接の rm と同じく止まる', t => {
  const f = fixture(t);
  for (const target of [f.outsideDir, '/d/my-claude-base-v3']) {
    const direct = f.run(`rm -rf ${target}`, 'bash', []);
    assertLikeDirect(f.run(`nohup rm -rf ${target}`, 'bash', ['nohup']), direct, `nohup rm -rf ${target}`);
  }
});

test('許した timeout で外のファイルへ写す: 直接の cp と同じく外に触れると言う', t => {
  const f = fixture(t);
  const direct = f.run(`cp main.ts ${f.outside}`, 'bash', []);
  assert.ok(direct.reasonKeys.includes('guard.touches_outside'), show(direct));
  assertLikeDirect(f.run(`timeout 5 cp main.ts ${f.outside}`, 'bash', ['timeout']), direct, 'timeout cp');
});

test('許した nice でリンクを作る: リンクの確かめは許しで消えない', t => {
  const f = fixture(t);
  const v = f.run('nice ln main.ts link', 'bash', ['nice']);
  assert.equal(v.decision, 'ask', show(v));
  assert.equal(v.onceOnly, true, show(v));
  assert.ok(v.reasonKeys.includes('list.form'), show(v));
});

test('許した cmd の /c と /k で外へ写す: 確かめになる', t => {
  const f = fixture(t);
  const outside = f.outside.split('/').join('\\');
  for (const flag of ['/c', '/k']) {
    const v = f.run(`cmd ${flag} copy main.ts ${outside}`, 'powershell', ['cmd']);
    assert.equal(v.decision, 'ask', `${flag}: ${show(v)}`);
    assert.equal(v.onceOnly, true, `${flag}: ${show(v)}`);
  }
});

test('ほかの包むコマンドと Start-Process も、許しても中のコマンドを確かめる', t => {
  const f = fixture(t);
  const direct = f.run(`cp main.ts ${f.outside}`, 'bash', []);
  for (const [allow, command] of [
    ['stdbuf', `stdbuf -oL cp main.ts ${f.outside}`], ['exec', `exec cp main.ts ${f.outside}`], ['unbuffer', `unbuffer cp main.ts ${f.outside}`],
    ['winpty', `winpty cp main.ts ${f.outside}`], ['chronic', `chronic cp main.ts ${f.outside}`],
  ] as const) assertLikeDirect(f.run(command, 'bash', [allow]), direct, command);
  for (const command of [`Start-Process -FilePath cp -ArgumentList 'main.ts','${f.outside}'`, `Start-Process cmd -ArgumentList '/c copy main.ts ${f.outside}'`]) {
    const v = f.run(command, 'powershell', ['start-process']);
    assert.equal(v.decision, 'ask', `${command}: ${show(v)}`);
  }
});

test('env・command と組み合わせても、中のコマンドを確かめる', t => {
  const f = fixture(t);
  const direct = f.run(`cp main.ts ${f.outside}`, 'bash', []);
  for (const wrapper of ['nohup', 'timeout 5', 'nice', 'stdbuf -oL', 'exec', 'unbuffer', 'winpty', 'chronic']) {
    const name = wrapper.split(' ')[0]!;
    for (const lead of ['env', 'command']) {
      const command = `${lead} ${wrapper} cp main.ts ${f.outside}`;
      assertLikeDirect(f.run(command, 'bash', [lead, name]), direct, command);
    }
    const reversed = `${wrapper} env cp main.ts ${f.outside}`;
    assertLikeDirect(f.run(reversed, 'bash', ['env', name]), direct, reversed);
  }
});

test('許した包むコマンドで、許した害のないコマンドを動かすときは、そのまま通す', t => {
  const f = fixture(t);
  assert.equal(f.run('timeout 5 npm test', 'bash', ['timeout', 'npm test']).decision, 'allow');
  assert.equal(f.run('nohup timeout 5 nice true', 'bash', ['nohup', 'timeout', 'nice', 'true']).decision, 'allow');
  assert.equal(f.run('env command timeout 5 npm test', 'bash', ['env', 'command', 'timeout', 'npm test']).decision, 'allow');
  const v = f.run('timeout 5 npm test', 'bash', ['timeout']);
  assert.equal(v.decision, 'ask', show(v));
});

test('持ち主の項目が中のコマンドまで書いていれば、その続きを中のコマンドの許しとして扱う。ほかの確かめは残る', t => {
  const f = fixture(t);
  assert.equal(f.run('timeout 5 npm test', 'bash', ['timeout 5 npm test']).decision, 'allow');
  assert.equal(f.run('nohup npm test -- --watch', 'bash', ['nohup npm test']).decision, 'allow');
  assert.equal(f.run('timeout 5 npm run build', 'bash', ['timeout 5 npm test']).decision, 'ask');
  const direct = f.run(`cp main.ts ${f.outside}`, 'bash', ['cp']);
  assertLikeDirect(f.run(`timeout 5 cp main.ts ${f.outside}`, 'bash', ['timeout 5 cp']), direct, 'timeout 5 cp');
  assertLikeDirect(f.run(`nohup rm -rf ${f.outsideDir}`, 'bash', ['nohup rm']), f.run(`rm -rf ${f.outsideDir}`, 'bash', ['rm']), 'nohup rm');
});

test('中のコマンドが読み取れないときは、許しでは消えない確かめ（今回だけ）にする', t => {
  const f = fixture(t);
  for (const [command, allow] of [
    ['nohup', ['nohup']],
    ['cd $D; nohup true', ['cd', 'nohup', 'true']],
    ['nohup timeout 5 nice stdbuf -oL true', ['nohup', 'timeout', 'nice', 'stdbuf', 'true']],
  ] as const) {
    const v = f.run(command, 'bash', [...allow]);
    assert.equal(v.decision, 'ask', `${command}: ${show(v)}`);
    assert.equal(v.onceOnly, true, `${command}: ${show(v)}`);
    assert.ok(v.reasonKeys.includes('code.wrapped_unknown'), `${command}: ${show(v)}`);
  }
});
