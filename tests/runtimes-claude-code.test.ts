import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeConfig } from '../src/config/schema.ts';
import type { AppPaths } from '../src/paths.ts';
import { ClaudeCodeError, createClaudeCodeRuntime, type ClaudeCodeOptions } from '../src/runtimes/claude-code/adapter.ts';
import { findClaudeExecutable } from '../src/runtimes/claude-code/executable.ts';
import { ProcessManager } from '../src/runtimes/process-manager.ts';
import { RuntimeRegistry } from '../src/runtimes/registry.ts';
import type { RuntimeEvent, RuntimePermission, RuntimeRequest } from '../src/runtimes/types.ts';
import { SECRET_GLOBS } from '../src/tools/hooks/scope.ts';
import { echoScript, FakeClaudeSdk, initMessage, resultMessage, sdkMessage, textMessage, type FakeScript, type FakeSdkConfig } from './helpers/fake-claude-sdk.ts';
import { tempDir } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BASICS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles'];
const basics = (): NodeJS.ProcessEnv => Object.fromEntries(BASICS.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

// 親の環境に入れる、子に渡ってはいけない名前（値は、漏れたらすぐ分かる目印）
const DROPPED: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sentinel-anthropic-key', ANTHROPIC_BASE_URL: 'sentinel-anthropic-url', CLAUDECODE: 'sentinel-claudecode', CLAUDE_CODE_ENTRYPOINT: 'sentinel-entrypoint',
  OPENAI_API_KEY: 'sentinel-openai', CODEX_API_KEY: 'sentinel-codex', GITHUB_TOKEN: 'sentinel-github',
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function until<T>(probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 25));
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

interface Report { answers: Array<PermissionResult | null>; pid?: number; grand?: number }

interface SetupOptions { script?: FakeScript; sdkConfig?: FakeSdkConfig; env?: Record<string, string>; runtime?: Partial<RuntimeConfig>; options?: Partial<ClaudeCodeOptions> }

function setup(t: TestContext, opts: SetupOptions = {}) {
  // 後始末は、一時のフォルダを消す（tempDir）より前に登録する（子が動いているあいだは消せない。後始末は登録の順に動く）
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const step of cleanup) await step(); });
  const root = tempDir(t);
  const app = join(root, 'app');
  const data = join(root, 'data');
  const work = join(root, 'work');
  for (const folder of [join(app, 'templates'), data, work]) mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  const processes = new ProcessManager({ log: line => lines.push(line), graceMs: 1500 });
  const sdk = new FakeClaudeSdk(opts.script, opts.sdkConfig);
  const loads = { count: 0 };
  const config: RuntimeConfig = { id: 'cc', kind: 'claude-code', enabled: true, executablePath: process.execPath, ...opts.runtime };
  const runtime = createClaudeCodeRuntime(config, { processes, log: line => lines.push(line) }, {
    loadSdk: async () => { loads.count += 1; return sdk; },
    paths: () => ({ data, templates: join(app, 'templates') }) as AppPaths,
    env: { ...basics(), ...opts.env },
    initTimeoutMs: 10_000,
    ...opts.options,
  });
  const started: string[] = [];
  cleanup.push(async () => { for (const id of started) await runtime.close(id); await processes.closeAll(); });
  const request = (over: Partial<RuntimeRequest> = {}): RuntimeRequest => ({ conversationId: 'c1', cwd: work, permission: 'default', signal: new AbortController().signal, ...over });
  const start = async (over: Partial<RuntimeRequest> = {}) => {
    const session = await runtime.start(request(over));
    started.push(session.id);
    return session;
  };
  return { root, app, data, work, lines, processes, sdk, loads, runtime, config, request, start };
}

type Runtime = ReturnType<typeof setup>['runtime'];

