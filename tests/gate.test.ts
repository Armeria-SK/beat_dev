import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { AcceptanceCheck, AcceptanceDoc } from '../src/projects/acceptance.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import type { AddressInfo } from 'node:net';
import { eraseConversation } from '../src/db/erase.ts';
import { GATE_LIMIT } from '../src/projects/gate.ts';
import { unbuilt } from '../src/projects/build.ts';
import { createWebServer } from '../src/web/server.ts';
import { JudgeAdapter, reply, tempDir, type Script, testConfig, withLoad, notSearch } from './helpers.ts';

function toolCall(name: string, args: unknown, before?: () => void): Script {
  return async function* (req) {
    before?.();
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

const PASS = 'node pass.js';
const FAIL = 'node fail.js';
const SEND = 'curl -d hello https://beat-test.invalid/upload';
const look: AcceptanceCheck = { kind: 'look' };
const read: AcceptanceCheck = { kind: 'read' };
const command = (text: string): AcceptanceCheck => ({ kind: 'command', command: text });

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.now() - 3_600_000 };
  let adapter!: JudgeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const product = (name: string, items: Array<{ result: string; check: AcceptanceCheck }>, checkCommand: string | null = null, taintedRuns: string[] = []) => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pass.js'), "require('fs').appendFileSync('runs.log', 'pass\\n'); console.log('all good');");
    writeFileSync(join(root, 'fail.js'), "require('fs').appendFileSync('runs.log', 'fail\\n'); console.log('2 tests failed'); console.error('token sk-' + 'ant-' + 'B'.repeat(30)); process.exit(1);");
    const row = app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand });
    mkdirSync(join(paths.projects, row.id), { recursive: true });
    const doc: AcceptanceDoc = {
      schema: 1, version: 1, language: null, taintedRuns,
      notDoing: [{ id: 'N-1', text: 'No login screen', source: { kind: 'owner_edit' } }],
      items: items.map((entry, i) => ({ id: `A-${i + 1}`, result: entry.result, source: { kind: 'owner_edit' as const }, check: entry.check, state: 'open' as const, evidence: [], changedIn: null, removedIn: null })),
    };
    if (items.length) app.acceptance.freeze(row.id, doc, { plan_hash: null, source: 'build', created_at: clock.now }, () => null);
    return { id: row.id, root };
  };
  const task = (projectId: string, items: string[], title = 'Build: shop') => app.tasks.create({ title, origin: 'user', actor: 'user', projectId, acceptanceItems: items, ownerRequest: true });
  const run = async (id: string, scripts: Script[]) => {
    adapter.scripts.push(...scripts);
    app.worker.requestRun(id);
    assert.equal(await app.worker.tick(), 'ran');
  };
  const toolTexts = (taskId: string) => {
    const cid = app.tasks.get(taskId)!.conversation_id!;
    return app.conversations.messages(cid).filter(notSearch).map(m => ({ text: m.text, isError: (m.message as { isError?: boolean }).isError === true }));
  };
  const states = (projectId: string) => Object.fromEntries(app.acceptance.read(projectId)!.items.map(entry => [entry.id, entry.state]));
  const evidence = (projectId: string, id: string) => app.acceptance.read(projectId)!.items.find(entry => entry.id === id)!.evidence;
  const events = (taskId: string, kind: string) => app.tasks.events(taskId).filter(e => e.kind === kind);
  const runs = (root: string) => { try { return readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n'); } catch { return []; } };
  const file = (projectId: string) => join(paths.projects, projectId, 'acceptance.json');
  const serve = async () => {
    const web = createWebServer(app);
    await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    web.setOrigins([origin]);
    t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
    return async (path: string, method: string, body?: unknown) => {
      const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
  };
  return { app, adapter: () => adapter, clock, paths, product, task, run, toolTexts, states, evidence, events, runs, file, serve };
}

const done = (items?: unknown[], before?: () => void) => toolCall('task_complete', { summary: 'done', notify: false, ...(items ? { items } : {}) }, before);
const lastText = (texts: Array<{ text: string; isError: boolean }>, name: string) => texts.filter(m => m.text.startsWith(`[${name}]`)).at(-1)!;
const echo = (text: string) => toolCall('shell_run', { command: `echo ${text}` });

test('5-3b 実機の代わり（台本のモデル・本物のシェル）: 項目 3 つ（コマンド 2・目で見る 1）→ コマンドの 2 つが met、1 つが Awaiting check。結果に項目の行と STATE の 1 行', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Lists files', check: command(PASS) }, { result: 'Saves files', check: command(PASS) }, { result: 'The page looks right', check: look }]);
  const task = s.task(p.id, ['A-1', 'A-2', 'A-3']);
  await s.run(task.id, [echo('page'), done([{ id: 'A-3', evidence: 'E-1' }])]);
  assert.deepEqual(s.states(p.id), { 'A-1': 'met', 'A-2': 'met', 'A-3': 'unverified' });
  assert.deepEqual(s.runs(p.root), ['pass', 'pass']);
  const after = s.app.tasks.get(task.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.check_state, 'awaiting');
  const result = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /A-1 met \(its command passed\)/u);
  assert.match(result.text, /A-3 unverified/u);
  assert.match(result.text, /mesh_state_set/u);
  const copy = s.evidence(p.id, 'A-3')[0] as { at: number };
  assert.deepEqual(s.evidence(p.id, 'A-3'), [{ tag: 'E-1', tool: 'shell_run', input: '{"command":"echo page"}', ok: true, at: copy.at }]);
  assert.equal(s.app.acceptance.itemStates(p.id)['A-1']!.by, 'gate');
});

test('5-3b 作業の取り決め: 受け持つ項目・確かめ方・しないことが実行の最初の発言に入り、判定役の頼みには入らない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Lists files', check: command(PASS) }, { result: 'The page looks right', check: look }, { result: 'Not mine', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [reply('thinking')]);
  const first = JSON.stringify(s.adapter().calls[0]!.messages);
  assert.match(first, /# Work agreement/u);
  assert.match(first, /A-1: Lists files \(check: beat runs its command at task_complete: node pass\.js\)/u);
  assert.match(first, /A-2: The page looks right \(check: look/u);
  assert.match(first, /Not doing: No login screen/u);
  assert.doesNotMatch(first, /A-3: Not mine/u);
  assert.equal(first.split('# Work agreement').length, 2, 'the agreement appears once');
  assert.doesNotMatch(s.app.tasks.get(task.id)!.body, /Work agreement/u);
  const request = s.app.tasks.judgeRequest(task.id);
  assert.equal(request, 'Build: shop');
  const plain = s.app.tasks.create({ title: 'plain', origin: 'user', actor: 'user', projectId: p.id });
  await s.run(plain.id, [reply('ok')]);
  assert.doesNotMatch(JSON.stringify(s.adapter().calls.at(-1)!.messages), /Work agreement/u, '項目を受け持たないタスクには入らない');
});

