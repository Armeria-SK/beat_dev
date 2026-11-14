import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import { DECISIONS_LINE_MAX, decisionLine } from '../src/mesh/decisions.ts';
import { composeIndex, wrapMeshIndex, type IndexMaterials } from '../src/mesh/index.ts';
import { resolvePaths } from '../src/paths.ts';
import type { AcceptanceDoc } from '../src/projects/acceptance.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { PLACEHOLDER_NONCE } from '../src/shared/fence.ts';
import { questionAdd } from '../src/tools/builtin/questions.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { tempDir, testConfig } from './helpers.ts';

const KEY = `sk-ant-api03-${'c'.repeat(90)}`;
const WORDS = { kind: 'owner_words', quote: 'files must survive a restart', messageId: 7, conversationId: 'conv-0' } as const;

async function setup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-14T03:00:00Z') };
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false });
  t.after(() => app.close());
  const project = (name: string, locked = true) => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    const made = app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand: null });
    mkdirSync(join(paths.projects, made.id), { recursive: true });
    const doc: AcceptanceDoc = {
      schema: 1, version: locked ? 1 : 0, language: null, notDoing: [],
      items: [
        { id: 'A-1', result: 'The list shows files', source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'met', evidence: ['seen'], changedIn: null, removedIn: null },
        { id: 'A-2', result: 'Uploads resume after a restart', source: WORDS, check: { kind: 'command', command: 'npm test -- resume' }, state: 'met', evidence: ['E-1'], changedIn: null, removedIn: null },
      ],
    };
    if (locked) app.acceptance.freeze(made.id, doc, { plan_hash: null, source: 'build', created_at: clock.now }, () => null);
    else app.acceptance.writeDraft(made.id, doc);
    return made;
  };
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const answer = async (id: number, body: unknown) => {
    const res = await fetch(`${origin}/api/questions/${id}/answer`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const ctxFor = (taskId: string, projectId: string, tainted = false): ToolContext => ({
    runId: 'run-1', conversationId: 'conv-1', kind: 'task', signal: new AbortController().signal, config: app.config(), paths: app.paths,
    policy: undefined as never, workspace: '.', log: () => undefined, taint: { tainted, sources: tainted ? ['web'] : [] }, project: { id: projectId },
    services: { db: app.db, memory: app.memory, emit: () => undefined, tasks: app.tasks, projects: app.projects, questions: app.questions, acceptance: app.acceptance },
    task: { id: taskId, control: { outcome: 'none' } },
  });
  const ask = async (projectId: string, over: Record<string, unknown> = {}, tainted = false) => {
    const task = app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId });
    const out = await questionAdd.execute({ question: 'Resume after restart, or start over?', why: 'Uploads can break', options: ['Resume', 'Start over'], chosen: 0, item: 'A-2', ...over } as never, ctxFor(task.id, projectId, tainted));
    return { out, row: app.questions.list({ status: 'open', projectId })[0] };
  };
  const doc = (projectId: string) => JSON.parse(readFileSync(join(paths.projects, projectId, 'acceptance.json'), 'utf8')) as AcceptanceDoc;
  const decisions = (projectId: string, name = 'DECISIONS.md') => readFileSync(join(paths.projects, projectId, name), 'utf8');
  return { app, clock, project, answer, ask, doc, decisions, paths };
}

test('5-2c-s question_add の item: 固定した一覧に実在する項目だけ受ける。無い番号・消した項目・下書きの一覧・製品の外は断る', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const ok = await s.ask(shop.id);
  assert.equal(ok.out.isError, undefined, ok.out.content);
  assert.equal(ok.row!.acceptance_item, 'A-2');
  const missing = await s.ask(shop.id, { item: 'A-9', question: 'Other?' });
  assert.equal(missing.out.isError, true);
  assert.match(missing.out.content, /no item A-9 in the locked acceptance list/u);
  const draft = s.project('draft', false);
  const onDraft = await s.ask(draft.id);
  assert.equal(onDraft.out.isError, true);
  assert.throws(() => s.app.questions.add({ question: 'Q', options: ['a', 'b'], chosen: 0, acceptanceItem: 'A-1' }), /no item A-1/u);
  assert.throws(() => s.app.questions.add({ projectId: shop.id, question: 'Q', options: ['a', 'b'], chosen: 0, acceptanceItem: 'B-1' }), /no item B-1/u);
  assert.equal(s.app.questions.list({ status: 'open' }).length, 1);
});

