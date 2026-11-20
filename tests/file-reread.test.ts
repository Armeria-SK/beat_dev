import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { toolText } from '../src/shared/messages/tools.ts';
import { fileEdit, fileRead, fileReadLog, fileWrite } from '../src/tools/builtin/files.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { notSearch, reply, type Script, tempDir, testConfig, withLoad } from './helpers.ts';

// TE-6 (b): file_edit・上書きの file_write は、この会話で読んで（または書いて）いないファイル、読んだあと中身が変わったファイルを断る。
// (a) 読み直しの短い返事は、入れる条件（読み直しの量が道具の結果の 3% 以上）を満たさなかったので入れていない（deviations.md の TE-6）

type Started = Awaited<ReturnType<typeof startApp>>;

const call = (name: string, args: unknown, before?: () => void, id = `call_${Math.random().toString(36).slice(2)}`): Script => async function* (req) {
  before?.();
  const toolCall: ToolCall = { id, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function chat(s: Started, id: string, text: string): Promise<string> {
  if (!s.app.conversations.get(id)) s.app.conversations.create({ id, title: 'te-6' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  return sent.body.runId as string;
}

const results = (s: Started, conversationId: string) => s.app.conversations.messages(conversationId).filter(notSearch).map(m => m.message)
  .flatMap(m => (m.role === 'tool' ? [{ name: m.name, content: m.content, isError: m.isError === true }] : []));

const NOT_READ = (path: string) => toolText('en', 'file.not_read', { path });
const CHANGED = (path: string) => toolText('en', 'file.changed_since_read', { path });
const NOT_READ_WRITE = (path: string) => toolText('en', 'file.not_read_write', { path });
const UNSEEN_EDIT = (path: string) => toolText('en', 'file.unseen_edit', { path });
const refused = (content: string, message: string) => assert.ok(content.includes(message), content);

test('TE-6 読まずに file_edit すると断り、ファイルは変わらない（読み直してと返す）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  s.adapter().scripts = [call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }), reply('done')];
  await chat(s, uuid(1), 'edit');
  const [edit] = results(s, uuid(1));
  assert.equal(edit!.isError, true);
  refused(edit!.content, NOT_READ('a.txt'));
  assert.match(edit!.content, /file_read/u);
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n');
});

test('TE-6 読んでから file_edit すると通り、続けてもう一度 file_edit しても通る（自分で書いた中身を覚える）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  s.adapter().scripts = [
    call('file_read', { path: 'a.txt' }),
    call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }),
    call('file_edit', { path: 'a.txt', old: 'two', new: 'TWO' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'edit');
  assert.deepEqual(results(s, uuid(1)).map(r => r.isError), [false, false, false]);
  assert.equal(readFileSync(file, 'utf8'), 'ONE\nTWO\n');
});

test('TE-6 一部だけ読んだ（offset・limit）ファイルも読んだに数える', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  s.adapter().scripts = [call('file_read', { path: 'a.txt', offset: 3, limit: 1 }), call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }), reply('done')];
  await chat(s, uuid(1), 'edit');
  assert.deepEqual(results(s, uuid(1)).map(r => r.isError), [false, false]);
  assert.equal(readFileSync(file, 'utf8'), 'ONE\ntwo\nthree\n');
});

test('TE-6 読んだあとにほかの手（コマンド・持ち主）で中身が変わったら、file_edit も上書きの file_write も断る。読み直せば通る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  s.adapter().scripts = [
    call('file_read', { path: 'a.txt' }),
    call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }, () => writeFileSync(file, 'one\nchanged outside\n')),
    call('file_write', { path: 'a.txt', content: 'overwritten' }),
    call('file_read', { path: 'a.txt' }),
    call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'edit');
  const r = results(s, uuid(1));
  assert.deepEqual(r.map(x => x.isError), [false, true, true, false, false]);
  refused(r[1]!.content, CHANGED('a.txt'));
  refused(r[2]!.content, CHANGED('a.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'ONE\nchanged outside\n');
});