test('5-3b 成功した echo ok の札では met にならない（目で見る項目は unverified、コマンドの項目は札を見ずにコマンドで決まる）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Tests pass', check: command(FAIL) }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [echo('ok'), done([{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', evidence: 'E-1' }])]);
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified', 'A-2': 'open' });
  assert.notEqual(s.app.tasks.get(task.id)!.status, 'done');
});

test('5-3b 項目のコマンドが失敗すると open と出力の末尾（鍵は伏せる）。断りは同じ実行の作る役に返り、直して通ると完了', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command('node check.js') }]);
  writeFileSync(join(p.root, 'check.js'), "const fs = require('fs'); if (!fs.existsSync('fixed')) { console.log('1 test failed'); console.error('sk-' + 'ant-' + 'C'.repeat(30)); process.exit(1); }");
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done(), done(undefined, () => writeFileSync(join(p.root, 'fixed'), ''))]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.equal(texts.length, 2);
  assert.equal(texts[0]!.isError, true);
  assert.match(texts[0]!.text, /A-1: its command failed/u);
  assert.match(texts[0]!.text, /1 test failed/u);
  assert.doesNotMatch(texts[0]!.text, /sk-ant-C/u);
  assert.equal(texts[1]!.isError, false, texts[1]!.text);
  assert.equal(s.events(task.id, 'item_check_failed').length, 1);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.equal(s.app.tasks.get(task.id)!.check_state, null);
  assert.deepEqual(s.states(p.id), { 'A-1': 'met' });
  assert.doesNotMatch(JSON.stringify(s.app.acceptance.itemStates(p.id)), /sk-ant-C/u);
});

test('5-3b 項目のコマンドが送るに当たると Pending に積まれ unverified。止まらずに done + awaiting', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Uploads the report', check: command(SEND) }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done()]);
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified' });
  const held = s.evidence(p.id, 'A-1')[0] as { held: string; pending: number };
  assert.equal(held.held, 'pending');
  const row = s.app.db.prepare('SELECT kind, status, task_id FROM pending_actions WHERE id = ?').get(held.pending) as { kind: string; status: string; task_id: string };
  assert.deepEqual({ ...row }, { kind: 'send', status: 'waiting', task_id: task.id });
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
});

test('5-3b 項目のコマンドが判定役に回り「聞きたい」→ Pending で unverified（止まらない）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Code is formatted', check: command('npx prettier --check .') }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done()]);
  assert.equal(s.adapter().judged.length, 1);
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified' });
  const held = s.evidence(p.id, 'A-1')[0] as { pending: number };
  assert.equal((s.app.db.prepare('SELECT kind FROM pending_actions WHERE id = ?').get(held.pending) as { kind: string }).kind, 'judge');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
});

