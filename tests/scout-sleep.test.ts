import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { ledgerPath } from '../src/scout/ledger.ts';
import { readSleep } from '../src/scout/sleep.ts';
import { restScout, scoutState } from '../src/scout/run.ts';
import type { Proposal } from '../src/tasks/proposal.ts';
import type { Task } from '../src/tasks/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { isScoutState } from '../web/src/ui/scout.ts';
import { FakeAdapter, reply, type Script, tempDir, testConfig } from './helpers.ts';
import { MIN, toolCall } from './helpers/task-app.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const commitAll = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', message]); return git(root, ['rev-parse', 'HEAD']); };

interface Options { scout?: string[]; edit?: (c: AppConfig) => void; dir?: string; file?: boolean; git?: boolean }

async function setup(t: { after: (fn: () => void) => void }, options: Options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'beat-test-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [
    { id: 'near', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 },
    { id: 'far', kind: 'openai_compatible', baseUrl: 'https://cloud.example.test/v1', maxParallel: 2, timeoutMs: 10_000 },
  ];
  config.models = [
    { id: 'm', provider: 'near', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false },
    { id: 'c', provider: 'far', model: 'y', contextLength: 65536, maxOutputTokens: 1024, vision: false },
  ];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0, scout: options.scout ?? ['m'] };
  config.worker.enabled = true;
  config.memory.review = false;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-18T03:00:00Z') };
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, ...(options.file ? {} : { databasePath: ':memory:' }), log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const adapter = adapters.get(p.id) ?? new FakeAdapter(p); adapters.set(p.id, adapter); return adapter; },
  });
  await app.status.probeAll(app.config());
  let closed = false;
  const close = () => { if (closed) return; closed = true; app.worker.stop(); app.engine.stopAll(); app.close(); };
  t.after(close);
  // 実行の終わりのあとも git を使う後片づけが少し続くので、閉じたあとに、イベントループを止めずに待ちながら消す
  if (!options.dir) t.after(async () => { for (let i = 0; ; i += 1) { try { rmSync(dir, { recursive: true, force: true }); return; } catch (error) { if (i >= 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } } });
  const root = join(dir, 'shop');
  let projectId = app.projects.list()[0]?.id;
  if (!projectId) {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'docs', 'b.md'), '# b\n');
    if (options.git) {
      git(root, ['init', '-q']);
      spawnSync('git', ['config', '--file', join(root, '.git', 'config'), 'core.autocrlf', 'false']);
      commitAll(root, 'first');
    }
    projectId = app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null }).id;
    app.projects.update(projectId, { scoutMode: 'research' });
    const build = app.tasks.create({ title: 'build the shop', origin: 'user', actor: 'user', projectId, acceptanceItems: ['i1'] });
    app.tasks.finish(build.id, 'done', 'built', 'user');
  }
  const changed: string[] = [];
  app.bus.subscribe(e => { if (e.event.type === 'scout.changed') changed.push(e.event.projectId); });
  const adapter = (id = 'near') => adapters.get(id)!;
  const scoutRows = () => app.db.prepare("SELECT * FROM tasks WHERE proposed_by = 'scout-run' ORDER BY created_at, rowid").all() as unknown as Task[];
  const later = (minutes = 2) => { clock.now += minutes * MIN; };
  return { app, dir, root, projectId, paths, adapter, clock, scoutRows, close, later, changed };
}

type S = Awaited<ReturnType<typeof setup>>;

const checkBoth: Script[] = [
  toolCall('ledger_record', { title: 'src check', area: ['src'], checked: 'read a.ts', result: 'no problem' }),
  toolCall('ledger_record', { title: 'docs check', area: ['docs'], checked: 'read b.md', result: 'no problem' }),
  reply('Checked src and docs.'),
];

const PROPOSAL: Proposal = { kind: 'feature', why: 'Something is missing.', area: ['src'], size: 'S', goal: null, evidence: null, ledger: null };
const propose = (s: S, title: string) => s.app.tasks.create({ title, body: 'x', origin: 'self', propose: true, projectId: s.projectId, proposal: PROPOSAL, actor: 'beat' });

async function server(t: { after: (fn: () => void) => void }, s: S) {
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  return async (path: string, method = 'GET') => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
}

