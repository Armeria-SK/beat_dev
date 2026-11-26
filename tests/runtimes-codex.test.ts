import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '../src/config/schema.ts';
import { CodexRuntime, createCodexRuntime, type CodexRuntimeSession } from '../src/runtimes/codex/adapter.ts';
import { CodexRefused } from '../src/runtimes/codex/app-server.ts';
import { wirePermission } from '../src/runtimes/codex/protocol.ts';
import { ProcessManager } from '../src/runtimes/process-manager.ts';
import { FACTORIES, RuntimeRegistry } from '../src/runtimes/registry.ts';
import { PERMISSIONS, type ApprovalDecision, type RuntimeEvent, type RuntimeRequest } from '../src/runtimes/types.ts';
import { tempDir } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./helpers/fake-codex-app-server.mjs', import.meta.url));
const WINDOWS = process.platform === 'win32';
const SECRET = 'sk-ant-abcdefgh12345678';
const ACCOUNT_EMAIL = 'secret-person@example.com';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function rig(t: { after: (fn: () => void | Promise<void>) => void }, scenario = 'text', extra: string[] = [], config: Partial<RuntimeConfig> = {}, options: { initializeTimeoutMs?: number } = {}) {
  const dir = tempDir(t);
  const logFile = join(dir, 'client.jsonl');
  const work = join(dir, 'work');
  mkdirSync(work);
  const lines: string[] = [];
  const processes = new ProcessManager({ log: line => lines.push(line), graceMs: 3000 });
  const deps = { processes, log: (line: string) => lines.push(line) };
  const launch = { file: process.execPath, args: [FAKE, '--log', logFile, '--scenario', scenario, ...extra] };
  const runtime = new CodexRuntime({ id: 'cx', kind: 'codex', enabled: true, ...config }, deps, { launch, ...options });
  const log = (): any[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const requests = (): any[] => log().filter(entry => entry.dir === 'in' && entry.message.method !== undefined).map(entry => entry.message);
  const answers = (): any[] => log().filter(entry => entry.dir === 'answer').map(entry => entry.message);
  const request = (over: Partial<RuntimeRequest> = {}): RuntimeRequest => ({ conversationId: 'c1', cwd: work, permission: 'read-only', signal: new AbortController().signal, ...over });
  return { runtime, lines, log, requests, answers, request, work, dir, processes, deps, launch, pid: (): number => log().find(entry => entry.dir === 'pid').pid as number };
}

async function collect(runtime: CodexRuntime, sessionId: string, onEvent?: (event: RuntimeEvent) => Promise<void> | void): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.events(sessionId)) { events.push(event); await onEvent?.(event); }
  return events;
}

// 起こす → 1 回発言 → 出来事を最後まで → 閉じる
async function reply(r: ReturnType<typeof rig>, over: Partial<RuntimeRequest> = {}, decide?: (event: Extract<RuntimeEvent, { type: 'approval' }>) => ApprovalDecision) {
  const session = await r.runtime.start(r.request(over));
  await r.runtime.send(session.id, { text: 'hello' });
  const events = await collect(r.runtime, session.id, async event => { if (event.type === 'approval' && decide) await r.runtime.approve(session.id, event.requestId, decide(event)); });
  await r.runtime.close(session.id);
  return { session, events };
}

const refused = (reason: CodexRefused['reason']) => (error: unknown): boolean => error instanceof CodexRefused && error.reason === reason;