test('5-3b 札も理由も無い項目があると断られ、断りの文に足りない項目と使える札が並ぶ。続けて札を渡すと通る', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [echo('page'), done(), done([{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', not_done: 'No text yet' }])]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.equal(texts[0]!.isError, true);
  assert.match(texts[0]!.text, /refusal 1 of 3/u);
  assert.match(texts[0]!.text, /Items with neither evidence nor a reason: A-1, A-2/u);
  assert.match(texts[0]!.text, /Tags you can use \(newest first\):\nE-1 shell_run \{"command":"echo page"\}/u);
  assert.equal(texts[1]!.isError, false, texts[1]!.text);
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified', 'A-2': 'open' });
  assert.equal((s.evidence(p.id, 'A-2')[0] as { notDone: string }).notDone, 'No text yet');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
  assert.equal(s.events(task.id, 'gate_refused').length, 1);
});

test('5-3b 別のタスクの札・失敗した呼び出しの札・Pending に積まれた呼び出しの札は断られる', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const other = s.app.tasks.create({ title: 'other', origin: 'user', actor: 'user', projectId: p.id });
  await s.run(other.id, [echo('a'), echo('b'), echo('c'), done()]);
  assert.equal(s.app.tasks.get(other.id)!.status, 'done');
  const cases: Array<[string, Script, string, RegExp]> = [
    ['other', echo('mine'), 'E-3', /E-3 is not accepted \(there is no such tag/u],
    ['failed', toolCall('shell_run', { command: FAIL }), 'E-1', /E-1 is not accepted \(that call failed\)/u],
    ['parked', toolCall('shell_run', { command: SEND }), 'E-1', /E-1 is not accepted \(that call did not run/u],
  ];
  for (const [name, first, tag, why] of cases) {
    const task = s.task(p.id, ['A-1'], `Build ${name}`);
    await s.run(task.id, [first, done([{ id: 'A-1', evidence: tag }])]);
    const text = lastText(s.toolTexts(task.id), 'task_complete');
    assert.equal(text.isError, true, name);
    assert.match(text.text, why, name);
    assert.deepEqual(s.states(p.id), { 'A-1': 'open' }, name);
    s.app.tasks.finish(task.id, 'cancelled', null, 'user');
  }
});

test('5-3b 一覧のファイルを直接書き換えると完了が受け付けられない（経過に残る）。手で met にしただけのファイルも、DB の状態で決まる', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const stateOnly = JSON.parse(readFileSync(s.file(p.id), 'utf8')) as AcceptanceDoc;
  stateOnly.items[0]!.state = 'met';
  writeFileSync(s.file(p.id), JSON.stringify(stateOnly));
  const first = s.task(p.id, ['A-1'], 'Build state');
  await s.run(first.id, [done()]);
  assert.match(lastText(s.toolTexts(first.id), 'task_complete').text, /Items with neither evidence nor a reason: A-1/u);
  s.app.tasks.finish(first.id, 'cancelled', null, 'user');
  const hacked = JSON.parse(readFileSync(s.file(p.id), 'utf8')) as AcceptanceDoc;
  hacked.items[0]!.result = 'Anything goes';
  writeFileSync(s.file(p.id), JSON.stringify(hacked));
  const task = s.task(p.id, ['A-1'], 'Build hacked');
  await s.run(task.id, [echo('hi'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(text.isError, true);
  assert.match(text.text, /acceptance\.json does not match the fixed version 1/u);
  assert.equal(s.events(task.id, 'gate_list_changed').length, 1);
  assert.deepEqual(s.states(p.id), { 'A-1': 'open' });
  assert.equal(JSON.parse(readFileSync(s.file(p.id), 'utf8')).items[0].result, 'Anything goes', '断るだけで書き戻さない');
});

test('5-3b Build のあとで足された項目（親が受け持たない）では親を断らない。次の Build の候補に残る', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  s.clock.now += 1000;
  s.app.acceptance.applyOwnerDecision(p.id, [{ op: 'add', item: { result: 'New thing', check: look }, source: { kind: 'owner_edit' } }], 'question');
  await s.run(task.id, [echo('hi'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(text.isError, false, text.text);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified', 'A-2': 'open' });
  assert.deepEqual(unbuilt(s.app, p.id, s.app.acceptance.read(p.id)!), ['A-2']);
});

test('5-3b 親が受け持つ項目が Build のあとで変わり、どのタスクも受け持たないなら断る。断られ続けて閉じるときは、その項目を名指しして done + awaiting', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  s.clock.now += 1000;
  s.app.acceptance.applyOwnerDecision(p.id, [{ op: 'change', id: 'A-2', item: { result: 'Reads very well', check: read }, source: { kind: 'owner_edit' } }], 'question');
  const items = [{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', not_done: 'Later' }];
  await s.run(task.id, [echo('hi'), done(items), done(items), done(items)]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.equal(texts.length, 3);
  assert.match(texts[0]!.text, /Items no task covers: A-2/u);
  assert.equal(texts[0]!.isError, true);
  assert.equal(texts[2]!.isError, false, texts[2]!.text);
  assert.match(texts[2]!.text, /Items no task covers yet: A-2/u);
  const after = s.app.tasks.get(task.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.check_state, 'awaiting');
});

test('5-3b 子に項目を渡す: 実在しない番号・親が受け持たない番号は断る。子が済にした項目は親でも済（コマンドは動かし直さない）、子の札も親で数える', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command(PASS) }, { result: 'Has a page', check: look }, { result: 'Other', check: look }]);
  s.task(p.id, ['A-3'], 'Build: other');
  const parent = s.task(p.id, ['A-1', 'A-2']);
  await s.run(parent.id, [
    toolCall('task_create', { title: 'missing', items: ['A-9'] }),
    toolCall('task_create', { title: 'foreign', items: ['A-3'] }),
    toolCall('task_create', { title: 'child', body: 'do A-1 and A-2', items: ['A-1', 'A-2'] }),
    done(),
  ]);
  const created = s.toolTexts(parent.id).filter(m => m.text.startsWith('[task_create]'));
  assert.match(created[0]!.text, /there is no live acceptance item A-9/u);
  assert.match(created[1]!.text, /this task does not cover A-3/u);
  assert.equal(created[2]!.isError, false, created[2]!.text);
  const child = s.app.db.prepare('SELECT id, acceptance_items FROM tasks WHERE spawned_by = ?').get(parent.id) as { id: string; acceptance_items: string };
  assert.equal(child.acceptance_items, '["A-1","A-2"]');
  assert.equal(s.app.tasks.get(parent.id)!.status, 'ready', '子が残っているので区切る');
  await s.run(child.id, [echo('page'), done([{ id: 'A-2', evidence: 'E-1' }])]);
  assert.deepEqual(s.states(p.id), { 'A-1': 'met', 'A-2': 'unverified', 'A-3': 'open' });
  assert.equal(s.app.tasks.get(child.id)!.check_state, 'awaiting');
  await s.run(parent.id, [done()]);
  const text = lastText(s.toolTexts(parent.id), 'task_complete');
  assert.equal(text.isError, false, text.text);
  assert.match(text.text, /A-1 met\b/u);
  assert.deepEqual(s.runs(p.root), ['pass'], '子が済にした項目のコマンドは親で動かし直さない');
  assert.equal(s.app.tasks.get(parent.id)!.status, 'done');
  assert.equal(s.app.tasks.get(parent.id)!.check_state, 'awaiting');
});

test('5-3b 会話から・項目を受け持たないタスクからは、項目を渡せない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const plain = s.app.tasks.create({ title: 'plain', origin: 'user', actor: 'user', projectId: p.id });
  await s.run(plain.id, [toolCall('task_create', { title: 'child', items: ['A-1'] })]);
  assert.match(lastText(s.toolTexts(plain.id), 'task_create').text, /this task does not cover A-1/u);
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE acceptance_items IS NOT NULL').get() as { n: number }).n, 0);
});

test('5-3b 確かめ待ちのタスクは親と 1 製品 1 タスクの枠を止めない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const parent = s.task(p.id, ['A-1']);
  const child = s.app.tasks.create({ title: 'child', origin: 'user', actor: 'user', projectId: p.id, acceptanceItems: ['A-1'], spawnedBy: parent.id });
  await s.run(child.id, [done([{ id: 'A-1', not_done: 'no browser' }])]);
  assert.equal(s.app.tasks.get(child.id)!.status, 'done');
  assert.equal(s.app.tasks.get(child.id)!.check_state, 'awaiting');
  assert.equal(s.app.tasks.openChildren(parent.id), 0);
  assert.equal(s.app.tasks.pickNext()?.id, parent.id, '親が選ばれる');
  assert.equal(s.app.tasks.productBusy(s.app.tasks.get(parent.id)!), false);
});

test('5-3b 会話を消しても証拠の写しが残る（札はもう引けない）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const before = s.evidence(p.id, 'A-1');
  eraseConversation({ db: s.app.db, uploadsDir: s.app.paths.uploads, toolOutputsDir: join(s.app.paths.data, 'tool_outputs'), markDeleted: ids => s.app.conversations.markDeleted(ids) }, s.app.tasks.get(task.id)!.conversation_id!);
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE evidence_no = 1 AND conversation_id IS NOT NULL').get() as { n: number }).n, 0);
  assert.deepEqual(s.evidence(p.id, 'A-1'), before);
  assert.equal((before[0] as { input: string }).input, '{"command":"echo page"}');
});

test('5-3b 一覧の無い製品・項目を受け持たないタスクは check_command だけ', async t => {
  const s = await setup(t);
  const p = s.product('bare', [], PASS);
  const task = s.app.tasks.create({ title: 'build', origin: 'user', actor: 'user', projectId: p.id });
  await s.run(task.id, [done()]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.match(text.text, /The product's check command passed: node pass\.js/u);
  assert.doesNotMatch(text.text, /Acceptance items/u);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.equal(s.app.tasks.get(task.id)!.check_state, null);
  assert.deepEqual(s.runs(p.root), ['pass']);
});

test('5-3b 断られ続ける出口: 門が 3 回続けて断ると、残りを理由なしの unverified として閉じ、done + awaiting', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [done(), done([{ id: 'A-1', evidence: 'E-99' }]), done()]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.deepEqual(texts.map(m => m.isError), [true, true, false]);
  assert.match(texts[2]!.text, new RegExp(`refused ${GATE_LIMIT} times in a row, so the items left \\(A-1, A-2\\) are closed as unverified`, 'u'));
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified', 'A-2': 'unverified' });
  assert.match(JSON.stringify(s.evidence(p.id, 'A-1')), /closed without evidence after 3 refusals/u);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
  assert.equal(s.events(task.id, 'gate_closed').length, 1);
});

test('5-3b 項目のコマンドが 3 回続けて失敗するとタスクは failed になり、質問票に check_failed の行', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command(FAIL) }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done(), done(), done()]);
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
  const question = s.app.db.prepare('SELECT kind, question, options FROM questions WHERE task_id = ?').get(task.id) as { kind: string; question: string; options: string };
  assert.equal(question.kind, 'check_failed');
  assert.match(question.question, /The command of an acceptance item failed 3 times in a row for "Build: shop"/u);
  assert.deepEqual(JSON.parse(question.options), ['Retry', 'Leave it']);
  assert.deepEqual(s.runs(p.root), ['fail', 'fail', 'fail']);
});

