import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { INSTRUCTIONS_DEFAULT_TOKENS, instructionsBudget, instructionsSection, readInstructions } from '../src/projects/instructions.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

const model = (id: string, contextLength: number): ModelConfig => ({ id, provider: 'fake', model: id, contextLength, minContext: 4096, maxOutputTokens: 1024, vision: false });

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const dir = tempDir(t);
  const paths = resolvePaths(join(dir, 'data'));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [model('m', 65536)];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  writeFileSync(join(paths.workspace, 'SOUL.md'), 'SOUL-MARKER');
  writeFileSync(join(paths.workspace, 'USER.md'), 'USER-MARKER');
  app.memory.save({ book: 'user', content: 'MEMORY-MARKER likes tea', actor: 'clive' });
  const root = join(dir, 'product');
  mkdirSync(root);
  const real = realpathSync.native(root);
  const project = app.projects.create({ name: 'Demo', root: real, rootKey: rootKeyOf(real), checkCommand: null });
  const send = async (id: string, text: string, projectId?: string) => {
    const outcome = app.engine.send(id, text, [], [], {}, projectId ? { projectId } : {});
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const result = await app.engine.wait(outcome.runId);
    assert.ok(!result || result.ok, JSON.stringify(result));
  };
  return { app, adapter: () => adapter, paths, root: real, project, send };
}

const frozenOf = (app: App, id: string) => app.conversations.get(id)?.snapshot ?? '';

test('2-3 指示ファイル: AGENTS.md を読み、無ければ CLAUDE.md、どちらも無ければ何も入れない', t => {
  const root = tempDir(t);
  assert.equal(readInstructions(root, 2000), undefined);
  assert.equal(instructionsSection(undefined), undefined);
  writeFileSync(join(root, 'CLAUDE.md'), 'claude rules');
  assert.deepEqual(readInstructions(root, 2000), { name: 'CLAUDE.md', text: 'claude rules', truncated: false });
  writeFileSync(join(root, 'AGENTS.md'), '﻿agents rules\n');
  assert.deepEqual(readInstructions(root, 2000), { name: 'AGENTS.md', text: 'agents rules', truncated: false });
  assert.equal(instructionsSection(readInstructions(root, 2000)), '# Product instructions (AGENTS.md)\n\nagents rules');
});

test('2-3 指示ファイル: 見えない文字（幅ゼロ・向きを変える印・タグ文字・制御文字）を取り除く。改行とタブは残す', t => {
  const root = tempDir(t);
  writeFileSync(join(root, 'AGENTS.md'), 'a​b‮c⁦d\u{E0041}e\u0007f\tg\nh­i');
  assert.equal(readInstructions(root, 2000)?.text, 'abcdef\tg\nhi');
});

test('2-3 指示ファイル: 上限を超えると頭から上限まで入れ、切った旨の 1 行が付く。大きなファイルを丸ごと読まない', t => {
  const root = tempDir(t);
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(10_000_000));
  const found = readInstructions(root, 100)!;
  assert.equal(found.truncated, true);
  assert.equal(found.text.length, 350);
  assert.match(instructionsSection(found)!, /\n\n\(AGENTS\.md is longer than the limit, so only its beginning is included here\.\)$/u);
  assert.equal(instructionsBudget(undefined), INSTRUCTIONS_DEFAULT_TOKENS);
  assert.equal(instructionsBudget(100_000), 5000);
});

test('2-3 指示ファイル: フォルダやリンクで外を指す AGENTS.md は読まない。中のファイルを指すリンクは読む', t => {
  const base = tempDir(t);
  const root = join(base, 'root');
  mkdirSync(root);
  writeFileSync(join(base, 'outside.md'), 'OUTSIDE');
  mkdirSync(join(root, 'AGENTS.md'));
  writeFileSync(join(root, 'CLAUDE.md'), 'inside');
  assert.equal(readInstructions(root, 2000), undefined, 'AGENTS.md がフォルダなら読まない（CLAUDE.md にも替えない）');
  const linked = join(base, 'linked');
  mkdirSync(linked);
  try { symlinkSync(join(base, 'outside.md'), join(linked, 'AGENTS.md'), 'file'); } catch { t.skip('この環境ではシンボリックリンクを作れない'); return; }
  assert.equal(readInstructions(linked, 2000), undefined, '外を指すリンクは読まない');
  writeFileSync(join(linked, 'CLAUDE.md'), 'real rules');
  const inner = join(base, 'inner');
  mkdirSync(inner);
  writeFileSync(join(inner, 'CLAUDE.md'), 'inner rules');
  symlinkSync(join(inner, 'CLAUDE.md'), join(inner, 'AGENTS.md'), 'file');
  assert.deepEqual(readInstructions(inner, 2000), { name: 'AGENTS.md', text: 'inner rules', truncated: false }, '中を指すリンクは読む');
});