async function collect(runtime: Runtime, id: string, onEvent?: (event: RuntimeEvent) => Promise<void> | void, ms = 20_000): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const reading = (async () => { for await (const event of runtime.events(id)) { events.push(event); await onEvent?.(event); } })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out; events so far: ${JSON.stringify(events)}`)), ms); });
  await Promise.race([reading, timeout]).finally(() => clearTimeout(timer));
  return events;
}

const refused = (reason: ClaudeCodeError['reason']) => (error: unknown): boolean => {
  assert.ok(error instanceof ClaudeCodeError, `expected a ClaudeCodeError, got ${String(error)}`);
  assert.equal(error.reason, reason, error.message);
  return true;
};

const bash = (command: string): Record<string, unknown> => ({ command });

// 求めを順に出し、答えを控える流れ
function approvalScript(report: Report, requests: Array<{ tool?: string; input?: Record<string, unknown>; toolUseID?: string; suggestions?: PermissionUpdate[]; suppress?: boolean }>): FakeScript {
  return async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    for (const item of requests) {
      report.answers.push(await ctx.requestPermission(item.tool ?? 'Bash', item.input ?? bash('echo hi'), {
        ...(item.toolUseID !== undefined ? { toolUseID: item.toolUseID } : {}),
        ...(item.suggestions ? { suggestions: item.suggestions } : {}),
        ...(item.suppress ? { suppressAlwaysAllowRule: true } : {}),
      }));
    }
    yield resultMessage();
  };
}

// ---------------------------------------------------------------- 起こし方（SDK に渡るもの）

test('start asks for the default permission mode, user settings only, a fresh session id, the secret-path deny rules, and nothing that skips permission checks', async t => {
  const s = setup(t);
  const session = await s.start();
  const options = s.sdk.last.ctx.options;
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(options.settingSources, ['user'], 'the product folder settings.json and .mcp.json are not read');
  assert.equal(options.cwd, s.work);
  assert.equal(options.pathToClaudeCodeExecutable, process.execPath);
  assert.equal(options.includePartialMessages, true);
  assert.match(options.sessionId ?? '', UUID);
  assert.equal(session.runtimeSession, options.sessionId);
  assert.equal('resume' in options, false);
  assert.equal('allowDangerouslySkipPermissions' in options, false);
  assert.equal('permissionPromptToolName' in options, false);
  assert.equal(typeof options.canUseTool, 'function');
  assert.equal(typeof options.spawnClaudeCodeProcess, 'function');
  assert.ok(options.disallowedTools?.includes('AskUserQuestion'));
  assert.deepEqual(s.runtime.launchOf(session.id)?.settingSources, ['user']);
});

test('the permission value is narrowed again inside the adapter: a wide-open value or nothing becomes default; acceptEdits stays', async t => {
  const s = setup(t);
  const cases: Array<[string | undefined, string]> = [
    ['default', 'default'], ['acceptEdits', 'acceptEdits'], ['bypassPermissions', 'default'],
    ['plan', 'default'], ['auto', 'default'], ['dontAsk', 'default'], ['ACCEPTEDITS', 'default'], [undefined, 'default'],
  ];
  for (const [given, expected] of cases) {
    const session = await s.start({ permission: given as RuntimePermission });
    assert.equal(s.sdk.last.ctx.options.permissionMode, expected, `${String(given)} must start in ${expected}`);
    assert.equal(s.runtime.launchOf(session.id)?.permission, expected);
    await s.runtime.close(session.id);
  }
});

test('a permission value of the other runtime (Codex) is refused before anything starts, not turned into default', async t => {
  const s = setup(t);
  for (const given of ['workspace-write', 'read-only']) {
    await assert.rejects(s.start({ permission: given as RuntimePermission }), refused('permission'), given);
  }
  assert.equal(s.loads.count, 0, 'the SDK was not even loaded');
  assert.equal(s.sdk.queries.length, 0);
  assert.equal(s.lines.some(line => line.includes('runtime process started')), false, 'no process was started');
  await s.start({ permission: 'default' });
  assert.equal(s.sdk.queries.length, 1);
});

test('a session continues with the saved id (resume, no sessionId); a bad id or model name is refused before the SDK is called', async t => {
  const s = setup(t);
  const saved = '99999999-8888-4777-8666-555555555555';
  const session = await s.start({ resume: saved, model: 'sonnet' });
  const options = s.sdk.last.ctx.options;
  assert.equal(options.resume, saved);
  assert.equal('sessionId' in options, false, 'the SDK refuses a sessionId together with resume');
  assert.equal(options.model, 'sonnet');
  assert.equal(session.runtimeSession, saved);
  assert.equal(s.runtime.launchOf(session.id)?.resumed, true);
  const before = s.sdk.queries.length;
  await assert.rejects(s.start({ resume: 'not-a-uuid' }), refused('resume'));
  await assert.rejects(s.start({ resume: '--dangerously-skip-permissions' }), refused('resume'));
  await assert.rejects(s.start({ model: '--dangerously-skip-permissions' }), refused('model'));
  await assert.rejects(s.start({ model: 'a b' }), refused('model'));
  assert.equal(s.sdk.queries.length, before, 'nothing reached the SDK');
});

test('the working folder must be an existing absolute folder that does not overlap beat itself or its data folder, links included', async t => {
  const s = setup(t);
  mkdirSync(join(s.app, 'sub'), { recursive: true });
  mkdirSync(join(s.data, 'deep'), { recursive: true });
  writeFileSync(join(s.root, 'a-file.txt'), 'x');
  symlinkSync(s.app, join(s.root, 'link-to-app'), 'junction');
  const overlapping = [s.app, join(s.app, 'sub'), s.root, s.data, join(s.data, 'deep'), join(s.root, 'link-to-app')];
  for (const cwd of overlapping) {
    await assert.rejects(s.start({ cwd }), (error: unknown) => refused('cwd')(error) && /overlaps/u.test((error as Error).message), `${cwd} must be refused`);
  }
  for (const cwd of ['work', join(s.root, 'missing'), join(s.root, 'a-file.txt')]) await assert.rejects(s.start({ cwd }), refused('cwd'), `${cwd} must be refused`);
  assert.equal(s.sdk.queries.length, 0, 'the SDK was never called');
  assert.equal(s.lines.some(line => line.includes('runtime process started')), false, 'no process was started');
  await s.start();
  assert.equal(s.sdk.queries.length, 1, 'a folder of its own is accepted');
});

test('the working folder cannot be a device path, a network path, or a data-stream path, even when it points at an ordinary folder', async t => {
  const s = setup(t);
  const hazards = [`\\\\?\\${s.work}`, `\\\\.\\${s.work}`, `${s.work}:stream`, ...(WINDOWS ? ['\\\\server\\share\\work', '//server/share/work', `\\??\\${s.work}`] : [])];
  for (const cwd of hazards) {
    await assert.rejects(s.start({ cwd }), (error: unknown) => refused('cwd')(error) && /network path or a device path/u.test((error as Error).message), `${cwd} must be refused as a hazard`);
  }
  assert.equal(s.sdk.queries.length, 0, 'the SDK was never called');
  assert.equal(s.lines.some(line => line.includes('runtime process started')), false, 'no process was started');
});

test('a reply that was already stopped does not start; a missing or relative Claude Code path is refused', async t => {
  const s = setup(t);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(s.start({ signal: stopped.signal }), refused('aborted'));
  for (const executablePath of [join(s.root, 'nope', 'claude.exe'), 'claude.exe']) {
    const other = setup(t, { runtime: { executablePath } });
    await assert.rejects(other.start(), refused('executable'));
    assert.equal(other.sdk.queries.length, 0);
  }
});

test('a stop that arrives while Claude Code is still starting is not lost: the start is refused as stopped and the process is stopped', async t => {
  const s = setup(t, { sdkConfig: { initDelayMs: 400 } });
  const controller = new AbortController();
  const starting = s.runtime.start(s.request({ signal: controller.signal }));
  const outcome = assert.rejects(starting, refused('aborted'));
  await until(() => s.sdk.queries.length === 1);
  controller.abort();
  await outcome;
  const child = s.sdk.last.ctx.child!;
  await until(() => child.killed);
  assert.ok(s.sdk.last.closed);
  await until(() => child.exitCode !== null);
  const later = await s.start();
  assert.ok(later.id, 'a start that is not stopped still works');
});

test('the Claude Code body is found beside an npm launcher (.cmd), and a launcher without it is refused (Windows)', { skip: !WINDOWS }, t => {
  const root = tempDir(t);
  const bin = join(root, 'bin');
  const real = join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(bin, 'claude.cmd'), '@echo off');
  assert.ok('reason' in findClaudeExecutable(join(bin, 'claude.cmd'), {}), 'no body beside the launcher');
  writeFileSync(join(real, 'claude.exe'), 'x');
  assert.deepEqual(findClaudeExecutable(join(bin, 'claude.cmd'), {}), { path: join(real, 'claude.exe') });
  assert.deepEqual(findClaudeExecutable(undefined, { PATH: bin, PATHEXT: '.COM;.EXE;.CMD' }), { path: join(real, 'claude.exe') });
});

test('the PATH search uses only absolute entries: "." and empty entries do not look in the temp folder, relative entries do not look in the current folder', t => {
  const root = tempDir(t);
  const fakeTemp = join(root, 'temp');
  const bin = join(root, 'bin');
  mkdirSync(fakeTemp, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const name = WINDOWS ? 'claude.exe' : 'claude';
  writeFileSync(join(fakeTemp, name), 'planted');
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.TEMP = fakeTemp;
  process.env.TMP = fakeTemp;
  process.env.TMPDIR = fakeTemp;
  const planted = join(fakeTemp, name);
  const env = (path: string): NodeJS.ProcessEnv => ({ PATH: path, PATHEXT: '.COM;.EXE;.CMD' });
  for (const path of [`.${delimiter}`, `${delimiter}.${delimiter}`, delimiter, '.', 'temp']) {
    const found = findClaudeExecutable(undefined, env(path));
    assert.ok(!('path' in found) || found.path !== planted, `PATH=${path} must not find a program in the temp folder`);
  }
  writeFileSync(join(bin, name), 'real');
  assert.deepEqual(findClaudeExecutable(undefined, env(`.${delimiter}${delimiter}${bin}`)), { path: join(bin, name) }, 'the absolute entry is used, the "." and empty ones are skipped');
});

test('every optional program package of the SDK (its own copy of the Claude Code body) is turned into nothing by an override in package.json', () => {
  const root = new URL('..', import.meta.url);
  const read = (file: string): { optionalDependencies?: Record<string, string>; overrides?: Record<string, unknown> } => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const sdk = read('node_modules/@anthropic-ai/claude-agent-sdk/package.json');
  const mine = read('package.json');
  const optional = Object.keys(sdk.optionalDependencies ?? {});
  assert.ok(optional.length > 0, 'the SDK lists its body packages as optional dependencies');
  for (const name of optional) assert.equal(mine.overrides?.[name], '0.0.0-none', `${name} must be overridden so the SDK's own ~400 MB body is not installed`);
});