test('5-3b 確かめ待ちの口: 「確かめた」で持ち主の名で met、「まだ足りない」で直しのタスク（項目は残る）。どちらも経過に残り、残りが無くなると checked', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }, { result: 'Tests pass', check: command(PASS) }]);
  const task = s.task(p.id, ['A-1', 'A-2', 'A-3']);
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', evidence: 'E-1' }])]);
  const listed = await api(`/api/tasks?projectId=${p.id}`, 'GET');
  const row = (listed.body.finished as Array<{ id: string; check_state: string; items: unknown }>).find(entry => entry.id === task.id)!;
  assert.equal(row.check_state, 'awaiting');
  assert.deepEqual(row.items, { owned: 3, met: 1, remaining: ['A-1', 'A-2'] });
  assert.equal((await api(`/api/tasks/${task.id}/items/A-1/check`, 'POST', { result: 'checked', version: 2 })).status, 409, '見ていた版が違えば断る');
  assert.equal((await api(`/api/tasks/${task.id}/items/A-3/check`, 'POST', { result: 'checked', version: 1 })).status, 409, '残っていない項目は断る');
  assert.equal((await api(`/api/tasks/${task.id}/items/A-1/check`, 'POST', { result: 'maybe', version: 1 })).status, 400);
  const checked = await api(`/api/tasks/${task.id}/items/A-1/check`, 'POST', { result: 'checked', version: 1, note: 'looks fine' });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(checked.body.task.items, { owned: 3, met: 2, remaining: ['A-2'] });
  assert.equal(s.app.acceptance.itemStates(p.id)['A-1']!.by, 'owner');
  const short = await api(`/api/tasks/${task.id}/items/A-2/check`, 'POST', { result: 'insufficient', version: 1, note: 'too terse' });
  assert.equal(short.status, 200, JSON.stringify(short.body));
  const fix = s.app.tasks.get(short.body.fix.id)!;
  assert.deepEqual([fix.origin, fix.status, fix.acceptance_items, fix.project_id], ['user', 'ready', '["A-2"]', p.id]);
  assert.match(fix.body, /too terse/u);
  // 題に受け入れの結果（AI の文）が入るので、ブラウザの持ち主の文には数えない（9-1b の審査）。判定役の依頼は今までどおり
  assert.equal(s.app.tasks.ownerRequestText(fix.id), undefined);
  assert.notEqual(s.app.tasks.judgeRequest(fix.id), '');
  assert.equal((await api(`/api/tasks/${task.id}/items/A-2/check`, 'POST', { result: 'insufficient', version: 1 })).body.fix.id, fix.id, '2 回押しても直しは 1 つ');
  assert.equal(s.states(p.id)['A-2'], 'unverified', '項目はそのまま');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
  const decisions = s.events(task.id, 'owner_check').map(e => JSON.parse(e.content!)).reverse();
  assert.deepEqual(decisions.slice(0, 2), [{ item: 'A-1', result: 'checked', note: 'looks fine' }, { item: 'A-2', result: 'insufficient', note: 'too terse', fix: fix.id }]);
  const all = await api(`/api/tasks/${task.id}/check`, 'POST', { version: 1 });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.task.check_state, 'checked');
  assert.deepEqual(s.states(p.id), { 'A-1': 'met', 'A-2': 'met', 'A-3': 'met' });
  assert.equal((await api(`/api/tasks/${task.id}/check`, 'POST', { version: 1 })).status, 409, 'もう確かめ待ちではない');
});

test('5-3b 直しのタスクは前のタスクの札では通らない（自分で証拠を出す）。直しのタスクで項目が済になると、もとのタスクの確かめ待ちも片づく', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const short = await api(`/api/tasks/${task.id}/items/A-1/check`, 'POST', { result: 'insufficient', version: 1 });
  const fix = short.body.fix.id as string;
  await s.run(fix, [done(), echo('better page'), done([{ id: 'A-1', evidence: 'E-2' }])]);
  const texts = s.toolTexts(fix).filter(m => m.text.startsWith('[task_complete]'));
  assert.equal(texts[0]!.isError, true);
  assert.match(texts[0]!.text, /Items with neither evidence nor a reason: A-1/u);
  assert.equal(texts[1]!.isError, false, texts[1]!.text);
  assert.equal(s.app.tasks.get(fix)!.check_state, 'awaiting');
  assert.equal(s.app.acceptance.itemStates(p.id)['A-1']!.taskId, fix);
  const checked = await api(`/api/tasks/${fix}/items/A-1/check`, 'POST', { result: 'checked', version: 1 });
  assert.equal(checked.body.task.check_state, 'checked');
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'checked', 'もとのタスクも片づく');
});

test('5-3b 開き直し（5-P2・Retry）で確かめ待ちの印が外れる', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done([{ id: 'A-1', not_done: 'later' }])]);
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
  s.app.tasks.reopen(task.id, 'beat', 'Pending item #1 ended as failed');
  assert.equal(s.app.tasks.get(task.id)!.check_state, null);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
});