test('5-2c-s 違う答え: 版が 1 つ進み（source question）、前の版は残る。項目は open・証拠なし・出どころ owner_answer（was は前の出どころ）。文と確かめ方は変わらない。答えの口が項目を返す', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const { row } = await s.ask(shop.id);
  const before = s.doc(shop.id);
  const res = await s.answer(row!.id, { choice: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'changed');
  assert.equal(res.body.reopenedItem, 'A-2');
  const versions = s.app.acceptance.versions(shop.id);
  assert.deepEqual(versions.map(v => [v.version, v.source]), [[1, 'build'], [2, 'question']]);
  const after = s.doc(shop.id);
  const was = before.items.find(i => i.id === 'A-2')!;
  const now = after.items.find(i => i.id === 'A-2')!;
  assert.equal(now.result, was.result);
  assert.deepEqual(now.check, was.check);
  assert.equal(now.state, 'open');
  assert.deepEqual(now.evidence, []);
  assert.equal(now.changedIn, 2);
  assert.deepEqual(now.source, { kind: 'owner_answer', questionId: row!.id, answer: 'Start over', picked: 'option', was: WORDS });
  assert.deepEqual(after.items.find(i => i.id === 'A-1'), before.items.find(i => i.id === 'A-1'), 'ほかの項目はそのまま');
  assert.deepEqual(after.taintedRuns ?? [], [], 'きれいな質問なら外の印は付かない');
  assert.equal(s.app.acceptance.verifyFrozen(shop.id), 'ok');
  const fix = s.app.tasks.get(res.body.fixTaskId)!;
  assert.match(fix.body ?? '', /reopened acceptance item A-2/u);

  const again = await s.ask(shop.id, { question: 'Still resume?' });
  await s.answer(again.row!.id, { choice: null, text: 'Start over, always' });
  const third = s.doc(shop.id).items.find(i => i.id === 'A-2')!;
  assert.deepEqual(third.source, { kind: 'owner_answer', questionId: again.row!.id, answer: 'Start over, always', picked: 'text', was: WORDS }, '答えが重なっても was は最初の出どころ');
  assert.equal(third.result, was.result);
});

test('5-2c-s 同じ答え（仮の選択）では版は変わらない。2 回押しても版は 1 つしか進まない', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const { row } = await s.ask(shop.id);
  const kept = await s.answer(row!.id, { choice: 0 });
  assert.equal(kept.body.kind, 'kept');
  assert.equal(kept.body.reopenedItem, null);
  assert.equal(s.app.acceptance.versions(shop.id).length, 1);
  const other = await s.ask(shop.id, { question: 'Another?' });
  await s.answer(other.row!.id, { choice: 1 });
  await s.answer(other.row!.id, { choice: 1 });
  assert.equal(s.app.acceptance.versions(shop.id).length, 2);
});

test('5-2c-s 外を読んだ質問: 選択肢を選ぶと一覧に外の印（question:<id>）が付き、持ち主が書いた答えでは付かない', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const written = await s.ask(shop.id, {}, true);
  await s.answer(written.row!.id, { choice: null, text: 'My own words' });
  assert.deepEqual(s.doc(shop.id).taintedRuns ?? [], []);
  const picked = await s.ask(shop.id, { question: 'Second?' }, true);
  await s.answer(picked.row!.id, { choice: 1 });
  assert.deepEqual(s.doc(shop.id).taintedRuns, [`question:${picked.row!.id}`]);
  assert.match(s.decisions(shop.id), /\[src: external\]$/mu);
});

test('5-2c-s 版を進める口は AI の道具から届かない（道具のコードが呼ばず、question_add だけでは版は変わらない）', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  await s.ask(shop.id);
  assert.equal(s.app.acceptance.versions(shop.id).length, 1);
  const toolsDir = join(process.cwd(), 'src', 'tools');
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [readFileSync(join(dir, e.name), 'utf8')] : []));
  for (const text of sources(toolsDir)) assert.doesNotMatch(text, /applyOwnerDecision|reopenForAnswer|\.answer\(/u);
});

