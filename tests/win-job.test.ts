import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const WINDOWS = process.platform === 'win32';
const FAKE_BEAT = join(import.meta.dirname, 'fixtures', 'win-job-fake-beat.mjs');

type Run = { beat: number; shell: number; child: number; grand: number; result: { state: string; reason?: string } | null };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pids: number[], ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every(pid => !alive(pid))) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return pids.every(pid => !alive(pid));
}

function forceKill(pid: number): void {
  try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { }
}

function startFakeBeat(t: { after: (fn: () => void) => void }, mode: 'job' | 'nojob', inject: { failAt?: number; haltAfter?: number; timeoutMs?: number } = {}): Promise<Run> {
  const args = [FAKE_BEAT, 'beat', mode, String(inject.failAt ?? 0), String(inject.haltAfter ?? 0), String(inject.timeoutMs ?? 0)];
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const run: Partial<Run> = { beat: proc.pid! };
  t.after(() => { for (const pid of [run.grand, run.child, run.shell, run.beat]) if (pid) forceKill(pid); });
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`fake beat did not get ready: ${text}`)), 30_000);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`fake beat exited (${code}): ${text}`)); });
    proc.stdout.on('data', chunk => {
      text += String(chunk);
      for (const line of text.split('\n')) {
        const [key, value] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1).trim()];
        if (key === 'RESULT') run.result = JSON.parse(value);
        if (key === 'SHELL') run.shell = Number(value);
        if (key === 'CHILD') run.child = Number(value);
        if (key === 'GRAND') run.grand = Number(value);
      }
      if (run.grand && run.child && run.shell && run.result !== undefined) {
        clearTimeout(timer);
        proc.removeAllListeners('exit');
        resolve(run as Run);
      }
    });
  });
}

test('a force-killed beat takes its children and grandchildren with it', { skip: !WINDOWS && 'Windows only' }, async t => {
  const run = await startFakeBeat(t, 'job');
  assert.deepEqual(run.result, { state: 'joined' });
  const tree = [run.shell, run.child, run.grand];
  assert.ok(tree.every(alive));
  forceKill(run.beat);
  assert.equal(await gone(tree), true, `still alive: ${tree.filter(alive).join(', ')}`);
});

test('control: without the job the grandchildren outlive a force-killed beat', { skip: !WINDOWS && 'Windows only' }, async t => {
  const run = await startFakeBeat(t, 'nojob');
  forceKill(run.beat);
  assert.equal(await gone([run.grand], 2000), false);
});

test('a helper that fails at any stage leaves beat running', { skip: !WINDOWS && 'Windows only', concurrency: true }, async t => {
  await Promise.all([1, 2, 3, 4].map(failAt =>
    t.test(`failure at stage ${failAt}`, async t => {
      const run = await startFakeBeat(t, 'job', { failAt });
      assert.equal(run.result?.state, 'failed');
      assert.match(run.result?.reason ?? '', new RegExp(`stage ${failAt}`, 'u'));
      await new Promise(r => setTimeout(r, 500));
      assert.equal(alive(run.beat), true);
    })));
});

test('a helper killed after any stage leaves beat running', { skip: !WINDOWS && 'Windows only', concurrency: true }, async t => {
  await Promise.all([1, 2, 3, 4].map(haltAfter =>
    t.test(`killed after stage ${haltAfter}`, async t => {
      const run = await startFakeBeat(t, 'job', { haltAfter, timeoutMs: 6000 });
      assert.equal(run.result?.state, 'failed');
      assert.match(run.result?.reason ?? '', /timed out/u);
      await new Promise(r => setTimeout(r, 500));
      assert.equal(alive(run.beat), true);
      if (haltAfter === 4) {
        forceKill(run.beat);
        assert.equal(await gone([run.shell, run.child, run.grand]), true, 'beat was in the job before the helper died, so the job still works');
      }
    })));
});

test('does nothing outside Windows', { skip: WINDOWS && 'not Windows' }, async () => {
  const { enterKillOnCloseJob } = await import('../src/os/win-job.ts');
  assert.deepEqual(await enterKillOnCloseJob(), { state: 'skipped' });
});
