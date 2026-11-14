import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveShell, runProcess, scrubEnv, which, type ShellChoice } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const bashPath = which('bash');
const bashOk = bashPath !== undefined && spawnSync(bashPath, ['--noprofile', '--norc', '-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';

const PROBES: Array<{ shell: ShellChoice; name: string; script: string; posixOrphanCheck: boolean }> = [
  { shell: 'bash', name: 'bash: the leader exits, a background job keeps stdout', script: '(sleep 4; touch late.txt; sleep 8) & echo started', posixOrphanCheck: true },
  { shell: 'bash', name: 'bash: the leader stays, a background job keeps stdout', script: '(sleep 4; touch late.txt; sleep 8) & echo started; sleep 30', posixOrphanCheck: true },
  ...(WINDOWS ? [
    { shell: 'powershell' as const, name: 'powershell: Start-Process -NoNewWindow keeps stdout', script: "Start-Process -NoNewWindow node -ArgumentList '-e','setTimeout(()=>{},6000)'; 'started'", posixOrphanCheck: false },
    { shell: 'powershell' as const, name: 'powershell: a detached grandchild keeps stdout', script: "& node -e \"require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{stdio:'inherit',detached:true}).unref()\"; 'started'", posixOrphanCheck: false },
  ] : []),
];

for (const probe of PROBES) {
  for (const how of ['timeout', 'abort'] as const) {
    test(`runProcess: a grandchild holding stdout does not keep it open past the ${how} (${probe.name})`, { skip: probe.shell === 'bash' && !bashOk && 'no bash' }, async t => {
      const dir = tempDir(t);
      const spec = resolveShell(probe.shell);
      const stop = new AbortController();
      if (how === 'abort') setTimeout(() => stop.abort(), 1500);
      const started = Date.now();
      const result = await runProcess(spec.file, spec.args(probe.script), {
        cwd: probe.shell === 'bash' ? dir : process.cwd(), env: scrubEnv(), timeoutMs: how === 'timeout' ? 1500 : 60_000, signal: stop.signal, maxBytes: 10_000, ...(spec.stdin ? { input: spec.stdin(probe.script) } : {}),
      });
      const took = Date.now() - started;
      assert.ok(took < 5000, `took ${took} ms`);
      assert.equal(how === 'timeout' ? result.timedOut : result.aborted, true);
      assert.match(result.stdout, /started/u);
      if (!WINDOWS && probe.posixOrphanCheck) {
        await new Promise(r => setTimeout(r, Math.max(0, 5000 - took)));
        assert.equal(existsSync(join(dir, 'late.txt')), false, 'the grandchild survived');
      }
    });
  }
}

test('runProcess: tailBytes keeps the real end of output past the cap', async t => {
  const dir = tempDir(t);
  const script = String.raw`process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\nFINAL OUT LINE\n'); process.stderr.write('e'.repeat(300000) + '\nFINAL ERR LINE\n');`;
  const result = await runProcess(process.execPath, ['-e', script], { cwd: dir, env: scrubEnv(), timeoutMs: 30_000, signal: new AbortController().signal, maxBytes: 4096, tailBytes: 2048 });
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.stdout, /FINAL/u);
  assert.match(result.stdoutTail ?? '', /FINAL OUT LINE\n$/u);
  assert.match(result.stderrTail ?? '', /FINAL ERR LINE\n$/u);
  assert.ok((result.stdoutTail ?? '').length <= 2048);
});

for (const code of [0, 1]) {
  test(`runProcess: settleOnExit returns the real exit code (${code}) soon after the command exits, even if a grandchild keeps stdout`, { timeout: 30_000 }, async () => {
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true }).unref(); console.log('leader done'); process.exit(${code});`;
    const started = Date.now();
    const result = await runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), env: scrubEnv(), timeoutMs: 6000, signal: new AbortController().signal, maxBytes: 10_000, settleOnExit: true });
    const took = Date.now() - started;
    assert.ok(took < 4000, `took ${took} ms`);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.equal(result.exitCode, code);
    assert.match(result.stdout, /leader done/u);
  });
}
