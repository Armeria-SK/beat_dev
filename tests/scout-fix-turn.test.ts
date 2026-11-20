import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { readLedger, recordEntry } from '../src/scout/ledger.ts';
import { proposalProblem, readProposal, type Proposal } from '../src/tasks/proposal.ts';
import type { Task } from '../src/tasks/store.ts';
import { proposalAdd } from '../src/tools/builtin/proposal.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, fail, readThen, reply, type Script, tempDir, testConfig } from './helpers.ts';
import { ProviderError } from '../src/providers/types.ts';
import { taskUpdate } from '../src/tools/builtin/tasks.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { toolCall } from './helpers/task-app.ts';

// beat 8-6b: 直す番（考える番に直す提案があれば直す実行）・Pre-fix の Approve / Reject・モードの切り替えのサーバー側

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SHORT_WAIT = 61_000;

function gitIn(dir: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

function makeProduct(dir: string): string {
  mkdirSync(join(dir, 'tests'), { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'bug\n');
  writeFileSync(join(dir, 'check.js'), "const fs = require('fs');\nprocess.exit(fs.readFileSync('a.txt', 'utf8').includes('fixed') ? 0 : 1);\n");
  writeFileSync(join(dir, 'tests', 'a.test.js'), 'ok\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'notes.txt'), 'owner notes\n');
  return dir;
}

// 本体の中身: 作業の木（.git を除く）と、.git の objects 以外の全部を、名前と中身のハッシュで
function mainContent(product: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string, skip: (rel: string) => boolean): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(prefix === 'git:' ? join(product, '.git') : product, abs).replaceAll('\\', '/');
      if (skip(rel)) continue;
      if (lstatSync(abs).isDirectory()) walk(abs, prefix, skip);
      else out.set(`${prefix}${rel}`, createHash('sha256').update(readFileSync(abs)).digest('hex'));
    }
  };
  walk(product, 'tree:', rel => rel === '.git');
  walk(join(product, '.git'), 'git:', rel => rel === 'objects');
  return out;
}
const changedKeys = (a: Map<string, string>, b: Map<string, string>): string[] => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
const pick = (value: Record<string, unknown> | null | undefined, like: Record<string, unknown>): Record<string, unknown> | null => (value ? Object.fromEntries(Object.keys(like).map(key => [key, value[key]])) : null);
const onlyBeatBranch = (keys: string[]): boolean => keys.every(key => /^git:(?:logs\/)?refs\/heads\/beat\//u.test(key));
const branchesOf = (product: string): string[] => gitIn(product, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n').filter(Boolean);

const BUG: Proposal = { kind: 'bug', why: 'a.txt says bug.', area: ['a.txt'], size: 'S', goal: null, evidence: null, ledger: null, fixable: true };
const editFix = (): Script => readThen('file_edit', { path: 'a.txt', old: 'bug', new: 'fixed' });

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

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, options: { cloud?: boolean; mode?: 'fix' | 'research' } = {}) {
  const dir = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(dir, 'beat'));
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
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0, scout: [options.cloud ? 'c' : 'm'] };
  config.worker.enabled = true;
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.now() };
  const adapters = new Map<string, FakeAdapter>();
  const logs: string[] = [];
  const app = new App({
    paths, databasePath: ':memory:', log: line => { logs.push(line); }, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const made = adapters.get(p.id) ?? new FakeAdapter(p); adapters.set(p.id, made); return made; },
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { app.worker.stop(); app.engine.stopAll(); web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const json = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  const product = makeProduct(join(dir, 'product'));
  const project = app.projects.create({ name: 'P', root: product, rootKey: rootKeyOf(product), checkCommand: 'node check.js' });
  app.projects.update(project.id, { scoutMode: options.mode ?? 'fix' });
  const build = app.tasks.create({ title: 'build', origin: 'user', actor: 'user', projectId: project.id, acceptanceItems: ['i1'] });
  app.tasks.finish(build.id, 'done', 'built', 'user');
  const propose = (over: Partial<Omit<Proposal, 'fixable'>> & { fixable?: true | undefined } = {}, title = 'Fix the a.txt bug', untrusted = true): Task => {
    const { fixable, ...rest } = { ...BUG, ...over };
    const made = app.tasks.create({ title, body: 'x', origin: 'self', propose: true, projectId: project.id, proposal: { ...rest, ...(fixable ? { fixable } : {}) }, actor: 'beat' });
    if (untrusted) app.tasks.markUntrusted(made.id, 'scout', 'Proposed by a scout run');
    return made;
  };
  const model = (id = 'near') => adapters.get(id)!;
  const fixRows = () => app.db.prepare("SELECT * FROM worktrees WHERE kind = 'fix' ORDER BY created_at, id").all() as Array<{ id: string; state: string; path: string | null; branch: string; proposal_id: string; note: string | null }>;
  const events = (id: string, kind: string) => app.tasks.events(id).filter(e => e.kind === kind).map(e => e.content ?? '');
  const scoutRows = () => app.db.prepare("SELECT * FROM tasks WHERE proposed_by = 'scout-run' ORDER BY created_at, rowid").all() as unknown as Task[];
  const card = async (id: string) => {
    const listed = await json(`/api/tasks?project=${project.id}`, 'GET');
    const all = [...listed.body.active, ...listed.body.finished].filter((task: { id: string }) => task.id === id);
    return { card: all[0], awaiting: listed.body.awaiting.some((task: { id: string }) => task.id === id) };
  };
  return { app, dir, paths, product, project, clock, json, propose, model, fixRows, events, scoutRows, card, logs, adapters };
}

test('8-6b: a fix product still gets scout runs (no stop.mode), Think now does not say scout_off, and proposal_add explains fixable only there', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  s.model().scripts.push(reply('Nothing to check.'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const row = s.scoutRows()[0]!;
  assert.equal(row.status, 'done', row.result_summary ?? '');
  assert.equal(s.fixRows().length, 0, 'no fixable proposal: a plain scout run');
  assert.deepEqual((await s.json('/api/runs', 'GET')).body.runs.map((r: { fix_branch: string | null }) => r.fix_branch), [null], 'a plain scout run has no fix marker');
  const told = s.model().calls[0]!.tools.find(tool => tool.name === 'proposal_add');
  assert.match(told?.description ?? '', /fixable: set true only for a bug of size S or M/u, 'the fix product sees fixable in the tool description');
  assert.notEqual(s.app.worker.scoutView(s.project.id)?.state, 'off');
  s.clock.now += SHORT_WAIT;
  const now = await s.json(`/api/projects/${s.project.id}/scout/run`, 'POST', {});
  assert.equal(now.status, 202, JSON.stringify(now.body));

  const research = await setup(t, { mode: 'research' });
  research.model().scripts.push(reply('Nothing to check.'));
  assert.equal(await research.app.worker.tick(), 'ran');
  const plain = research.model().calls[0]!.tools.find(tool => tool.name === 'proposal_add');
  assert.ok(plain);
  assert.doesNotMatch(plain.description, /fixable/u, 'a research-only product does not see fixable');
  assert.match(ToolRegistry.specs([proposalAdd], research.app.config(), { fixProduct: true })[0]!.description, /fixable/u);
});

test('8-6b: proposals carry fixable only as true; readProposal keeps it', () => {
  const base = { kind: 'bug', why: 'w', area: [], size: 'S', goal: null, evidence: null, ledger: null };
  assert.equal(proposalProblem({ ...base, fixable: true }), null);
  assert.equal(proposalProblem(base), null, 'older proposals without the key stay valid');
  assert.match(proposalProblem({ ...base, fixable: false }) ?? '', /fixable/u);
  assert.match(proposalProblem({ ...base, fixable: 'yes' }) ?? '', /fixable/u);
  assert.equal(readProposal(JSON.stringify({ ...base, fixable: true }))?.fixable, true);
  assert.equal('fixable' in readProposal(JSON.stringify(base))!, false);
});

test('8-6b: a fixable bug becomes a Pre-fix (prefix on the card, ledger result, one notice); Approve moves it to Awaiting check without running a task or copying the owner request; the owner merge closes it; the product only gains the beat branch until then', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const ledger = recordEntry(s.app.paths.projects, s.project.id, { title: 'a.txt check', area: ['a.txt'], checked: 'read a.txt', result: 'proposal Fix the a.txt bug' }, { when: '2026-11-20T00:00:00Z', commit: null, by: 'm' });
  const proposal = s.propose({ ledger: ledger.id });
  const before = mainContent(s.product);
  s.model().scripts.push(editFix(), reply('Changed bug to fixed.'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.fixRows();
  assert.equal(row?.state, 'branch', JSON.stringify([s.fixRows(), s.app.tasks.events(proposal.id)]));
  assert.equal(row!.path, null);
  assert.equal(s.scoutRows().length, 1, 'the fix run replaced the scout run in this turn');

  const shown = await s.card(proposal.id);
  assert.equal(shown.card.status, 'inbox');
  assert.deepEqual(shown.card.prefix, { branch: row!.branch, base: gitIn(s.product, 'rev-parse', 'HEAD'), checks: 'passed', files: 1, added: 1, removed: 1, diff: ['-bug', '+fixed'] });
  const fixView = { id: row!.id, branch: row!.branch, base: gitIn(s.product, 'rev-parse', 'HEAD'), state: 'branch' };
  assert.deepEqual(pick(shown.card.worktree, fixView), fixView, 'the Proposed card carries the fix row (Open diff needs its id)');
  assert.equal(shown.awaiting, false, 'an open proposal is not a merge card yet');
  const single = await s.json(`/api/tasks/${proposal.id}`, 'GET');
  assert.equal(single.status, 200);
  assert.deepEqual(single.body.task.prefix, shown.card.prefix, 'GET /api/tasks/:id carries prefix');
  assert.deepEqual(pick(single.body.task.worktree, fixView), fixView, 'GET /api/tasks/:id carries worktree');
  const diff = await s.json(`/api/tasks/${proposal.id}/branch`, 'GET');
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  assert.equal(diff.body.branch, row!.branch);
  for (const path of ['merged', 'discard']) {
    const early = await s.json(`/api/tasks/${proposal.id}/${path}`, 'POST', { tip: 'x', files: 'y' });
    assert.equal(early.status, 409, `${path} before the owner decides`);
    assert.match(JSON.stringify(early.body), /prefix_undecided/u);
  }
  assert.equal(s.fixRows()[0]!.state, 'branch');
  const runs = (await s.json('/api/runs', 'GET')).body.runs as Array<{ fix_branch: string | null }>;
  assert.deepEqual(runs.map(r => r.fix_branch), [row!.branch], 'the fix run is marked with its branch on the Runs API');
  assert.equal(readLedger(s.app.paths.projects, s.project.id).entries.find(e => e.id === ledger.id)?.result, `fix ${row!.branch}`);
  assert.equal(s.app.notifications.list().filter(n => n.title === 'New pre-fix for P').length, 1);
  assert.deepEqual(s.events(proposal.id, 'prefix'), [`Pre-fix ready on branch ${row!.branch}: the check command passed (1 files, +1 -1)`]);
  assert.ok(onlyBeatBranch(changedKeys(before, mainContent(s.product))), JSON.stringify(changedKeys(before, mainContent(s.product))));

  const approved = await s.json(`/api/tasks/${proposal.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.task.status, 'done');
  assert.equal(approved.body.task.origin, 'user');
  const stored = s.app.tasks.get(proposal.id)!;
  assert.equal(stored.owner_request, null, 'the proposal text (from web reads) is not the owner request');
  assert.equal(stored.proposed_by, 'self');
  assert.equal(s.app.tasks.pickNext(), undefined, 'nothing runs: Approve does not start a task');
  const waiting = await s.card(proposal.id);
  assert.equal(waiting.awaiting, true, 'Awaiting check: merge it');
  assert.deepEqual(pick(waiting.card.worktree, fixView), fixView, 'Awaiting check keeps the same worktree');
  assert.equal(waiting.card.prefix?.branch, row!.branch);
  assert.ok(onlyBeatBranch(changedKeys(before, mainContent(s.product))), 'Approve does not touch the product either');

  gitIn(s.product, 'merge', '-q', '--no-edit', row!.branch);
  assert.equal(await s.app.mergeWatch.check(s.project.id), 1);
  const merged = await s.card(proposal.id);
  assert.equal(merged.awaiting, false, 'merged: the card leaves Awaiting check');
  assert.equal(merged.card.status, 'done');
  assert.equal(merged.card.worktree?.state, 'merged');
  assert.equal(merged.card.prefix?.branch, row!.branch, 'Done shows it as a merged pre-fix');
  assert.equal(branchesOf(s.product).some(b => b.startsWith('refs/heads/beat/')), false, 'the merged branch is cleaned up');
  assert.equal(s.events(proposal.id, 'worktree').length, 1, 'the merge event lands on the proposal, not on the hidden run row');
});

test('8-6b: Reject on a Pre-fix cancels the proposal and removes its beat branch; run-now on a Pre-fix approves it without running', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const branch = s.fixRows()[0]!.branch;
  assert.ok(branchesOf(s.product).includes(`refs/heads/${branch}`));
  const rejected = await s.json(`/api/tasks/${proposal.id}/cancel`, 'POST', { reason: 'Not this way' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.task.status, 'cancelled');
  assert.equal(rejected.body.task.prefix, null);
  assert.equal(branchesOf(s.product).includes(`refs/heads/${branch}`), false, 'the branch is gone');
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  assert.deepEqual(s.events(proposal.id, 'worktree'), [`Pre-fix rejected, so the branch ${branch} was removed`]);

  const second = s.propose({}, 'Fix the a.txt bug again');
  s.clock.now += SHORT_WAIT;
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().at(-1)!.state, 'branch');
  const ran = await s.json(`/api/tasks/${second.id}/run-now`, 'POST', {});
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.task.status, 'done', 'run-now on a Pre-fix is its Approve');
  assert.equal(s.app.tasks.pickNext(), undefined);
});

test('8-6b: the same proposal is tried once per HEAD; a failed fix leaves one "Pre-fix not kept" line and the next turn thinks instead', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(readThen('file_edit', { path: 'a.txt', old: 'bug', new: 'still broken' }), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().length, 1);
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  const [line] = s.events(proposal.id, 'prefix');
  assert.match(line ?? '', /^Pre-fix not kept: the check command did not pass/u);
  const edited = s.app.db.prepare("SELECT output_preview AS out FROM tool_calls WHERE tool = 'file_edit'").get() as { out: string };
  assert.equal(edited.out, 'Replaced 1 occurrence(s): a.txt', 'the edit was written and the check failed on it');
  assert.equal(s.app.tasks.get(proposal.id)!.status, 'inbox', 'the proposal stays as it was');
  const plain = (await s.json(`/api/tasks/${proposal.id}`, 'GET')).body.task;
  assert.deepEqual([plain.worktree, plain.prefix], [null, null], 'a thrown-away fix leaves no worktree or prefix on the open proposal');

  s.clock.now += SHORT_WAIT;
  s.model().scripts.push(reply('Nothing to check.'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().length, 1, 'same HEAD: no second try');
  assert.equal(s.scoutRows().length, 2, 'a scout run instead');

  writeFileSync(join(s.product, 'b.txt'), 'b\n');
  gitIn(s.product, 'add', 'b.txt');
  gitIn(s.product, 'commit', '-q', '-m', 'owner commit');
  s.clock.now += SHORT_WAIT;
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().length, 2, 'a new HEAD: tried again');
  assert.equal(s.fixRows()[1]!.state, 'branch');
});

test('8-6b: only open, fixable, small bugs are fixed', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  s.propose({ fixable: undefined }, 'not marked');
  s.propose({ size: 'L' }, 'too big');
  s.propose({ kind: 'feature' }, 'a feature');
  const edited = s.propose({}, 'owner approved already');
  s.app.tasks.approve(edited.id);
  s.app.tasks.finish(edited.id, 'done', 'x', 'user');
  s.model().scripts.push(reply('Nothing to check.'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().length, 0);
  s.app.projects.update(s.project.id, { checkCommand: null });
  s.propose({}, 'no check');
  s.clock.now += SHORT_WAIT;
  s.model().scripts.push(reply('Nothing to check.'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows().length, 0, 'no check command: no fix');
});

test('8-6b: main_changed tells which part changed and that an owner change can be ignored', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  const owner: Script = async function* (req) {
    writeFileSync(join(s.product, 'owner-new.txt'), 'owner\n');
    yield* editFix()(req);
  };
  s.model().scripts.push(owner, reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const [line] = s.events(proposal.id, 'prefix');
  assert.match(line ?? '', /^Pre-fix not kept: the product folder changed while the fix was being made \(.*working tree.*\)\. If you changed the product folder yourself, you can ignore this$/u);
  assert.equal(branchesOf(s.product).some(b => b.startsWith('refs/heads/beat/')), false);
});

test('8-6b: a fix run stops on Off, pause, the mode going off or to Research only, and its copy is thrown away', { skip: !gitAvailable }, async t => {
  for (const change of ['off', 'paused', 'mode_off', 'research'] as const) {
    const s = await setup(t);
    const proposal = s.propose();
    const held = gate();
    s.model().scripts.push(held.script);
    const running = s.app.worker.tick();
    await held.started;
    const copy = s.fixRows()[0]!;
    assert.equal(copy.state, 'active');
    assert.ok(copy.path && existsSync(copy.path));
    assert.equal(s.app.worker.status().runningAll.some(run => run.kind === 'scout'), true, change);
    if (change === 'off') { const next = s.app.config(); next.worker.enabled = false; await s.app.applyConfig(next, { probe: false }); }
    if (change === 'paused') s.app.worker.setPaused(true);
    if (change === 'mode_off') s.app.projects.update(s.project.id, { scoutMode: 'off' });
    if (change === 'research') s.app.projects.update(s.project.id, { scoutMode: 'research' });
    await s.app.worker.tick();
    assert.equal(await running, 'ran', change);
    const row = s.fixRows()[0]!;
    // Windows では消したファイルが少しのあいだ掴まれていて、空のフォルダが removing で残ることがある（次の直す番が消し直す。下の試験）
    assert.ok(row.state === 'discarded' || row.state === 'removing', `${change}: ${row.state}`);
    assert.equal(row.note, 'failed', change);
    assert.ok(!existsSync(copy.path) || readdirSync(copy.path).length === 0, `${change}: nothing of the copy is left`);
    for (let i = 0; i < 50 && s.fixRows()[0]!.state !== 'discarded'; i++) { await new Promise(resolve => setTimeout(resolve, 200)); await s.app.fixes.sweepFixCopies(); }
    assert.equal(s.fixRows()[0]!.state, 'discarded', change);
    assert.equal(existsSync(copy.path), false, change);
    assert.equal(branchesOf(s.product).some(b => b.startsWith('refs/heads/beat/')), false, change);
    assert.equal(s.app.worker.status().runningAll.length, 0, change);
    assert.deepEqual(s.events(proposal.id, 'prefix'), [], `${change}: a stop is not a failed fix`);
    assert.equal(s.app.kv.get(`scout:fix-tried:${proposal.id}`), undefined, `${change}: a stopped fix may be tried again`);
  }
});

test('8-6b: a fix turn first removes copies an earlier fix run could not remove', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const old = s.propose({}, 'old one');
  const made = await s.app.fixes.createFixCopy({ projectId: s.project.id, root: s.product, proposalId: old.id, title: 'old one' });
  assert.ok(made.ok);
  s.app.db.prepare("UPDATE worktrees SET state = 'removing', ending = 'discarded' WHERE id = ?").run(made.row.id);
  s.app.tasks.finish(old.id, 'cancelled', 'x', 'user');
  const next = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.fixes.get(made.row.id)!.state, 'discarded');
  assert.equal(existsSync(made.row.path!), false);
  assert.equal(s.fixRows().find(row => row.proposal_id === next.id)?.state, 'branch');
});

test('8-6b: when the owner decides the proposal while its fix runs, the kept branch is thrown away instead of becoming a Pre-fix', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  const decide: Script = async function* (req) {
    s.app.tasks.finish(proposal.id, 'cancelled', 'Rejected', 'user', undefined, 'not wanted');
    yield* editFix()(req);
  };
  s.model().scripts.push(decide, reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  assert.equal(branchesOf(s.product).some(b => b.startsWith('refs/heads/beat/')), false);
  assert.equal((await s.card(proposal.id)).card.prefix, null);
  assert.equal(s.app.notifications.list().some(n => n.title === 'New pre-fix for P'), false);
});

test('8-6b: a fix run on a cloud model counts toward scout.cloudRunsPerHour', { skip: !gitAvailable }, async t => {
  const s = await setup(t, { cloud: true });
  s.propose();
  s.model('far').scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.fixRows()[0]?.state, 'branch');
  assert.equal(s.app.kv.getJson<number[]>('scout:cloud-runs')?.length, 1);
  s.propose({}, 'another bug');
  s.clock.now += SHORT_WAIT;
  assert.notEqual(await s.app.worker.tick(), 'ran', 'the hourly cloud cap (1) is used');
  assert.equal(s.fixRows().length, 1);
});

// review REVISE 1: 確かめが通ったあとに止めても、持ち主の見ないブランチ（Pre-fix の無い branch の行）を残さない
const beatBranches = (product: string): string[] => branchesOf(product).filter(b => b.startsWith('refs/heads/beat/'));
const unrecorded = (s: Awaited<ReturnType<typeof setup>>) => s.fixRows().filter(row => row.state === 'branch' && s.app.kv.get(`scout:prefix:${row.id}`) === undefined);

test('8-6b: a stop that lands after the check passed leaves no beat branch and no branch row without a Pre-fix', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  const fixes = s.app.fixes;
  const original = fixes.finishFixCopy.bind(fixes);
  fixes.finishFixCopy = async (id, options) => {
    const done = await original(id, options);
    s.app.worker.setPaused(true);
    await s.app.worker.tick();
    return done;
  };
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(beatBranches(s.product), [], 'no beat branch the owner never saw');
  assert.deepEqual(unrecorded(s), []);
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  assert.equal((await s.card(proposal.id)).card.prefix, null);
  assert.equal(s.app.kv.get(`scout:fix-tried:${proposal.id}`), undefined, 'a stopped fix may be tried again');
});

test('8-6b: after a restart in the middle of keeping a fix, the next fix turn removes the branch nobody recorded', { skip: !gitAvailable }, async t => {
  for (const at of ['before_drop', 'before_record'] as const) {
    const s = await setup(t);
    s.propose();
    s.model().scripts.push(editFix(), reply('done'));
    assert.equal(await s.app.worker.tick(), 'ran');
    const row = s.fixRows()[0]!;
    assert.equal(row.state, 'branch');
    // before_drop: update-ref は済んだが行は active のまま / before_record: 行は branch だが recordFix の前（prefix の kv が無い）
    s.app.kv.delete(`scout:prefix:${row.id}`);
    if (at === 'before_drop') s.app.db.prepare("UPDATE worktrees SET state = 'active' WHERE id = ?").run(row.id);
    const other = s.propose({}, 'another bug');
    s.clock.now += SHORT_WAIT;
    s.model().scripts.push(editFix(), reply('done'));
    await s.app.worker.tick();
    assert.deepEqual(beatBranches(s.product).filter(b => b.endsWith(row.branch)), [], at);
    assert.deepEqual(unrecorded(s), [], at);
    assert.equal(s.app.fixes.get(row.id)!.state, 'discarded', at);
    assert.ok(s.fixRows().some(r => r.proposal_id === other.id), `${at}: the next fix still ran`);
  }
});

// review REVISE 2: Reject でブランチを消せなかった（ref の鍵が掴まれていた）ら、見回りが消し直す
test('8-6b: a Reject whose branch delete failed is retried by the sweep until the branch is gone', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const row = s.fixRows()[0]!;
  const lock = join(s.product, '.git', 'refs', 'heads', `${row.branch}.lock`);
  writeFileSync(lock, '');
  const rejected = await s.json(`/api/tasks/${proposal.id}/cancel`, 'POST', {});
  assert.equal(rejected.status, 200);
  assert.equal(beatBranches(s.product).length, 1, 'the lock kept the branch for now');
  await s.app.fixes.sweepFixCopies();
  assert.equal(beatBranches(s.product).length, 1);
  assert.notEqual(s.fixRows()[0]!.state, 'discarded', 'not closed while the branch is still there');
  rmSync(lock);
  await s.app.fixes.sweepFixCopies();
  assert.deepEqual(beatBranches(s.product), []);
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  assert.deepEqual(s.events(proposal.id, 'worktree'), [`Pre-fix rejected, but the branch ${row.branch} was kept. Delete it yourself if you no longer need it`]);
});

// review REVISE 3: チャットの task_update で取り消しても、Pre-fix のブランチを消す
test('8-6b: cancelling a Pre-fix through task_update also removes its branch', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(beatBranches(s.product).length, 1);
  const ctx = { runId: 'r1', conversationId: 'c1', kind: 'chat', config: s.app.config(), signal: new AbortController().signal, log: () => undefined, services: { db: s.app.db, tasks: s.app.tasks } } as unknown as ToolContext;
  const done = await taskUpdate.execute({ id: proposal.id, status: 'cancelled' }, ctx);
  assert.notEqual(done.isError, true, done.content);
  // task_update は片付けを待たない。onFinished が始めた片付けが行と経過まで書き終えるのを待つ（ここで片付けを呼ぶと、知らせの道の試験にならない）
  for (let i = 0; i < 100 && (s.fixRows()[0]!.state !== 'discarded' || s.events(proposal.id, 'worktree').length === 0); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(beatBranches(s.product), []);
  assert.equal(s.fixRows()[0]!.state, 'discarded');
  assert.equal(s.events(proposal.id, 'worktree').length, 1);
});

// review REVISE 4: 外から読んだ印の無い提案でも、Approve は提案の文を持ち主の頼みに写さない
test('8-6b: approving a Pre-fix whose proposal is not marked untrusted still leaves owner_request empty', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose({}, 'Fix the a.txt bug', false);
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const approved = await s.json(`/api/tasks/${proposal.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(s.app.tasks.get(proposal.id)!.owner_request, null);
});

// review REVISE 5: 止める条件の残り
test('8-6b: a stop during the check command ends the check at once', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  writeFileSync(join(s.product, 'slow.js'), 'setTimeout(() => process.exit(0), 60000);\n');
  gitIn(s.product, 'add', 'slow.js');
  gitIn(s.product, 'commit', '-q', '-m', 'slow check');
  s.app.projects.update(s.project.id, { checkCommand: 'node slow.js' });
  const proposal = s.propose();
  const fixes = s.app.fixes;
  const original = fixes.finishFixCopy.bind(fixes);
  let stopped = 0;
  fixes.finishFixCopy = async (id, options) => {
    const timer = setTimeout(() => { stopped = Date.now(); s.app.worker.setPaused(true); void s.app.worker.tick(); }, 3000);
    try { return await original(id, options); } finally { clearTimeout(timer); }
  };
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(stopped > 0, 'the stop landed while the check ran');
  assert.ok(Date.now() - stopped < 20_000, `the check was stopped, not waited for (${Date.now() - stopped} ms)`);
  assert.deepEqual(beatBranches(s.product), []);
  assert.deepEqual(s.events(proposal.id, 'prefix'), []);
});

test('8-6b: a fix run also stops when routing.scout is emptied or owner work is ready', { skip: !gitAvailable }, async t => {
  for (const change of ['route', 'owner'] as const) {
    const s = await setup(t);
    const proposal = s.propose();
    const held = gate();
    s.model().scripts.push(held.script);
    const running = s.app.worker.tick();
    await held.started;
    if (change === 'route') { const next = s.app.config(); next.routing.scout = []; await s.app.applyConfig(next, { probe: false }); }
    if (change === 'owner') s.app.tasks.create({ title: 'Owner work', body: 'x', origin: 'user', projectId: s.project.id, actor: 'user' });
    await s.app.worker.tick();
    assert.equal(await running, 'ran', change);
    for (let i = 0; i < 50 && s.fixRows()[0]!.state !== 'discarded'; i++) { await new Promise(resolve => setTimeout(resolve, 200)); await s.app.fixes.sweepFixCopies(); }
    assert.equal(s.fixRows()[0]!.state, 'discarded', change);
    assert.deepEqual(beatBranches(s.product), [], change);
    assert.equal(s.app.kv.get(`scout:fix-tried:${proposal.id}`), undefined, change);
  }
});

test('8-6b: a fix run that hits a rate limit rests the scout model until midnight with one notice', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  s.propose();
  s.model().scripts.push(fail(new ProviderError('rate_limit', 'busy', { retryable: false })));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.notifications.list().filter(n => n.dedup_key?.startsWith('scout-rest:near:')).length, 1, 'one rest notice');
  s.clock.now += SHORT_WAIT;
  s.propose({}, 'another bug');
  assert.notEqual(await s.app.worker.tick(), 'ran', 'resting: no new fix');
  assert.equal(s.fixRows().length, 1);
});

test('8-6b: Reject keeps a beat branch that carries the owner commits and says so', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const branch = s.fixRows()[0]!.branch;
  gitIn(s.product, 'checkout', '-q', branch);
  writeFileSync(join(s.product, 'mine.txt'), 'mine\n');
  gitIn(s.product, 'add', 'mine.txt');
  gitIn(s.product, 'commit', '-q', '-m', 'owner on the beat branch');
  gitIn(s.product, 'checkout', '-q', 'main');
  const rejected = await s.json(`/api/tasks/${proposal.id}/cancel`, 'POST', {});
  assert.equal(rejected.status, 200);
  assert.ok(branchesOf(s.product).includes(`refs/heads/${branch}`), 'the owner commits are not thrown away');
  assert.deepEqual(s.events(proposal.id, 'worktree'), [`Pre-fix rejected, but the branch ${branch} has commits that were not made by beat, so it was kept`]);
});

// review REVISE 6: 差分の見本の行は、200 文字で切る前に設定の鍵を伏せる
test('8-6b: a provider key in the fix diff is masked before the sample line is cut', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const key = 'QZKEY' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  s.adapters.delete('far');
  const put = await s.json('/api/providers/far/key', 'PUT', { key });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.ok(s.app.registry.secrets().includes(key), 'the key is one of the registry secrets');
  const proposal = s.propose();
  s.model().scripts.push(readThen('file_edit', { path: 'a.txt', old: 'bug', new: `fixed${'x'.repeat(177)}${key}` }), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const prefix = (await s.json(`/api/tasks/${proposal.id}`, 'GET')).body.task.prefix;
  assert.ok(prefix, JSON.stringify(s.app.tasks.events(proposal.id)));
  const added = prefix.diff.find((line: string) => line.startsWith('+'));
  assert.ok(added, JSON.stringify(prefix.diff));
  assert.equal(added.includes(key.slice(0, 10)), false, added);
});

// review REVISE 6: pre-fix のモードのあいだに確かめのコマンドを消す PATCH は断る（モードは黙って変えない）
test('8-6b: clearing the check command while the mode is pre-fix is refused', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const cleared = await s.json(`/api/projects/${s.project.id}`, 'PATCH', { checkCommand: '' });
  assert.equal(cleared.status, 400, JSON.stringify(cleared.body));
  assert.match(JSON.stringify(cleared.body), /scout_fix_needs_check/u);
  assert.equal(s.app.projects.get(s.project.id)!.check_command, 'node check.js');
  const both = await s.json(`/api/projects/${s.project.id}`, 'PATCH', { checkCommand: '', scoutMode: 'research' });
  assert.equal(both.status, 200, 'leaving pre-fix in the same PATCH is fine');
  assert.equal(s.app.projects.get(s.project.id)!.scout_mode, 'research');
  const renamed = await s.json(`/api/projects/${s.project.id}`, 'PATCH', { name: 'Q' });
  assert.equal(renamed.status, 200);
});