test('a normal reply: text, tools, no experimental API, and every request carries read-only + on-request + user', { timeout: 60_000 }, async t => {
  const r = rig(t, 'text');
  const { session, events } = await reply(r);
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => (event as { delta: string }).delta), ['Hel', 'lo', '\n\n', 'Second without deltas'], 'streamed text is not repeated from the final item; a message without deltas is used; messages are separated');
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(events.filter(event => event.type === 'done').length, 1, 'a turn of another conversation is not ours');
  assert.equal(events.filter(event => event.type === 'unknown').length, 1, 'only the truly new notification is kept');
  assert.ok(r.lines.some(line => line.includes('Codex said (configWarning)') && !line.includes(SECRET)), 'a warning is logged with secrets hidden');
  const requests = r.requests();
  const init = requests.find(message => message.method === 'initialize');
  assert.equal(init.params.capabilities.experimentalApi, false);
  assert.equal(requests.find(message => message.method === 'account/read').params.refreshToken, false);
  const start = requests.find(message => message.method === 'thread/start');
  const { cwd: startCwd, ...startRest } = start.params;
  assert.equal(startCwd, r.work);
  assert.deepEqual(startRest, { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: false });
  const turn = requests.find(message => message.method === 'turn/start');
  assert.equal(turn.params.approvalPolicy, 'on-request');
  assert.equal(turn.params.approvalsReviewer, 'user');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  const wire = JSON.stringify(requests);
  for (const forbidden of ['untrusted', '"never"', 'danger-full-access', 'dangerFullAccess', 'auto_review', 'guardian_subagent', 'granular', 'experimentalApi":true']) assert.ok(!wire.includes(forbidden), `${forbidden} was sent`);
  assert.deepEqual(requests.map(message => message.method).filter(Boolean), ['initialize', 'initialized', 'account/read', 'windowsSandbox/readiness', 'thread/start', 'turn/start']);
  const record = session.record;
  assert.equal(record.version, '0.172.0');
  assert.equal(record.verifiedVersion, true);
  assert.equal(record.account, 'chatgpt');
  assert.equal(record.sandboxReadiness, 'ready');
  assert.deepEqual(record.sent, { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
  assert.deepEqual(record.effective, { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'readOnly', modelProvider: 'openai' });
  assert.equal(record.threadId, 'thr-1');
  assert.equal(session.runtimeSession, 'thr-1');
  const everything = JSON.stringify([record, events, r.lines]);
  for (const identifier of [ACCOUNT_EMAIL, 'user-secret-id', 'acct-secret']) assert.ok(!everything.includes(identifier), `${identifier} leaked`);
});

