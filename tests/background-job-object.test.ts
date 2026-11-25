import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { openRunJob, type ListenAnswer, type RunJob } from '../src/os/run-job.ts';
import { jobLines, jobState } from '../src/tools/builtin/shell-bg.ts';
import { BackgroundJobs, type BackgroundOptions, type JobView } from '../src/tools/shell/background.ts';
import { resolveShell, scrubEnv } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

// 実機の会話 85ab1ade: 裏のシェル（bg-2）の根の PowerShell が終わったあと、それが起こした headless Chrome が 40 分以上残った。
// 裏のコマンドは 1 本ずつ、その回だけのプロセスの入れ物（src/os/run-job.ts）に入れ、止めたとき・終わったときに孫まで止める。
// 孫は害の無い node（setInterval だけ）。Windows では切り離して（detached）起こしても入れ物の中に残る。POSIX では切り離すとグループを抜けるので、グループの中に起こす
const WINDOWS = process.platform === 'win32';

const SPAWNER = [
  "const { spawn } = require('child_process');",
  "const { writeFileSync } = require('fs');",
  "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: process.argv[3] === 'pipe' ? 'inherit' : 'ignore', detached: process.platform === 'win32' });",
  'c.unref();',
  'writeFileSync(process.argv[2], String(c.pid));',
].join('\n');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function until<T>(probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !alive(pid);
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }, options: Partial<BackgroundOptions> = {}) {
  const dir = tempDir(t);
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs'), ...options });
  const spawner = join(dir, 'spawner.js');
  writeFileSync(spawner, SPAWNER, 'utf8');
  const extra: number[] = [];
  t.after(async () => {
    jobs.closeAll();
    for (const pid of extra) { try { process.kill(pid, 'SIGKILL'); } catch { } }
    await new Promise(r => setTimeout(r, 300));
  });
  let n = 0;
  // 根はいつものシェル（Windows は PowerShell）。根は孫を起こす node を動かし、それが終わったら自分も終わる。direct は根が孫を起こす node そのもの
  // （Windows の PowerShell の下では、孫が stdio: 'ignore' でも PowerShell から受け継いだ出力の口を持ったままになる。Chrome の件と同じ）
  const start = (stdio: 'pipe' | 'ignore', taskId?: string, direct = false) => {
    const pidFile = join(dir, `grand-${n += 1}.pid`);
    const shell = resolveShell('auto');
    const command = WINDOWS ? `& '${process.execPath}' '${spawner}' '${pidFile}' ${stdio}; 'root done'` : `'${process.execPath}' '${spawner}' '${pidFile}' ${stdio}; echo 'root done'`;
    const how = direct ? { file: process.execPath, args: [spawner, pidFile, stdio] } : { file: shell.file, args: shell.args(command), ...(shell.stdin ? { stdin: shell.stdin(command) } : {}) };
    const result = jobs.start({ conversationId: 'c1', projectId: 'p1', ...(taskId ? { taskId } : {}), command, cwd: dir, env: scrubEnv(), fetched: false, ...how });
    assert.ok('id' in result, JSON.stringify(result));
    return { id: result.id, pidFile };
  };
  const grandPid = async (pidFile: string): Promise<number> => {
    const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')));
    extra.push(pid);
    return pid;
  };
  return { jobs, dir, start, grandPid };
}

const rootDone = (jobs: BackgroundJobs, id: string) => until(() => /root done/u.test(jobs.peek(id, 0)?.text ?? ''));

test('shell_stop: the root exited, a grandchild still holds the output pipe -> stopping leaves no grandchild alive', async t => {
  const { jobs, start, grandPid } = setup(t);
  const { id, pidFile } = start('pipe');
  const grand = await grandPid(pidFile);
  await rootDone(jobs, id);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(alive(grand));
  assert.equal(jobs.get(id)!.state, 'running', 'the grandchild keeps the pipe, so the command is still running');
  const view = await jobs.stop(id, 'model', 'c1');
  assert.equal(view!.orphaned, false);
  assert.equal(view!.containReason, undefined, 'closing the job object on stop is not a lost container');
  assert.equal(await gone(grand), true, `grandchild ${grand} survived shell_stop`);
});