function gate(): { script: Script; started: Promise<void> } {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const script: Script = async function* (req) {
    begin();
    yield { type: 'text', delta: '…' };
    await new Promise<void>((_resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
  return { script, started };
}

const prompts = (s: S) => s.adapter().calls.map((req: ModelRequest) => JSON.stringify(req.messages));

test('scout sleep: once every area is checked the scout sleeps without a run, and a new commit wakes it', { skip: !gitAvailable }, async t => {
  const s = await setup(t, { git: true });
  s.adapter().scripts.push(...checkBoth);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.scoutRows().length, 1);
  s.later();
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.scoutRows().length, 1, 'nothing left to look at: no new scout row');
  assert.equal(readSleep(s.app.kv, s.projectId)?.reason, 'done');
  assert.equal(s.app.worker.scoutView(s.projectId)?.state, 'asleep');
  const calls = s.adapter().calls.length;
  s.later();
  await s.app.worker.tick();
  assert.equal(s.adapter().calls.length, calls, 'asleep: the model is not called');
  appendFileSync(join(s.root, 'src', 'a.ts'), 'export const b = 2;\n');
  commitAll(s.root, 'change src');
  s.adapter().scripts.push(reply('Looked again.'));
  s.later();
  assert.equal(await s.app.worker.tick(), 'ran', 'a commit wakes the scout');
  assert.equal(s.scoutRows().length, 2);
  assert.match(prompts(s).at(-1)!, /src check/u);
});

test('scout sleep: a proposal or a deepening by the scout does not wake it; the owner\'s Reject and a plan save do', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(...checkBoth);
  await s.app.worker.tick();
  const open = propose(s, 'Add tests');
  s.later();
  await s.app.worker.tick();
  const first = readSleep(s.app.kv, s.projectId)!;
  assert.equal(first.reason, 'done');
  // 考える実行の足した提案・深めた経過（inbox の提案）ではカンバンの印が変わらない
  const second = propose(s, 'Add docs');
  s.app.tasks.deepenProposal(second.id, { ...PROPOSAL, why: 'Deeper.' }, 'commit none');
  s.later();
  await s.app.worker.tick();
  assert.equal(readSleep(s.app.kv, s.projectId)!.at, first.at, 'still the same sleep');
  // 持ち主の Reject で起きる（見る所が無いので、起きてすぐ新しい印でまた休む）
  s.app.tasks.finish(open.id, 'cancelled', 'Not now', 'user');
  s.later();
  await s.app.worker.tick();
  const third = readSleep(s.app.kv, s.projectId)!;
  assert.ok(third.at > first.at, 'woke on the Reject and slept again');
  assert.notEqual(third.kanban, first.kanban);
  // 計画書の保存で起きる
  const chat = s.app.conversations.create({ kind: 'chat', title: 'plan', projectId: s.projectId });
  s.app.plans.write(s.projectId, chat.id, '# Plan\n\n## Goal\n', { by: 'owner', tainted: false, conversationId: null, runId: null }, null);
  s.later();
  await s.app.worker.tick();
  const fourth = readSleep(s.app.kv, s.projectId)!;
  assert.ok(fourth.at > third.at, 'woke on the plan save');
  assert.notEqual(fourth.plan, third.plan);
  assert.equal(s.scoutRows().length, 1, 'no model run while there is nothing to look at');
});

test('scout sleep: when the areas left do not go down in 3 runs in a row, the scout sleeps with a note; the sleep survives a restart', async t => {
  const dir = tempDir(t);
  const s = await setup(t, { dir, file: true });
  for (let i = 0; i < 5; i += 1) s.adapter().scripts.push(reply(`nothing ${i}`));
  for (let i = 0; i < 3; i += 1) { assert.equal(await s.app.worker.tick(), 'ran', `run ${i + 1}`); s.later(); }
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.scoutRows().length, 3, 'three runs, then sleep');
  assert.equal(readSleep(s.app.kv, s.projectId)?.reason, 'stuck');
  const view = s.app.worker.scoutView(s.projectId)!;
  assert.equal(view.state, 'asleep');
  assert.match(view.note ?? '', /ledger is not growing/u);
  const sleptAt = readSleep(s.app.kv, s.projectId)!.at;
  s.close();
  const again = await setup(t, { dir, file: true });
  again.clock.now = s.clock.now + 10 * MIN;
  again.adapter().scripts.push(reply('after restart'));
  await again.app.worker.tick();
  assert.equal(again.scoutRows().length, 3, 'still asleep after a restart');
  assert.equal(readSleep(again.app.kv, again.projectId)?.at, sleptAt, 'the same sleep: the product is not even looked at again');
  assert.equal(again.app.worker.scoutView(again.projectId)?.state, 'asleep');
  again.close();
});