const until = async (check: () => boolean, what: string) => {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

test('5-3b task_update では項目を受け持つタスク（根も子も）を done にできない（門を飛ばさない）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const build = s.task(p.id, ['A-1']);
  const child = s.app.tasks.create({ title: 'child', origin: 'user', actor: 'user', projectId: p.id, acceptanceItems: ['A-1'], spawnedBy: build.id });
  const other = s.app.tasks.create({ title: 'other', origin: 'user', actor: 'user', projectId: p.id });
  await s.run(other.id, [toolCall('task_update', { id: build.id, status: 'done' }), toolCall('task_update', { id: child.id, status: 'done' }), done()]);
  const texts = s.toolTexts(other.id).filter(m => m.text.startsWith('[task_update]'));
  assert.equal(texts.length, 2);
  for (const text of texts) {
    assert.equal(text.isError, true);
    assert.match(text.text, /covers acceptance items, so it can be completed only with task_complete in its own run/u);
  }
  assert.notEqual(s.app.tasks.get(build.id)!.status, 'done');
  assert.notEqual(s.app.tasks.get(child.id)!.status, 'done');
});

test('5-3b 一覧のファイルが変えられたままなら何回でも断る（3 回の出口に数えない）。持ち主への知らせは 1 つだけ（質問票は使わない）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Tests pass', check: command(PASS) }]);
  const hacked = JSON.parse(readFileSync(s.file(p.id), 'utf8')) as AcceptanceDoc;
  hacked.items[0]!.result = 'Anything goes';
  writeFileSync(s.file(p.id), JSON.stringify(hacked));
  const task = s.task(p.id, ['A-1', 'A-2']);
  const items = [{ id: 'A-1', evidence: 'E-1' }];
  await s.run(task.id, [echo('hi'), done(items), done(items), done(items), done(items)]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.deepEqual(texts.map(m => m.isError), [true, true, true, true]);
  for (const text of texts) assert.match(text.text, /does not match the fixed version 1/u);
  assert.notEqual(s.app.tasks.get(task.id)!.status, 'done');
  assert.deepEqual(s.states(p.id), { 'A-1': 'open', 'A-2': 'open' });
  assert.deepEqual(s.runs(p.root), [], '項目のコマンドは動かさない');
  assert.equal(s.events(task.id, 'gate_list_changed').length, 4);
  assert.equal(s.events(task.id, 'gate_refused').length + s.events(task.id, 'gate_closed').length, 0);
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n, 0, '質問票は使わない');
  const notes = s.app.db.prepare("SELECT kind, title, body, link FROM notifications WHERE dedup_key = ?").all(`gate-list:${task.id}`) as Array<{ kind: string; title: string; body: string; link: string }>;
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0]!.kind, notes[0]!.title, notes[0]!.link], ['health_alert', 'acceptance.json was changed outside beat', `#/tasks/${task.id}`]);
  assert.match(notes[0]!.body, /While "Build: shop" was working/u);
  assert.equal(s.events(task.id, 'gate_list_notified').length, 1);
});

test('5-3b 一覧のファイルの断りは、項目のコマンドの失敗の続きを切らない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command(FAIL) }]);
  const task = s.task(p.id, ['A-1']);
  let kept = '';
  const tamper = () => {
    kept = readFileSync(s.file(p.id), 'utf8');
    const doc = JSON.parse(kept) as AcceptanceDoc;
    doc.items[0]!.result = 'x';
    writeFileSync(s.file(p.id), JSON.stringify(doc));
  };
  await s.run(task.id, [done(), done(undefined, tamper), done(undefined, () => writeFileSync(s.file(p.id), kept)), done()]);
  assert.equal(s.events(task.id, 'gate_list_changed').length, 1);
  assert.equal(s.events(task.id, 'item_check_failed').length, 3);
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
});

test('5-3b 項目のコマンドの途中で実行を止めると、失敗にも断りにも数えず、何も書かない', { timeout: 30_000 }, async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command('node hold.js') }]);
  writeFileSync(join(p.root, 'hold.js'), "require('fs').writeFileSync('started', ''); setTimeout(() => process.exit(1), 5000);");
  const task = s.task(p.id, ['A-1']);
  s.adapter().scripts.push(done());
  s.app.worker.requestRun(task.id);
  const ticking = s.app.worker.tick();
  await until(() => existsSync(join(p.root, 'started')), 'item command started');
  const runId = s.app.worker.status().runningAll[0]!.runId;
  assert.equal(s.app.engine.stop(runId), true);
  assert.equal(await ticking, 'ran');
  assert.equal(s.events(task.id, 'item_check_failed').length, 0);
  assert.equal(s.events(task.id, 'gate_refused').length, 0);
  assert.equal(s.app.tasks.gateStreak(task.id).itemFailed, 0);
  assert.deepEqual(s.states(p.id), { 'A-1': 'open' });
  assert.deepEqual(s.evidence(p.id, 'A-1'), []);
  assert.ok(!['done', 'failed'].includes(s.app.tasks.get(task.id)!.status));
});

test('5-3b 失敗の出力の末尾は、見えない文字を消してから鍵を伏せる', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command('node hidden.js') }]);
  writeFileSync(join(p.root, 'hidden.js'), "console.error('token sk-' + '\\u200B' + 'ant-' + 'D'.repeat(30)); process.exit(1);");
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done()]);
  const result = lastText(s.toolTexts(task.id), 'task_complete').text;
  const stored = [JSON.stringify(s.app.acceptance.itemStates(p.id)), readFileSync(s.file(p.id), 'utf8'), JSON.stringify(s.app.tasks.events(task.id)), result];
  for (const text of stored) assert.doesNotMatch(text, /D{20}/u);
  assert.match(JSON.stringify(s.app.acceptance.itemStates(p.id)), /token/u);
});

test('5-3b 外を読んだあとに書かれた一覧では、作業の約束に項目の文を入れず番号と確かめ方だけ（mesh_read で読む）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Lists files SECRETWORD', check: command(PASS) }, { result: 'Looks right', check: look }], null, ['run-x']);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [reply('thinking')]);
  const first = JSON.stringify(s.adapter().calls[0]!.messages);
  assert.match(first, /- A-1 \(check: command\)/u);
  assert.match(first, /- A-2 \(check: look\)/u);
  assert.match(first, /Read them with mesh_read/u);
  assert.doesNotMatch(first, /SECRETWORD|Looks right|node pass\.js|No login screen/u);
});