test('run end (stopWhere by task): a grandchild that outlived the root is stopped too', async t => {
  const { jobs, start, grandPid } = setup(t);
  const { id, pidFile } = start('pipe', 't1');
  const grand = await grandPid(pidFile);
  await rootDone(jobs, id);
  assert.equal(await jobs.stopWhere({ taskId: 't1' }), 1);
  assert.equal(jobs.get(id)!.orphaned, false);
  assert.equal(await gone(grand), true, `grandchild ${grand} survived the end of the run`);
});

test('the command ends by itself while a grandchild that does not hold the pipe keeps running -> the grandchild is stopped', async t => {
  const { jobs, start, grandPid } = setup(t);
  const { id, pidFile } = start('ignore', undefined, true);
  const grand = await grandPid(pidFile);
  await until(() => jobs.get(id)!.state !== 'running');
  assert.equal(jobs.get(id)!.state, 'exited');
  assert.equal(await gone(grand), true, `grandchild ${grand} outlived its command`);
});

test('closeAll (beat stops): a grandchild that outlived the root is stopped too', async t => {
  const { jobs, start, grandPid } = setup(t);
  const { id, pidFile } = start('pipe');
  const grand = await grandPid(pidFile);
  await rootDone(jobs, id);
  jobs.closeAll();
  assert.equal(await gone(grand), true, `grandchild ${grand} survived closeAll`);
});

function fakeJob(over: { add?: (child: ChildProcess, onFail?: (reason: string) => void) => void; listens?: (port: number) => ListenAnswer } = {}): RunJob & { added: number; closed: number; lose: () => void } {
  let lose!: () => void;
  const ended = new Promise<void>(r => { lose = r; });
  const fake = {
    added: 0, closed: 0, ended, lose: () => lose(),
    add: (child: ChildProcess, onFail?: (reason: string) => void) => { fake.added += 1; over.add?.(child, onFail); },
    listens: async (port: number): Promise<ListenAnswer> => over.listens?.(port) ?? 'unknown',
    close: async () => { fake.closed += 1; lose(); },
  };
  return fake;
}

test('when the job object cannot be made, the command still runs as before', async t => {
  const { jobs } = setup(t, { openJob: async () => ({ failed: 'no job' }) });
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', "console.log('hello')"], env: scrubEnv(), fetched: false });
  assert.ok('id' in result);
  const view = await until(() => { const v = jobs.get(result.id)!; return v.state !== 'running' && v; });
  assert.equal(view.exitCode, 0);
  assert.match(jobs.peek(result.id, 0)!.text, /hello/u);
  // 入れ物に入っていないことは、状態の文・一覧の行に 1 行で出る
  assert.equal(view.contained, false);
  assert.equal(view.containReason, 'no job');
  assert.match(jobState(view, 'en'), /not in beat's process container: no job/u);
  assert.match(jobLines([view], 'en'), /not in beat's process container: no job/u);
});

const node = (jobs: BackgroundJobs, script: string, env = scrubEnv()) => {
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', script], env, fetched: false });
  assert.ok('id' in result);
  return result.id;
};

test('when the command cannot be put in the job object, it keeps running and the reason is reported (not killed)', async t => {
  const fake = fakeJob({ add: (_child, onFail) => onFail?.('the process could not be put in the job') });
  const { jobs } = setup(t, { openJob: async () => fake });
  const id = node(jobs, "setTimeout(() => console.log('still here'), 600)");
  await until(() => jobs.get(id)!.containReason);
  assert.equal(jobs.get(id)!.state, 'running');
  const view = await until(() => { const v = jobs.get(id)!; return v.state !== 'running' && v; });
  assert.equal(view.exitCode, 0);
  assert.match(jobs.peek(id, 0)!.text, /still here/u);
  assert.equal(view.containReason, 'the process could not be put in the job');
});

test('when the job helper stops while the command runs, the command is marked as no longer contained', async t => {
  const fake = fakeJob();
  const { jobs } = setup(t, { openJob: async () => fake });
  const id = node(jobs, 'setInterval(() => {}, 1000)');
  await until(() => fake.added > 0);
  assert.equal(jobs.get(id)!.containReason, undefined);
  fake.lose();
  await until(() => jobs.get(id)!.containReason);
  await jobs.stop(id, 'model', 'c1');
  assert.match(jobState(jobs.get(id)!, 'en'), /job helper stopped/u);
});

test('a normal end closes the job object without marking the command as uncontained', async t => {
  const fake = fakeJob();
  const { jobs } = setup(t, { openJob: async () => fake });
  const id = node(jobs, "console.log('x')");
  await until(() => jobs.get(id)!.state !== 'running');
  await until(() => fake.closed > 0);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(jobs.get(id)!.containReason, undefined);
});

test('run-job: a process that cannot be assigned is reported through onFail instead of being killed', { skip: !WINDOWS && 'Windows only' }, async () => {
  const made = await openRunJob();
  assert.ok(!('failed' in made), 'failed' in made ? made.failed : '');
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(r => child.once('exit', r));
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('onFail was not called')), 10_000);
      made.add(child, why => { clearTimeout(timer); resolve(why); });
    });
    assert.equal(reason, 'the process could not be put in the job');
  } finally { await made.close(); }
});