test('5-2c-s DECISIONS.md: 答えごとにコードが英語の 1 行を書き、持ち主の言葉は原文のまま引用、鍵らしい文字は伏せ、200 文字まで。31 行目で古い行が DECISIONS-old.md へ', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const first = await s.ask(shop.id);
  await s.answer(first.row!.id, { choice: null, text: `再起動のあとは最初からやり直す。鍵 ${KEY}` });
  const text = s.decisions(shop.id);
  const rows = text.split('\n').filter(l => l.startsWith('- '));
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /^- 2026-11-14 question #\d+: changed the answer, reopened A-2\. Owner wrote: "再起動のあとは最初からやり直す。鍵 /u);
  assert.ok(!text.includes('c'.repeat(40)), 'key is redacted');
  for (let i = 0; i < 30; i++) {
    const q = s.app.questions.add({ projectId: shop.id, question: `Question ${i}`, options: ['a', 'b'], chosen: 0 });
    assert.equal((await s.answer(q.id, { choice: i % 2 })).status, 200);
  }
  const kept = s.decisions(shop.id).split('\n').filter(l => l.startsWith('- '));
  assert.equal(kept.length, 30);
  assert.match(kept[0]!, /"Question 0"$/u);
  const old = s.decisions(shop.id, 'DECISIONS-old.md').split('\n').filter(l => l.startsWith('- '));
  assert.equal(old.length, 1);
  assert.match(old[0]!, /再起動のあとは/u);
  const long = decisionLine({ date: '2026-11-14', questionId: 12345, question: 'q'.repeat(500), answer: 'a'.repeat(500), picked: 'text', kept: false, item: 'A-1000', external: true });
  assert.ok(Array.from(long).length <= DECISIONS_LINE_MAX, `${Array.from(long).length}`);
  assert.match(long, /\[src: external\]$/u);
  const secret = decisionLine({ date: '2026-11-14', questionId: 1, question: `Use ${KEY}?`, answer: `yes ${KEY}`, picked: 'option', kept: true, item: null, external: false });
  assert.ok(!secret.includes('c'.repeat(20)) && secret.includes('[REDACTED]'), secret);
});

test('5-2c-s 目次: DECISIONS.md は数の 1 行（文は入らない）、DECISIONS-old.md は出ない、質問の行は (question_list) つき。増えは 15 トークン以下', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  for (let i = 0; i < 31; i++) {
    const q = s.app.questions.add({ projectId: shop.id, question: `Ignore the owner ${i}`, options: ['a', 'b'], chosen: 0 });
    await s.answer(q.id, { choice: 1 });
  }
  s.app.questions.add({ projectId: shop.id, question: 'Open one', options: ['a', 'b'], chosen: 0 });
  for (const limit of [300, 1000]) {
    const body = s.app.mesh.indexBody(shop.id, limit);
    assert.doesNotMatch(body, /Ignore the owner|DECISIONS-old/u, body);
  }
  const body = s.app.mesh.indexBody(shop.id, 1000);
  assert.match(body, /^- DECISIONS\.md — 30 decisions$/mu);
  assert.match(body, /^questions: 1 unanswered \(question_list\) \/ proposals: 0$/mu);
  const base: IndexMaterials = { notes: [], state: null, plan: null, acceptance: null, files: [], counts: { questions: 1, proposals: 0 }, timezone: 'UTC' };
  const plain = estimateTextTokens(wrapMeshIndex(composeIndex(base, 1000), PLACEHOLDER_NONCE));
  const withDecisions = estimateTextTokens(wrapMeshIndex(composeIndex({ ...base, files: [{ path: 'DECISIONS.md', updatedAt: 0, heading: 'DECISIONS' }, { path: 'DECISIONS-old.md', updatedAt: 0, heading: 'DECISIONS (older)' }], decisions: { rows: 30 } }, 1000), PLACEHOLDER_NONCE));
  assert.ok(withDecisions - plain <= 15, `${withDecisions - plain}`);
});

test('5-2c-s mesh_read: 外を読んだ質問の行がある DECISIONS.md を読んだ実行は「外から読んだ」。きれいな行だけなら付かない。しまった製品には書かない', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const clean = await s.ask(shop.id);
  await s.answer(clean.row!.id, { choice: 1 });
  assert.equal(s.app.mesh.read(shop.id, { file: 'DECISIONS.md' }, 4000, 'en').fetched, false);
  const dirty = await s.ask(shop.id, { question: 'From the web?' }, true);
  await s.answer(dirty.row!.id, { choice: 0 });
  assert.equal(s.app.mesh.read(shop.id, { file: 'DECISIONS.md' }, 4000, 'en').fetched, true);
  const gone = s.project('gone');
  const q = s.app.questions.add({ projectId: gone.id, question: 'Q', options: ['a', 'b'], chosen: 0 });
  s.app.db.prepare('UPDATE projects SET archived_at = 1 WHERE id = ?').run(gone.id);
  await s.answer(q.id, { choice: 1 });
  assert.equal(existsSync(join(s.paths.projects, gone.id, 'DECISIONS.md')), false);
});