test('the permission setting is applied on every start: garbage, missing and everything-allowed values become read-only + on-request', { timeout: 120_000 }, async t => {
  const values: unknown[] = [undefined, '', 'bypassPermissions', 'danger-full-access', 'never', 'untrusted', 'READ-ONLY', 'auto', 'dontAsk', 42, null, {}];
  for (const value of values) {
    const r = rig(t);
    const { session } = await reply(r, { permission: value as never });
    assert.equal(session.record.permission, 'read-only', `the adapter applies permissionFor itself for ${String(value)}`);
    const start = r.requests().find(message => message.method === 'thread/start');
    const turn = r.requests().find(message => message.method === 'turn/start');
    assert.equal(start.params.sandbox, 'read-only', `thread/start for ${String(value)}`);
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly', `turn/start for ${String(value)}`);
  }
  const r = rig(t);
  const { session } = await reply(r, { permission: 'workspace-write' });
  assert.equal(r.requests().find(message => message.method === 'thread/start').params.sandbox, 'workspace-write');
  assert.deepEqual(r.requests().find(message => message.method === 'turn/start').params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(session.record.permission, 'workspace-write');
  for (const permission of [...PERMISSIONS.codex, undefined, 'bypassPermissions', 'danger-full-access']) {
    const wire = wirePermission(permission);
    assert.equal(wire.approvalPolicy, 'on-request');
    assert.equal(wire.approvalsReviewer, 'user');
    assert.ok(wire.sandbox === 'read-only' || wire.sandbox === 'workspace-write');
  }
});

test('a Claude Code permission value is refused, and no process is started for it', { timeout: 30_000 }, async t => {
  for (const value of PERMISSIONS['claude-code']) {
    const r = rig(t);
    await assert.rejects(r.runtime.start(r.request({ permission: value as never })), refused('permission'));
    assert.equal(r.log().length, 0, 'the app-server was never started');
  }
});

test('the Windows sandbox must be ready: not ready means no conversation, no thread, no process left', { timeout: 60_000 }, async t => {
  for (const readiness of ['updateRequired', 'notConfigured', 'none']) {
    const r = rig(t, 'text', ['--readiness', readiness]);
    await assert.rejects(r.runtime.start(r.request()), refused('sandbox_not_ready'));
    const methods = r.requests().map(message => message.method);
    assert.ok(methods.includes('windowsSandbox/readiness'));
    assert.ok(!methods.includes('thread/start') && !methods.includes('turn/start'), `${readiness}: a thread was started`);
    assert.equal(alive(r.pid()), false, 'the process was stopped');
  }
  const linux = rig(t, 'text', ['--platform', 'linux', '--readiness', 'updateRequired']);
  await reply(linux);
  assert.ok(!linux.requests().some(message => message.method === 'windowsSandbox/readiness'), 'the Windows check is only for Windows');
});

test('the login must be a ChatGPT subscription: not signed in or an API key means no conversation', { timeout: 60_000 }, async t => {
  const none = rig(t, 'text', ['--account', 'none']);
  await assert.rejects(none.runtime.start(none.request()), refused('login_required'));
  const apiKey = rig(t, 'text', ['--account', 'apiKey']);
  await assert.rejects(apiKey.runtime.start(apiKey.request()), (error: unknown) => refused('auth_mismatch')(error) && /apiKey/u.test((error as Error).message));
  for (const r of [none, apiKey]) {
    const methods = r.requests().map(message => message.method);
    assert.ok(!methods.includes('thread/start') && !methods.includes('windowsSandbox/readiness'), 'nothing was started or checked after the login check failed');
    assert.equal(alive(r.pid()), false);
  }
});

test('the settings Codex says are in effect must be the ones beat asked for', { timeout: 90_000 }, async t => {
  const cases: string[][] = [['--eff-approval', 'never'], ['--eff-approval', 'untrusted'], ['--eff-reviewer', 'auto_review'], ['--eff-sandbox', 'danger-full-access'], ['--eff-sandbox', 'workspace-write'], ['--eff-network', 'true']];
  for (const extra of cases) {
    const r = rig(t, 'text', extra);
    await assert.rejects(r.runtime.start(r.request()), refused('config_mismatch'), extra.join(' '));
    assert.ok(!r.requests().some(message => message.method === 'turn/start'));
    assert.equal(alive(r.pid()), false);
  }
});

test('the conversation must go to OpenAI and nothing else may be in force: another provider, a missing answer or a named permission profile stop the start', { timeout: 90_000 }, async t => {
  const cases: Array<[string[], CodexRefused['reason']]> = [[['--provider', 'azure'], 'auth_mismatch'], [['--omit-provider'], 'auth_mismatch'], [['--omit-effective'], 'config_mismatch'], [['--active-profile'], 'config_mismatch']];
  for (const [extra, reason] of cases) {
    const r = rig(t, 'text', extra);
    await assert.rejects(r.runtime.start(r.request()), refused(reason), extra.join(' '));
    assert.ok(!r.requests().some(message => message.method === 'turn/start'), `${extra.join(' ')}: no reply was started`);
    assert.equal(alive(r.pid()), false, `${extra.join(' ')}: the process was stopped`);
  }
});

test('a resume that answers with a different conversation than the one asked for is an error, with nothing left running', { timeout: 30_000 }, async t => {
  const r = rig(t, 'text', ['--resume-other']);
  await assert.rejects(r.runtime.start(r.request({ resume: 'thr-9' })), refused('protocol'));
  assert.ok(!r.requests().some(message => message.method === 'thread/start' || message.method === 'turn/start'), 'no other conversation was started or used');
  assert.equal(alive(r.pid()), false);
});

test('resume sends thread/resume without history; a refused resume is an error, never a silent new conversation', { timeout: 60_000 }, async t => {
  const r = rig(t);
  const { session } = await reply(r, { resume: 'thr-9' });
  const resume = r.requests().find(message => message.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'thr-9');
  assert.equal(resume.params.excludeTurns, true);
  assert.equal(resume.params.approvalPolicy, 'on-request');
  assert.equal(resume.params.sandbox, 'read-only');
  assert.equal(session.record.resumed, true);
  assert.equal(session.runtimeSession, 'thr-9');
  const failing = rig(t, 'text', ['--resume-fails']);
  await assert.rejects(failing.runtime.start(failing.request({ resume: 'thr-9' })), (error: unknown) => refused('protocol')(error) && !(error as Error).message.includes(SECRET));
  assert.ok(!failing.requests().some(message => message.method === 'thread/start'), 'no new conversation was started in its place');
});

test('tool items become tool_start / tool_end; output is cut and secrets are hidden; quiet items are dropped and a new item type is kept', { timeout: 60_000 }, async t => {
  const r = rig(t, 'tools');
  const { events } = await reply(r);
  const starts = events.filter(event => event.type === 'tool_start') as Array<Extract<RuntimeEvent, { type: 'tool_start' }>>;
  assert.deepEqual(starts.map(event => [event.id, event.name]), [['c1', 'commandExecution'], ['f1', 'fileChange']]);
  assert.deepEqual(starts[0]?.input, { command: 'echo hi', cwd: 'D:\\work' });
  const ends = events.filter(event => event.type === 'tool_end') as Array<Extract<RuntimeEvent, { type: 'tool_end' }>>;
  assert.equal(ends[0]?.isError, false);
  assert.ok(!ends[0]?.output.includes(SECRET));
  assert.ok((ends[0]?.output.length ?? 0) < 101_000, 'a long output is cut');
  assert.equal(ends[1]?.isError, true, 'a declined change is an error row');
  assert.equal(ends[1]?.output, 'update src/a.ts');
  const unknown = events.filter(event => event.type === 'unknown');
  assert.equal(unknown.length, 1);
  assert.match((unknown[0] as { raw: string }).raw, /brandNewItemType/u);
});

test('a command approval reaches the owner as an event, and only the closed answers go back', { timeout: 60_000 }, async t => {
  const table: Array<[ApprovalDecision, string]> = [['accept', 'accept'], ['accept_for_reply', 'acceptForSession'], ['decline', 'decline'], ['cancel', 'cancel']];
  for (const [decision, expected] of table) {
    const r = rig(t, 'command-approval');
    const seen: Array<Extract<RuntimeEvent, { type: 'approval' }>> = [];
    const { events } = await reply(r, {}, event => { seen.push(event); return decision; });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.tool, 'commandExecution');
    assert.deepEqual(seen[0]?.input, { kind: 'command', itemId: 'c1', command: 'ls -la', cwd: 'D:\\work', reason: null, network: null, actions: [{ type: 'listFiles', command: 'ls -la' }] });
    assert.ok(!JSON.stringify(seen[0]).includes('execpolicy') && !JSON.stringify(seen[0]).includes('"ls"'), 'proposed rule changes are not carried');
    assert.deepEqual(r.answers().map(answer => ({ id: answer.id, result: answer.result })), [{ id: 100, result: { decision: expected } }]);
    assert.equal(events.at(-1)?.type, 'done');
  }
});