test('background commands run with BROWSER=none, whatever the owner set (dev servers do not open a browser outside beat)', async t => {
  const { jobs } = setup(t);
  const id = node(jobs, "console.log('ENV ' + JSON.stringify(Object.keys(process.env).filter(k => /^browser$/i.test(k)).map(k => k + '=' + process.env[k])))", { ...scrubEnv(), Browser: 'chrome' });
  await until(() => jobs.get(id)!.state !== 'running');
  const out = jobs.peek(id, 0)!.text;
  assert.ok(out.includes('ENV ["BROWSER=none"]'), out);
});

test('the job object gets the command, and is closed when the command ends', async t => {
  const fake = fakeJob();
  const { jobs } = setup(t, { openJob: async () => fake });
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', "console.log('hello')"], env: scrubEnv(), fetched: false });
  assert.ok('id' in result);
  await until(() => jobs.get(result.id)!.state !== 'running');
  await until(() => fake.closed > 0);
  assert.equal(fake.added, 1);
});

test('stopped before the job object is ready: the command never starts and the job object is closed', { skip: !WINDOWS && 'Windows only (POSIX starts at once)' }, async t => {
  const fake = fakeJob();
  let release!: () => void;
  const ready = new Promise<void>(r => { release = r; });
  const { jobs, dir } = setup(t, { openJob: async () => { await ready; return fake; } });
  const marker = join(dir, 'ran.txt');
  const seen: JobView['state'][] = [];
  jobs.onChange(view => seen.push(view.state));
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], env: scrubEnv(), fetched: false });
  assert.ok('id' in result);
  const view = await jobs.stop(result.id, 'model', 'c1');
  assert.equal(view!.state, 'stopped');
  release();
  await until(() => fake.closed > 0);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fake.added, 0);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(seen, ['running', 'stopped']);
});

test('closing the job object on a stop does not mark the command as uncontained, even while its pipe is still open', { skip: !WINDOWS && 'Windows only (POSIX does not close the job on a stop)' }, async t => {
  const fake = fakeJob();
  const { jobs, start, grandPid } = setup(t, { openJob: async () => fake, limits: { stopWaitMs: 1000 } });
  const { id, pidFile } = start('pipe');
  const grand = await grandPid(pidFile);
  await rootDone(jobs, id);
  const view = await jobs.stop(id, 'model', 'c1');
  try { process.kill(grand, 'SIGKILL'); } catch { }
  assert.equal(fake.closed > 0, true);
  assert.equal(view!.containReason, undefined);
});