test('the SDK is loaded when the first reply starts, not when the runtime is made; a failed load is reported and tried again next time', async t => {
  let attempts = 0;
  const s = setup(t, { options: { loadSdk: async () => { attempts += 1; if (attempts === 1) throw new Error('boom'); return s.sdk; } } });
  await s.runtime.probe();
  assert.equal(attempts, 0, 'probing does not load the SDK');
  await assert.rejects(s.start(), (error: unknown) => refused('startup')(error) && /could not be loaded/u.test((error as Error).message));
  await s.start();
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------- 始まりの確かめ

test('start refuses before any message when the SDK reports an API key as the login source, and stops the process', async t => {
  const s = setup(t, { sdkConfig: { apiKeySource: 'ANTHROPIC_API_KEY' } });
  await assert.rejects(s.start(), refused('auth'));
  const child = s.sdk.last.ctx.child!;
  assert.ok(s.sdk.last.closed);
  await until(() => child.killed);
  await setup(t, { sdkConfig: { apiKeySource: 'none' } }).start();
  await setup(t).start();
});

test('start refuses a Claude Code older than the minimum, an unreadable version, a failing start, and one that never answers', async t => {
  for (const version of ['2.1.295', '2.0.999', '1.9.9', 'garbage']) {
    const s = setup(t, { sdkConfig: { version } });
    await assert.rejects(s.start(), refused('version'), version);
    await until(() => s.sdk.last.ctx.child!.killed);
  }
  for (const version of ['2.1.296', '2.2.0', '3.0.0']) await setup(t, { sdkConfig: { version } }).start();
  const failing = setup(t, { sdkConfig: { initError: new Error('spawn exploded with sk-ant-api03-ABCDEFGHIJKLMNOP') } });
  await assert.rejects(failing.start(), (error: unknown) => refused('startup')(error) && !(error as Error).message.includes('ABCDEFGHIJKLMNOP'));
  const hanging = setup(t, { sdkConfig: { initHangs: true }, options: { initTimeoutMs: 100 } });
  await assert.rejects(hanging.start(), refused('startup'));
  await until(() => hanging.sdk.last.ctx.child!.killed);
});

// ---------------------------------------------------------------- 1 回の返事

test('a reply streams text once (no double text from the finished message), shows the tool, asks for approval, and ends with done', async t => {
  const report: Report = { answers: [] };
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    const user = await ctx.nextUser();
    assert.equal((user?.message.content as Array<{ text: string }>)[0]?.text, 'please run it');
    yield sdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } });
    yield sdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
    yield sdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } });
    yield textMessage('m1', 'Hello');
    yield sdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: bash('echo hi') }] } });
    report.answers.push(await ctx.requestPermission('Bash', bash('echo hi'), { toolUseID: 'toolu_1' }));
    yield sdkMessage({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi', is_error: false }] } });
    yield resultMessage();
  };
  const s = setup(t, { script });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'please run it' });
  const events = await collect(s.runtime, session.id, event => event.type === 'approval' ? s.runtime.approve(session.id, event.requestId, 'accept') : undefined);
  assert.deepEqual(events, [
    { type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' },
    { type: 'tool_start', id: 'toolu_1', name: 'Bash', input: bash('echo hi') },
    { type: 'approval', requestId: 'toolu_1', tool: 'Bash', input: bash('echo hi') },
    { type: 'tool_end', id: 'toolu_1', output: 'hi', isError: false },
    { type: 'done' },
  ]);
  assert.deepEqual(report.answers, [{ behavior: 'allow', updatedInput: bash('echo hi') }]);
});