test('an approval can be answered once: a second answer, an unknown id and an unknown answer are refused', { timeout: 60_000 }, async t => {
  const r = rig(t, 'command-approval');
  const session = await r.runtime.start(r.request());
  await r.runtime.send(session.id, { text: 'go' });
  const iterator = r.runtime.events(session.id)[Symbol.asyncIterator]();
  let approval: Extract<RuntimeEvent, { type: 'approval' }> | undefined;
  while (!approval) { const next = await iterator.next(); if (next.value?.type === 'approval') approval = next.value; }
  await assert.rejects(r.runtime.approve(session.id, approval.requestId, 'acceptWithExecpolicyAmendment' as never), refused('protocol'));
  await assert.rejects(r.runtime.approve(session.id, 'codex-n999', 'accept'), refused('protocol'));
  await r.runtime.approve(session.id, approval.requestId, 'accept');
  await assert.rejects(r.runtime.approve(session.id, approval.requestId, 'decline'), refused('protocol'), 'the second answer is refused');
  while (!(await iterator.next()).done) { /* 最後まで */ }
  await r.runtime.close(session.id);
  assert.deepEqual(r.answers().map(answer => answer.result), [{ decision: 'accept' }], 'only the first answer reached Codex');
});

test('two approvals at once: each answer goes to its own request', { timeout: 60_000 }, async t => {
  const r = rig(t, 'two-approvals');
  await reply(r, {}, event => ((event.input as { itemId: string }).itemId === 'c1' ? 'accept' : 'decline'));
  const byId = Object.fromEntries(r.answers().map(answer => [answer.id, answer.result.decision]));
  assert.deepEqual(byId, { 101: 'accept', 102: 'decline' });
});

test('a file change approval gets its paths from the item that started it; without one the paths are unknown (null)', { timeout: 60_000 }, async t => {
  const r = rig(t, 'file-approval');
  const seen: Array<Extract<RuntimeEvent, { type: 'approval' }>> = [];
  await reply(r, {}, event => { seen.push(event); return 'accept'; });
  assert.deepEqual(seen.map(event => event.tool), ['fileChange', 'fileChange']);
  assert.deepEqual(seen[0]?.input, { itemId: 'f1', reason: 'needs write', grantRoot: 'D:\\work', changes: [{ path: 'src/a.ts', kind: 'update', movePath: 'src/b.ts' }, { path: 'src/new.ts', kind: 'add' }] });
  assert.deepEqual(seen[1]?.input, { itemId: 'ghost', reason: null, grantRoot: null, changes: null });
  assert.ok(!JSON.stringify(seen).includes('@@'), 'the diff itself is not carried');
});