// beat が入れ物を閉じると、手伝いは「ok N」を読まれる前に終わることがあり、待っていた add は HELPER_GONE で onFail に返る。それは「入れ物に入っていない」ではない
test('an add refused because beat itself closed the job object does not mark the command as uncontained', async t => {
  let pending: ((reason: string) => void) | undefined;
  const fake = fakeJob({ add: (_child, onFail) => { pending = onFail; } });
  const close = fake.close;
  fake.close = async () => { pending?.('the job helper stopped'); await close(); };
  const { jobs } = setup(t, { openJob: async () => fake });
  const id = node(jobs, "console.log('x')");
  await until(() => jobs.get(id)!.state !== 'running');
  await until(() => fake.closed > 0);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(jobs.get(id)!.containReason, undefined);
  assert.equal(jobs.get(id)!.contained, undefined);
});

// ── browser-rethink P7: 「そのポートで待ち受けているプロセスが、この裏のコマンドのジョブの中にあるか」（RunJob.listens と BackgroundJobs.ownsPort）──
// 暗証番号の欄に入れてよいのは、beat が自分で起動して、いま動いている開発サーバーのページだけ。出力にポートが出ただけ・ジョブの外のサーバーでは入れない。
// 本物のプロセスで確かめる（Windows のジョブ + iphlpapi の待ち受けの表）

const LISTEN_SCRIPT = (host: string, port: number): string => `const s = require('net').createServer(); s.listen(${port}, '${host}', () => console.log('PORT ' + s.address().port)); setInterval(() => {}, 1000);`;

async function spawnListener(t: { after: (fn: () => void) => void }, host: string, port = 0): Promise<{ child: ChildProcess; port: number }> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', LISTEN_SCRIPT(host, port)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill(); } catch { } });
  const bound = await new Promise<number>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('the listener did not start')), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      const m = /PORT (\d+)/u.exec(seen);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('the listener exited')); });
  });
  return { child, port: bound };
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
  });
}

// 入れた直後は手伝いがまだ入れていないので、答えが want になるまで待つ
async function answers(job: RunJob, port: number, want: string, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    last = await job.listens(port);
    if (last === want) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  return last;
}

test('run-job listens: a listener inside the job answers yes; one outside the job answers no; a port nobody listens on answers none', { skip: !WINDOWS && 'Windows only' }, async t => {
  const made = await openRunJob();
  assert.ok(!('failed' in made), 'failed' in made ? made.failed : '');
  t.after(() => made.close());
  const inside = await spawnListener(t, '127.0.0.1');
  made.add(inside.child);
  assert.equal(await answers(made, inside.port, 'yes'), 'yes', 'the listener that was put in the job');
  const outside = await spawnListener(t, '::1');
  assert.equal(await made.listens(outside.port), 'no', 'a listener outside the job (on [::1])');
  assert.equal(await made.listens(await freePort()), 'none', 'nobody listens');
  const answered = await Promise.all([made.listens(inside.port), made.listens(outside.port), made.listens(await freePort()), made.listens(inside.port)]);
  assert.deepEqual(answered, ['yes', 'no', 'none', 'yes'], 'several questions at once are answered each for its own port');
});

test('run-job listens: when the same port is also listened to by a process outside the job (the other address family), the answer is no', { skip: !WINDOWS && 'Windows only' }, async t => {
  const made = await openRunJob();
  assert.ok(!('failed' in made), 'failed' in made ? made.failed : '');
  t.after(() => made.close());
  const inside = await spawnListener(t, '127.0.0.1');
  made.add(inside.child);
  assert.equal(await answers(made, inside.port, 'yes'), 'yes');
  await spawnListener(t, '::1', inside.port);
  assert.equal(await made.listens(inside.port), 'no', 'one listener of two is outside the job');
});

// 根は 1.5 秒待ってから孫（待ち受け）を起こす。根がジョブに入ったあとに起こされた孫は、ジョブに入る
const GRANDCHILD_ROOT = `setTimeout(() => { const { spawn } = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(LISTEN_SCRIPT('127.0.0.1', 0))}], { stdio: ['ignore', 'inherit', 'ignore'] }); }, 1500); setInterval(() => {}, 1000);`;
const printedPort = (jobs: BackgroundJobs, id: string): number | false => { const m = /PORT (\d+)/u.exec(jobs.peek(id, 0)?.text ?? ''); return m ? Number(m[1]) : false; };