test('a tool result that holds a key reaches the screen with the key removed', async t => {
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    yield sdkMessage({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'bad sk-ant-api03-ABCDEFGHIJKLMNOP', is_error: false }] } });
    yield resultMessage();
  };
  const s = setup(t, { script });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  const events = await collect(s.runtime, session.id);
  const end = events.find(event => event.type === 'tool_end');
  assert.ok(end?.type === 'tool_end' && end.output.startsWith('bad ') && !end.output.includes('ABCDEFGHIJKLMNOP'), JSON.stringify(end));
});

test('a session takes one message: a second or empty message is refused', async t => {
  const s = setup(t);
  const session = await s.start();
  await assert.rejects(s.runtime.send(session.id, { text: '   ' }), refused('input'));
  await s.runtime.send(session.id, { text: 'one' });
  await assert.rejects(s.runtime.send(session.id, { text: 'two' }), refused('busy'));
  assert.deepEqual((await collect(s.runtime, session.id)).map(event => event.type), ['text', 'done']);
  await s.runtime.close(session.id);
  await assert.rejects(s.runtime.send(session.id, { text: 'again' }), refused('closed'));
  assert.throws(() => s.runtime.events(session.id), refused('closed'));
  await s.runtime.close(session.id);
});

test('a stream that ends without a result, or that throws, is reported as a failure (once)', async t => {
  const ends = setup(t, { script: async function* () { yield initMessage(); } });
  const a = await ends.start();
  await ends.runtime.send(a.id, { text: 'go' });
  assert.deepEqual(await collect(ends.runtime, a.id), [{ type: 'failed', kind: 'process', message: 'Claude Code ended without finishing the reply' }]);
  const throws = setup(t, { script: async function* () { yield initMessage(); throw new Error('stream broke sk-ant-api03-ABCDEFGHIJKLMNOP'); } });
  const b = await throws.start();
  await throws.runtime.send(b.id, { text: 'go' });
  const events = await collect(throws.runtime, b.id);
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'failed' && events[0].message.includes('stream broke') && !events[0].message.includes('ABCDEFGHIJKLMNOP'));
});