test('5-3b 作業の約束の大きさには上限があり、出さなかった行の数を言う', async t => {
  const s = await setup(t);
  const items = Array.from({ length: 50 }, (_, i) => ({ result: `Item ${i + 1} ${'x'.repeat(400)}`, check: look }));
  const p = s.product('shop', items);
  const task = s.task(p.id, items.map((_, i) => `A-${i + 1}`));
  await s.run(task.id, [reply('thinking')]);
  const first = JSON.stringify(s.adapter().calls[0]!.messages);
  const start = first.indexOf('# Work agreement');
  const end = first.indexOf('more lines are not shown', start);
  assert.ok(start >= 0 && end > start);
  const agreement = first.slice(start, end);
  assert.match(agreement, /- A-1: Item 1/u);
  assert.doesNotMatch(agreement, /- A-50: /u);
  assert.ok(agreement.length < 6000 + 1000, String(agreement.length));
  const shown = (agreement.match(/\\n- A-\d+: /gu) ?? []).length + (agreement.match(/\\nNot doing: /gu) ?? []).length;
  assert.equal(Number(/(\d+) $/u.exec(agreement)![1]), 51 - shown);
});

test('5-3b Pending で止まった command の項目を「まだ足りない」にした直しのタスクは、そのコマンドを動かし直す', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Uploads the report', check: command(SEND) }]);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done()]);
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
  const short = await api(`/api/tasks/${task.id}/items/A-1/check`, 'POST', { result: 'insufficient', version: 1 });
  const fix = short.body.fix.id as string;
  await s.run(fix, [done()]);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind = 'send'").get() as { n: number }).n, 2);
  assert.equal(s.app.acceptance.itemStates(p.id)['A-1']!.taskId, fix);
});

test('5-3b 「まだ足りない」の直しのタスクと子のタスクは、開いた Build とみなさない', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }]);
  const build = s.task(p.id, ['A-1', 'A-2']);
  s.clock.now += 1000;
  const child = s.app.tasks.create({ title: 'child', origin: 'user', actor: 'user', projectId: p.id, acceptanceItems: ['A-2'], spawnedBy: build.id });
  assert.equal(s.app.tasks.openBuild(p.id), build.id, '子ではなく根の Build');
  s.app.tasks.finish(child.id, 'cancelled', null, 'user');
  await s.run(build.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', evidence: 'E-1' }])]);
  assert.equal(s.app.tasks.hasOpenBuild(p.id), false);
  const short = await api(`/api/tasks/${build.id}/items/A-1/check`, 'POST', { result: 'insufficient', version: 1 });
  assert.equal(short.status, 200, JSON.stringify(short.body));
  assert.equal(s.app.tasks.get(short.body.fix.id)!.status, 'ready');
  assert.equal(s.app.tasks.hasOpenBuild(p.id), false);
  assert.equal(s.app.tasks.openBuild(p.id), null);
});

test('5-3b 「まだ足りない」は開いた直しのタスクだけを使い回し、持ち主の言葉はそのタスクに届く。Build や子は使い回さない', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Reads well', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }, { id: 'A-2', evidence: 'E-1' }])]);
  const lookalike = s.app.tasks.create({ title: 'Build again', origin: 'user', actor: 'user', projectId: p.id, acceptanceItems: ['A-2'] });
  const first = await api(`/api/tasks/${task.id}/items/A-2/check`, 'POST', { result: 'insufficient', version: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.notEqual(first.body.fix.id, lookalike.id);
  const again = await api(`/api/tasks/${task.id}/items/A-2/check`, 'POST', { result: 'insufficient', version: 1, note: 'also check the footer' });
  assert.equal(again.body.fix.id, first.body.fix.id);
  assert.match(s.app.tasks.get(first.body.fix.id)!.body, /also check the footer/u);
});

test('R13 答えで開き直した項目は直しのタスクが受け持ち、その門でコマンドを動かし直す。もとのタスクの確かめ待ちには出ず、受け入れの口とも食い違わない', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Says hello', check: command(PASS) }, { result: 'Saves files', check: command(PASS) }, { result: 'The page looks right', check: look }]);
  const build = s.task(p.id, ['A-1', 'A-2', 'A-3']);
  await s.run(build.id, [echo('page'), done([{ id: 'A-3', evidence: 'E-1' }])]);
  assert.deepEqual(s.states(p.id), { 'A-1': 'met', 'A-2': 'met', 'A-3': 'unverified' });
  assert.deepEqual(s.runs(p.root), ['pass', 'pass']);
  s.clock.now += 1000;
  const question = s.app.questions.add({ projectId: p.id, taskId: build.id, question: 'Say hello or hi?', options: ['hello', 'hi'], chosen: 0, acceptanceItem: 'A-1' });
  s.clock.now += 1000;
  const answered = await api(`/api/questions/${question.id}/answer`, 'POST', { choice: 1 });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.reopenedItem, 'A-1');
  const fixId = answered.body.fixTaskId as string;
  assert.equal(s.app.tasks.get(fixId)!.acceptance_items, '["A-1"]');
  assert.equal(s.app.tasks.openBuild(p.id), null, '直しのタスクは開いた Build ではない');
  const listed = await api(`/api/tasks?projectId=${p.id}`, 'GET');
  const original = (listed.body.awaiting as Array<{ id: string; items: { remaining: string[] } }>).find(entry => entry.id === build.id)!;
  assert.deepEqual(original.items.remaining, ['A-3'], '開き直した項目はもとのタスクの確かめ待ちに出ない');
  assert.equal((await api(`/api/tasks/${build.id}/items/A-1/check`, 'POST', { result: 'checked', version: 2 })).status, 409, 'もとのタスクで持ち主が met にはできない');
  const accepted = await api(`/api/projects/${p.id}/acceptance`, 'GET');
  assert.deepEqual(accepted.body.acceptance.unbuilt, [], '直しのタスクが受け持つので Build を待つ項目ではない');
  assert.equal(s.states(p.id)['A-1'], 'open');
  await s.run(fixId, [done()]);
  assert.deepEqual(s.runs(p.root), ['pass', 'pass', 'pass'], '門がコマンドを動かし直す');
  assert.equal(s.app.tasks.get(fixId)!.status, 'done');
  const reran = s.app.acceptance.itemStates(p.id)['A-1']!;
  assert.deepEqual([reran.state, reran.by, reran.taskId], ['met', 'gate', fixId]);
  assert.equal(s.app.tasks.get(build.id)!.check_state, 'awaiting');
});

