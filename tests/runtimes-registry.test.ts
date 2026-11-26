import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { RUNTIME_KINDS, type RuntimeConfig, type RuntimeKind } from '../src/config/schema.ts';
import { ProcessManager, ProcessRefused } from '../src/runtimes/process-manager.ts';
import { FACTORIES, RuntimeRegistry, RuntimeUnavailable, type RuntimeFactory } from '../src/runtimes/registry.ts';
import { PERMISSIONS, permissionFor, type AgentRuntime, type RuntimeRequest } from '../src/runtimes/types.ts';
import { FakeRuntime } from './helpers/fake-runtime.ts';
import { tempDir } from './helpers.ts';

type Factories = Record<RuntimeKind, RuntimeFactory | undefined>;

function setup(factories: Partial<Factories> = {}) {
  const lines: string[] = [];
  const processes = new ProcessManager({ log: line => lines.push(line) });
  const made: FakeRuntime[] = [];
  const fake: RuntimeFactory = (config, deps) => { const runtime = new FakeRuntime(config, deps); made.push(runtime); return runtime; };
  const registry = new RuntimeRegistry({ processes, log: line => lines.push(line) }, { 'claude-code': fake, codex: fake, ...factories });
  return { registry, made, lines, processes };
}

const runtime = (id: string, kind: RuntimeKind, over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ id, kind, enabled: true, ...over });

test('both runtime names are pre-registered, so AR-4 and AR-5 each fill in one line of their own', () => {
  assert.deepEqual(Object.keys(FACTORIES).sort(), [...RUNTIME_KINDS].sort());
  assert.deepEqual([...RUNTIME_KINDS].sort(), ['claude-code', 'codex']);
  assert.deepEqual(new RuntimeRegistry({ processes: new ProcessManager(), log: () => undefined }).kinds(), RUNTIME_KINDS);
});

test('a runtime that is not in the settings, is turned off, or is not built yet is not handed out', () => {
  const s = setup({ codex: undefined });
  const config = { runtimes: [runtime('cc', 'claude-code'), runtime('off', 'claude-code', { enabled: false }), runtime('cx', 'codex')] };
  const found = s.registry.find(config, 'cc');
  assert.equal(found.ok, true);
  const unknown = s.registry.find(config, 'nope');
  assert.deepEqual(unknown.ok ? undefined : unknown.reason, 'unknown');
  const off = s.registry.find(config, 'off');
  assert.deepEqual(off.ok ? undefined : off.reason, 'disabled');
  const notBuilt = s.registry.find(config, 'cx');
  assert.equal(notBuilt.ok ? undefined : notBuilt.reason, 'not_built');
  assert.match(notBuilt.ok ? '' : notBuilt.detail, /not supported yet/u);
  assert.equal(s.registry.find({}, 'cc').ok, false, 'no runtimes section at all');
  assert.equal(s.made.length, 1, 'only the enabled, built runtime was made');
});

test('one runtime failing or being turned off does not touch the others', () => {
  let calls = 0;
  const s = setup({ 'claude-code': () => { calls += 1; throw new Error('cannot start'); } });
  const both = { runtimes: [runtime('cc', 'claude-code'), runtime('cx', 'codex')] };
  const failed = s.registry.find(both, 'cc');
  assert.equal(failed.ok ? undefined : failed.reason, 'failed');
  assert.match(failed.ok ? '' : failed.detail, /cannot start/u);
  assert.ok(s.lines.some(line => line.startsWith('[ERROR]') && line.includes('cannot start')));
  assert.equal(s.registry.find(both, 'cx').ok, true, 'codex is unaffected');
  assert.equal(s.registry.find(both, 'cc').ok, false);
  assert.equal(calls, 1, 'a failure is not retried until the settings of that runtime change');
  const changed = { runtimes: [runtime('cc', 'claude-code', { executablePath: 'C:/tools/claude.exe' }), runtime('cx', 'codex')] };
  s.registry.find(changed, 'cc');
  assert.equal(calls, 2, 'a changed setting tries again');
  const off = { runtimes: [runtime('cc', 'claude-code'), runtime('cx', 'codex', { enabled: false })] };
  assert.equal(s.registry.find(off, 'cx').ok, false);
  const stillThere = s.registry.find({ runtimes: [runtime('cc', 'claude-code'), runtime('cx', 'codex')] }, 'cx');
  assert.equal(stillThere.ok, true, 'turning one off and on again does not break it');
});

test('the same runtime object is handed out until its settings change, then it is made again', () => {
  const s = setup();
  const config = { runtimes: [runtime('cc', 'claude-code')] };
  const first = s.registry.find(config, 'cc');
  const again = s.registry.find(config, 'cc');
  assert.ok(first.ok && again.ok && first.runtime === again.runtime);
  const edited = s.registry.find({ runtimes: [runtime('cc', 'claude-code', { permission: 'acceptEdits' })] }, 'cc');
  assert.ok(edited.ok && edited.runtime !== first.runtime);
});