test('if the first message says an API key is in use, or a different permission mode, the reply stops at once and the process is killed', async t => {
  const key = setup(t, { script: async function* () { yield initMessage({ apiKeySource: 'ANTHROPIC_API_KEY' }); yield textMessage('m1', 'should never be shown'); yield resultMessage(); } });
  const a = await key.start();
  await key.runtime.send(a.id, { text: 'go' });
  const keyEvents = await collect(key.runtime, a.id);
  assert.deepEqual(keyEvents.map(event => event.type), ['failed']);
  assert.ok(keyEvents[0]?.type === 'failed' && keyEvents[0].kind === 'auth');
  await until(() => key.sdk.last.ctx.child!.killed);
  const silent = setup(t, { script: async function* () { yield initMessage({ apiKeySource: undefined }); yield textMessage('m1', 'should never be shown'); yield resultMessage(); } });
  const d = await silent.start();
  await silent.runtime.send(d.id, { text: 'go' });
  const silentEvents = await collect(silent.runtime, d.id);
  assert.deepEqual(silentEvents.map(event => event.type), ['failed'], 'a first message that does not say where the key comes from is not trusted');
  assert.ok(silentEvents[0]?.type === 'failed' && silentEvents[0].kind === 'auth');
  await until(() => silent.sdk.last.ctx.child!.killed);
  const mode = setup(t, { script: async function* () { yield initMessage({ permissionMode: 'bypassPermissions' }); yield textMessage('m1', 'nope'); yield resultMessage(); } });
  const b = await mode.start();
  await mode.runtime.send(b.id, { text: 'go' });
  const modeEvents = await collect(mode.runtime, b.id);
  assert.deepEqual(modeEvents.map(event => event.type), ['failed']);
  assert.ok(modeEvents[0]?.type === 'failed' && modeEvents[0].kind === 'process' && /permission mode/u.test(modeEvents[0].message));
  await until(() => mode.sdk.last.ctx.child!.killed);
  const acceptEdits = setup(t, { script: async function* () { yield initMessage({ permissionMode: 'acceptEdits' }); yield resultMessage(); } });
  const c = await acceptEdits.start({ permission: 'acceptEdits' });
  await acceptEdits.runtime.send(c.id, { text: 'go' });
  assert.deepEqual(await collect(acceptEdits.runtime, c.id), [{ type: 'done' }], 'the mode that was asked for is accepted');
});

// ---------------------------------------------------------------- 承認

test('decline and cancel are answered as denials (cancel also stops the reply); an unknown decision is a denial too', async t => {
  const report: Report = { answers: [] };
  const s = setup(t, { script: approvalScript(report, [{ toolUseID: 'a' }, { toolUseID: 'b' }, { toolUseID: 'c' }]) });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  const decisions: Record<string, string> = { a: 'decline', b: 'cancel', c: 'allow-everything' };
  await collect(s.runtime, session.id, event => event.type === 'approval' ? s.runtime.approve(session.id, event.requestId, decisions[event.requestId] as 'decline') : undefined);
  assert.deepEqual(report.answers, [
    { behavior: 'deny', message: 'The owner declined this request.' },
    { behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true },
    { behavior: 'deny', message: 'The owner declined this request.' },
  ]);
});

test('accept_for_reply returns only allow rules that stay inside this reply; user, project and local settings, directories and every mode change (acceptEdits too) are never returned', async t => {
  const dir = '/some/dir';
  const sessionRule: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }], behavior: 'allow', destination: 'session' };
  const sessionMode: PermissionUpdate = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
  const suggestions: PermissionUpdate[] = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'projectSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'cliArg' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'addDirectories', directories: [dir], destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' },
    { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    sessionRule, sessionMode,
  ];
  const report: Report = { answers: [] };
  const s = setup(t, { script: approvalScript(report, [{ toolUseID: 'a', suggestions }, { toolUseID: 'b', suggestions: suggestions.slice(0, 5) }, { toolUseID: 'c', suggestions, suppress: true }, { toolUseID: 'd', suggestions: [sessionMode] }]) });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  await collect(s.runtime, session.id, event => event.type === 'approval' ? s.runtime.approve(session.id, event.requestId, 'accept_for_reply') : undefined);
  assert.deepEqual(report.answers[0], { behavior: 'allow', updatedInput: bash('echo hi'), updatedPermissions: [sessionRule] }, 'the session mode change (acceptEdits for the rest of the reply) is wider than one approval and is dropped');
  assert.deepEqual(report.answers[1], { behavior: 'allow', updatedInput: bash('echo hi') }, 'nothing session-only to return: no updatedPermissions at all');
  assert.deepEqual(report.answers[2], { behavior: 'allow', updatedInput: bash('echo hi') }, 'a rule wider than the ask (suppressAlwaysAllowRule) is not returned');
  assert.deepEqual(report.answers[3], { behavior: 'allow', updatedInput: bash('echo hi') }, 'only a mode change on offer: a plain accept');
});