test('ownsPort: the dev server a background command started (a grandchild of the command) is the owner\'s own, for the conversation and for the task; another owner and a stopped command are not', { skip: !WINDOWS && 'Windows only' }, async t => {
  const { jobs } = setup(t);
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', taskId: 't1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', GRANDCHILD_ROOT], env: scrubEnv(), fetched: false });
  assert.ok('id' in result);
  const port = await until(() => printedPort(jobs, result.id));
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, port), true, 'the conversation that started it');
  assert.equal(await jobs.ownsPort({ conversationId: 'c9', taskId: 't1' }, port), true, 'the task that started it (from another conversation)');
  assert.equal(await jobs.ownsPort({ conversationId: 'c9' }, port), false, 'another conversation');
  assert.equal(await jobs.ownsPort({ conversationId: 'c9', taskId: 't2' }, port), false, 'another task');
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, await freePort()), false, 'a port nobody listens on');
  await jobs.stop(result.id, 'model', 'c1');
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, port), false, 'after the command was stopped');
});

test('ownsPort: a port that was only printed by a background command is not its own when the listener is outside the job (not even while the job is running)', { skip: !WINDOWS && 'Windows only' }, async t => {
  const { jobs } = setup(t);
  const outside = await spawnListener(t, '127.0.0.1');
  const id = node(jobs, `console.log('PORT ${outside.port}'); console.log('Local: http://localhost:${outside.port}/'); setInterval(() => {}, 1000);`);
  await until(() => jobs.printedPorts({ conversationId: 'c1' }).has(outside.port));
  assert.ok(printedPort(jobs, id), 'the port is in the command\'s output');
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, outside.port), false, 'but its listener is not in the job');
  const free = await freePort();
  const printedOnly = node(jobs, `console.log('Local: http://localhost:${free}/'); setInterval(() => {}, 1000);`);
  await until(() => jobs.printedPorts({ conversationId: 'c1' }).has(free));
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, free), false, 'nobody listens on the printed port');
  void printedOnly;
});

test('ownsPort: the listener of a command that could not be put in a job object is never proven (no container)', { skip: !WINDOWS && 'Windows only' }, async t => {
  const { jobs } = setup(t, { openJob: async () => ({ failed: 'no job' }) });
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'node', cwd: process.cwd(), file: process.execPath, args: ['-e', `require('net').createServer().listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); }); setInterval(() => {}, 1000);`], env: scrubEnv(), fetched: false });
  assert.ok('id' in result);
  const port = await until(() => printedPort(jobs, result.id));
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, port), false);
});

test('ownsPort: only the answer yes proves it (no / none / unknown do not), and a job whose container is lost or closing proves nothing', { skip: !WINDOWS && 'Windows only' }, async t => {
  for (const [answer, proven] of [['yes', true], ['no', false], ['none', false], ['unknown', false]] as const) {
    const fake = fakeJob({ listens: () => answer });
    const { jobs } = setup(t, { openJob: async () => fake });
    const id = node(jobs, 'setInterval(() => {}, 1000)');
    await until(() => fake.added > 0);
    assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, 4321), proven, answer);
    await jobs.stop(id, 'model', 'c1');
  }
  const lost = fakeJob({ listens: () => 'yes' });
  const { jobs } = setup(t, { openJob: async () => lost });
  const id = node(jobs, 'setInterval(() => {}, 1000)');
  await until(() => lost.added > 0);
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, 4321), true);
  lost.lose();
  await until(() => jobs.get(id)!.containReason);
  assert.equal(await jobs.ownsPort({ conversationId: 'c1' }, 4321), false, 'the job helper stopped, so the container is lost');
  await jobs.stop(id, 'model', 'c1');
});

test('run-job listens: without a Windows job (POSIX), the answer is unknown (nothing can be proven)', async () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  let made: Awaited<ReturnType<typeof openRunJob>>;
  try { made = await openRunJob(); } finally { Object.defineProperty(process, 'platform', real); }
  assert.ok(!('failed' in made));
  assert.equal(await made.listens(4321), 'unknown');
  await made.close();
});
