import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeConfig, RuntimeKind } from '../src/config/schema.ts';
import { RuntimeChecks } from '../src/runtimes/checks.ts';
import type { ProcessManager } from '../src/runtimes/process-manager.ts';
import { RuntimeRegistry, type RuntimeFactory } from '../src/runtimes/registry.ts';
import { PERMISSIONS, type AgentRuntime, type RuntimeModel, type RuntimeStatus } from '../src/runtimes/types.ts';
import { fakeModel, startApp } from './app-setup.ts';

// AR-6: 実行役の確かめの結果の置き場（checks.ts）、モデルの状態（status.ts）、Settings が読む口（routes-runtimes.ts）。
// 実行役の本体は起こさない（窓口の probe・models だけを、台本どおりに返すにせものに差し替える）

interface Plan {
  status: RuntimeStatus;
  models: RuntimeModel[];
  probes: number;
  lists: number;
  built: number;
  failProbe?: string;
  failModels?: string;
  hold?: Promise<void>;
}

const OK: RuntimeStatus = { installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'subscription' };

function plan(status: RuntimeStatus = OK): Plan { return { status, models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { id: 'opus' }], probes: 0, lists: 0, built: 0 }; }

function factory(p: Plan): RuntimeFactory {
  return (config: RuntimeConfig): AgentRuntime => {
    p.built += 1;
    const refuse = async (): Promise<never> => { throw new Error('a status test never starts a conversation'); };
    return {
      id: config.id, kind: config.kind,
      capabilities: { streaming: true, resume: true, interrupt: true, approvals: true, fileChanges: true, commandExecution: true, nativeTools: true, listsModels: true, externalApprovals: true, permissions: PERMISSIONS[config.kind] },
      async probe() {
        p.probes += 1;
        await p.hold;
        if (p.failProbe) throw new Error(p.failProbe);
        return p.status;
      },
      async models() {
        p.lists += 1;
        if (p.failModels) throw new Error(p.failModels);
        return p.models;
      },
      start: refuse, send: refuse, interrupt: refuse, approve: refuse, events: () => { throw new Error('no events'); }, close: refuse,
    };
  };
}

const RT = 'claude-code';

async function start(t: Parameters<typeof startApp>[0], claude = plan(), codex = plan({ installed: true, version: '0.172.0', verified: true, auth: 'ok', login: 'subscription' }), runtimes?: RuntimeConfig[]) {
  const s = await startApp(t, {
    models: [{ id: 'cc', runtime: RT, model: 'sonnet', vision: false }, fakeModel('m1')],
    configure: config => { config.runtimes = runtimes ?? [{ id: RT, kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: false }]; },
    runtimeFactories: { 'claude-code': factory(claude), codex: factory(codex) },
  });
  const model = async (id = 'cc') => (await s.json('/api/models', 'GET')).body.models.find((m: { id: string }) => m.id === id);
  const check = (id = RT) => s.json(`/api/runtimes/${id}/check`, 'POST');
  const rows = async () => (await s.json('/api/runtimes', 'GET')).body.runtimes as any[];
  return { ...s, model, check, rows, claude, codex };
}

test('a runtime model is not checked against a provider: before any check it says "not checked yet", and a settings save does not start the runtime', async t => {
  const s = await start(t);
  const before = await s.model();
  assert.equal(before.provider, '');
  assert.equal(before.runtime, RT);
  assert.equal(before.inChat, true, 'the runtime model first in the chat list is counted as a chat model, as the composer needs');
  assert.deepEqual([before.probe.status, before.probe.messageCode], ['unreachable', 'provider.probe.runtime_unchecked']);
  await s.app.status.probeAll(s.app.config());
  assert.equal(s.claude.probes, 0, 'only the owner pressing Check starts a check');
  assert.equal(s.claude.built, 0);
  assert.equal(s.app.status.usable('cc'), false);
  assert.equal(s.app.status.usable('m1'), true, 'a provider model is untouched');
});