test('an approval is answered once; an unknown or already answered id, and a second ask with the same id while one waits, are refused', async t => {
  const report: Report = { answers: [] };
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    const first = ctx.requestPermission('Bash', bash('a'), { toolUseID: 'dup' });
    report.answers.push(await ctx.requestPermission('Bash', bash('b'), { toolUseID: 'dup' }));
    report.answers.push(await first);
    yield resultMessage();
  };
  const s = setup(t, { script });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  let approvals = 0;
  await collect(s.runtime, session.id, async event => {
    if (event.type !== 'approval') return;
    approvals += 1;
    await assert.rejects(s.runtime.approve(session.id, 'no-such-id', 'accept'), refused('busy'));
    await s.runtime.approve(session.id, event.requestId, 'accept');
    await assert.rejects(s.runtime.approve(session.id, event.requestId, 'decline'), refused('busy'), 'the second answer for the same id');
  });
  assert.equal(approvals, 1, 'only one approval was shown');
  assert.deepEqual(report.answers[0], { behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true }, 'the duplicate is closed');
  assert.deepEqual(report.answers[1], { behavior: 'allow', updatedInput: bash('a') });
});

test('when the SDK withdraws an ask (its signal aborts), the ask is closed and can no longer be approved', async t => {
  const report: Report = { answers: [] };
  const s = setup(t, { script: approvalScript(report, [{ toolUseID: 'x' }]) });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  await collect(s.runtime, session.id, async event => {
    if (event.type !== 'approval') return;
    s.sdk.last.ctx.permissionAbort.abort();
    await until(() => report.answers.length > 0);
    await assert.rejects(s.runtime.approve(session.id, event.requestId, 'accept'), refused('busy'));
  });
  assert.deepEqual(report.answers, [{ behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true }]);
});

// ---------------------------------------------------------------- 止める

test('interrupt answers waiting approvals with a stop, calls the SDK once, and a result that follows counts as done, not failed', async t => {
  const report: Report = { answers: [] };
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    const waiting = ctx.requestPermission('Bash', bash('sleep 100'), { toolUseID: 'w' });
    await ctx.interrupted;
    report.answers.push(await waiting);
    yield resultMessage({ subtype: 'error_during_execution', is_error: true, errors: [], result: '' });
  };
  const s = setup(t, { script });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  const events = await collect(s.runtime, session.id, event => event.type === 'approval' ? s.runtime.interrupt(session.id) : undefined);
  assert.deepEqual(events.map(event => event.type), ['approval', 'done']);
  assert.equal(s.sdk.last.interrupts, 1);
  assert.deepEqual(report.answers, [{ behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true }]);
  await s.runtime.interrupt(session.id);
  assert.equal(s.sdk.last.interrupts, 1, 'a finished reply is not interrupted again');
});

test('the same error result without an interrupt is a failure', async t => {
  const s = setup(t, { script: async function* () { yield initMessage(); yield resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['it broke'], result: '' }); } });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  assert.deepEqual(await collect(s.runtime, session.id), [{ type: 'failed', kind: 'process', message: 'it broke' }]);
});

test('aborting the request signal interrupts the reply', async t => {
  const s = setup(t, { script: async function* (ctx) { yield initMessage(); await ctx.nextUser(); await ctx.interrupted; yield resultMessage({ is_error: true, subtype: 'error_during_execution', errors: [] }); } });
  const stop = new AbortController();
  const session = await s.start({ signal: stop.signal });
  await s.runtime.send(session.id, { text: 'go' });
  stop.abort();
  await until(() => s.sdk.last.interrupts === 1);
  assert.deepEqual(await collect(s.runtime, session.id), [{ type: 'done' }]);
});

test('closing after a finished reply lets the process see the end of its input; closing in the middle kills it, and a close is safe to repeat', async t => {
  const dir = tempDir(t);
  const done = join(dir, 'eof-done');
  const a = setup(t, { sdkConfig: { childArgs: ['--eof-marker', done] } });
  const session = await a.start();
  await a.runtime.send(session.id, { text: 'go' });
  await collect(a.runtime, session.id);
  await a.runtime.close(session.id);
  assert.ok(existsSync(done), 'the process saw the end of its input (a graceful stop)');
  assert.ok(a.sdk.last.closed);
  await a.runtime.close(session.id);
  assert.equal(a.runtime.launchOf(session.id), undefined);

  const mid = join(dir, 'eof-mid');
  const report: Report = { answers: [] };
  const b = setup(t, {
    sdkConfig: { childArgs: ['--eof-marker', mid] },
    script: async function* (ctx) { yield initMessage(); await ctx.nextUser(); report.pid = (await ctx.ask({ type: 'env' })).pid; await new Promise(() => undefined); },
  });
  const running = await b.start();
  await b.runtime.send(running.id, { text: 'go' });
  await until(() => report.pid);
  await b.runtime.close(running.id);
  assert.ok(await gone(report.pid!), 'the process is gone');
  assert.equal(existsSync(mid), false, 'it was killed, not asked to finish');
});