test('R13 確かめ待ちの項目が答えで開き直されて直しのタスクに移り、もとのタスクに残りが無くなると checked。残りの項目を受け持つほうはそのまま', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const build = s.task(p.id, ['A-1']);
  await s.run(build.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  assert.equal(s.app.tasks.get(build.id)!.check_state, 'awaiting');
  s.clock.now += 1000;
  const question = s.app.questions.add({ projectId: p.id, taskId: build.id, question: 'Blue or red page?', options: ['blue', 'red'], chosen: 0, acceptanceItem: 'A-1' });
  s.clock.now += 1000;
  const answered = await api(`/api/questions/${question.id}/answer`, 'POST', { choice: 1 });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(s.app.tasks.get(build.id)!.check_state, 'checked');
  assert.deepEqual(s.app.tasks.events(answered.body.fixTaskId).filter(e => e.kind === 'owner_fix').map(e => JSON.parse(e.content!)), [{ question: question.id, item: 'A-1' }]);
  await s.run(answered.body.fixTaskId, [done(), echo('red page'), done([{ id: 'A-1', evidence: 'E-2' }])]);
  const texts = s.toolTexts(answered.body.fixTaskId).filter(m => m.text.startsWith('[task_complete]'));
  assert.match(texts[0]!.text, /Items with neither evidence nor a reason: A-1/u, '前の札では通らない');
  assert.equal(texts[1]!.isError, false, texts[1]!.text);
  const fix = (await api(`/api/tasks?projectId=${p.id}`, 'GET')).body.awaiting as Array<{ id: string; items: { remaining: string[] } }>;
  assert.deepEqual(fix.map(entry => [entry.id, entry.items.remaining]), [[answered.body.fixTaskId, ['A-1']]]);
});

for (const path of ['edit', 'approve'] as const) {
  test(`R13 確かめ待ちの最後の項目を持ち主が一覧で変えると（${path}）、もとのタスクは checked になり、task.changed が出る`, async t => {
    const s = await setup(t);
    const api = await s.serve();
    const p = s.product('shop', [{ result: 'Has a page', check: look }, { result: 'Tests pass', check: command(PASS) }]);
    const build = s.task(p.id, ['A-1', 'A-2']);
    await s.run(build.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
    assert.equal(s.app.tasks.get(build.id)!.check_state, 'awaiting');
    s.clock.now += 1000;
    const changed: string[] = [];
    s.app.bus.subscribe(e => { if (e.event.type === 'task.changed' && e.event.task.id === build.id) changed.push(e.event.task.check_state ?? ''); });
    const item = { result: 'Has a blue page', check: { kind: 'look' } };
    const res = path === 'edit'
      ? await api(`/api/projects/${p.id}/acceptance/edit`, 'POST', { baseVersion: 1, ops: [{ op: 'change', id: 'A-1', item }] })
      : await api(`/api/projects/${p.id}/acceptance/changes/${s.app.acceptance.propose(p.id, [{ op: 'change', id: 'A-1', item: item as never, source: { kind: 'owner_edit' } }], { language: null, conversationId: null, tainted: false }).id}/approve`, 'POST', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(s.app.tasks.get(build.id)!.check_state, 'checked');
    assert.deepEqual(changed, ['checked']);
  });
}

test('R13 断りの文の例は、足りない項目の番号と、本物と取り違えない札の形を使う', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: command(PASS) }, { result: 'Reads well', check: read }]);
  const task = s.task(p.id, ['A-1', 'A-2']);
  await s.run(task.id, [echo('one'), echo('two'), echo('three'), done(), done([{ id: 'A-2', evidence: 'E-3' }])]);
  const refusal = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'))[0]!;
  assert.equal(refusal.isError, true);
  assert.match(refusal.text, /\[\{"id": "A-2", "evidence": "E-<n>"\}\]/u);
  assert.match(refusal.text, /\[\{"id": "A-2", "not_done": "why"\}\]/u);
  assert.doesNotMatch(refusal.text, /"A-1"|"E-3"/u);
});

test('5-3b 札は道具 task_* の呼び出しと、項目が最後に変わる前の呼び出しでは通らない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const listed = s.task(p.id, ['A-1'], 'Build listed');
  await s.run(listed.id, [toolCall('task_list', {}), done([{ id: 'A-1', evidence: 'E-1' }])]);
  assert.match(lastText(s.toolTexts(listed.id), 'task_complete').text, /E-1 is not accepted \(there is no such tag/u);
  s.app.tasks.finish(listed.id, 'cancelled', null, 'user');
  const task = s.task(p.id, ['A-1'], 'Build old');
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }], () => {
    s.clock.now = Date.now() + 1000;
    s.app.acceptance.applyOwnerDecision(p.id, [{ op: 'change', id: 'A-1', item: { result: 'Has a better page', check: look }, source: { kind: 'owner_edit' } }], 'question');
  })]);
  assert.match(lastText(s.toolTexts(task.id), 'task_complete').text, /E-1 is not accepted \(that call was made before this item last changed\)/u);
  assert.deepEqual(s.states(p.id), { 'A-1': 'open' });
});

test('T-1 tool_search の行に札があっても、門は証拠にしない（読み込んだだけで製品は何も確かめていない）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1'], 'Build searched');
  const plant = () => {
    const cid = s.app.tasks.get(task.id)!.conversation_id!;
    s.app.db.prepare("UPDATE tool_calls SET evidence_no = 99 WHERE conversation_id = ? AND tool = 'tool_search'").run(cid);
  };
  await s.run(task.id, [toolCall('tool_search', { query: 'task_list' }), done([{ id: 'A-1', evidence: 'E-99' }], plant)]);
  assert.match(lastText(s.toolTexts(task.id), 'task_complete').text, /E-99 is not accepted \(there is no such tag/u);
  assert.deepEqual(s.states(p.id), { 'A-1': 'open' });
});

test('5-3b 一覧の書き換えを知らせられなくても門は断るだけで落ちず、知らせは次の断りでやり直す', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const hacked = JSON.parse(readFileSync(s.file(p.id), 'utf8')) as AcceptanceDoc;
  hacked.items[0]!.result = 'Anything goes';
  writeFileSync(s.file(p.id), JSON.stringify(hacked));
  const task = s.task(p.id, ['A-1']);
  const real = s.app.notifications.notify.bind(s.app.notifications);
  s.app.notifications.notify = () => { throw new Error('notify broke'); };
  await s.run(task.id, [done(), done(undefined, () => { s.app.notifications.notify = real; })]);
  const texts = s.toolTexts(task.id).filter(m => m.text.startsWith('[task_complete]'));
  assert.equal(texts.length, 2);
  for (const text of texts) assert.match(text.text, /does not match the fixed version 1/u);
  assert.equal(s.events(task.id, 'gate_list_notified').length, 1);
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE dedup_key = ?').get(`gate-list:${task.id}`) as { n: number }).n, 1);
});

