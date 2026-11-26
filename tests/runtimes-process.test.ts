import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProcessManager, ProcessRefused, resolveExecutable, type ProcessManagerOptions, type RuntimeProcess } from '../src/runtimes/process-manager.ts';
import { FAKE_RUNTIME_SCRIPT } from './helpers/fake-runtime.ts';
import { tempDir } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const OWNER = fileURLToPath(new URL('./helpers/runtime-owner.ts', import.meta.url));

// 試験を動かしている環境に CLAUDE_* などが入っていてもよいが、子の PATH は絶対パスだけ残る。node を動かすのに要る基本の名前だけ渡す
const BASICS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles'];
const basics = (): NodeJS.ProcessEnv => Object.fromEntries(BASICS.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function until<T>(probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

const survivors = (pids: number[]): number[] => pids.filter(alive);

function setup(t: Parameters<typeof tempDir>[0], options: ProcessManagerOptions = {}) {
  const dir = tempDir(t);
  const lines: string[] = [];
  const manager = new ProcessManager({ log: line => lines.push(line), env: basics(), ...options });
  const extra: number[] = [];
  t.after(async () => {
    await manager.closeAll();
    for (const pid of extra) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });
  const start = async (args: string[] = [], signal?: AbortSignal) => {
    const scope = await manager.open();
    const child = scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT, ...args], cwd: dir, ...(signal ? { signal } : {}) });
    return { scope, child };
  };
  // 孫を起こさせ、その pid を返す。入れ物に入る前の数ミリ秒に起こされた孫は入れ物の外になる（run-job.ts の「残る穴」）ので、起こさせる前に少し待つ
  const grandchild = async (child: RuntimeProcess, exit = false): Promise<number> => {
    await new Promise(resolve => setTimeout(resolve, WINDOWS ? 1500 : 300));
    const file = join(dir, `grand-${extra.length}.pid`);
    child.writeLine(JSON.stringify({ type: 'grandchild', file, exit }));
    const pid = await until(() => existsSync(file) && Number(readFileSync(file, 'utf8')) || false);
    extra.push(pid);
    return pid;
  };
  return { dir, lines, manager, start, grandchild };
}

test('a normal reply: input is closed by us, the runtime ends by itself, nothing is killed', async t => {
  const s = setup(t);
  const marker = join(s.dir, 'eof');
  const { scope, child } = await s.start(['--eof-marker', marker]);
  child.writeLine(JSON.stringify({ type: 'user', text: 'hi' }));
  const seen: unknown[] = [];
  for await (const line of child.lines()) { seen.push(JSON.parse(line)); if (seen.length === 2) break; }
  assert.deepEqual(seen, [{ type: 'text', delta: 'echo: hi' }, { type: 'done' }]);
  const [exit] = await scope.finish();
  assert.equal(exit!.code, 0);
  assert.equal(exit!.stoppedBy, undefined, 'a runtime that ends when its input closes is not killed');
  assert.ok(existsSync(marker), 'the runtime saw its input close');
});

test('close, then wait, then kill the tree: a runtime that ignores the closed input is killed after the wait, with its grandchild', async t => {
  const s = setup(t, { graceMs: 700 });
  const marker = join(s.dir, 'eof');
  const { scope, child } = await s.start(['--stubborn', '--eof-marker', marker]);
  const grand = await s.grandchild(child);
  assert.ok(alive(child.pid!) && alive(grand));
  const before = Date.now();
  const [exit] = await scope.finish();
  const waited = Date.now() - before;
  assert.equal(exit!.stoppedBy, 'grace');
  assert.ok(waited >= 600, `it waited for the grace period before killing (${waited} ms)`);
  assert.ok(existsSync(marker), 'the input was closed first');
  assert.ok(Number(readFileSync(marker, 'utf8')) <= before + waited, 'the input was closed before the kill');
  assert.deepEqual(survivors([child.pid!, grand]), [], 'no child and no grandchild survive');
});

test('the root runtime ends by itself while its grandchild keeps running: finishing the scope stops the grandchild', async t => {
  const s = setup(t);
  const { scope, child } = await s.start();
  const grand = await s.grandchild(child, true);
  await child.exited;
  assert.ok(alive(grand), 'the grandchild outlived the root');
  await scope.finish();
  assert.equal(await gone(grand), true, `grandchild ${grand} survived the end of the reply`);
});