test('scout deepen: with 10 open proposals the run deepens instead, once per proposal per commit; when none is left it sleeps', async t => {
  const s = await setup(t);
  const open = Array.from({ length: 10 }, (_v, i) => propose(s, `Idea ${i}`));
  const id = open[0]!.id.slice(0, 8);
  s.adapter().scripts.push(
    toolCall('proposal_add', { title: 'Brand new idea', kind: 'feature', why: 'New.', size: 'S' }),
    toolCall('proposal_add', { title: 'Idea 0', kind: 'bug', why: 'Checked closer: it is a bug.', size: 'M', evidence: 'src/a.ts line 1', deepen: id }),
    toolCall('proposal_add', { title: 'Idea 0', kind: 'bug', why: 'Again.', size: 'M', deepen: id }),
    reply('Deepened one.'),
  );
  assert.equal(await s.app.worker.tick(), 'ran');
  const text = prompts(s)[0]!;
  assert.match(text, /Open proposals to deepen/u);
  assert.match(text, new RegExp(`${id} Idea 0`, 'u'));
  const results = s.app.db.prepare("SELECT text AS content FROM messages WHERE role = 'tool' ORDER BY id").all() as Array<{ content: string }>;
  assert.match(results[0]!.content, /already has 10 open proposals/u);
  assert.match(results[1]!.content, /Deepened proposal/u);
  assert.match(results[2]!.content, /already deepened at this commit/u);
  const row = s.app.tasks.get(open[0]!.id)!;
  assert.equal(row.status, 'inbox');
  assert.equal(JSON.parse(row.proposal!).why, 'Checked closer: it is a bug.');
  assert.equal(s.app.tasks.textTainted(row.id), true);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE proposal IS NOT NULL").get() as { n: number }).n, 10, 'no new proposal');
  // 次の材料に、深めたものは出ない
  s.adapter().scripts.push(reply('more'));
  s.later();
  await s.app.worker.tick();
  assert.doesNotMatch(prompts(s).at(-1)!.split('Open proposals to deepen')[1]!.split('END OF OUTSIDE')[0]!, new RegExp(id, 'u'));
  // 全部深めたら休む
  for (const task of open) s.app.tasks.event(task.id, 'deepened', 'scout', 'commit none');
  s.later();
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(readSleep(s.app.kv, s.projectId)?.reason, 'deepened');
});

test('Think now: with background work Off it runs once; pressing twice does not stack; it wakes a sleeping product', async t => {
  const s = await setup(t, { edit: c => { c.worker.enabled = false; } });
  const call = await server(t, s);
  s.adapter().scripts.push(...checkBoth, reply('second'), reply('third'));
  await s.app.worker.tick();
  assert.equal(s.scoutRows().length, 0, 'Off: no run on its own');
  const first = await call(`/api/projects/${s.projectId}/scout/run`, 'POST');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(isScoutState(first.body), true);
  assert.equal((await call(`/api/projects/${s.projectId}/scout/run`, 'POST')).status, 202);
  assert.equal(await s.app.worker.tick(), 'ran');
  s.later();
  await s.app.worker.tick();
  assert.equal(s.scoutRows().length, 1, 'two presses, one run');
  assert.equal(s.scoutRows()[0]!.status, 'done', 'not stopped for being Off');
  // 休んでいる製品でも、押せば 1 回動く
  const on = s.app.config(); on.worker.enabled = true; await s.app.applyConfig(on, { probe: false });
  s.later();
  await s.app.worker.tick();
  assert.equal(readSleep(s.app.kv, s.projectId)?.reason, 'done');
  assert.equal((await call(`/api/projects/${s.projectId}/scout/run`, 'POST')).status, 202);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.scoutRows().length, 2);
});