test('TE-6 読んだあと shell で書き換えたファイルの file_edit は断る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], judge: '{"decision":"allow","reason":"as asked"}' });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  writeFileSync(join(s.paths.workspace, 'grow.js'), "require('node:fs').appendFileSync('a.txt', 'two\\n');\n");
  s.adapter().scripts = [
    call('file_read', { path: 'a.txt' }),
    call('shell_run', { command: 'node grow.js' }),
    call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'edit');
  const r = results(s, uuid(1));
  assert.equal(r[1]!.isError, false, `shell_run ran: ${r[1]!.content}`);
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n', `前提: shell が書き換えた: ${r[1]!.content}`);
  assert.equal(r[2]!.isError, true);
  refused(r[2]!.content, CHANGED('a.txt'));
});

test('TE-6 新しいファイルの file_write は読まずに通り、作った直後の file_edit も通る。追記（append）は今までどおり読まずに通る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const log = join(s.paths.workspace, 'log.txt');
  writeFileSync(log, 'first\n');
  s.adapter().scripts = [
    call('file_write', { path: 'new.txt', content: 'hello' }),
    call('file_edit', { path: 'new.txt', old: 'hello', new: 'bye' }),
    call('file_write', { path: 'new.txt', content: 'again' }),
    call('file_write', { path: 'log.txt', content: 'second\n', mode: 'append' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'write');
  assert.deepEqual(results(s, uuid(1)).map(r => r.isError), [false, false, false, false]);
  assert.equal(readFileSync(join(s.paths.workspace, 'new.txt'), 'utf8'), 'again');
  assert.equal(readFileSync(log, 'utf8'), 'first\nsecond\n');
});

test('TE-6 Windows では大文字小文字だけ違うパスで読んだファイルも読んだに数える', { skip: process.platform !== 'win32' }, async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'Notes.txt');
  writeFileSync(file, 'one\n');
  s.adapter().scripts = [call('file_read', { path: 'NOTES.TXT' }), call('file_edit', { path: 'notes.txt', old: 'one', new: 'ONE' }), reply('done')];
  await chat(s, uuid(1), 'edit');
  assert.deepEqual(results(s, uuid(1)).map(r => r.isError), [false, false]);
  assert.equal(readFileSync(file, 'utf8'), 'ONE\n');
});

test('TE-6 読まずに上書きの file_write（mode を書かない・overwrite）は断り、ファイルは変わらない', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'keep');
  s.adapter().scripts = [call('file_write', { path: 'a.txt', content: 'x' }), call('file_write', { path: 'a.txt', content: 'y', mode: 'overwrite' }), reply('done')];
  await chat(s, uuid(1), 'write');
  const r = results(s, uuid(1));
  for (const x of r) refused(x.content, NOT_READ_WRITE('a.txt'));
  assert.equal(r.length, 2);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
});

test('TE-6 読んだ記録は会話に残り、次の実行でも使える。ほかの会話の記録は使えない', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  s.adapter().scripts = [call('file_read', { path: 'a.txt' }), reply('read')];
  await chat(s, uuid(1), 'read');
  s.adapter().scripts = [call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }), reply('other')];
  await chat(s, uuid(2), 'edit elsewhere');
  refused(results(s, uuid(2))[0]!.content, NOT_READ('a.txt'));
  s.adapter().scripts = [call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }), reply('same')];
  await chat(s, uuid(1), 'edit');
  assert.equal(results(s, uuid(1)).at(-1)!.isError, false);
  assert.equal(readFileSync(file, 'utf8'), 'ONE\n');
});

test('TE-6 子の担当は自分の会話の記録だけを使う（親が読んだファイルでも、子は読まずに編集できない）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  s.adapter().scripts = [
    call('file_read', { path: 'a.txt' }),
    call('agent_run', { task: 'edit a.txt' }),
    call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }),
    reply('child could not edit'),
    reply('parent done'),
  ];
  await chat(s, uuid(1), 'delegate');
  const child = s.app.conversations.db.prepare("SELECT conversation_id FROM engine_runs WHERE kind = 'agent'").get() as { conversation_id: string };
  const edit = results(s, child.conversation_id).find(r => r.name === 'file_edit')!;
  refused(edit.content, NOT_READ('a.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'one\n');
});