test('closeAll (beat is stopping) stops the runtimes of every open scope and their grandchildren', async t => {
  const s = setup(t);
  const { child } = await s.start(['--stubborn']);
  const grand = await s.grandchild(child);
  await s.manager.closeAll();
  assert.deepEqual(survivors([child.pid!, grand]), []);
});

test('an abort signal stops the runtime and its grandchild at once', async t => {
  const s = setup(t);
  const controller = new AbortController();
  const { scope, child } = await s.start(['--stubborn'], controller.signal);
  const grand = await s.grandchild(child);
  controller.abort();
  const exit = await child.exited;
  assert.equal(exit.stoppedBy, 'abort');
  await scope.finish();
  assert.equal(await gone(grand), true);
  const stopped = new AbortController();
  stopped.abort();
  const second = await s.manager.open();
  assert.throws(() => second.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT], cwd: s.dir, signal: stopped.signal }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'aborted');
  await second.finish();
});

test('beat dies first (Windows): the runtime and its grandchild do not outlive the process that started them', { skip: !WINDOWS && 'the job object is Windows only; on POSIX a runtime in its own process group outlives a killed parent' }, async t => {
  const dir = tempDir(t);
  const pidFile = join(dir, 'grand.pid');
  const owner = spawn(process.execPath, ['--import', LOADER, OWNER, pidFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } try { owner.kill('SIGKILL'); } catch { /* gone */ } });
  const report = await new Promise<{ owner: number; child: number; grandchild: number }>((resolve, reject) => {
    let text = '';
    owner.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); const line = text.split('\n').find(l => l.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    owner.once('exit', code => reject(new Error(`the owner exited early (${code})`)));
  });
  pids.push(report.child, report.grandchild);
  assert.ok(alive(report.child) && alive(report.grandchild), 'both are running while their owner lives');
  process.kill(report.owner, 'SIGKILL');
  assert.equal(await gone(report.child, 20_000), true, `runtime ${report.child} outlived beat`);
  assert.equal(await gone(report.grandchild, 20_000), true, `grandchild ${report.grandchild} outlived beat`);
});

test('when the job cannot be made, the runtime still runs, the reason is recorded and logged, and the root is still stopped', async t => {
  const s = setup(t, { openJob: async () => ({ failed: 'no job here' }), graceMs: 300 });
  const { scope, child } = await s.start(['--stubborn']);
  assert.equal(scope.containReason, 'no job here');
  assert.equal(child.containReason, 'no job here');
  assert.ok(s.lines.some(line => line.includes('[WARN]') && line.includes('no job here')));
  const [exit] = await scope.finish();
  assert.equal(exit!.stoppedBy, 'grace');
  assert.equal(await gone(child.pid!), true);
});

test('arguments that look like a secret are refused without starting anything, and the message does not repeat them', async t => {
  const s = setup(t);
  const scope = await s.manager.open();
  const secret = 'abcdef0123456789abcdef0123456789';
  for (const args of [[`--api-key=${secret}`], [`ANTHROPIC_API_KEY=${secret}`], ['--api-key', secret], [`sk-ant-api03-${secret}${secret}`]]) {
    assert.throws(() => scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT, ...args], cwd: s.dir }), (error: unknown) => {
      assert.ok(error instanceof ProcessRefused && error.reason === 'args', String(error));
      assert.equal(error.message.includes(secret), false, 'the secret is not in the message');
      return true;
    }, JSON.stringify(args));
  }
  assert.equal(s.lines.some(line => line.includes('runtime process started')), false, 'nothing was started');
  await scope.finish();
});

test('ordinary runtime arguments (resume ids, modes, paths, JSON settings) are not mistaken for secrets and the record keeps them', async t => {
  const s = setup(t);
  const args = ['--resume', '0a1b2c3d-4e5f-6789-abcd-ef0123456789', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--model', 'claude-sonnet-5-5', '-c', 'thread_unload_delay_secs=0', '--settings', '{"permissions":{"deny":["Read(**/.env)"]}}', 'app-server'];
  const { scope, child } = await s.start(args);
  assert.deepEqual(child.record.args, [FAKE_RUNTIME_SCRIPT, ...args]);
  assert.equal(child.record.executable, process.execPath);
  await scope.finish();
});

test('the program must be an absolute, existing path (or a name found on PATH, which is turned into an absolute path); nothing goes through a shell', async t => {
  const s = setup(t);
  const scope = await s.manager.open();
  const refused = (file: string, reason: string) => assert.throws(() => scope.spawn({ file, cwd: s.dir }), (error: unknown) => error instanceof ProcessRefused && error.reason === reason, `${file} -> ${reason}`);
  refused('./claude', 'relative');
  refused('tools\\claude.exe', 'relative');
  refused(join(s.dir, 'missing.exe'), 'not_found');
  refused('definitely-not-a-program-name', 'not_found');
  assert.throws(() => scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT], cwd: join(s.dir, 'no-such-folder') }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  await scope.finish();

  const named = setup(t, { env: { ...basics(), PATH: dirname(process.execPath) } });
  const second = await named.manager.open();
  const child = second.spawn({ file: 'node', args: [FAKE_RUNTIME_SCRIPT], cwd: named.dir });
  assert.equal(child.record.executable.toLowerCase(), process.execPath.toLowerCase(), 'the name was turned into the absolute path before starting');
  await second.finish();
});