test('closing in the middle of a reply stops the whole process tree and answers the waiting approval', async t => {
  const dir = tempDir(t);
  const report: Report = { answers: [] };
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    report.pid = (await ctx.ask({ type: 'env' })).pid;
    // 子が入れ物（ジョブ）に入ってから孫を起こさせる
    await new Promise(resolve => setTimeout(resolve, 1500));
    report.grand = (await ctx.ask({ type: 'grandchild', file: join(dir, 'grand.pid'), exit: false })).pid;
    report.answers.push(await ctx.requestPermission('Bash', bash('ping -n 60 127.0.0.1'), { toolUseID: 'p' }));
    await new Promise(() => undefined);
  };
  const s = setup(t, { script });
  const session = await s.start();
  await s.runtime.send(session.id, { text: 'go' });
  const seen: RuntimeEvent[] = [];
  const reading = collect(s.runtime, session.id, event => { seen.push(event); });
  await until(() => seen.some(event => event.type === 'approval'));
  assert.ok(alive(report.pid!) && alive(report.grand!), 'both are running before the close');
  await s.runtime.close(session.id);
  await reading;
  assert.ok(await gone(report.pid!), 'the process is gone');
  assert.ok(await gone(report.grand!), 'its child process is gone too');
  await until(() => report.answers.length === 1);
  assert.deepEqual(report.answers[0], { behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true });
});

// ---------------------------------------------------------------- 子が受け取るもの・記録

test('the child sees none of the API-key or other-runtime names from the parent, keeps CLAUDE_CONFIG_DIR, and the record names what was dropped without values', async t => {
  const seen: { env?: Record<string, string> } = {};
  const script: FakeScript = async function* (ctx) {
    yield initMessage();
    await ctx.nextUser();
    seen.env = (await ctx.ask({ type: 'env' })).env;
    yield resultMessage();
  };
  const s = setup(t, { script, env: { ...DROPPED, CLAUDE_CONFIG_DIR: 'C:/Users/someone/.claude' } });
  const session = await s.start();
  const options = s.sdk.last.ctx.options;
  for (const name of Object.keys(DROPPED)) assert.equal(name in (options.env ?? {}), false, `${name} was not given to the SDK`);
  await s.runtime.send(session.id, { text: 'go' });
  await collect(s.runtime, session.id);
  for (const name of Object.keys(DROPPED)) assert.equal(Object.keys(seen.env ?? {}).some(key => key.toUpperCase() === name), false, `${name} reached the child`);
  assert.equal(seen.env?.CLAUDE_CONFIG_DIR, 'C:/Users/someone/.claude');
  const launch = s.runtime.launchOf(session.id);
  assert.equal(launch?.record?.executable, process.execPath);
  assert.equal(launch?.record?.cwd, s.work);
  for (const name of Object.keys(DROPPED)) assert.ok(launch?.record?.droppedEnv.includes(name), `${name} is named in the record`);
  assert.ok(launch?.record?.keptEnv.includes('CLAUDE_CONFIG_DIR'));
  assert.equal(JSON.stringify(launch).includes('sentinel-'), false, 'no value is recorded');
  assert.equal(s.lines.some(line => line.includes('sentinel-')), false, 'no value is logged');
  assert.equal(launch?.claudeCodeVersion, '2.1.331');
});

test('every secret-path deny rule goes through the command line check of the process manager and into the record', async t => {
  const s = setup(t);
  const session = await s.start();
  const rules = s.sdk.last.ctx.options.disallowedTools ?? [];
  for (const glob of SECRET_GLOBS) {
    assert.ok(rules.includes(`Read(${glob})`), `Read(${glob})`);
    assert.ok(rules.includes(`Edit(${glob})`), `Edit(${glob})`);
  }
  const args = s.runtime.launchOf(session.id)?.record?.args ?? [];
  assert.ok(args.includes('Read(**/.env*)') && args.includes('Edit(**/*.pem)'), 'the fake child received the rules as arguments (nothing was redacted)');
});

test('the tools that ask a question, schedule later work, start remote work, publish or notify are turned off for a reply, for the model list, and on the child command line', async t => {
  const turnedOff = ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'Artifact', 'ClaudeDesign', 'PushNotification', 'SendUserMessage', 'SendUserFile', 'SendMessage', 'SendFeedback', 'ShareOnboardingGuide', 'EnterWorktree', 'ExitWorktree'];
  const s = setup(t);
  const session = await s.start();
  const reply = s.sdk.last.ctx.options.disallowedTools ?? [];
  const args = s.runtime.launchOf(session.id)?.record?.args ?? [];
  for (const name of turnedOff) {
    assert.ok(reply.includes(name), `${name} is turned off for a reply`);
    assert.ok(args.includes(name), `${name} reached the child command line`);
  }
  await s.runtime.models();
  const listing = s.sdk.last.ctx.options.disallowedTools ?? [];
  for (const name of turnedOff) assert.ok(listing.includes(name), `${name} is turned off for the model list`);
});

