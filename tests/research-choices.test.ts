import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { growthStats } from '../src/growth/stats.ts';
import { BUILD_BODY } from '../src/projects/build.ts';
import { languageDecided, languageOfFiles, languagesIn, pastLanguages, rankLanguages, LANGUAGE_QUESTION, LOAD_QUESTION, DELIVERY_QUESTION } from '../src/research/choices.ts';
import { pickedLanguage } from '../src/research/store.ts';
import type { ToolCheck } from '../src/research/toolchain.ts';
import { uuid, waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
import { ALPHA, researchApp } from './helpers/research-app.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M5・R-3): 言語とやり方の物差し、2 回目の部分、確定のあとだけの DECISIONS.md と Build の文、当たり率

const tool = (name: string, state: ToolCheck['state']): ToolCheck => ({ name, state, path: null, version: null });
const none = new Map();

test('言語の名前（R-1a の申し送り）: 語の切れ目のある所だけ当てる。「is written in Go」は当たり、「Google Apps Script」「Go ahead」は当たらない', () => {
  assert.deepEqual(languagesIn('It is written in Go.'), ['Go']);
  assert.deepEqual(languagesIn('Built with Google Apps Script'), []);
  assert.deepEqual(languagesIn('Go ahead and make it'), []);
  assert.deepEqual(languagesIn('A TypeScript app, not Rustic'), ['TypeScript / JavaScript']);
  assert.deepEqual(languagesIn('pythonic code'), []);
  assert.equal(languageOfFiles(['src/main.rs', 'src/lib.rs', 'build.py', 'README.md']), 'Rust');
  assert.equal(languageOfFiles(['README.md']), null);
});

test('聞かないとき: コードのある製品・設定の「聞かない」と好きな言語・発言に言語の名前が 1 つなら聞かない。2 つ言っていれば聞く', () => {
  const settings = { askLanguage: true, preferLanguages: [] };
  assert.deepEqual(languageDecided({ files: ['main.go'], settings, ownerText: 'in Python' }), { ask: false, language: 'Go', why: 'files' });
  assert.deepEqual(languageDecided({ files: [], settings: { askLanguage: false, preferLanguages: ['Rust'] }, ownerText: '' }), { ask: false, language: 'Rust', why: 'settings' });
  assert.deepEqual(languageDecided({ files: [], settings, ownerText: 'I want it in Python please' }), { ask: false, language: 'Python', why: 'owner' });
  assert.deepEqual(languageDecided({ files: [], settings, ownerText: 'Python or Go?' }), { ask: true });
  assert.deepEqual(languageDecided({ files: [], settings: { askLanguage: false, preferLanguages: [] }, ownerText: '' }), { ask: true });
});

test('物差し: 配り方と PC の道具が先、似ている OSS が次、好みと過去、重いときだけ速い言語。避けたい言語は出ない', () => {
  const base = { delivery: null, heavy: false, tools: [], similar: [], prefer: [], avoid: [], past: none } as const;
  assert.equal(rankLanguages({ ...base, delivery: 'browser' })[0]!.language, 'TypeScript / JavaScript');
  assert.equal(rankLanguages({ ...base, tools: [tool('go', 'installed')] })[0]!.language, 'Go');
  assert.equal(rankLanguages({ ...base, tools: [tool('python', 'alias')] })[0]!.language, 'TypeScript / JavaScript', 'a Store alias is not an installed tool');
  assert.equal(rankLanguages({ ...base, similar: ['Rust', 'Rust'] })[0]!.language, 'Rust');
  assert.equal(rankLanguages({ ...base, tools: [tool('python', 'installed')], similar: ['Rust', 'Rust', 'Rust'] })[0]!.language, 'Python', 'the PC tool weighs more than similar products');
  assert.ok(!rankLanguages({ ...base, avoid: ['Python'] }).some(r => r.language === 'Python'));
  const heavy = rankLanguages({ ...base, heavy: true, tools: [tool('python', 'installed'), tool('go', 'installed')] });
  assert.equal(heavy[0]!.language, 'Go');
});

async function confirmedProducts(s: Awaited<ReturnType<typeof researchApp>>, projectId = s.projectId, source = uuid(1)) {
  const store = s.app.research.store;
  const record = store.start({ projectId, phase: 'products', mode: 'batch', sourceConversationId: source });
  const a = store.addSource(record.id, { kind: 'similar', name: 'Alpha Notes', url: ALPHA, language: 'It is written in Go and runs anywhere.', evidence: {} });
  const f = store.addFeature(record.id, { label: 'Tag search', evidence: [{ similar: a.id, url: ALPHA, quote: 'Tag search' }] }).row;
  store.finish(record.id, 'done');
  return { record, f, hash: () => store.shownHash(record.id) };
}

async function setup(t: Parameters<typeof researchApp>[0], text = 'I want a Markdown notes app for me.') {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.app.research.toolchain = async names => names.map(name => tool(name, name === 'go' ? 'installed' : 'missing'));
  s.adapter().scripts.push(reply('Tell me more.'));
  await s.send(1, text);
  return s;
}

test('2 回目の部分（R-3）: products の確定のあと、コードが言語・配り方・負荷の問いを作る。頼みの generated の発言は確定した機能の名前とコードの言語の値だけで、部分は印つきで始まる', async t => {
  const s = await setup(t);
  const p = await confirmedProducts(s);
  s.adapter().scripts.push(reply('ok'), toolCall('research_record', { kind: 'choice', name: 'How to store notes', options: ['Plain files', 'SQLite'], recommended: 1 }), reply('libraries done'));
  const out = await s.json(`/api/research/${p.record.id}/confirm`, 'POST', { shownHash: p.hash(), picks: [{ id: p.f.id, decision: 'picked' }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
  const lib = s.records().find(x => x.phase === 'libraries')!;
  const rows = s.app.research.store.items(lib.id).filter(i => i.kind === 'choice');
  assert.deepEqual(rows.map(i => [i.name_or_label, i.recommended, JSON.parse(i.evidence).by]), [[LANGUAGE_QUESTION, 0, 'code'], [DELIVERY_QUESTION, null, 'code'], [LOAD_QUESTION, null, 'code'], ['How to store notes', 1, 'model']]);
  assert.equal(JSON.parse(rows[0]!.options!)[0], 'Go', 'Go is installed and Alpha is written in Go');
  const part = s.app.research.store.parts(lib.id)[0]!;
  const users = s.users(part.conversationId);
  assert.deepEqual(users.filter(m => m.generated === true).map(m => m.content), [`Features the owner picked:\n- Tag search\nLanguages being considered: ${JSON.parse(rows[0]!.options!).slice(0, 3).join(', ')}`]);
  assert.ok(!users.some(m => m.content.includes('Alpha Notes') || m.content.includes(ALPHA)), 'no researched text from the products record');
  const run = s.app.db.prepare('SELECT tainted FROM engine_runs WHERE id = ?').get(part.runId) as { tainted: number };
  assert.equal(run.tainted, 1, 'the libraries part starts as read from outside');
  const view = await s.json(`/api/projects/${s.projectId}/research`, 'GET');
  assert.deepEqual(view.body.libraries.items.filter((i: { kind: string }) => i.kind === 'choice').map((i: { by: string }) => i.by), ['code', 'code', 'code', 'model']);
});

test('聞かないとき（統合）: 持ち主が言語を言っていれば言語の問いは作らず、言った言語を頼みに渡す。配り方を言っていれば配り方の問いも作らない', async t => {
  const s = await setup(t, 'I want a notes web app in the browser, written in Python.');
  const p = await confirmedProducts(s);
  s.adapter().scripts.push(reply('ok'), reply('libraries done'));
  assert.equal((await s.json(`/api/research/${p.record.id}/confirm`, 'POST', { shownHash: p.hash(), picks: [] })).status, 200);
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
  const lib = s.records().find(x => x.phase === 'libraries')!;
  assert.deepEqual(s.app.research.store.items(lib.id).map(i => i.name_or_label), [LOAD_QUESTION], 'only the load question');
  const part = s.app.research.store.parts(lib.id)[0]!;
  assert.ok(s.users(part.conversationId).some(m => m.generated === true && m.content.endsWith('Languages being considered: Python')));
});

test('libraries の確定まで DECISIONS.md と Build の文には何も書かれない。確定のあと、言語の行（コードの値）とやり方の行（[src: external]）が入り、Build の文に 1 文。道具が無ければ知らせる', async t => {
  const s = await setup(t);
  s.app.research.toolchain = async names => names.map(name => tool(name, 'missing'));
  const p = await confirmedProducts(s);
  s.adapter().scripts.push(reply('ok'), toolCall('research_record', { kind: 'choice', name: 'How to store notes', options: ['Plain files', 'SQLite'], recommended: 1 }), reply('libraries done'));
  await s.json(`/api/research/${p.record.id}/confirm`, 'POST', { shownHash: p.hash(), picks: [{ id: p.f.id, decision: 'picked' }] });
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  const decisions = join(s.app.paths.projects, s.projectId, 'DECISIONS.md');
  const before = existsSync(decisions) ? readFileSync(decisions, 'utf8') : '';
  assert.ok(!before.includes('research #'));
  assert.equal(pickedLanguage(s.app.db, s.projectId), null);
  const lib = s.records().find(x => x.phase === 'libraries')!;
  const rows = s.app.research.store.items(lib.id);
  const language = rows.find(i => i.name_or_label === LANGUAGE_QUESTION)!;
  const approach = rows.find(i => i.name_or_label === 'How to store notes')!;
  const options = JSON.parse(language.options!) as string[];
  s.adapter().scripts.push(reply('noted'));
  const out = await s.json(`/api/research/${lib.id}/confirm`, 'POST', { shownHash: s.app.research.store.shownHash(lib.id), picks: [{ id: language.id, decision: 1 }, { id: approach.id, decision: 0 }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const lines = readFileSync(decisions, 'utf8').split('\n').filter(l => l.includes('research #'));
  assert.deepEqual(lines.map(l => l.replace(/^- \S+ /u, '')), [
    `research #${lib.id.slice(0, 8)}: owner picked language: "${options[1]}"`,
    `research #${lib.id.slice(0, 8)}: owner picked "Plain files" for "How to store notes" [src: external]`,
  ]);
  assert.equal(pickedLanguage(s.app.db, s.projectId), options[1]);
  assert.ok(BUILD_BODY(null, undefined, pickedLanguage(s.app.db, s.projectId)).includes(`Use ${options[1]} for the product`));
  assert.ok(!BUILD_BODY(null).includes('Use '), 'nothing without a pick');
  await waitFor(() => s.app.notifications.list().some(n => n.title.includes('were not found')), 'tools notice');
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
});

test('これまで選んだ言語（R-3）: DB のほかの製品の確定した、コードが作った言語の行だけを数える。ほかの製品の DECISIONS.md に手で書いた言語は数えない', async t => {
  const s = await setup(t);
  const store = s.app.research.store;
  mkdirSync(join(s.root, '..', 'Other'), { recursive: true });
  const otherId = (await s.json('/api/projects', 'POST', { root: join(s.root, '..', 'Other') })).body.project.id as string;
  const lib = store.start({ projectId: otherId, phase: 'libraries', mode: 'batch' });
  const code = store.addChoice(lib.id, { label: LANGUAGE_QUESTION, options: ['Rust', 'Go'], recommended: 0, what: 'language' });
  const model = store.addChoice(lib.id, { label: LANGUAGE_QUESTION, options: ['Python', 'Go'], recommended: 0 });
  store.finish(lib.id, 'done');
  store.confirm(lib.id, store.shownHash(lib.id), [{ id: code.id, decision: '0', reason: null, answerKind: 'kept' }, { id: model.id, decision: '0', reason: null, answerKind: 'kept' }]);
  mkdirSync(join(s.app.paths.projects, otherId), { recursive: true });
  writeFileSync(join(s.app.paths.projects, otherId, 'DECISIONS.md'), '# Decisions\n\n- 2026-11-01 research #abcdef12: owner picked language: "Python"\n');
  assert.deepEqual([...pastLanguages(s.app.db, s.projectId)], [['Rust', 1]]);
  assert.deepEqual([...pastLanguages(s.app.db, otherId)], [], 'the product itself is not counted');
});

test('当たり率（R-3）: 確定した選択の行のうちおすすめがあったものが、質問と同じ数え方で入る', async t => {
  const s = await setup(t);
  const store = s.app.research.store;
  const before = growthStats(s.app.db, { project: s.projectId }).buckets.reduce((n, b) => n + b.questions.asked, 0);
  const lib = store.start({ projectId: s.projectId, phase: 'libraries', mode: 'batch' });
  const a = store.addChoice(lib.id, { label: LANGUAGE_QUESTION, options: ['Rust', 'Go'], recommended: 0, what: 'language' });
  const b = store.addChoice(lib.id, { label: 'Store', options: ['Files', 'SQLite'], recommended: 1 });
  store.addChoice(lib.id, { label: LOAD_QUESTION, options: ['Light', 'Heavy'], recommended: null, what: 'load' });
  store.finish(lib.id, 'done');
  store.confirm(lib.id, store.shownHash(lib.id), [{ id: a.id, decision: '0', reason: null, answerKind: 'kept' }, { id: b.id, decision: '0', reason: null, answerKind: 'changed' }]);
  const stats = growthStats(s.app.db, { project: s.projectId }).buckets;
  assert.equal(stats.reduce((n, x) => n + x.questions.asked, 0) - before, 2);
  assert.equal(stats.reduce((n, x) => n + x.questions.kept, 0), 1);
  const view = await s.json(`/api/projects/${s.projectId}/research`, 'GET');
  assert.equal(view.body.suggestedCheck, 'cargo test', 'the default check command for the picked language');
});