// re-review MEDIUM: 承認した Pre-fix を task_update で取り消しても、取り込み待ちのブランチは消さない（消すのは Discard）
test('8-6b: cancelling an approved Pre-fix through task_update keeps its branch', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  const proposal = s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const approved = await s.json(`/api/tasks/${proposal.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const ctx = { runId: 'r1', conversationId: 'c1', kind: 'chat', config: s.app.config(), signal: new AbortController().signal, log: () => undefined, services: { db: s.app.db, tasks: s.app.tasks } } as unknown as ToolContext;
  await taskUpdate.execute({ id: proposal.id, status: 'cancelled' }, ctx);
  await s.app.dropRejectedPrefix(proposal.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(beatBranches(s.product).length, 1, 'the approved branch stays');
  assert.equal(s.fixRows()[0]!.state, 'branch');
  assert.deepEqual(s.events(proposal.id, 'worktree'), []);
});

// re-review LOW: 再起動のあと 1 回目の見回りで写しを消せなかった行も、2 回目でブランチまで捨てる
test('8-6b: a restarted fix whose copy removal failed once still has its branch dropped on the next sweep', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  s.propose();
  s.model().scripts.push(editFix(), reply('done'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const row = s.fixRows()[0]!;
  const place = s.app.worktrees.place();
  assert.ok(place.ok);
  const copy = join(place.root, 'fix', row.id);
  mkdirSync(copy, { recursive: true });
  s.app.kv.delete(`scout:prefix:${row.id}`);
  s.app.db.prepare("UPDATE worktrees SET state = 'removing', ending = 'discarded', path = ? WHERE id = ?").run(copy, row.id);
  await s.app.fixes.sweepFixCopies();
  assert.equal(existsSync(copy), false);
  assert.equal(s.app.fixes.get(row.id)!.state, 'discarded');
  assert.deepEqual(beatBranches(s.product), []);
});