// ---------------------------------------------------------------- 状態・一覧

test('probe reads the version and only the logged-in flag, and never returns the account details', async t => {
  const asks: string[][] = [];
  let status = '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgName":"Example Org"}';
  let version: string[] | undefined = ['2.1.331 (Claude Code)'];
  const s = setup(t, { options: { ask: async (file, args) => { asks.push([file, ...args]); return args[0] === '--version' ? version : [status]; } } });
  assert.deepEqual(await s.runtime.probe(), { installed: true, version: '2.1.331', auth: 'ok' });
  assert.deepEqual(asks, [[process.execPath, '--version'], [process.execPath, 'auth', 'status', '--json']]);
  status = '{"loggedIn":false}';
  const out = await s.runtime.probe();
  assert.equal(out.auth, 'login_required');
  assert.match(out.reason ?? '', /claude auth login/u);
  status = 'not json';
  assert.equal((await s.runtime.probe()).auth, 'unknown');
  status = '{"loggedIn":"yes"}';
  assert.equal((await s.runtime.probe()).auth, 'unknown', 'only a real true counts as logged in');
  version = ['2.1.295 (Claude Code)'];
  asks.length = 0;
  const old = await s.runtime.probe();
  assert.deepEqual([old.installed, old.version, old.auth], [true, '2.1.295', 'unknown']);
  assert.equal(asks.length, 1, 'the login state is not asked of a body that is too old');
  version = undefined;
  assert.deepEqual(await s.runtime.probe(), { installed: true, auth: 'unknown', reason: 'The Claude Code version could not be read' });
  const missing = setup(t, { runtime: { executablePath: join(s.root, 'none', 'claude.exe') } });
  const absent = await missing.runtime.probe();
  assert.deepEqual([absent.installed, absent.auth], [false, 'unknown']);
});

test('probe starts the program through the process manager', async t => {
  const s = setup(t);
  const status = await s.runtime.probe();
  assert.equal(status.installed, true);
  assert.equal(status.auth, 'unknown', 'a program that is not Claude Code does not tell a login state');
  assert.ok(s.lines.some(line => line.includes('runtime process started')), s.lines.join('\n'));
});

test('models lists what the SDK reports from a process that reads no settings or MCP servers, then stops it', async t => {
  const s = setup(t);
  assert.deepEqual(await s.runtime.models(), [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { id: 'haiku', label: 'Haiku' }]);
  const options = s.sdk.last.ctx.options;
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.ok(options.disallowedTools?.includes('AskUserQuestion'));
  await until(() => s.sdk.last.ctx.child!.killed);
  const missing = setup(t, { runtime: { executablePath: join(s.root, 'none', 'claude.exe') } });
  await assert.rejects(missing.runtime.models(), refused('executable'));
});

// ---------------------------------------------------------------- 登録

test('the registry hands out a Claude Code runtime built from the settings: off by default, and a wide-open value falls back to default', () => {
  const registry = new RuntimeRegistry({ processes: new ProcessManager(), log: () => undefined });
  const off = registry.find({ runtimes: [{ id: 'cc', kind: 'claude-code', enabled: false }] }, 'cc');
  assert.equal(off.ok ? undefined : off.reason, 'disabled');
  const on = registry.find({ runtimes: [{ id: 'cc', kind: 'claude-code', enabled: true, permission: 'bypassPermissions' }] }, 'cc');
  assert.ok(on.ok);
  assert.equal(on.runtime.kind, 'claude-code');
  assert.equal(on.permission, 'default');
  assert.deepEqual(on.runtime.capabilities.permissions, ['default', 'acceptEdits']);
  const edits = registry.find({ runtimes: [{ id: 'cc', kind: 'claude-code', enabled: true, permission: 'acceptEdits' }] }, 'cc');
  assert.equal(edits.ok ? edits.permission : undefined, 'acceptEdits');
});

test('a reply started through the registry carries the permission mode chosen from the settings', async t => {
  const s = setup(t);
  const registry = new RuntimeRegistry({ processes: s.processes, log: () => undefined }, { 'claude-code': () => s.runtime, codex: undefined });
  const config = (permission?: string) => ({ runtimes: [{ ...s.config, ...(permission !== undefined ? { permission } : {}) }] });
  const request = { conversationId: 'c1', cwd: s.work, signal: new AbortController().signal };
  for (const [permission, expected] of [['acceptEdits', 'acceptEdits'], ['workspace-write', 'default'], [undefined, 'default']] as const) {
    const session = await registry.start(config(permission), 'cc', request);
    assert.equal(s.sdk.last.ctx.options.permissionMode, expected);
    await s.runtime.close(session.id);
  }
});