test('Check: the result becomes the model state, and a later settings save keeps it without asking the runtime again', async t => {
  const s = await start(t);
  const res = await s.check();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.check, { checkedAt: res.body.check.checkedAt, installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'subscription', issues: [], stop: null, usable: true });
  const after = await s.model();
  assert.deepEqual([after.probe.status, after.probe.messageCode, after.probe.server], ['ok', 'provider.probe.runtime_ok', 'claude-code']);
  assert.equal(s.app.status.usable('cc'), true);
  await s.app.status.probeAll(s.app.config());
  await s.app.status.probeAll(s.app.config());
  assert.equal(s.claude.probes, 1, 'a save reads the remembered check');
  assert.equal(s.app.status.usable('cc'), true);
});

test('the model state follows what the check found: not installed, signed out, unreadable, a blocking issue, and a warning that still allows use', async t => {
  const cases: Array<[string, RuntimeStatus, string, string]> = [
    ['not installed', { installed: false, auth: 'unknown' }, 'not_found', 'runtime_missing'],
    ['signed out', { installed: true, version: '2.1.331', verified: true, auth: 'login_required' }, 'error', 'runtime_login'],
    ['login unreadable', { installed: true, version: '2.1.331', verified: true, auth: 'unknown' }, 'unreachable', 'runtime_unknown'],
    ['too old', { installed: true, version: '2.1.295', verified: false, auth: 'unknown', issues: [{ code: 'too_old', detail: '2.1.296' }] }, 'error', 'runtime_blocked'],
    ['sandbox not ready', { installed: true, version: '0.172.0', verified: true, auth: 'ok', issues: [{ code: 'sandbox_not_ready', detail: 'updateRequired' }] }, 'error', 'runtime_blocked'],
    ['unwritable folders only warn', { installed: true, version: '0.172.0', verified: true, auth: 'ok', issues: [{ code: 'world_writable', detail: 'C:/x' }] }, 'ok', 'runtime_ok'],
    ['an unchecked version still works', { installed: true, version: '2.1.400', verified: false, auth: 'ok', login: 'subscription' }, 'ok', 'runtime_ok'],
    ['a login that is not a subscription (API key, Console, cloud)', { installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'other' }, 'error', 'runtime_blocked'],
    ['Codex signed in with an API key', { installed: true, version: '0.172.0', verified: true, auth: 'unknown', login: 'other' }, 'error', 'runtime_blocked'],
  ];
  for (const [label, status, expected, code] of cases) {
    const s = await start(t, plan(status));
    assert.equal((await s.check()).status, 200, label);
    const probe = (await s.model()).probe;
    assert.deepEqual([probe.status, probe.messageCode], [expected, `provider.probe.${code}`], label);
  }
});

test('a login that is not a subscription is "not usable": the row says so and the model is blocked', async t => {
  const s = await start(t, plan({ installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'other' }));
  assert.equal((await s.check()).status, 200);
  const check = (await s.rows())[0].check;
  assert.deepEqual([check.auth, check.login, check.usable], ['ok', 'other', false]);
  assert.equal(s.app.status.usable('cc'), false);
  assert.equal((await s.model()).probe.messageCode, 'provider.probe.runtime_blocked');
});

test('loading models before any check keeps the list: the row and the model row show it, a save keeps it, and turning the runtime off forgets it', async t => {
  const s = await start(t);
  const loaded = await s.json(`/api/runtimes/${RT}/models`, 'POST');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.check, null, 'nothing was checked');
  assert.deepEqual(loaded.body.models.map((m: { id: string }) => m.id), ['sonnet', 'opus'], 'the answer still carries the list');
  assert.deepEqual((await s.rows())[0].models, loaded.body.models, 'and it is remembered for the screen');
  assert.deepEqual((await s.model()).efforts, ['low', 'high']);
  await s.app.status.probeAll(s.app.config());
  assert.equal((await s.rows())[0].models.length, 2, 'a settings save keeps the list');
  await s.check();
  assert.equal((await s.rows())[0].models.length, 2, 'a check keeps it too');
  const config = (await s.json('/api/settings', 'GET')).body.config;
  config.runtimes[0].enabled = false;
  assert.equal((await s.json('/api/settings', 'PUT', { config })).status, 200);
  assert.equal((await s.rows())[0].models, null);
  assert.equal(s.app.runtimeChecks.models(RT), null);
});