test('2-3 製品の会話: 固定の system に指示ファイルがあり、SOUL.md・USER.md・記憶の節が無い。毎回の部分に製品と「相対パスはここから」。記憶の道具は渡らない', async t => {
  const s = await setup(t);
  writeFileSync(join(s.root, 'AGENTS.md'), 'PRODUCT-RULES: use tabs');
  s.adapter().scripts.push(reply('ok'));
  await s.send('p1', 'hello', s.project.id);
  const frozen = frozenOf(s.app, 'p1');
  assert.match(frozen, /# Product instructions \(AGENTS\.md\)\n\nPRODUCT-RULES: use tabs/u);
  for (const absent of ['SOUL-MARKER', 'USER-MARKER', 'MEMORY-MARKER', '# What you remember (memory)']) assert.ok(!frozen.includes(absent), absent);
  const call = s.adapter().calls[0]!;
  assert.equal(call.system.frozen, frozen);
  assert.ok(call.system.dynamic.includes(`This conversation belongs to the product "Demo". Product folder: ${s.root} (relative paths start here).`), call.system.dynamic);
  assert.ok(!call.tools.some(tool => tool.name.startsWith('memory_')), call.tools.map(tool => tool.name).join(','));
});

test('2-3 製品に属さない会話: SOUL.md・USER.md はあり、記憶の節と記憶の道具は無い。製品の 1 行も無い', async t => {
  const s = await setup(t);
  writeFileSync(join(s.root, 'AGENTS.md'), 'PRODUCT-RULES');
  s.adapter().scripts.push(reply('ok'));
  await s.send('n1', 'hello');
  const frozen = frozenOf(s.app, 'n1');
  assert.ok(frozen.includes('SOUL-MARKER') && frozen.includes('USER-MARKER'));
  for (const absent of ['MEMORY-MARKER', '# What you remember (memory)', 'PRODUCT-RULES', 'Product instructions']) assert.ok(!frozen.includes(absent), absent);
  const call = s.adapter().calls[0]!;
  assert.ok(!call.system.dynamic.includes('relative paths start here'));
  assert.ok(!call.tools.some(tool => tool.name.startsWith('memory_')));
});

test('2-3 製品の会話で指示ファイルが無ければ節ごと無い（SOUL.md・USER.md も入らない）。直した指示ファイルは新しい会話から効く', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('ok'), reply('ok'), reply('ok'));
  await s.send('p1', 'hello', s.project.id);
  const first = frozenOf(s.app, 'p1');
  assert.ok(!first.includes('Product instructions') && !first.includes('SOUL-MARKER'));
  writeFileSync(join(s.root, 'CLAUDE.md'), 'LATER-RULES');
  await s.send('p1', 'again');
  assert.equal(frozenOf(s.app, 'p1'), first, '会話の途中では変わらない');
  await s.send('p2', 'new', s.project.id);
  assert.match(frozenOf(s.app, 'p2'), /# Product instructions \(CLAUDE\.md\)\n\nLATER-RULES/u);
});

test('2-3 前からある会話の固定した system は変わらない（記憶の入った古い system のまま）', async t => {
  const s = await setup(t);
  s.app.conversations.ensure('old');
  s.app.conversations.setSnapshotOnce('old', 'OLD SYSTEM with MEMORY-MARKER', 'h');
  s.adapter().scripts.push(reply('ok'));
  await s.send('old', 'hello');
  assert.equal(s.adapter().calls[0]!.system.frozen, 'OLD SYSTEM with MEMORY-MARKER');
});

test('2-3 上限は使うモデルの窓で変わる（小さい窓では切られ、大きい窓では全部入る）', async t => {
  const body = 'y'.repeat(14_000);
  for (const [contextLength, cut] of [[16_384, true], [262_144, false]] as const) {
    const s = await setup(t, c => { c.models = [model('m', contextLength)]; });
    writeFileSync(join(s.root, 'AGENTS.md'), body);
    s.adapter().scripts.push(reply('ok'));
    await s.send('p', 'hi', s.project.id);
    const frozen = frozenOf(s.app, 'p');
    assert.equal(frozen.includes('is longer than the limit'), cut, String(contextLength));
    assert.equal(frozen.includes(body), !cut, String(contextLength));
  }
});