test('every start passes a permission setting; a missing, unknown or everything-allowed value becomes the default of that runtime', async t => {
  const s = setup();
  const cwd = tempDir(t);
  const signal = new AbortController().signal;
  const cases: Array<[RuntimeKind, string | undefined, string]> = [
    ['claude-code', undefined, 'default'],
    ['claude-code', 'acceptEdits', 'acceptEdits'],
    ['claude-code', 'bypassPermissions', 'default'],
    ['claude-code', 'dontAsk', 'default'],
    ['claude-code', '', 'default'],
    ['codex', undefined, 'read-only'],
    ['codex', 'workspace-write', 'workspace-write'],
    ['codex', 'danger-full-access', 'read-only'],
    ['codex', 'never', 'read-only'],
    ['codex', 'acceptEdits', 'read-only'],
  ];
  for (const [index, [kind, permission, expected]] of cases.entries()) {
    const id = `r${index}`;
    const config = { runtimes: [runtime(id, kind, permission === undefined ? {} : { permission })] };
    const session = await s.registry.start(config, id, { conversationId: 'c1', cwd, signal });
    const found = s.registry.find(config, id);
    assert.ok(found.ok);
    const fake = found.runtime as FakeRuntime;
    assert.equal(fake.starts.at(-1)!.permission, expected, `${kind} ${String(permission)}`);
    assert.equal(fake.starts.at(-1)!.cwd, cwd);
    await fake.close(session.id);
  }
  assert.deepEqual(PERMISSIONS, { 'claude-code': ['default', 'acceptEdits'], codex: ['read-only', 'workspace-write'] });
  assert.equal(permissionFor('codex', 'workspace-write'), 'workspace-write');
});

test('starting a runtime that is turned off or missing is refused with the reason', async t => {
  const s = setup();
  const cwd = tempDir(t);
  const signal = new AbortController().signal;
  await assert.rejects(s.registry.start({ runtimes: [runtime('cc', 'claude-code', { enabled: false })] }, 'cc', { conversationId: 'c', cwd, signal }), (error: unknown) => error instanceof RuntimeUnavailable && error.reason === 'disabled');
  await assert.rejects(s.registry.start({}, 'cc', { conversationId: 'c', cwd, signal }), (error: unknown) => error instanceof RuntimeUnavailable && error.reason === 'unknown');
  assert.equal(s.made.length, 0, 'nothing was made or started');
});

test('the window onto a runtime (fake runtime on a real child process): status, the model list, and one reply with its events, then close', async t => {
  const s = setup();
  const cwd = tempDir(t);
  const found = s.registry.find({ runtimes: [runtime('cc', 'claude-code')] }, 'cc');
  assert.ok(found.ok);
  const fake = found.runtime;
  assert.equal(fake.kind, 'claude-code');
  assert.equal(fake.capabilities.listsModels, true);
  assert.equal(fake.capabilities.externalApprovals, false, 'what the runtime cannot do is declared as not possible');
  assert.deepEqual(fake.capabilities.permissions, ['default', 'acceptEdits']);
  assert.deepEqual(await fake.probe(), { installed: true, version: '0.0.0-fake', auth: 'ok' });
  assert.deepEqual(await fake.models(), [{ id: 'fake-large', label: 'Fake large', efforts: ['low', 'high'] }, { id: 'fake-small' }]);
  const session = await fake.start({ conversationId: 'c1', cwd, permission: 'default', signal: new AbortController().signal });
  await fake.send(session.id, { text: 'hello' });
  const events = [];
  for await (const event of fake.events(session.id)) events.push(event);
  assert.deepEqual(events, [{ type: 'text', delta: 'echo: hello' }, { type: 'done' }]);
  await fake.close(session.id);
  await assert.rejects(fake.approve(session.id, 'r1', 'accept'));
});

test('a factory that fails with a key in its message neither logs nor returns the key', () => {
  const secret = 'sk-ant-api03-abcdef0123456789abcdef0123456789';
  const s = setup({ codex: () => { throw new Error(`could not start with ${secret}`); } });
  const found = s.registry.find({ runtimes: [runtime('cx', 'codex')] }, 'cx');
  assert.equal(found.ok ? undefined : found.reason, 'failed');
  assert.match(found.ok ? '' : found.detail, /could not be set up/u, 'the message is still useful');
  assert.equal(found.ok ? '' : found.detail.includes(secret), false, 'the returned detail has no key');
  assert.ok(s.lines.some(line => line.startsWith('[ERROR]') && line.includes('could not be set up')), 'the failure is logged');
  assert.equal(s.lines.some(line => line.includes(secret)), false, 'the log has no key');
});

test('the permission a runtime is started with is a closed type: a value outside the list does not type-check, and find() hands out the already-narrowed one', () => {
  const s = setup();
  const found = s.registry.find({ runtimes: [runtime('cc', 'claude-code', { permission: 'bypassPermissions' })] }, 'cc');
  assert.ok(found.ok);
  const narrowed: 'default' | 'acceptEdits' | 'read-only' | 'workspace-write' = found.permission;
  assert.equal(narrowed, 'default');
  const neverCalled = (runtimeToStart: AgentRuntime, base: Omit<RuntimeRequest, 'permission'>): void => {
    // @ts-expect-error bypassPermissions is not one of the permissions a runtime can be started with
    void runtimeToStart.start({ ...base, permission: 'bypassPermissions' });
    // @ts-expect-error an arbitrary string is not a permission either
    void runtimeToStart.start({ ...base, permission: 'anything' as string });
    void runtimeToStart.start({ ...base, permission: 'acceptEdits' });
  };
  assert.equal(typeof neverCalled, 'function');
});

test('when the process cannot be started, the fake runtime closes the job it opened (the template AR-4 and AR-5 copy does not leak a job helper)', async t => {
  let opened = 0;
  let closed = 0;
  const job = { add: () => undefined, close: async () => { closed += 1; }, ended: Promise.resolve(), listens: async () => 'unknown' as const };
  const processes = new ProcessManager({ log: () => undefined, openJob: async () => { opened += 1; return job; } });
  t.after(() => processes.closeAll());
  const fake = new FakeRuntime(runtime('cc', 'claude-code'), { processes });
  const missing = join(tempDir(t), 'no-such-folder');
  await assert.rejects(fake.start({ conversationId: 'c1', cwd: missing, permission: 'default', signal: new AbortController().signal }), (error: unknown) => error instanceof ProcessRefused && error.reason === 'cwd');
  assert.equal(opened, 1);
  assert.equal(closed, 1, 'the job was closed');
});