test('a runtime turned off, or pointed at another program, while its check runs does not keep the result', async t => {
  const settings = async (s: Awaited<ReturnType<typeof start>>, edit: (config: any) => void) => {
    const config = (await s.json('/api/settings', 'GET')).body.config;
    edit(config);
    return s.json('/api/settings', 'PUT', { config });
  };
  const slow = async (change: (config: any) => void) => {
    const p = plan();
    let release = (): void => undefined;
    p.hold = new Promise<void>(resolve => { release = resolve; });
    const s = await start(t, p);
    const pending = s.check();
    for (let i = 0; i < 200 && p.probes === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(p.probes, 1, 'the check is running');
    assert.equal((await settings(s, change)).status, 200);
    release();
    return { s, res: await pending };
  };
  const off = await slow(config => { config.runtimes[0].enabled = false; });
  assert.deepEqual([off.res.status, off.res.body.code], [409, 'http.runtime_off']);
  assert.equal(off.s.app.runtimeChecks.get(RT), undefined, 'no "ok" is kept for a runtime that was turned off');
  assert.equal((await off.s.model()).probe.messageCode, 'provider.probe.runtime_off');
  const moved = await slow(config => { config.runtimes[0].executablePath = process.execPath; });
  assert.equal(moved.res.status, 200);
  assert.equal(moved.res.body.check, null, 'the answer is about the runtime as it is now: not checked');
  assert.equal(moved.s.app.runtimeChecks.get(RT), undefined, 'the result for the old program is not kept');
  assert.equal((await moved.s.model()).probe.messageCode, 'provider.probe.runtime_unchecked');
});

test('text a runtime returns is cleaned before it is logged, kept or sent: control characters become ? and secrets are hidden', async t => {
  const s = await start(t);
  s.claude.failProbe = 'spawn\u0007 failed\u202E sk-ant-api03-abcdefghijklmnop';
  const res = await s.check();
  assert.equal(res.status, 502);
  assert.ok(!/[\u0007\u202E]/u.test(res.body.message ?? ''), 'no control character in what the screen gets');
  assert.ok(!(res.body.message ?? '').includes('abcdefghijklmnop'));
  assert.ok(s.logs.some(line => line.includes('the check failed: spawn? failed?')), 'and the log has the cleaned text');
  assert.ok(!s.logs.some(line => /[\u0007\u202E]/u.test(line)));
  delete s.claude.failProbe;
  s.claude.status = { installed: true, auth: 'unknown', reason: 'odd\u0007 reason\u202E' };
  await s.check();
  assert.ok(s.logs.some(line => line.includes('runtime claude-code: odd? reason?')), 'a reason the runtime gave is cleaned in the log');
  s.app.runtimeChecks.report(RT, { code: 'tools_unreviewed', detail: 'Foo\u0007, Bar\u202E' });
  assert.equal((await s.rows())[0].check.stop.detail, 'Foo?, Bar?');
});

test('a turned-off or unknown runtime is never started by Check or by loading models', async t => {
  const s = await start(t);
  const off = await s.check('codex');
  assert.deepEqual([off.status, off.body.code], [409, 'http.runtime_off']);
  assert.equal((await s.json('/api/runtimes/codex/models', 'POST')).status, 409);
  assert.equal((await s.check('nope')).status, 404);
  assert.equal((await s.json('/api/runtimes/nope/models', 'POST')).status, 404);
  assert.deepEqual([s.codex.built, s.codex.probes, s.codex.lists], [0, 0, 0]);
});

test('Check and model loading are write-style calls: a request from another origin is refused before the runtime starts', async t => {
  const s = await start(t);
  for (const path of [`/api/runtimes/${RT}/check`, `/api/runtimes/${RT}/models`]) {
    const res = await s.api(path, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403, path);
  }
  assert.deepEqual([s.claude.built, s.claude.probes, s.claude.lists], [0, 0, 0]);
});

test('the list has a row for each kind, and the permission choices are only the closed list: nothing that allows everything', async t => {
  const s = await start(t, plan(), plan(), [{ id: RT, kind: 'claude-code', enabled: true, permission: 'bypassPermissions' }]);
  const rows = await s.rows();
  assert.deepEqual(rows.map(row => [row.id, row.kind, row.configured, row.enabled]), [[RT, 'claude-code', true, true], ['codex', 'codex', false, false]]);
  const byKind = Object.fromEntries(rows.map(row => [row.kind, row]));
  assert.deepEqual(byKind['claude-code'].permissions, ['default', 'acceptEdits']);
  assert.deepEqual(byKind.codex.permissions, ['read-only', 'workspace-write']);
  assert.equal(byKind['claude-code'].permission, 'default', 'a wide-open value in the settings shows (and runs) as the default');
  assert.equal(byKind.codex.permission, 'read-only');
  assert.ok(!/bypass|danger|never|dontAsk|auto_review/u.test(JSON.stringify(rows.map(row => row.permissions))));
  assert.equal(rows[0].check, null, 'no check is shown until the owner presses Check');
});

test('loading models keeps the list and the depths: the model row picks up the depths from the list', async t => {
  const s = await start(t);
  assert.equal((await s.model()).efforts.length, 0);
  await s.check();
  const loaded = await s.json(`/api/runtimes/${RT}/models`, 'POST');
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.models, [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { id: 'opus', label: 'opus', efforts: [] }]);
  assert.deepEqual((await s.rows())[0].models, loaded.body.models, 'the list is remembered for the screen');
  assert.deepEqual((await s.model()).efforts, ['low', 'high'], 'depths come from the runtime list');
  s.claude.failModels = 'sk-ant-api03-abcdefghijklmnop could not list';
  const failed = await s.json(`/api/runtimes/${RT}/models`, 'POST');
  assert.deepEqual([failed.status, failed.body.code], [502, 'http.runtime_models_failed']);
  assert.ok(!JSON.stringify(failed.body).includes('abcdefghijklmnop'), 'a secret in the runtime error does not reach the screen');
  assert.deepEqual((await s.rows())[0].models, loaded.body.models, 'a failed load keeps the last list');
});