test('5-3b 外を読んだあとに書かれた一覧では、断りの文にも項目のコマンドを出さない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Tests pass', check: command(FAIL) }], null, ['run-x']);
  const task = s.task(p.id, ['A-1']);
  await s.run(task.id, [done()]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(text.isError, true);
  assert.match(text.text, /A-1: its command failed/u);
  assert.match(text.text, /Command: \(not shown; read it in acceptance\.json with mesh_read\)/u);
  assert.doesNotMatch(text.text, /node fail\.js/u);
});

test('5-3b 止めたときも、同じ呼び出しで先に動かし終えた項目の結果は残る（Pending に二重に積まない）', { timeout: 30_000 }, async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Uploads the report', check: command(SEND) }, { result: 'Tests pass', check: command('node hold.js') }]);
  writeFileSync(join(p.root, 'hold.js'), "require('fs').writeFileSync('started', ''); setTimeout(() => process.exit(1), 5000);");
  const task = s.task(p.id, ['A-1', 'A-2']);
  s.adapter().scripts.push(done());
  s.app.worker.requestRun(task.id);
  const ticking = s.app.worker.tick();
  await until(() => existsSync(join(p.root, 'started')), 'item command started');
  assert.equal(s.app.engine.stop(s.app.worker.status().runningAll[0]!.runId), true);
  assert.equal(await ticking, 'ran');
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified', 'A-2': 'open' });
  assert.equal(s.app.acceptance.itemStates(p.id)['A-1']!.taskId, task.id);
  assert.equal(s.events(task.id, 'item_check_failed').length + s.events(task.id, 'gate_refused').length, 0);
  if (s.app.tasks.get(task.id)!.status !== 'ready') s.app.tasks.reopen(task.id, 'user', 'again');
  await s.run(task.id, [done(undefined, () => writeFileSync(join(p.root, 'hold.js'), 'process.exit(0);'))]);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind = 'send'").get() as { n: number }).n, 1);
});

test('5-3b この呼び出しで札をもらった項目は、受け持ちの確かめで「どのタスクも受け持たない」と言われない', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  s.clock.now += 1000;
  s.app.acceptance.applyOwnerDecision(p.id, [{ op: 'change', id: 'A-1', item: { result: 'Has a better page', check: look }, source: { kind: 'owner_edit' } }], 'question');
  await s.run(task.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(text.isError, false, text.text);
  assert.deepEqual(s.states(p.id), { 'A-1': 'unverified' });
  assert.equal(s.app.tasks.get(task.id)!.check_state, 'awaiting');
});

test('5-3c-u GET /api/tasks の awaiting: 終わったタスクの新しい 50 件より古い確かめ待ちも、項目の数つきで返る。製品で絞れ、active の意味は変えない', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const q = s.product('notes', [{ result: 'Notes are saved', check: look }]);
  const old = s.task(p.id, ['A-1']);
  await s.run(old.id, [echo('page'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const elsewhere = s.task(q.id, ['A-1'], 'Build: notes');
  await s.run(elsewhere.id, [echo('notes'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  assert.equal(s.app.tasks.get(old.id)!.check_state, 'awaiting');
  const finish = s.app.db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?");
  for (let i = 0; i < 55; i++) {
    const row = s.app.tasks.create({ title: `later ${i}`, origin: 'user', actor: 'user', projectId: p.id });
    finish.run(s.clock.now + 60_000 + i, s.clock.now + 60_000 + i, row.id);
  }
  const all = await api('/api/tasks', 'GET');
  assert.equal(all.status, 200);
  assert.equal((all.body.finished as Array<{ id: string }>).some(row => row.id === old.id), false, '新しい 50 件には入らない');
  assert.equal((all.body.active as Array<{ id: string }>).some(row => row.id === old.id), false, 'active には入れない');
  const rows = all.body.awaiting as Array<{ id: string; check_state: string; items: unknown }>;
  assert.deepEqual(rows.map(row => row.id).sort(), [old.id, elsewhere.id].sort());
  assert.deepEqual(rows.find(row => row.id === old.id)!.items, { owned: 1, met: 0, remaining: ['A-1'] });
  const mine = await api(`/api/tasks?project=${p.id}`, 'GET');
  assert.deepEqual((mine.body.awaiting as Array<{ id: string }>).map(row => row.id), [old.id], '製品で絞る');
  assert.deepEqual((await api('/api/tasks?project=none', 'GET')).body.awaiting, []);
  await api(`/api/tasks/${old.id}/check`, 'POST', { version: 1 });
  assert.deepEqual(((await api(`/api/tasks?project=${p.id}`, 'GET')).body.awaiting as unknown[]), [], '確かめが済めば外れる');
});

test('5-3c-u GET /api/tasks の awaiting: しまった製品の確かめ待ちは返さない（持ち主が片づけられないので）。多くても 200 件まで', async t => {
  const s = await setup(t);
  const api = await s.serve();
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const q = s.product('notes', [{ result: 'Notes are saved', check: look }]);
  const shelved = s.task(q.id, ['A-1'], 'Build: notes');
  await s.run(shelved.id, [echo('notes'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  assert.equal(s.app.tasks.get(shelved.id)!.check_state, 'awaiting');
  assert.deepEqual((await api('/api/tasks', 'GET')).body.awaiting.map((row: { id: string }) => row.id), [shelved.id]);
  s.app.projects.update(q.id, { archived: true });
  assert.deepEqual((await api('/api/tasks', 'GET')).body.awaiting, [], 'しまった製品のものは出さない');
  const mark = s.app.db.prepare("UPDATE tasks SET status = 'done', check_state = 'awaiting', completed_at = ?, updated_at = ? WHERE id = ?");
  for (let i = 0; i < 205; i++) {
    const row = s.app.tasks.create({ title: `old ${i}`, origin: 'user', actor: 'user', projectId: p.id });
    mark.run(s.clock.now + i, s.clock.now + i, row.id);
  }
  assert.equal(((await api('/api/tasks', 'GET')).body.awaiting as unknown[]).length, 200, 'active と同じく 200 件まで');
});