test('Think now: it waits while paused, and is refused (409) for a cloud model with cloudRunsPerHour 0, while resting, with no scout model, with the mode off, and before the first Build', async t => {
  const s = await setup(t, { edit: c => { c.worker.enabled = false; } });
  const call = await server(t, s);
  s.app.worker.setPaused(true);
  assert.equal((await call(`/api/projects/${s.projectId}/scout/run`, 'POST')).status, 202);
  assert.equal(await s.app.worker.tick(), 'paused');
  assert.equal(s.scoutRows().length, 0, 'paused: Think now waits');
  s.app.worker.setPaused(false);
  s.adapter().scripts.push(reply('ran after the pause'));
  assert.equal(await s.app.worker.tick(), 'ran');

  const zero = await setup(t, { scout: ['c'], edit: c => { c.worker.enabled = false; c.scout = { cloudRunsPerHour: 0 }; } });
  const zeroCall = await server(t, zero);
  const refused = await zeroCall(`/api/projects/${zero.projectId}/scout/run`, 'POST');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'project.scout_cloud_zero');
  await zero.app.worker.tick();
  assert.equal(zero.scoutRows().length, 0);

  const rest = await setup(t, { scout: ['c'] });
  const restCall = await server(t, rest);
  restScout(rest.app.kv, 'far', rest.clock.now + 60 * MIN);
  assert.equal((await restCall(`/api/projects/${rest.projectId}/scout/run`, 'POST')).body.code, 'project.scout_resting');
  assert.equal(rest.app.worker.scoutView(rest.projectId)?.state, 'resting');

  const none = await setup(t, { scout: [] });
  const noneCall = await server(t, none);
  assert.equal((await noneCall(`/api/projects/${none.projectId}/scout/run`, 'POST')).body.code, 'project.scout_no_model');
  none.app.projects.update(none.projectId, { scoutMode: 'off' });
  assert.equal((await noneCall(`/api/projects/${none.projectId}/scout/run`, 'POST')).body.code, 'project.scout_off');
  assert.equal((await noneCall('/api/projects/00000000-0000-4000-8000-000000000000/scout/run', 'POST')).status, 404);

  const fresh = await setup(t);
  const freshCall = await server(t, fresh);
  fresh.app.db.prepare("UPDATE tasks SET status = 'running' WHERE acceptance_items IS NOT NULL").run();
  assert.equal((await freshCall(`/api/projects/${fresh.projectId}/scout/run`, 'POST')).body.code, 'project.scout_not_built');
});

test('scout state endpoint: the 7-1 shape; off only for mode off, no scout model or archived (not for background work Off); thinking with the area; resting; broken ledger lines in the note; scout.changed on changes', async t => {
  const s = await setup(t, { edit: c => { c.worker.enabled = false; } });
  const call = await server(t, s);
  const idle = await call(`/api/projects/${s.projectId}/scout`);
  assert.equal(idle.status, 200);
  assert.deepEqual(Object.keys(idle.body).sort(), ['area', 'examined', 'lastChangeAt', 'note', 'state']);
  assert.equal(isScoutState(idle.body), true);
  assert.equal(idle.body.state, 'idle', 'background work Off is not "off"');
  assert.equal((await call('/api/projects/00000000-0000-4000-8000-000000000000/scout')).status, 404);

  const held = gate();
  s.adapter().scripts.push(toolCall('agent_run', { task: 'Check the src folder', title: 'Check src' }), held.script);
  assert.equal((await call(`/api/projects/${s.projectId}/scout/run`, 'POST')).status, 202);
  const running = s.app.worker.tick();
  await held.started;
  const thinking = await call(`/api/projects/${s.projectId}/scout`);
  assert.equal(thinking.body.state, 'thinking');
  assert.equal(thinking.body.area, 'Check src');
  s.app.engine.stopAll();
  await running;
  assert.ok(s.changed.filter(id => id === s.projectId).length >= 3, 'scout.changed on Think now, run start and run end');

  writeFileSync(ledgerPath(s.app.paths.projects, s.projectId), '# Scout ledger\n\n## L-0001 x\n- nonsense line\n');
  const broken = await call(`/api/projects/${s.projectId}/scout`);
  assert.match(String(broken.body.note), /lines the scout cannot read/u);
  assert.equal(typeof broken.body.examined, 'number');

  s.app.kv.setJson(`scout:product:${s.projectId}`, { ...scoutState(s.app.kv, s.projectId), fails: 1, until: s.clock.now + 5 * MIN });
  assert.equal((await call(`/api/projects/${s.projectId}/scout`)).body.state, 'resting');

  const routeOff = s.app.config(); routeOff.routing.scout = []; await s.app.applyConfig(routeOff, { probe: false });
  assert.equal((await call(`/api/projects/${s.projectId}/scout`)).body.state, 'off');
  const back = s.app.config(); back.routing.scout = ['m']; await s.app.applyConfig(back, { probe: false });
  s.app.projects.update(s.projectId, { scoutMode: 'off' });
  assert.equal((await call(`/api/projects/${s.projectId}/scout`)).body.state, 'off');
  s.app.projects.update(s.projectId, { scoutMode: 'research', archived: true });
  assert.equal((await call(`/api/projects/${s.projectId}/scout`)).body.state, 'off');
});