test('a file change list that changed (patchUpdated) before the approval is not shown stale: the paths become unknown (null)', { timeout: 60_000 }, async t => {
  const r = rig(t, 'patch-updated');
  const seen: Array<Extract<RuntimeEvent, { type: 'approval' }>> = [];
  const { events } = await reply(r, {}, event => { seen.push(event); return 'decline'; });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.input, { itemId: 'f1', reason: null, grantRoot: null, changes: null });
  assert.equal(events.some(event => event.type === 'unknown'), false, 'patchUpdated is known, not a new kind of event');
});

test('a request name from Codex is cut, cleaned of control characters and secrets before it reaches a log line or a row name', { timeout: 60_000 }, async t => {
  const r = rig(t, 'odd-method');
  const { events } = await reply(r);
  const control = /[\p{Cc}\p{Cf}]/u;
  const start = events.find(event => event.type === 'tool_start') as Extract<RuntimeEvent, { type: 'tool_start' }>;
  const end = events.find(event => event.type === 'tool_end') as Extract<RuntimeEvent, { type: 'tool_end' }>;
  assert.ok(start.name.length <= 100 && !control.test(start.name), start.name);
  assert.ok(end.output.length < 250 && !control.test(end.output), end.output);
  const logged = r.lines.filter(line => line.includes('asked for something'));
  assert.equal(logged.length, 1);
  assert.ok(logged[0]!.length < 250 && !control.test(logged[0]!), logged[0]);
  assert.ok(!logged[0]!.includes('abcdefgh12345678') && !start.name.includes('abcdefgh12345678') && !end.output.includes('abcdefgh12345678'), 'a secret in the name is hidden');
});

test('network and stdin requests are carried for the owner, flagged; permission requests are granted only as asked and only for the turn', { timeout: 90_000 }, async t => {
  const net = rig(t, 'network-and-stdin');
  const seen: Array<Extract<RuntimeEvent, { type: 'approval' }>> = [];
  await reply(net, {}, event => { seen.push(event); return 'accept_for_reply'; });
  assert.deepEqual(seen.map(event => (event.input as { kind: string }).kind), ['command', 'writeStdin']);
  assert.deepEqual((seen[0]?.input as { network: unknown }).network, { host: 'example.com', protocol: 'https' });
  assert.deepEqual(net.answers().map(answer => answer.result), [{ decision: 'acceptForSession' }, { decision: 'acceptForSession' }]);

  const granted = rig(t, 'permissions');
  await reply(granted, {}, () => 'accept');
  assert.deepEqual(granted.answers()[0].result, { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['D:\\other'] } }, scope: 'turn' });
  const sessionWide = rig(t, 'permissions');
  await reply(sessionWide, {}, () => 'accept_for_reply');
  assert.equal(sessionWide.answers()[0].result.scope, 'turn', 'never session');
  for (const decision of ['decline', 'cancel'] as const) {
    const denied = rig(t, 'permissions');
    await reply(denied, {}, () => decision);
    assert.deepEqual(denied.answers()[0].result, { permissions: {}, scope: 'turn' }, 'nothing is added');
  }
});

test('requests beat cannot answer are declined without hanging Codex, and leave a row in the conversation', { timeout: 60_000 }, async t => {
  const r = rig(t, 'unanswerable');
  const { events } = await reply(r);
  const byId = Object.fromEntries(r.answers().map(answer => [answer.id, answer]));
  assert.deepEqual(byId[140].result, { answers: {} });
  assert.deepEqual(byId[141].result, { action: 'decline', content: null, _meta: null });
  assert.equal(byId[142].error.code, -32601);
  assert.equal(byId[143].error.code, -32601);
  assert.deepEqual(byId[144].result, { decision: 'decline' });
  assert.equal(byId[145].error.code, -32601);
  assert.equal(byId[146].error.code, -32602);
  assert.equal(events.some(event => event.type === 'approval'), false, 'none of them reached the owner as an approval');
  const rows = events.filter(event => event.type === 'tool_end') as Array<Extract<RuntimeEvent, { type: 'tool_end' }>>;
  assert.ok(rows.length >= 5 && rows.every(row => row.isError && /beat cannot answer/u.test(row.output)));
  assert.ok(!events.some(event => event.type === 'tool_start' && event.name === 'account/chatgptAuthTokens/refresh'), 'the token request leaves no row, only a log line');
  assert.equal(events.at(-1)?.type, 'done');
});