test('the list a runtime returns is not trusted: a secret in a label, control characters, repeats, a very long id and odd depths are dropped', async t => {
  const s = await start(t);
  s.claude.models = [
    { id: 'sonnet', label: 'Sonnet sk-ant-api03-abcdefghijklmnop', efforts: ['low', 'HIGH!', 'x'.repeat(40), 'ok_1', 'low'] },
    { id: 'bad\u0007id', label: 'bell' },
    { id: 'sonnet', label: 'again' },
    { id: 'a'.repeat(201), label: 'too long' },
    { id: 'many', efforts: Array.from({ length: 12 }, (_, i) => `e${i + 1}`) },
    { id: 'nl', label: 'two\nlines' },
  ];
  await s.check();
  const loaded = await s.json(`/api/runtimes/${RT}/models`, 'POST');
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.models.map((m: { id: string }) => m.id), ['sonnet', 'many', 'nl']);
  const [sonnet, many, nl] = loaded.body.models;
  assert.ok(!sonnet.label.includes('abcdefghijklmnop'), 'a secret in a label does not reach the screen');
  assert.deepEqual(sonnet.efforts, ['low', 'ok_1']);
  assert.equal(many.efforts.length, 8);
  assert.equal(nl.label, 'two lines');
});

test('a failing check is an error for the screen and the log, not a made-up state; the model stays "not checked"', async t => {
  const s = await start(t);
  s.claude.failProbe = 'spawn exploded';
  const res = await s.check();
  assert.deepEqual([res.status, res.body.code], [502, 'http.runtime_check_failed']);
  assert.ok(s.logs.some(line => line.includes('runtime claude-code') && line.includes('spawn exploded')));
  assert.equal((await s.model()).probe.messageCode, 'provider.probe.runtime_unchecked');
  assert.equal((await s.rows())[0].check, null);
});

