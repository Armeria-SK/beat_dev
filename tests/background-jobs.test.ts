import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_LIMITS, BackgroundJobs, type BackgroundLimits, type JobOwner, type StartInput } from '../src/tools/shell/background.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';

const WINDOWS = process.platform === 'win32';
const KEY = `sk-ant-${'B'.repeat(32)}`;

const GRAND = "console.log('GRAND ' + process.pid); setInterval(() => {}, 1000);";

const TREE = [
  "const { spawn } = require('child_process');",
  "const { writeFileSync } = require('fs');",
  "console.log('ROOT ' + process.pid);",
  "if (process.platform === 'win32') {",
  '  writeFileSync(process.argv[1], process.argv[2]);',
  "  spawn(process.env.ComSpec, ['/d', '/s', '/c', '\"\"' + process.execPath + '\" \"' + process.argv[1] + '\"\"'], { stdio: 'inherit', windowsVerbatimArguments: true });",
  "} else spawn(process.execPath, ['-e', process.argv[2]], { stdio: 'inherit' });",
  'setInterval(() => {}, 1000);',
].join('\n');

const SLEEP = 'setInterval(() => {}, 1000);';

function setup(t: { after: (fn: () => void | Promise<void>) => void }, options: { limits?: Partial<BackgroundLimits>; isOpen?: (owner: JobOwner) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beat-bg-'));
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs'), ...options });
  const extra: number[] = [];
  t.after(async () => {
    jobs.closeAll();
    for (const pid of extra) { try { process.kill(pid); } catch { } }
    await new Promise(r => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  let n = 0;
  const start = (script: string, more: Partial<StartInput> = {}) => {
    const args = script === TREE ? ['-e', script, join(dir, `grand-${n += 1}.js`), GRAND] : ['-e', script];
    const result = jobs.start({
      conversationId: 'c1', projectId: 'p1', command: `node -e <script>`, cwd: dir, file: process.execPath, args,
      env: scrubEnv(), fetched: false, ...more,
    });
    assert.ok('id' in result, JSON.stringify(result));
    return result.id;
  };
  return { jobs, dir, start, extra };
}

async function until<T>(probe: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function gone(pids: number[], ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every(pid => !alive(pid))) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return pids.every(pid => !alive(pid));
}

async function treePids(jobs: BackgroundJobs, id: string): Promise<number[]> {
  const text = await until(() => {
    const out = jobs.peek(id, 0)?.text ?? '';
    return /ROOT \d+/u.test(out) && /GRAND \d+/u.test(out) ? out : undefined;
  });
  return [Number(/ROOT (\d+)/u.exec(text)![1]), Number(/GRAND (\d+)/u.exec(text)![1])];
}

test('limits are the plan constants', () => {
  assert.deepEqual(
    { ...BACKGROUND_LIMITS },
    { perConversation: 4, total: 8, ringBytes: 256 * 1024, logBytes: 50 * 1024 * 1024, keepPerConversation: 8, keepTotal: 32, partialLineBytes: 4096, stopWaitMs: 5000, termGraceMs: 5000 },
  );
});

test('start and read: output arrives, the read position advances, the end is read', async t => {
  const { jobs, start } = setup(t);
  const id = start("console.log('one'); setTimeout(() => { console.log('two'); }, 400);");
  const first = await until(() => { const r = jobs.read(id, 'c1'); return r && r.text.includes('one') ? r : undefined; });
  assert.equal(first.state, 'running');
  assert.doesNotMatch(first.text, /two/u);
  assert.equal(await jobs.wait(id, 'c1', 10, new AbortController().signal), 'done');
  const second = jobs.read(id, 'c1')!;
  assert.equal(second.text, 'two\n');
  assert.equal(second.state, 'exited');
  assert.equal(second.exitCode, 0);
  assert.equal(second.unread, false);
  assert.equal(jobs.read(id, 'c1')!.text, '');
});

test('wait: returns on timeout and on abort while the command keeps running', async t => {
  const { jobs, start } = setup(t);
  const id = start(SLEEP);
  const began = Date.now();
  assert.equal(await jobs.wait(id, 'c1', 0.3, new AbortController().signal), 'timeout');
  assert.ok(Date.now() - began < 3000);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  assert.equal(await jobs.wait(id, 'c1', 60, stop.signal), 'aborted');
  assert.equal(jobs.get(id)!.state, 'running');
});

test('stop: the child and its grandchild are gone afterwards', async t => {
  const { jobs, start } = setup(t);
  const id = start(TREE);
  const pids = await treePids(jobs, id);
  assert.ok(pids.every(alive));
  const view = await jobs.stop(id, 'model');
  assert.equal(view!.state, 'stopped');
  assert.equal(view!.stoppedBy, 'model');
  assert.equal(view!.orphaned, false);
  assert.equal(await gone(pids), true, `still alive: ${pids.filter(alive).join(', ')}`);
});

test('closeAll: no child or grandchild survives', async t => {
  const { jobs, start } = setup(t);
  const a = start(TREE);
  const b = start(TREE, { conversationId: 'c2' });
  const pids = [...await treePids(jobs, a), ...await treePids(jobs, b)];
  jobs.closeAll();
  assert.equal(jobs.get(a)!.state, 'stopped');
  assert.equal(jobs.get(a)!.stoppedBy, 'system');
  assert.equal(await gone(pids), true, `still alive: ${pids.filter(alive).join(', ')}`);
});

test('limits: 4 per conversation and 8 overall; the refusal lists only that conversation', async t => {
  const { jobs, start } = setup(t);
  for (let i = 0; i < 4; i += 1) start(SLEEP, { command: `secret-a-${i}` });
  const own = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'x', cwd: process.cwd(), file: process.execPath, args: ['-e', SLEEP], env: scrubEnv(), fetched: false });
  assert.ok('refused' in own && own.refused === 'conversation_limit');
  assert.equal(own.running.length, 4);
  assert.equal(own.elsewhere, 0);
  for (let i = 0; i < 4; i += 1) start(SLEEP, { conversationId: 'c2', command: `secret-b-${i}` });
  const other = jobs.start({ conversationId: 'c3', projectId: 'p2', command: 'x', cwd: process.cwd(), file: process.execPath, args: ['-e', SLEEP], env: scrubEnv(), fetched: false });
  assert.ok('refused' in other && other.refused === 'total_limit');
  assert.deepEqual(other.running, []);
  assert.equal(other.elsewhere, 8);
  assert.doesNotMatch(JSON.stringify(other), /secret-/u);
  const fromC2 = jobs.start({ conversationId: 'c2', projectId: 'p1', command: 'x', cwd: process.cwd(), file: process.execPath, args: ['-e', SLEEP], env: scrubEnv(), fetched: false });
  assert.ok('refused' in fromC2 && fromC2.refused === 'conversation_limit');
  assert.doesNotMatch(JSON.stringify(fromC2), /secret-a/u);
  assert.equal(fromC2.elsewhere, 4);
});

test('start is refused when the owner is no longer open', async t => {
  const { jobs } = setup(t, { isOpen: owner => owner.conversationId !== 'archived' });
  const result = jobs.start({ conversationId: 'archived', projectId: 'p1', command: 'x', cwd: process.cwd(), file: process.execPath, args: ['-e', SLEEP], env: scrubEnv(), fetched: false });
  assert.deepEqual(result, { refused: 'closed' });
  assert.deepEqual(jobs.list(), []);
});

test('log: everything is written raw, and writing stops at the cap with one line', async t => {
  const { jobs, start } = setup(t, { limits: { logBytes: 1000 } });
  const id = start(`process.stdout.write('${KEY}\\n'); process.stdout.write('y'.repeat(5000)); process.stderr.write('err\\n');`);
  assert.equal(await jobs.wait(id, 'c1', 10, new AbortController().signal), 'done');
  const view = jobs.get(id)!;
  assert.equal(view.logCut, true);
  await until(() => { try { return readFileSync(view.logPath, 'utf8').includes('Log stopped'); } catch { return false; } });
  const text = readFileSync(view.logPath, 'utf8');
  assert.ok(text.startsWith(KEY));
  assert.ok(statSync(view.logPath).size < 1200, `size ${statSync(view.logPath).size}`);
  assert.match(text, /Log stopped at 1000 bytes/u);
});

test('log: an uncut log keeps stdout and stderr', async t => {
  const { jobs, start } = setup(t);
  const id = start("console.log('out line'); console.error('err line');");
  await jobs.wait(id, 'c1', 10, new AbortController().signal);
  const view = jobs.get(id)!;
  await until(() => { try { return readFileSync(view.logPath, 'utf8').includes('err line'); } catch { return false; } });
  const text = readFileSync(view.logPath, 'utf8');
  assert.match(text, /out line/u);
  assert.match(text, /\[stderr\] err line/u);
  assert.match(view.logPath, /bg-c1-\d+\.log$/u);
});

test('stopWhere: stops only the matching commands and waits for them', async t => {
  const { jobs, start } = setup(t);
  const a = start(SLEEP);
  const b = start(SLEEP, { conversationId: 'c2', projectId: 'p2' });
  const c = start(SLEEP, { conversationId: 'c3', projectId: 'p3', taskId: 't1' });
  const d = start(SLEEP, { conversationId: 'c4', projectId: 'p4' });
  assert.equal(await jobs.stopWhere({ conversationId: 'c1' }), 1);
  assert.equal(jobs.get(a)!.state, 'stopped');
  assert.equal(jobs.get(a)!.stoppedBy, 'system');
  assert.equal(jobs.get(b)!.state, 'running');
  assert.equal(await jobs.stopWhere({ projectId: 'p2' }), 1);
  assert.equal(jobs.get(b)!.state, 'stopped');
  assert.equal(jobs.get(c)!.state, 'running');
  assert.equal(await jobs.stopWhere({ taskId: 't1' }), 1);
  assert.equal(jobs.get(c)!.state, 'stopped');
  assert.equal(jobs.get(d)!.state, 'running');
  assert.equal(await jobs.stopWhere({ taskId: 'nope' }), 0);
});

test('the command never stalls when nobody reads its output', async t => {
  const { jobs, start } = setup(t);
  const id = start("process.stdout.write('z'.repeat(2 * 1024 * 1024) + '\\nEND\\n');");
  assert.equal(await jobs.wait(id, 'c1', 30, new AbortController().signal), 'done');
  const read = jobs.read(id, 'c1')!;
  assert.equal(read.exitCode, 0);
  assert.ok(read.skipped > 1024 * 1024, `skipped ${read.skipped}`);
  assert.match(read.text, /END\n$/u);
});

test('another conversation cannot read, wait on, or see the cursor of a command', async t => {
  const { jobs, start } = setup(t);
  const id = start("console.log('mine');");
  await jobs.wait(id, 'c1', 10, new AbortController().signal);
  assert.equal(jobs.read(id, 'c2'), undefined);
  assert.equal(await jobs.wait(id, 'c2', 1, new AbortController().signal), undefined);
  assert.equal(jobs.read(id, 'c1')!.text, 'mine\n');
  assert.equal(jobs.read('bg-999', 'c1'), undefined);
  assert.deepEqual(jobs.list({ conversationId: 'c2' }), []);
});

test('onExit runs exactly once, whether the command exits or is stopped', async t => {
  const { jobs, start } = setup(t);
  let exited = 0; let stopped = 0;
  const a = start("console.log('quick');", { onExit: () => { exited += 1; } });
  const b = start(SLEEP, { onExit: () => { stopped += 1; } });
  await jobs.wait(a, 'c1', 10, new AbortController().signal);
  await jobs.stop(b, 'owner');
  await jobs.stop(b, 'owner');
  await jobs.stop(a, 'model');
  jobs.closeAll();
  assert.equal(exited, 1);
  assert.equal(stopped, 1);
  assert.equal(jobs.get(a)!.state, 'exited');
  assert.equal(jobs.get(a)!.stoppedBy, undefined);
  assert.equal(jobs.get(b)!.stoppedBy, 'owner');
});

test('stop waits only up to the cap when a detached grandchild keeps the pipe after the root exits', async t => {
  const { jobs, start, extra } = setup(t, { limits: { stopWaitMs: 1000 } });
  const id = start("const c = require('child_process').spawn(process.execPath, ['-e', \"console.log('GRAND ' + process.pid); setInterval(() => {}, 1000);\"], { stdio: 'inherit', detached: true }); c.unref(); setTimeout(() => process.exit(0), 300);");
  const text = await until(() => { const out = jobs.peek(id, 0)?.text ?? ''; return /GRAND \d+/u.test(out) ? out : undefined; });
  const grand = Number(/GRAND (\d+)/u.exec(text)![1]);
  extra.push(grand);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(jobs.get(id)!.state, 'running');
  const began = Date.now();
  assert.equal(await jobs.stopWhere({ conversationId: 'c1' }), 1);
  const took = Date.now() - began;
  assert.ok(took < 4000, `took ${took} ms`);
  const view = jobs.get(id)!;
  assert.equal(view.state, 'exited');
  assert.equal(view.exitCode, 0);
  assert.equal(view.orphaned, true);
});

test('read: a key written in two parts with colour codes between is never shown', async t => {
  const { jobs, start } = setup(t);
  const id = start(`process.stdout.write('token ${KEY.slice(0, 10)}\\u001b[1m'); setTimeout(() => { process.stdout.write('${KEY.slice(10)}\\u001b[0m\\nnext'); }, 600); setTimeout(() => {}, 1500);`);
  const reads: string[] = [];
  await until(() => { reads.push(jobs.read(id, 'c1')!.text); return reads.join('').includes('[REDACTED]'); });
  const joined = reads.join('');
  assert.doesNotMatch(joined, /BBBBBBBB/u);
  assert.doesNotMatch(joined, /\u001b/u);
  assert.doesNotMatch(joined, /next/u);
  await jobs.wait(id, 'c1', 10, new AbortController().signal);
  assert.equal(jobs.read(id, 'c1')!.text, 'next');
});

test('retention: finished commands are kept per conversation and overall, newest first, read or not', async t => {
  const { jobs, start } = setup(t, { limits: { keepPerConversation: 3, keepTotal: 5 } });
  const run = async (conversationId: string) => {
    const id = start("console.log('x');", { conversationId });
    await jobs.wait(id, conversationId, 10, new AbortController().signal);
    return id;
  };
  const c1: string[] = [];
  for (let i = 0; i < 4; i += 1) c1.push(await run('c1'));
  jobs.read(c1[1]!, 'c1');
  assert.deepEqual(jobs.list({ conversationId: 'c1' }).map(v => v.id), c1.slice(1));
  const c2: string[] = [];
  for (let i = 0; i < 3; i += 1) c2.push(await run('c2'));
  assert.deepEqual(jobs.list().map(v => v.id), [...c1.slice(2), ...c2]);
  const running = start(SLEEP, { conversationId: 'c3' });
  assert.ok(jobs.list().some(v => v.id === running));
});

test('a command that cannot start ends once as exited with the spawn error', async t => {
  const { jobs } = setup(t);
  const seen: string[] = [];
  jobs.onChange(view => seen.push(view.state));
  let exits = 0;
  const result = jobs.start({ conversationId: 'c1', projectId: 'p1', command: 'x', cwd: process.cwd(), file: join(tmpdir(), 'no-such-program-beat'), args: [], env: scrubEnv(), fetched: false, onExit: () => { exits += 1; } });
  assert.ok('id' in result);
  await until(() => jobs.get(result.id)!.state !== 'running');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(jobs.get(result.id)!.state, 'exited');
  assert.ok(jobs.get(result.id)!.spawnError);
  assert.equal(exits, 1);
  assert.deepEqual(seen, ['running', 'exited']);
});

test('a multibyte character split across two writes reads whole', async t => {
  const { jobs, start } = setup(t);
  const id = start("const b = Buffer.from('日本語\\n'); process.stdout.write(b.subarray(0, 4)); setTimeout(() => process.stdout.write(b.subarray(4)), 400);");
  await jobs.wait(id, 'c1', 10, new AbortController().signal);
  assert.equal(jobs.read(id, 'c1')!.text, '日本語\n');
});

test('onChange reports the start and the end', async t => {
  const { jobs, start } = setup(t);
  const seen: string[] = [];
  const off = jobs.onChange(view => seen.push(`${view.id}:${view.state}`));
  const id = start("console.log('x');");
  await jobs.wait(id, 'c1', 10, new AbortController().signal);
  off();
  start("console.log('y');");
  assert.deepEqual(seen, [`${id}:running`, `${id}:exited`]);
});

test('POSIX: stop sends SIGTERM first, then SIGKILL after the grace period', { skip: WINDOWS && 'POSIX only' }, async t => {
  const { jobs, start } = setup(t, { limits: { termGraceMs: 500 } });
  const polite = start("process.on('SIGTERM', () => { console.log('bye'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);");
  await until(() => jobs.peek(polite, 0)!.text.includes('ready'));
  await jobs.stop(polite, 'model');
  assert.match(jobs.peek(polite, 0)!.text, /bye/u);
  const stubborn = start("process.on('SIGTERM', () => {}); console.log('ROOT ' + process.pid); setInterval(() => {}, 1000);");
  const text = await until(() => { const out = jobs.peek(stubborn, 0)!.text; return /ROOT \d+/u.test(out) ? out : undefined; });
  const pid = Number(/ROOT (\d+)/u.exec(text)![1]);
  await jobs.stop(stubborn, 'model');
  assert.equal(await gone([pid], 3000), true);
  assert.equal(jobs.get(stubborn)!.state, 'stopped');
});