test('a failed turn is failed with a kind; secrets in the message are hidden', { timeout: 60_000 }, async t => {
  const auth = await reply(rig(t, 'failed-auth'));
  const failure = auth.events.at(-1) as Extract<RuntimeEvent, { type: 'failed' }>;
  assert.equal(failure.type, 'failed');
  assert.equal(failure.kind, 'auth');
  assert.ok(!failure.message.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  const rate = (await reply(rig(t, 'failed-rate'))).events.at(-1) as Extract<RuntimeEvent, { type: 'failed' }>;
  assert.equal(rate.kind, 'rate_limit');
  const plain = (await reply(rig(t, 'failed-plain'))).events.at(-1) as Extract<RuntimeEvent, { type: 'failed' }>;
  assert.equal(plain.kind, 'process');
});

test('the process dying mid-reply is a failure (not a success), with its message hidden of secrets, and nothing stays running', { timeout: 60_000 }, async t => {
  const r = rig(t, 'crash');
  const { events } = await reply(r);
  const last = events.at(-1) as Extract<RuntimeEvent, { type: 'failed' }>;
  assert.equal(last.type, 'failed');
  assert.equal(last.kind, 'process');
  assert.match(last.message, /exit code 3/u);
  assert.ok(!last.message.includes(SECRET));
  assert.equal(events.some(event => event.type === 'done'), false);
  assert.equal(alive(r.pid()), false);
});

test('a long message is accepted: a full pipe is not a failure, the whole text arrives, and the reply ends', { timeout: 90_000 }, async t => {
  for (const size of [20_000, 200_000]) {
    const r = rig(t);
    const session = await r.runtime.start(r.request());
    await r.runtime.send(session.id, { text: 'x'.repeat(size) });
    const events = await collect(r.runtime, session.id);
    assert.equal(events.at(-1)?.type, 'done', `${size} characters`);
    const turn = r.requests().find(message => message.method === 'turn/start');
    assert.equal(turn.params.input[0].text.length, size, 'every character arrived');
    await r.runtime.close(session.id);
  }
});

test('a reply that cannot be started ends as failed, stops the process, and the caller is told', { timeout: 60_000 }, async t => {
  const r = rig(t, 'text', ['--turn-error']);
  const session = await r.runtime.start(r.request());
  await assert.rejects(r.runtime.send(session.id, { text: 'go' }), (error: unknown) => refused('protocol')(error) && !(error as Error).message.includes(SECRET));
  const events = await collect(r.runtime, session.id);
  assert.deepEqual(events.map(event => event.type), ['failed']);
  const failure = events[0] as Extract<RuntimeEvent, { type: 'failed' }>;
  assert.equal(failure.kind, 'process');
  assert.ok(!failure.message.includes(SECRET));
  assert.ok(await gone(r.pid()), 'the process was stopped');
  await r.runtime.close(session.id);
});

test('when the reply ends Codex gets its input closed and exits by itself, without waiting for close()', { timeout: 60_000 }, async t => {
  const r = rig(t);
  const session = await r.runtime.start(r.request());
  await r.runtime.send(session.id, { text: 'go' });
  const events = await collect(r.runtime, session.id);
  assert.equal(events.at(-1)?.type, 'done');
  assert.ok(await gone(r.pid(), 5000), 'the process ended after the reply, before close()');
  await r.runtime.close(session.id);
});

test('a bare "codex" is never taken from the work folder: empty and relative PATH entries are skipped', { timeout: 30_000 }, async t => {
  const dir = tempDir(t);
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(work, WINDOWS ? 'codex.exe' : 'codex'), '');
  const processes = new ProcessManager({ env: { PATH: ['', '.', 'relative-bin'].join(delimiter) } });
  const runtime = new CodexRuntime({ id: 'cx', kind: 'codex', enabled: true }, { processes, log: () => undefined });
  await assert.rejects(runtime.start({ conversationId: 'c1', cwd: work, permission: 'read-only', signal: new AbortController().signal }), refused('not_installed'));
});