test('2-3 製品の実行の子の担当の会話は製品の system（指示ファイルあり、SOUL.md・USER.md なし）。製品に属さない会話の子は今までどおり', async t => {
  const s = await setup(t, c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; });
  writeFileSync(join(s.root, 'AGENTS.md'), 'CHILD-RULES');
  s.adapter().scripts.push(toolCall('agent_run', { task: 'look', title: 'child' }), reply('child answer'), reply('parent done'));
  await s.send('p1', 'delegate', s.project.id);
  s.adapter().scripts.push(toolCall('agent_run', { task: 'look', title: 'child' }), reply('child answer'), reply('parent done'));
  await s.send('n1', 'delegate');
  const children = s.app.conversations.db.prepare("SELECT id, project_id FROM conversations WHERE parent_run_id IS NOT NULL ORDER BY created_at, rowid").all() as Array<{ id: string; project_id: string | null }>;
  assert.equal(children.length, 2);
  const productChild = frozenOf(s.app, children.find(c => c.project_id === s.project.id)!.id);
  assert.ok(productChild.includes('CHILD-RULES') && !productChild.includes('SOUL-MARKER') && !productChild.includes('USER-MARKER'));
  const plainChild = frozenOf(s.app, children.find(c => c.project_id === null)!.id);
  assert.ok(plainChild.includes('SOUL-MARKER') && !plainChild.includes('CHILD-RULES') && !plainChild.includes('MEMORY-MARKER'));
});

test('2-3 振り返り: 依頼文に memory_ の字が無く、記憶の道具も渡らず、スキルの下書きは作れる。製品の会話の振り返りは製品の system', async t => {
  const s = await setup(t);
  writeFileSync(join(s.root, 'AGENTS.md'), 'REVIEW-RULES');
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('ok'));
  await s.send('p1', 'weekly report steps', s.project.id);
  s.app.reviews.enqueue('manual', 'manual:p1', { conversationId: 'p1' });
  s.adapter().scripts.push(toolCall('skill_draft', { name: 'weekly-report', description: 'When writing the weekly report', body: '1. Collect', reason: 'Weekly' }), reply('drafted'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls.at(-2)!;
  const prompt = String(request.messages.at(-1)?.content);
  assert.match(prompt, /^\[Review\]/u);
  assert.doesNotMatch(prompt, /memory_/u);
  assert.ok(!request.tools.some(tool => tool.name.startsWith('memory_')));
  assert.ok(request.system.frozen.includes('REVIEW-RULES') && !request.system.frozen.includes('SOUL-MARKER'));
  assert.ok(s.app.skills.drafts().some(draft => draft.name === 'weekly-report'), 'スキルの下書きができる');
});

test('2-3 整理の振り返り（book_full）は積まれず、待っていた分は「飛ばした」で終わる（モデルを呼ばず、失敗の通知も出ない）', async t => {
  const s = await setup(t, c => { c.models = [model('m', 16_384)]; });
  for (let i = 0; i < 40; i++) s.app.memory.save({ book: 'notes', content: `note ${i} ${'z'.repeat(500)}`, actor: 'clive' });
  await s.app.worker.tick();
  assert.equal(s.app.reviews.list().filter(job => job.trigger === 'book_full').length, 0, '記憶が予算を超えても積まない');
  const job = s.app.reviews.enqueue('book_full', 'book:all:1')!;
  const calls = s.adapter().calls.length;
  assert.equal(await s.app.worker.tick(), 'idle');
  const done = s.app.reviews.get(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.note, 'Memory tidy-up reviews are off for now, so this one was skipped');
  assert.equal(s.adapter().calls.length, calls);
  assert.equal(s.app.notifications.list().length, 0);
});

test('2-3 data/workspace の中身と DB の記憶の行数は、製品の会話・製品に属さない会話の前後で同じ', async t => {
  const s = await setup(t);
  writeFileSync(join(s.root, 'AGENTS.md'), 'RULES');
  const hash = () => createHash('sha256').update(readdirSync(s.paths.workspace, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)).sort().map(p => `${p}\n${readFileSync(p, 'base64')}`).join('\n')).digest('hex');
  const rows = () => (s.app.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  const before = { hash: hash(), rows: rows() };
  s.adapter().scripts.push(reply('ok'), reply('ok'));
  await s.send('p1', 'hello', s.project.id);
  await s.send('n1', 'hello');
  assert.deepEqual({ hash: hash(), rows: rows() }, before);
});