test('TE-6 記録は会話ごとに新しい 200 件まで（古いものから落ちる）', t => {
  const db = startDb(t);
  const log = fileReadLog(new KV(db), 'c1');
  for (let i = 0; i < 201; i++) log.set(`/f${i}`, `h${i}`);
  assert.equal(log.get('/f0'), undefined);
  assert.equal(log.get('/f1'), 'h1');
  assert.equal(log.get('/f200'), 'h200');
  log.set('/f1', 'again');
  log.set('/new', 'n');
  assert.equal(log.get('/f1'), 'again', '書き直した記録は新しい方へ移り、落ちない');
  assert.equal(log.get('/f2'), undefined);
  assert.equal(fileReadLog(new KV(db), 'c2').get('/f1'), undefined);
});

test('TE-6 道具は、いまモデルへ送っている発言にある結果の呼び出しの id を見られる（結果の無い呼び出しの id は入らない）', async t => {
  const seen: string[][] = [];
  const probe: ToolDef = { name: 'probe_sent', description: 'probe', input: Type.Object({}), effect: 'read', allowedIn: ['chat'], async execute(_input, ctx) { seen.push([...(ctx.sentCalls?.() ?? [])]); return { content: 'ok' }; } };
  const s = await startApp(t, { models: [fakeModel('m1')] });
  s.app.tools.register(probe);
  s.app.conversations.create({ id: uuid(1), title: 'te-6' });
  s.app.conversations.append(uuid(1), { role: 'user', content: 'earlier' });
  s.app.conversations.append(uuid(1), { role: 'tool', toolCallId: 'orphan', name: 'file_read', content: 'a result with no call before it' });
  s.app.conversations.append(uuid(1), { role: 'assistant', content: '', toolCalls: [{ id: 'dangling', name: 'file_read', arguments: { path: 'a.txt' } }] });
  s.adapter().scripts = [call('probe_sent', {}, undefined, 'first'), call('probe_sent', {}, undefined, 'second'), reply('done')];
  await chat(s, uuid(1), 'probe');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.includes('dangling'), false, '結果の無い呼び出しに足した「動かしていない」は、送った結果に数えない');
  assert.equal(seen[0]!.includes('orphan'), false, '呼び出しの無い結果（送る前に外す）は数えない');
  assert.equal(seen[0]!.includes('first'), false, '自分の結果はまだ送っていない');
  assert.equal(seen[1]!.includes('first'), true, '前の呼び出しの結果は、次の呼び出しで送っている');
  assert.equal(seen[1]!.includes('second'), false);
});

test('TE-6 読んだあと持ち主が変えたファイルに追記しても、読んだ記録は追記のあとの中身にならない（上書きは断られ、持ち主の行が残る）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  s.adapter().scripts = [
    call('file_read', { path: 'a.txt' }),
    call('file_write', { path: 'a.txt', content: 'x\n', mode: 'append' }, () => writeFileSync(file, 'one\nowner\n')),
    call('file_write', { path: 'a.txt', content: 'mine' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'append');
  const r = results(s, uuid(1));
  assert.equal(r[1]!.isError, false, r[1]!.content);
  refused(r[2]!.content, CHANGED('a.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'one\nowner\nx\n');
});

test('TE-6 読んでいないファイルに空の追記をしても、上書きは読んでいないとして断る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'a.txt');
  writeFileSync(file, 'keep\n');
  s.adapter().scripts = [call('file_write', { path: 'a.txt', content: '', mode: 'append' }), call('file_write', { path: 'a.txt', content: 'mine' }), reply('done')];
  await chat(s, uuid(1), 'append');
  const r = results(s, uuid(1));
  assert.equal(r[0]!.isError, false, r[0]!.content);
  refused(r[1]!.content, NOT_READ_WRITE('a.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'keep\n');
});

test('TE-6 読んでいない SOUL.md の上書きは、持ち主に聞く前に断る（Pending の札を作らない）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  writeFileSync(join(s.paths.workspace, 'SOUL.md'), '# SOUL\nname: beat\n');
  s.adapter().scripts = [call('file_write', { path: 'SOUL.md', content: '# SOUL\nchanged\n' }), reply('done')];
  await chat(s, uuid(1), 'change the soul');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0, 'Pending に積まない');
  refused(results(s, uuid(1))[0]!.content, NOT_READ_WRITE('SOUL.md'));
  assert.match(results(s, uuid(1))[0]!.content, /file_read/u);
  assert.equal(readFileSync(join(s.paths.workspace, 'SOUL.md'), 'utf8'), '# SOUL\nname: beat\n');
});

test('TE-6 file_read が見せられないファイル（UTF-16LE）: 読む前は断り、file_read が binary と答えたあとは丸ごとの上書きだけ通る（file_edit は断る）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const file = join(s.paths.workspace, 'out.txt');
  writeFileSync(file, Buffer.from('﻿hello\r\n', 'utf16le'));
  s.adapter().scripts = [
    call('file_write', { path: 'out.txt', content: 'first' }),
    call('file_read', { path: 'out.txt' }),
    call('file_edit', { path: 'out.txt', old: 'h', new: 'H' }),
    call('file_write', { path: 'out.txt', content: 'hello\n' }),
    call('file_edit', { path: 'out.txt', old: 'hello', new: 'bye' }),
    reply('done'),
  ];
  await chat(s, uuid(1), 'fix it');
  const r = results(s, uuid(1));
  refused(r[0]!.content, NOT_READ_WRITE('out.txt'));
  assert.match(r[0]!.content, /binary/u, '断りの文が、見せられないときの次の一手を書く');
  assert.equal(r[1]!.content, toolText('en', 'file.binary'));
  refused(r[2]!.content, UNSEEN_EDIT('out.txt'));
  assert.equal(r[3]!.isError, false, r[3]!.content);
  assert.equal(r[4]!.isError, false, '丸ごと書いたあとは、自分で書いた中身として編集できる');
  assert.equal(readFileSync(file, 'utf8'), 'bye\n');
});