test('interrupt asks Codex to stop the turn and the reply ends; waiting approvals are cancelled, not answered', { timeout: 60_000 }, async t => {
  const hang = rig(t, 'hang');
  const session = await hang.runtime.start(hang.request());
  await hang.runtime.send(session.id, { text: 'go' });
  await hang.runtime.interrupt(session.id);
  const events = await collect(hang.runtime, session.id);
  assert.equal(events.at(-1)?.type, 'done');
  const interrupt = hang.requests().find(message => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thr-1', turnId: 'turn-1' });
  await hang.runtime.close(session.id);

  const waiting = rig(t, 'hang-approval');
  const second = await waiting.runtime.start(waiting.request());
  await waiting.runtime.send(second.id, { text: 'go' });
  const iterator = waiting.runtime.events(second.id)[Symbol.asyncIterator]();
  for (;;) { const next = await iterator.next(); if (next.value?.type === 'approval') break; }
  await waiting.runtime.interrupt(second.id);
  while (!(await iterator.next()).done) { /* 最後まで */ }
  assert.deepEqual(waiting.answers().map(answer => answer.result), [{ decision: 'cancel' }]);
  await waiting.runtime.close(second.id);

  const stubborn = rig(t, 'ignore-interrupt');
  const third = await stubborn.runtime.start(stubborn.request());
  await stubborn.runtime.send(third.id, { text: 'go' });
  await stubborn.runtime.interrupt(third.id);
  const stopped = await collect(stubborn.runtime, third.id);
  assert.equal(stopped.at(-1)?.type, 'done', 'a refused interrupt falls back to stopping the process');
  assert.equal(alive(stubborn.pid()), false);
  await stubborn.runtime.close(third.id);
});

test('aborting the request signal stops the process and ends the reply as stopped, not failed', { timeout: 60_000 }, async t => {
  const r = rig(t, 'hang');
  const controller = new AbortController();
  const session = await r.runtime.start(r.request({ signal: controller.signal }));
  await r.runtime.send(session.id, { text: 'go' });
  controller.abort();
  const events = await collect(r.runtime, session.id);
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(alive(r.pid()), false);
  await r.runtime.close(session.id);
});

test('close stops the process; one reply per process', { timeout: 60_000 }, async t => {
  const r = rig(t, 'hang');
  const session = await r.runtime.start(r.request());
  assert.equal(alive(r.pid()), true);
  await r.runtime.send(session.id, { text: 'go' });
  await assert.rejects(r.runtime.send(session.id, { text: 'again' }), refused('busy'));
  await r.runtime.close(session.id);
  assert.equal(alive(r.pid()), false);
  await r.runtime.close(session.id);
  await assert.rejects(r.runtime.send(session.id, { text: 'x' }), refused('protocol'));
});

test('probe: signed in + verified version is ok with no reason; an unchecked version, a login problem and a sandbox that is not ready are said', { timeout: 90_000 }, async t => {
  const ok = await rig(t).runtime.probe();
  assert.deepEqual(ok, { installed: true, version: '0.172.0', verified: true, auth: 'ok', login: 'subscription' });
  const newer = await rig(t, 'text', ['--version', '0.199.0']).runtime.probe();
  assert.equal(newer.auth, 'ok');
  assert.equal(newer.verified, false, 'a version beat has not checked is said so');
  assert.match(newer.reason ?? '', /only checked Codex 0\.172\.0 \(this is 0\.199\.0\)/u);
  const loggedOut = await rig(t, 'text', ['--account', 'none']).runtime.probe();
  assert.equal(loggedOut.auth, 'login_required');
  const apiKey = await rig(t, 'text', ['--account', 'apiKey']).runtime.probe();
  assert.equal(apiKey.auth, 'unknown');
  assert.equal(apiKey.login, 'other', 'an API key login is not the subscription login');
  assert.equal(loggedOut.login, undefined);
  assert.match(apiKey.reason ?? '', /not with a ChatGPT subscription/u);
  const sandbox = await rig(t, 'text', ['--readiness', 'updateRequired']).runtime.probe();
  assert.match(sandbox.reason ?? '', /Windows sandbox for Codex is not ready \(updateRequired\)/u);
  assert.deepEqual(sandbox.issues, [{ code: 'sandbox_not_ready', detail: 'updateRequired' }]);
  assert.equal(ok.issues, undefined);
  const writable = await rig(t, 'text', ['--world-writable']).runtime.probe();
  assert.deepEqual(writable.issues, [{ code: 'world_writable', detail: 'C:/shared/a, C:/shared/b, C:/shared/c (+7)' }], 'the folders the sandbox cannot protect are kept short');
  assert.equal(writable.auth, 'ok');
  assert.ok(!JSON.stringify([ok, newer, loggedOut, apiKey, sandbox]).includes(ACCOUNT_EMAIL));
});

test('probe says "not installed" for a missing program or a .cmd launcher, and never starts a shell', { timeout: 60_000 }, async t => {
  const dir = tempDir(t);
  const processes = new ProcessManager({});
  const deps = { processes, log: () => undefined };
  const missing = await new CodexRuntime({ id: 'cx', kind: 'codex', enabled: true, executablePath: join(dir, 'nope', 'codex.exe') }, deps).probe();
  assert.equal(missing.installed, false);
  assert.match(missing.reason ?? '', /not found/u);
  if (WINDOWS) {
    const { writeFileSync } = await import('node:fs');
    const cmd = join(dir, 'codex.cmd');
    writeFileSync(cmd, '@echo off\r\n');
    const launcher = await new CodexRuntime({ id: 'cx', kind: 'codex', enabled: true, executablePath: cmd }, deps).probe();
    assert.equal(launcher.installed, false);
    assert.match(launcher.reason ?? '', /launcher/u);
  }
});

test('models: all pages, hidden and repeated ones dropped, efforts from the list; not signed in gives an empty list', { timeout: 60_000 }, async t => {
  const models = await rig(t).runtime.models();
  assert.deepEqual(models, [{ id: 'm-one', label: 'Name m-one', efforts: ['low', 'high'] }, { id: 'm-two', label: 'Name m-two' }]);
  assert.deepEqual(await rig(t, 'text', ['--account', 'none']).runtime.models(), []);
});

test('a Codex that never answers initialize is a timeout error, with the process stopped', { timeout: 90_000 }, async t => {
  const r = rig(t, 'text', ['--hang-initialize'], {}, { initializeTimeoutMs: 1500 });
  const started = Date.now();
  await assert.rejects(r.runtime.start(r.request()), refused('timeout'));
  assert.ok(Date.now() - started < 20_000);
  assert.equal(alive(r.pid()), false);
});

test('registered as the codex factory, off unless enabled: a turned-off runtime starts nothing; the permission from settings is applied by the registry and again by the adapter', { timeout: 90_000 }, async t => {
  assert.equal(FACTORIES.codex, createCodexRuntime);
  assert.equal(typeof FACTORIES['claude-code'], 'function', 'claude-code is registered too (AR-5); this test builds only the codex one');
  const r = rig(t);
  const registry = new RuntimeRegistry(r.deps, { 'claude-code': undefined, codex: (config, deps) => new CodexRuntime(config, deps, { launch: r.launch }) });
  const off = { runtimes: [{ id: 'cx', kind: 'codex' as const, enabled: false }] };
  const found = registry.find(off, 'cx');
  assert.equal(found.ok ? undefined : found.reason, 'disabled');
  await assert.rejects(registry.start(off, 'cx', { conversationId: 'c', cwd: r.work, signal: new AbortController().signal }));
  assert.equal(r.log().length, 0, 'a turned-off runtime started nothing');
  const bad = { runtimes: [{ id: 'cx', kind: 'codex' as const, enabled: true, permission: 'bypassPermissions' }] };
  const session = await registry.start(bad, 'cx', { conversationId: 'c', cwd: r.work, signal: new AbortController().signal }) as CodexRuntimeSession;
  assert.equal(session.record.sent.sandbox, 'read-only');
  assert.equal(session.record.permission, 'read-only');
  const lookup = registry.find(bad, 'cx');
  if (lookup.ok) await lookup.runtime.close(session.id);
  const real = new RuntimeRegistry({ processes: new ProcessManager({}), log: () => undefined });
  const missing = { runtimes: [{ id: 'cx', kind: 'codex' as const, enabled: true, executablePath: join(r.dir, 'missing', 'codex.exe') }] };
  await assert.rejects(real.start(missing, 'cx', { conversationId: 'c', cwd: r.work, signal: new AbortController().signal }), refused('not_installed'));
});