test('turning the runtime off in the settings forgets its check; changing only the permission keeps it', async t => {
  const s = await start(t);
  await s.check();
  const settings = async (edit: (config: any) => void) => {
    const config = (await s.json('/api/settings', 'GET')).body.config;
    edit(config);
    return s.json('/api/settings', 'PUT', { config });
  };
  assert.equal((await settings(config => { config.runtimes[0].permission = 'acceptEdits'; })).status, 200);
  assert.equal((await s.model()).probe.status, 'ok', 'the permission is not part of what was checked');
  assert.equal((await s.rows())[0].permission, 'acceptEdits');
  assert.equal((await settings(config => { config.runtimes[0].enabled = false; })).status, 200);
  assert.deepEqual([(await s.model()).probe.messageCode, (await s.rows())[0].check], ['provider.probe.runtime_off', null]);
  assert.equal((await settings(config => { config.runtimes[0].enabled = true; })).status, 200);
  assert.equal((await s.model()).probe.messageCode, 'provider.probe.runtime_unchecked', 'turning it back on does not bring back the old result');
  assert.equal(s.claude.probes, 1);
});

test('a conversation stop reported by the runtime layer shows on the row and goes away at the next check', async t => {
  const s = await start(t);
  s.app.runtimeChecks.report(RT, { code: 'tools_unreviewed', detail: 'Foo, Bar' });
  assert.equal((await s.rows())[0].check, null, 'nothing is remembered before a first check');
  await s.check();
  s.app.runtimeChecks.report(RT, { code: 'tools_unreviewed', detail: 'Foo, Bar sk-ant-api03-abcdefghijklmnop' });
  const stop = (await s.rows())[0].check.stop;
  assert.equal(stop.code, 'tools_unreviewed');
  assert.ok(stop.detail.startsWith('Foo, Bar') && !stop.detail.includes('abcdefghijklmnop'));
  await s.check();
  assert.equal((await s.rows())[0].check.stop, null);
});

// ---------------------------------------------------------------- RuntimeChecks 単体

function checks(p: Plan, kind: RuntimeKind = 'claude-code', deadlineMs?: number) {
  const registry = new RuntimeRegistry({ processes: {} as ProcessManager, log: () => undefined }, { 'claude-code': factory(p), codex: factory(plan()) });
  const logs: string[] = [];
  return { logs, checks: new RuntimeChecks(registry, line => logs.push(line), deadlineMs), config: (extra: Partial<RuntimeConfig> = {}) => ({ runtimes: [{ id: 'rt', kind, enabled: true, ...extra }] as RuntimeConfig[] }) };
}

test('two checks of the same runtime at once share one run of the runtime', async () => {
  const p = plan();
  let release = (): void => undefined;
  p.hold = new Promise<void>(resolve => { release = resolve; });
  const c = checks(p);
  const first = c.checks.check(c.config(), 'rt');
  const second = c.checks.check(c.config(), 'rt');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(p.probes, 1);
  assert.deepEqual([a.ok, b.ok], [true, true]);
});

test('a runtime that never answers is cut off at the deadline', async () => {
  const p = plan();
  p.hold = new Promise<void>(() => undefined);
  const c = checks(p, 'claude-code', 20);
  const out = await c.checks.check(c.config(), 'rt');
  assert.deepEqual([out.ok, out.ok ? '' : out.reason], [false, 'check_failed']);
  assert.equal(c.checks.get('rt'), undefined);
});