test('TE-6 終わりより後ろの offset で何も返らなかった読みは、読んだに数えない', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'one\n');
  s.adapter().scripts = [call('file_read', { path: 'a.txt', offset: 10 }), call('file_edit', { path: 'a.txt', old: 'one', new: 'ONE' }), reply('done')];
  await chat(s, uuid(1), 'edit');
  refused(results(s, uuid(1))[1]!.content, NOT_READ('a.txt'));
});

function direct(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const policy = buildPolicy(config, paths);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, fileReads: fileReadLog(new KV(db), 'c1'),
  };
  const run = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined,
    lastUserRequest: () => 'please do the work', autoClassify: async () => '{"decision":"ask","reason":"not sure"}',
  });
  return { paths, db, ctx, run, pending, registry, config };
}

test('TE-6 確かめを通ったあと、書く直前までに中身が変われば file_edit は断る（実行のときにも見る）', async t => {
  const d = direct(t);
  const file = join(d.ctx.workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  await fileRead.execute({ path: 'a.txt' }, d.ctx);
  assert.equal((await fileEdit.preCheck!({ path: 'a.txt', old: 'one', new: 'ONE' }, d.ctx)).decision, 'allow');
  writeFileSync(file, 'one\nowner\n');
  const out = await fileEdit.execute({ path: 'a.txt', old: 'one', new: 'ONE' }, d.ctx);
  assert.equal(out.content, CHANGED('a.txt'));
  assert.equal(readFileSync(file, 'utf8'), 'one\nowner\n');
});

test('TE-6 Pending の再実行のあいだに会話が消えたら、その会話の読んだ記録の行を残さない', async t => {
  const d = direct(t);
  const soul = join(d.ctx.workspace, 'SOUL.md');
  writeFileSync(soul, '# SOUL\n');
  assert.equal((await d.run('file_read', { path: 'SOUL.md' })).output.isError, undefined);
  const parked = await d.run('file_write', { path: 'SOUL.md', content: '# SOUL\nnew\n' });
  assert.equal(parked.decidedBy, 'pending', parked.output.content);
  const [row] = d.pending.list({ status: 'waiting' });
  const outcome = await replayAction(d.pending.claim(row!.id), {
    db: d.db, store: d.pending, registry: d.registry, config: () => d.config, paths: d.paths,
    conversationExists: () => readFileSync(soul, 'utf8') === '# SOUL\n',
  });
  assert.equal(outcome.status, 'ran', outcome.output);
  assert.equal(readFileSync(soul, 'utf8'), '# SOUL\nnew\n');
  assert.equal(new KV(d.db).get('file-reads:c1'), undefined);
});

function startDb(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  t.after(() => db.close());
  return db;
}