test('scout: new proposals give one notification per product while it is unread', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    toolCall('proposal_add', { title: 'One', kind: 'feature', why: 'a.', size: 'S' }),
    toolCall('proposal_add', { title: 'Two', kind: 'bug', why: 'b.', size: 'S' }),
    reply('two proposals'),
    toolCall('proposal_add', { title: 'Three', kind: 'feature', why: 'c.', size: 'S' }),
    reply('one more'),
  );
  await s.app.worker.tick();
  s.later();
  await s.app.worker.tick();
  const rows = s.app.db.prepare("SELECT title, link FROM notifications WHERE dedup_key LIKE 'scout-proposals:%'").all() as Array<{ title: string; link: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'New proposals for shop');
  assert.equal(rows[0]!.link, `#/p/${s.projectId}`);
});

test('scout: a cloud scout run stops when it has used scout.cloudTokensPerRun tokens; a local run has no such cap', async t => {
  const usageCall = (name: string, args: unknown, inputTokens: number): Script => async function* (req) {
    for await (const e of toolCall(name, args)(req)) {
      if (e.type === 'done') yield { type: 'usage', usage: { inputTokens, outputTokens: 10 } };
      yield e;
    }
  };
  const cloud = await setup(t, { scout: ['c'], edit: c => { c.scout = { cloudRunsPerHour: 1, cloudTokensPerRun: 10_000 }; } });
  cloud.adapter('far').scripts.push(
    usageCall('ledger_record', { title: 'src check', area: ['src'], checked: 'read', result: 'no problem' }, 6_000),
    usageCall('ledger_record', { title: 'docs check', area: ['docs'], checked: 'read', result: 'no problem' }, 6_000),
    reply('never reached'),
  );
  assert.equal(await cloud.app.worker.tick(), 'ran');
  const row = cloud.scoutRows()[0]!;
  assert.equal(row.status, 'done');
  assert.match(row.result_summary ?? '', /token budget/u);
  assert.equal(cloud.adapter('far').calls.length, 2, 'stopped after the call that crossed the budget');
  assert.equal(scoutState(cloud.app.kv, cloud.projectId).fails, 0, 'not counted as a failure');

  const local = await setup(t, { edit: c => { c.scout = { cloudRunsPerHour: 1, cloudTokensPerRun: 10_000 }; } });
  local.adapter().scripts.push(
    usageCall('ledger_record', { title: 'src check', area: ['src'], checked: 'read', result: 'no problem' }, 6_000),
    usageCall('ledger_record', { title: 'docs check', area: ['docs'], checked: 'read', result: 'no problem' }, 6_000),
    reply('done'),
  );
  await local.app.worker.tick();
  assert.equal(local.adapter().calls.length, 3);
  assert.doesNotMatch(local.scoutRows()[0]!.result_summary ?? '', /token budget/u);
});

test('scout sleep: a newer fresh entry for the same area replaces a stale one, so re-checking a changed area lets the scout sleep again (found in the 7-3b launch check)', { skip: !gitAvailable }, async t => {
  const s = await setup(t, { git: true });
  s.adapter().scripts.push(...checkBoth);
  await s.app.worker.tick();
  appendFileSync(join(s.root, 'src', 'a.ts'), 'export const b = 2;\n');
  commitAll(s.root, 'change src');
  s.adapter().scripts.push(toolCall('ledger_record', { title: 'src check again', area: ['src'], checked: 'read a.ts again', result: 'no problem' }), reply('Re-checked src.'));
  s.later();
  assert.equal(await s.app.worker.tick(), 'ran');
  s.later();
  assert.equal(await s.app.worker.tick(), 'idle', 'the old src entry is replaced by the new one, so nothing is stale');
  assert.equal(readSleep(s.app.kv, s.projectId)?.reason, 'done');
  assert.equal(s.scoutRows().length, 2);
});

test('Think now: a second press while the first one is starting (materials being read) does not add a second run (found in the 7-3b launch check)', async t => {
  const s = await setup(t, { edit: c => { c.worker.enabled = false; } });
  s.adapter().scripts.push(reply('one'), reply('two'));
  assert.equal(s.app.worker.scoutNow(s.projectId)?.ok, true);
  // 2 回目は、材料を読み終えて実行を始める直前（まだ動いている実行の一覧に入っていない間）に押す
  const runScout = s.app.engine.runScout.bind(s.app.engine);
  let pressed = false;
  s.app.engine.runScout = (...args: Parameters<typeof runScout>) => {
    if (!pressed) { pressed = true; assert.equal(s.app.worker.scoutNow(s.projectId)?.ok, true); }
    return runScout(...args);
  };
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(pressed, true);
  s.later();
  await s.app.worker.tick();
  assert.equal(s.scoutRows().length, 1, 'two presses, one run');
});