test('a remembered check is dropped when the runtime is gone, off, or points at another program, and kept otherwise', async () => {
  const c = checks(plan());
  await c.checks.check(c.config(), 'rt');
  c.checks.prune(c.config({ permission: 'acceptEdits' }));
  assert.ok(c.checks.get('rt'));
  c.checks.prune(c.config({ executablePath: 'D:/elsewhere/claude.exe' }));
  assert.equal(c.checks.get('rt'), undefined);
  await c.checks.check(c.config(), 'rt');
  c.checks.prune(c.config({ enabled: false }));
  assert.equal(c.checks.get('rt'), undefined);
  await c.checks.check(c.config(), 'rt');
  c.checks.prune({ runtimes: [] });
  assert.equal(c.checks.get('rt'), undefined);
});

// 持ち主の見直し 2（2026-11-27）: 確かめの結果は覚えるだけで、起動をまたいで残らない。起動のたびに Check を押さないと、実行役のモデルが「確かめていない」のまま選べなかった。
// 起動のときに、入っている実行役を 1 回確かめ、使えるときだけ一覧も読む（持ち主は何も押さない）。使えるかは、その確かめの結果だけで決める
test('after a restart nothing needs pressing: the start-up pass checks each turned-on runtime once and loads its list, so its model is usable; a turned-off runtime is not started', async t => {
  const s = await start(t);
  assert.equal(s.app.status.usable('cc'), false, 'a fresh start (what a restart leaves) knows no check');
  await s.app.checkRuntimes();
  assert.deepEqual([s.claude.probes, s.claude.lists], [1, 1]);
  assert.deepEqual([s.codex.built, s.codex.probes, s.codex.lists], [0, 0, 0], 'the turned-off runtime is never started');
  assert.equal(s.app.status.usable('cc'), true);
  const probe = (await s.model()).probe;
  assert.deepEqual([probe.status, probe.messageCode], ['ok', 'provider.probe.runtime_ok']);
  assert.deepEqual((await s.rows())[0].models.map((m: { id: string }) => m.id), ['sonnet', 'opus'], 'the list is there without pressing Load models');
  await s.app.status.probeAll(s.app.config());
  assert.equal(s.claude.probes, 1, 'a settings save afterwards still does not ask the runtime again');
});

test('the start-up pass marks nothing usable without a successful check: a check that fails or finds the runtime not ready keeps the model unusable and reads no list', async t => {
  const out = await start(t, plan({ installed: true, version: '2.1.331', verified: true, auth: 'login_required' }));
  await out.app.checkRuntimes();
  assert.equal(out.app.status.usable('cc'), false);
  assert.equal((await out.model()).probe.messageCode, 'provider.probe.runtime_login');
  assert.equal(out.claude.lists, 0, 'no list for a runtime that is signed out');
  assert.equal((await out.rows())[0].models, null);
  const failing = plan();
  failing.failProbe = 'boom';
  const broken = await start(t, failing);
  await broken.app.checkRuntimes();
  assert.equal(broken.app.status.usable('cc'), false);
  assert.equal((await broken.model()).probe.messageCode, 'provider.probe.runtime_unchecked');
  assert.equal(broken.claude.lists, 0);
  assert.ok(broken.logs.some(line => line.includes('runtime claude-code: the check failed: boom')));
});

test('a runtime turned off while the start-up check runs keeps no result', async t => {
  const p = plan();
  let release = (): void => undefined;
  p.hold = new Promise<void>(resolve => { release = resolve; });
  const s = await start(t, p);
  const pending = s.app.checkRuntimes();
  for (let i = 0; i < 200 && p.probes === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  const config = (await s.json('/api/settings', 'GET')).body.config;
  config.runtimes[0].enabled = false;
  assert.equal((await s.json('/api/settings', 'PUT', { config })).status, 200);
  release();
  await pending;
  assert.equal(s.app.runtimeChecks.get(RT), undefined);
  assert.equal(s.app.runtimeChecks.models(RT), null);
  assert.equal((await s.model()).probe.messageCode, 'provider.probe.runtime_off');
});