test('a bare program name is never looked up in the work folder: empty, "." and relative PATH entries are skipped, absolute ones still work', t => {
  const dir = tempDir(t);
  const name = WINDOWS ? 'codex.exe' : 'codex';
  writeFileSync(join(dir, name), '');
  for (const PATH of ['', delimiter, ['', '.'].join(delimiter), ['relative-bin', '.', ''].join(delimiter), [dirname(process.execPath), '', '.'].join(delimiter)]) {
    assert.throws(() => resolveExecutable('codex', { PATH }, dir), (error: unknown) => error instanceof ProcessRefused && error.reason === 'not_found', JSON.stringify(PATH));
  }
  assert.equal(resolveExecutable('codex', { PATH: ['', '.', dir].join(delimiter) }, dir), join(dir, name), 'an absolute entry is still searched');
  const mixedCase = WINDOWS ? { Path: ['', '.'].join(delimiter) } : { PATH: ['', '.'].join(delimiter) };
  assert.throws(() => resolveExecutable('codex', mixedCase, dir), (error: unknown) => error instanceof ProcessRefused && error.reason === 'not_found', 'Path is the same name as PATH');
});

test('writeLine: a large line is accepted and arrives whole (a full pipe is not a refusal); only an input that can no longer be written gives false', async t => {
  const s = setup(t);
  const { scope, child } = await s.start();
  for (const size of [20_000, 200_000]) {
    assert.equal(child.writeLine(JSON.stringify({ type: 'user', text: 'x'.repeat(size) })), true, `${size} characters`);
  }
  const seen: Array<{ type: string; delta?: string }> = [];
  for await (const line of child.lines()) { seen.push(JSON.parse(line)); if (seen.length === 4) break; }
  assert.deepEqual(seen.map(message => message.type), ['text', 'done', 'text', 'done']);
  assert.equal(seen[0]!.delta!.length, 'echo: '.length + 20_000, 'the whole line arrived');
  assert.equal(seen[2]!.delta!.length, 'echo: '.length + 200_000);
  child.closeInput();
  assert.equal(child.writeLine('{"type":"user","text":"late"}'), false, 'a closed input refuses');
  await scope.finish();
});

test('a .cmd or .bat launcher is refused with a message that says what to do (Windows)', { skip: !WINDOWS && 'only Windows has .cmd launchers' }, async t => {
  const s = setup(t);
  mkdirSync(join(s.dir, 'bin'));
  const launcher = join(s.dir, 'bin', 'claude.cmd');
  writeFileSync(launcher, '@echo off\r\n');
  const scope = await s.manager.open();
  assert.throws(() => scope.spawn({ file: launcher, cwd: s.dir }), (error: unknown) => {
    assert.ok(error instanceof ProcessRefused && error.reason === 'launcher', String(error));
    assert.match(error.message, /cannot be started without a shell/u);
    assert.match(error.message, /\.exe/u);
    return true;
  });
  await scope.finish();
});

test('a line longer than the limit ends the stream at the last whole line and stops the runtime', async t => {
  const s = setup(t, { limits: { lineBytes: 1000 } });
  const { scope, child } = await s.start();
  child.writeLine(JSON.stringify({ type: 'models' }));
  child.writeLine(JSON.stringify({ type: 'long-line', bytes: 5000 }));
  const seen: string[] = [];
  for await (const line of child.lines()) seen.push(line);
  assert.deepEqual(seen.map(line => JSON.parse(line).type), ['models'], 'the whole line before the long one is kept; the long line and what follows are not');
  const exit = await child.exited;
  assert.equal(exit.limit, 'line');
  assert.equal(exit.stoppedBy, 'limit');
  await scope.finish();
  assert.equal(await gone(child.pid!), true);
});

