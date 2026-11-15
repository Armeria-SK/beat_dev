import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { createWebServer } from '../src/web/server.ts';
import { JudgeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

function toolCall(name: string, args: unknown, before?: () => void): Script {
  return async function* () {
    before?.();
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
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
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-15T09:00:00Z') };
  let adapter!: JudgeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const product = (name: string, items: Array<{ result: string; check: AcceptanceCheck }>, checkCommand: string | null = null) => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pass.js'), "require('fs').appendFileSync('runs.log', 'pass\\n'); console.log('all good');");
    writeFileSync(join(root, 'fail.js'), "require('fs').appendFileSync('runs.log', 'fail\\n'); console.log('2 tests failed'); console.error('token sk-' + 'ant-' + 'B'.repeat(30)); process.exit(1);");
    const row = app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand });
    mkdirSync(join(paths.projects, row.id), { recursive: true });
    const doc: AcceptanceDoc = {
      schema: 1, version: 1, language: null, taintedRuns: [],
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
    return app.conversations.messages(cid).filter(m => m.role === 'tool').map(m => ({ text: m.text, isError: (m.message as { isError?: boolean }).isError === true }));
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

test('5-3b 受け持ちの無い項目があると親が完了にならない（Build のあとで足された項目）', async t => {
  const s = await setup(t);
  const p = s.product('shop', [{ result: 'Has a page', check: look }]);
  const task = s.task(p.id, ['A-1']);
  s.clock.now += 1000;
  s.app.acceptance.applyOwnerDecision(p.id, [{ op: 'add', item: { result: 'New thing', check: look }, source: { kind: 'owner_edit' } }], 'question');
  await s.run(task.id, [echo('hi'), done([{ id: 'A-1', evidence: 'E-1' }])]);
  const text = lastText(s.toolTexts(task.id), 'task_complete');
  assert.equal(text.isError, true);
  assert.match(text.text, /Items no task covers: A-2/u);
  assert.notEqual(s.app.tasks.get(task.id)!.status, 'done');
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
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, parent.id, '親が選ばれる');
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