test('output beyond the total limit ends the stream and stops the runtime', async t => {
  const s = setup(t, { limits: { totalBytes: 5000 } });
  const { scope, child } = await s.start();
  child.writeLine(JSON.stringify({ type: 'flood', bytes: 200_000 }));
  let bytes = 0;
  for await (const line of child.lines()) bytes += line.length + 1;
  assert.ok(bytes <= 5000, `at most the limit came through (${bytes})`);
  const exit = await child.exited;
  assert.equal(exit.limit, 'total');
  assert.equal(exit.stoppedBy, 'limit');
  await scope.finish();
  assert.equal(await gone(child.pid!), true);
});

test('a start the SDK can call (synchronous, command / args / cwd / env / signal in, stdin / stdout / exit out) goes through the same checks', async t => {
  const s = setup(t);
  const scope = await s.manager.open();
  const controller = new AbortController();
  const given = spawnOptions(s.dir, controller.signal);
  const spawned = scope.spawnForSdk(given);
  assert.equal(typeof (spawned as unknown as { then?: unknown }).then, 'undefined', 'it returns the process itself, not a promise');
  assert.equal(spawned.exitCode, null);
  assert.equal(spawned.killed, false);
  const exits: Array<[number | null, NodeJS.Signals | null]> = [];
  spawned.on('exit', (code, signal) => exits.push([code, signal]));
  spawned.stdin.write(`${JSON.stringify({ type: 'env' })}\n`);
  const reply = await new Promise<any>(resolve => spawned.stdout.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8')))));
  const names = Object.keys(reply.env);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'OPENAI_API_KEY']) assert.equal(names.includes(name), false, `${name} (given by the SDK caller) reached the child`);
  assert.equal(reply.env.CLAUDE_CONFIG_DIR, 'C:/Users/someone/.claude');
  assert.equal(spawned.kill('SIGTERM'), true);
  await until(() => exits.length > 0);
  assert.equal(spawned.killed, true);
  assert.equal(await gone(reply.pid), true);
  assert.throws(() => scope.spawnForSdk({ ...spawnOptions(s.dir, controller.signal), args: [FAKE_RUNTIME_SCRIPT, '--token=abcdef0123456789abcdef0123'] }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'args');
  await scope.finish();
});

function spawnOptions(cwd: string, signal: AbortSignal) {
  return {
    command: process.execPath,
    args: [FAKE_RUNTIME_SCRIPT],
    cwd,
    env: { ...basics(), ANTHROPIC_API_KEY: 'sentinel-key', ANTHROPIC_BASE_URL: 'sentinel-url', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '9', OPENAI_API_KEY: 'sentinel-openai', CLAUDE_CONFIG_DIR: 'C:/Users/someone/.claude' },
    signal,
  };
}

test('a start without a working folder is refused (the SDK form too) and never falls back to the folder beat itself runs in', async t => {
  const s = setup(t);
  const scope = await s.manager.open();
  const { cwd: _unused, ...withoutCwd } = spawnOptions(s.dir, new AbortController().signal);
  assert.throws(() => scope.spawnForSdk(withoutCwd), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  assert.throws(() => scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT] } as unknown as Parameters<typeof scope.spawn>[0]), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  assert.throws(() => scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT], cwd: '.' }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  assert.throws(() => scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT], cwd: 'relative/folder' }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  assert.equal(s.lines.some(line => line.includes('runtime process started')), false, 'nothing was started');
  await scope.finish();
});

test('a line with a line break is refused, so one write can never become two messages on the runtime\'s input', async t => {
  const s = setup(t);
  const { scope, child } = await s.start();
  for (const line of ['{"type":"user"}\n{"type":"approve"}', '{"type":"user"}\r{"type":"approve"}', '\n', 'a\r\nb']) {
    assert.throws(() => child.writeLine(line), (error: unknown) => error instanceof ProcessRefused && error.reason === 'line', JSON.stringify(line));
  }
  child.writeLine(JSON.stringify({ type: 'env' }));
  const seen: string[] = [];
  for await (const line of child.lines()) { seen.push(line); break; }
  assert.equal(seen.length, 1, 'a normal line (JSON.stringify escapes its own breaks) still works');
  await scope.finish();
});
