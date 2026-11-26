import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { ownerSpeech } from '../src/db/conversations.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { prepareSpeech, SCAN_BUDGET, verifySource } from '../src/projects/acceptance.ts';
import { CONFIRM_MESSAGE_MAX } from '../src/research/confirm.ts';
import { OwnerAct } from '../src/research/run.ts';
import { confirmedPicks, type ResearchStore } from '../src/research/store.ts';
import { uuid, waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
import { ALPHA, BETA, researchApp } from './helpers/research-app.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M4・R-2s): 確定の口（守り 3 の 1〜8、R3.11 M7・M8・L4、R3.13 の 1・3）

const GH = 'https://github.com/acme/notes';

type App = Awaited<ReturnType<typeof researchApp>>;

// 終わった products の記録を 1 つ作る（似ているもの 2・機能 3〔定番 1・持ち主が言った 1・ほか 1〕）
function seed(s: App, options: { projectId?: string; status?: 'done' | 'running'; source?: string } = {}) {
  const store: ResearchStore = s.app.research.store;
  const record = store.start({ projectId: options.projectId ?? s.projectId, phase: 'products', mode: 'batch', sourceConversationId: options.source ?? uuid(1) });
  const alpha = store.addSource(record.id, { kind: 'similar', name: 'Alpha Notes', url: ALPHA, detail: 'A long description with https://evil.example/x', license: 'It is released under the MIT License.', evidence: {} });
  const beta = store.addSource(record.id, { kind: 'similar', name: 'Beta Notes', url: BETA, evidence: {} });
  const tags = store.addFeature(record.id, { label: 'Tag search', evidence: [{ similar: alpha.id, url: ALPHA, quote: 'It has Tag search for notes.' }, { similar: beta.id, url: BETA, quote: 'It has Tag search for notes.' }] }).row;
  const short = store.addFeature(record.id, { label: 'タグ', evidence: [{ similar: beta.id, url: BETA, quote: 'タグ' }] }).row;
  const preview = store.addFeature(record.id, { label: 'Live Markdown preview', evidence: [{ similar: alpha.id, url: ALPHA, quote: 'It has Live Markdown preview.' }] }).row;
  if (options.status !== 'running') store.finish(record.id, 'done');
  return { record: store.get(record.id)!, alpha, beta, tags, short, preview, hash: () => store.shownHash(record.id) };
}

async function setup(t: Parameters<typeof researchApp>[0], extra: Parameters<typeof researchApp>[1] = {}) {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; }, ...extra });
  s.adapter().scripts.push(reply('Tell me more.'));
  await s.send(1, 'I want a Markdown notes app with Live Markdown preview, please.');
  const confirm = (id: string, body: unknown) => s.json(`/api/research/${id}/confirm`, 'POST', body);
  const generated = (conversationId = uuid(1)) => s.users(conversationId).filter(m => m.generated === true);
  return { ...s, confirm, generated };
}

test('確定（守り 3 の 2・3・6）: 選んだ名前だけが決まった枠の generated の発言で入り、名前のバイト列が同じ。説明・リンク・ライセンスは入らず、印も付かない。返事が 1 つ始まる', async t => {
  const s = await setup(t);
  const r = seed(s);
  assert.equal(r.tags.default_reason, 'standard');
  assert.equal(s.app.research.store.items(r.record.id).find(i => i.id === r.preview.id)!.default_reason, 'owner_said');
  assert.equal(s.generated().length, 0, 'default checks put nothing in before the owner presses');
  s.adapter().scripts.push(reply('Noted the picks.'), reply('libraries part'));
  const done = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }, { id: r.preview.id, decision: 'not_needed', reason: 'Not now\nlater maybe' }, { id: r.alpha.id, decision: 'build' }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.replied, true);
  const [message] = s.generated();
  assert.ok(message, 'one generated message');
  const lines = message!.content.split('\n');
  const inside = lines.slice(lines.indexOf('<<<picked') + 1, lines.indexOf('>>>'));
  assert.deepEqual(inside, ['Build it from scratch.', 'Feature: Tag search']);
  assert.ok(Buffer.from(inside[1]!.slice('Feature: '.length)).equals(Buffer.from(r.tags.name_or_label)), 'the name bytes are the ones shown');
  for (const leak of ['Alpha Notes', 'evil.example', ALPHA, 'MIT', 'Live Markdown preview', 'タグ']) assert.ok(!message!.content.includes(leak), leak);
  assert.equal(s.app.conversations.everTainted(uuid(1)), false);
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  const items = s.app.research.store.items(r.record.id);
  assert.deepEqual(items.map(i => [i.name_or_label, i.decision, i.reason, i.answer_kind]), [
    ['Alpha Notes', 'build', null, null], ['Beta Notes', null, null, null],
    ['Tag search', 'picked', null, 'kept'], ['タグ', 'later', null, 'kept'], ['Live Markdown preview', 'not_needed', 'Not now later maybe', 'changed'],
  ]);
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'confirmed');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('確定（守り 3 の 2）: 終わる前・見せたものが違う・ほかの記録の行・種類に合わない選び・use が 2 つ・library の選び・範囲の外の選択肢は断られ、何も書かれない', async t => {
  const s = await setup(t);
  const running = seed(s, { status: 'running' });
  const runningCase = await s.confirm(running.record.id, { shownHash: running.hash(), picks: [] });
  assert.deepEqual([runningCase.status, runningCase.body.code], [409, 'research.not_finished']);
  s.app.research.store.finish(running.record.id, 'cancelled');
  const r = seed(s, { projectId: s.projectId });
  const cases: Array<[string, unknown, number]> = [
    ['hash', { shownHash: 'a'.repeat(64), picks: [] }, 409],
    ['other record', { shownHash: r.hash(), picks: [{ id: running.tags.id, decision: 'picked' }] }, 400],
    ['feature use', { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'use' }] }, 400],
    ['two use', { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'use' }, { id: r.beta.id, decision: 'base' }] }, 400],
    ['similar picked', { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'picked' }] }, 400],
    ['setup without use', { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'build', setup: true }] }, 400],
    ['twice', { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }, { id: r.tags.id, decision: 'later' }] }, 400],
    ['no hash', { picks: [] }, 400],
  ];
  for (const [label, body, status] of cases) {
    const out = await s.confirm(r.record.id, body);
    assert.equal(out.status, status, `${label}: ${JSON.stringify(out.body)}`);
  }
  // 見せたものの印は DB の欄（名前・初めのチェックと理由）のどれが変わっても変わる
  const before = r.hash();
  s.app.db.prepare('UPDATE research_items SET default_checked = 0 WHERE id = ?').run(r.tags.id);
  assert.notEqual(r.hash(), before);
  s.app.db.prepare("UPDATE research_items SET default_checked = 1, default_reason = 'owner_said' WHERE id = ?").run(r.tags.id);
  assert.notEqual(r.hash(), before);
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
  assert.ok(s.app.research.store.items(r.record.id).every(i => i.decision === null));
  assert.equal(s.generated().length, 0);
});

test('確定（守り 3 の 2）: 2 回押す・同時に 2 つ押すと、書かれるのは 1 回だけで 2 つ目は 409', async t => {
  const s = await setup(t);
  const r = seed(s);
  s.adapter().scripts.push(reply('ok'), reply('lib'), reply('ok2'), reply('lib2'));
  const body = { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] };
  const [a, b] = await Promise.all([s.confirm(r.record.id, body), s.confirm(r.record.id, body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const again = await s.confirm(r.record.id, body);
  assert.equal(again.status, 409);
  assert.equal(s.generated().length, 1);
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('確定（守り 3 の 5）: 入れる発言が 1,500 字を超えると断り、何も書かない（黙って切らない）', async t => {
  const s = await setup(t);
  const store = s.app.research.store;
  const record = store.start({ projectId: s.projectId, phase: 'products', mode: 'batch', sourceConversationId: uuid(1) });
  const a = store.addSource(record.id, { kind: 'similar', name: 'Alpha Notes', url: ALPHA, evidence: {} });
  const rows = Array.from({ length: 22 }, (_, i) => store.addFeature(record.id, { label: `A feature with a fairly long descriptive name number ${String(i).padStart(2, '0')}`, evidence: [{ similar: a.id, url: ALPHA, quote: 'x' }] }).row);
  store.finish(record.id, 'done');
  const out = await s.confirm(record.id, { shownHash: store.shownHash(record.id), picks: rows.map(r => ({ id: r.id, decision: 'picked' })) });
  assert.deepEqual([out.status, out.body.code], [400, 'research.too_long'], JSON.stringify(out.body));
  assert.ok(CONFIRM_MESSAGE_MAX === 1500);
  assert.equal(store.get(record.id)!.status, 'done');
  assert.equal(s.generated().length, 0);
});

test('確定（R3.11 M8 (a)）: 元の会話が消えた・しまった・ほかの製品・task の会話なら 409 で、状態は done のまま', async t => {
  const s = await setup(t);
  for (const [label, change] of [
    ['archived', 'UPDATE conversations SET archived = 1 WHERE id = ?'],
    ['task', "UPDATE conversations SET kind = 'task' WHERE id = ?"],
    ['other product', "UPDATE conversations SET project_id = 'p-other' WHERE id = ?"],
  ] as const) {
    const r = seed(s);
    const saved = s.app.conversations.get(uuid(1))!;
    s.app.db.prepare(change).run(uuid(1));
    const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
    assert.deepEqual([out.status, out.body.code], [409, 'research.source_gone'], label);
    assert.equal(s.app.research.store.get(r.record.id)!.status, 'done', label);
    s.app.db.prepare('UPDATE conversations SET archived = ?, kind = ?, project_id = ? WHERE id = ?').run(saved.archived, saved.kind, saved.project_id, uuid(1));
    s.app.db.prepare("UPDATE research_runs SET status = 'cancelled' WHERE id = ?").run(r.record.id);
  }
  const r = seed(s);
  const erased = await s.json(`/api/conversations/${uuid(1)}`, 'DELETE');
  assert.ok(erased.status < 300, JSON.stringify(erased.body));
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.equal(out.status, 409, 'erased');
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
});

test('確定: 元の会話が外の実行役に結ばれていれば 409 runtime_source で断り、状態は done のまま・何も書かず、返事も始めない（beat の発言だけが残って次の実行役の返事に混ざらない）', async t => {
  const s = await setup(t);
  const r = seed(s);
  assert.equal(s.app.conversations.bindRuntime(uuid(1), 'claude-code'), true);
  const before = s.app.conversations.messages(uuid(1)).length;
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.deepEqual([out.status, out.body.code], [409, 'research.runtime_source'], JSON.stringify(out.body));
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
  assert.ok(s.app.research.store.items(r.record.id).every(i => i.decision === null));
  assert.equal(s.app.conversations.messages(uuid(1)).length, before, 'no message was added to the conversation');
  assert.equal(s.generated().length, 0);
  assert.equal(s.app.engine.activeRuns().length, 0, 'no reply was started');
});

test('確定（R3.13 の 1）: 計画の会話が返事をしている間は 409 conversation_running で行が増えず done のまま。終わってから押すと通り、道具を呼んだ assistant の行のすぐあとに必ず tool の行が並ぶ', async t => {
  let release!: () => void;
  const s = await setup(t, { hold: { search: new Promise<void>(resolve => { release = resolve; }) } });
  const r = seed(s);
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes apps' }), reply('Here is what I found.'));
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'Look around first.', projectId: s.projectId });
  assert.equal(sent.status, 202);
  await waitFor(() => s.app.engine.activeRuns().some(run => run.conversationId === uuid(1)) && s.app.conversations.messages(uuid(1)).some(m => m.message.role === 'assistant' && (m.message.toolCalls?.length ?? 0) > 0), 'tool call pending');
  const count = s.app.conversations.messages(uuid(1)).length;
  const busy = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.deepEqual([busy.status, busy.body.code], [409, 'research.conversation_running']);
  assert.equal(s.app.conversations.messages(uuid(1)).length, count);
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
  release();
  await waitFor(() => !s.app.engine.chatting, 'chat ended');
  s.adapter().scripts.push(reply('ok'), reply('lib'));
  const done = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  const all = s.app.conversations.messages(uuid(1)).map(m => m.message);
  all.forEach((m: ChatMessage, i) => {
    if (m.role === 'assistant' && m.toolCalls?.length) assert.equal(all[i + 1]?.role, 'tool', `row ${i + 1} follows a tool call`);
  });
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('確定（R3.11 M8）: 使えるモデルが無くても発言は会話に残る（返事は始まらない）', async t => {
  const s = await setup(t);
  const r = seed(s);
  s.app.db.prepare("UPDATE conversations SET model_id = 'missing-model' WHERE id = ?").run(uuid(1));
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.replied, false);
  assert.equal(s.generated().length, 1);
  assert.equal(s.app.engine.chatting, false);
});

test('owner_pick（D8・R3.11 M7）: 確定した名前とまるごと同じ引用だけが owner_pick。短い「タグ」も当たる。一部だけ・確定していない記録・ほかの製品は ai_added。owner_said は短い名前に付かない', async t => {
  const s = await setup(t);
  const r = seed(s);
  const speech = () => prepareSpeech(ownerSpeech(s.app.db, s.projectId), SCAN_BUDGET, confirmedPicks(s.app.db, s.projectId));
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'タグ' }).kind, 'ai_added', 'not confirmed yet');
  assert.equal(s.app.research.store.items(r.record.id).find(i => i.id === r.short.id)!.default_reason, null, 'D9 skips short names');
  s.adapter().scripts.push(reply('ok'), reply('lib'));
  const ok = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.short.id, decision: 'picked' }, { id: r.beta.id, decision: 'build' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(verifySource(speech(), { kind: 'owner_words', quote: 'タグ' }), { kind: 'owner_pick', researchId: r.record.id, itemId: r.short.id, label: 'タグ' });
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: ' タグ ' }).kind, 'owner_pick', 'whole name after trimming');
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'タグ付け' }).kind, 'ai_added');
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'Tag search' }).kind, 'ai_added', 'not picked (later)');
  assert.deepEqual(confirmedPicks(s.app.db, 'another-product'), []);
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('owner_pick（B2）: 確定の文の行をまるごと引いた引用（「Feature: 名前」）も owner_pick。選んでいない名前の行・行の一部は ai_added', async t => {
  const s = await setup(t);
  const r = seed(s);
  const speech = () => prepareSpeech(ownerSpeech(s.app.db, s.projectId), SCAN_BUDGET, confirmedPicks(s.app.db, s.projectId));
  s.adapter().scripts.push(reply('ok'), reply('lib'));
  const ok = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.short.id, decision: 'picked' }, { id: r.beta.id, decision: 'build' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const sent = s.app.conversations.messages(uuid(1)).map(m => m.message).filter(m => m.role === 'user' && m.generated).at(-1)!;
  assert.ok(sent.content.split('\n').includes('Feature: タグ'), 'the confirm message has the line as quoted');
  assert.deepEqual(verifySource(speech(), { kind: 'owner_words', quote: 'Feature: タグ' }), { kind: 'owner_pick', researchId: r.record.id, itemId: r.short.id, label: 'タグ' });
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: ' Feature: タグ ' }).kind, 'owner_pick');
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'Feature: Tag search' }).kind, 'ai_added', 'a feature that was not picked');
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'Feature: タグ付け' }).kind, 'ai_added');
  assert.equal(verifySource(speech(), { kind: 'owner_words', quote: 'Feature:' }).kind, 'ai_added');
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('土台にする: 土台にある機能はチェックの対象から外れ（選ぶと 400）、決めは残らない。足りない機能だけが入る', async t => {
  const s = await setup(t);
  const r = seed(s);
  const onBase = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'base' }, { id: r.tags.id, decision: 'picked' }] });
  assert.equal(onBase.status, 400, 'Tag search is on Alpha');
  s.adapter().scripts.push(reply('ok'), reply('lib'));
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'base' }, { id: r.short.id, decision: 'picked' }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const content = s.generated()[0]!.content;
  assert.ok(content.includes('Build on this existing product: Alpha Notes'));
  assert.ok(content.includes('Feature: タグ'));
  const items = s.app.research.store.items(r.record.id);
  assert.equal(items.find(i => i.id === r.tags.id)!.decision, null);
  assert.equal(items.find(i => i.id === r.preview.id)!.decision, null, 'Live Markdown preview is on Alpha too');
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
});

test('これを使う（D11・付記）: 入れて設定するタスクは持ち主の頼みなし・外を読んだ印つき・本文はコードの文と名前・URL・ライセンスの有無だけ。リンクとメモは製品のフォルダにも mesh にも書かれない。2 回目の調べる記録は始まらない', async t => {
  const s = await setup(t);
  const r = seed(s);
  s.adapter().scripts.push(reply('ok'));
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.alpha.id, decision: 'use', reason: 'MEMO-zq81 keep it simple', setup: true }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const task = s.app.tasks.get(out.body.setupTask)!;
  assert.equal(task.origin, 'user');
  assert.equal(s.app.tasks.judgeRequest(task.id), '', 'the judge gets no owner request');
  assert.ok(s.app.db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND run_id = 'untrusted-input'").get(task.id), 'marked as read from outside');
  assert.ok(task.body!.includes(ALPHA) && task.body!.includes('Alpha Notes') && task.body!.includes('checked on the page'));
  for (const leak of ['A long description', 'evil.example', 'MIT', 'MEMO-zq81']) assert.ok(!task.body!.includes(leak), leak);
  assert.equal(s.app.research.store.items(r.record.id).find(i => i.id === r.alpha.id)!.reason, 'MEMO-zq81 keep it simple');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
  assert.deepEqual(readdirSync(s.root), [], 'nothing in the product folder');
  const dataProject = join(s.app.paths.data, 'projects', s.projectId);
  let found: string[] = [];
  try { found = files(dataProject).filter(p => readFileSync(p, 'utf8').includes('MEMO-zq81')).map(p => relative(dataProject, p)); } catch { found = []; }
  assert.deepEqual(found, [], 'nothing in mesh or other product data files');
  assert.equal(s.records().filter(x => x.phase === 'libraries').length, 0);
  assert.ok(s.generated()[0]!.content.includes('Use this existing product instead of building: Alpha Notes'));
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
});

test('libraries の始め方（R3.13 の 3）: products を確定すると libraries の記録が owner_confirm で始まり、頼みの generated の発言は確定した機能の名前だけ。外の口から owner_confirm は渡せない', async t => {
  const s = await setup(t);
  const r = seed(s);
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code; } };
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(1), trigger: 'owner_confirm', owner: new OwnerAct(), phase: 'libraries' })), 'not_owner');
  s.adapter().scripts.push(reply('ok'), reply('libraries done'));
  const out = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.libraries.phase, 'libraries');
  await Promise.all(s.records().map(x => s.app.research.waitFor(x.id)));
  const libraries = s.records().find(x => x.phase === 'libraries')!;
  const part = s.app.research.store.parts(libraries.id)[0]!;
  const users = s.users(part.conversationId);
  const follow = users.filter(m => m.generated === true).map(m => m.content);
  assert.equal(follow.length, 1);
  assert.match(follow[0]!, /^Features the owner picked:\n- Tag search\nLanguages being considered: [^\n]+$/u);
  assert.ok(!users.some(m => m.content.includes('Live Markdown preview') && m.generated === true));
  const partStart = (s.app.db.prepare('SELECT started_at FROM engine_runs WHERE id = ?').get(part.runId) as { started_at: number }).started_at;
  const chat = s.app.db.prepare("SELECT MAX(ended_at) AS e FROM engine_runs WHERE conversation_id = ? AND kind = 'chat'").get(uuid(1)) as { e: number };
  assert.ok(partStart >= chat.e, 'the libraries part starts after the reply to the confirmation');
});

test('守り 3 の 1: Origin の無い確定の呼び出しは断られる。調べる表に書く SQL は src/research/store.ts だけ（消す道の切り離し 1 行を除く）', async t => {
  const s = await setup(t);
  const r = seed(s);
  const bare = await fetch(`${s.origin}/api/research/${r.record.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shownHash: r.hash(), picks: [] }) });
  assert.ok(bare.status === 403 || bare.status === 401, String(bare.status));
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
  const src = join(import.meta.dirname, '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const writers = walk(src).flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+research_(runs|items)/u.test(line)).map(line => `${relative(src, file).replaceAll('\\', '/')}: ${line.trim().slice(0, 60)}`));
  const outside = writers.filter(w => !w.startsWith('research/store.ts') && !w.startsWith('db/migrations.ts'));
  assert.deepEqual(outside.map(w => w.split(':')[0]), ['db/erase.ts']);
  assert.ok(outside[0]!.includes('SET source_conversation_id'));
});

test('P-R3-6: 同じリポジトリを 2 つの道（github の README と tree/main）で開いても、似ているものは 1 行', async t => {
  const s = await setup(t);
  const store = s.app.research.store;
  const record = store.start({ projectId: s.projectId, phase: 'products', mode: 'batch', sourceConversationId: uuid(1) });
  store.addSource(record.id, { kind: 'similar', name: 'Acme Notes', url: GH, evidence: {} });
  assert.throws(() => store.addSource(record.id, { kind: 'similar', name: 'Acme Notes app', url: `${GH}/tree/main` , evidence: {} }), /already has a row/u);
  assert.throws(() => store.addSource(record.id, { kind: 'similar', name: 'Acme', url: 'https://www.github.com/ACME/notes.git', evidence: {} }), /already has a row/u);
  store.addSource(record.id, { kind: 'similar', name: 'Other', url: 'https://github.com/acme/other', evidence: {} });
  assert.equal(store.items(record.id).length, 2);
  store.finish(record.id, 'cancelled');
});

test('守り 3 の 2（store）: 確定は動いている記録を断り（not_finished）、2 回目は finished で断る。選びは 1 回だけ書かれる', async t => {
  const s = await setup(t);
  const store = s.app.research.store;
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code; } };
  const running = seed(s, { status: 'running' });
  assert.equal(code(() => store.confirm(running.record.id, running.hash(), [])), 'not_finished');
  assert.equal(store.get(running.record.id)!.status, 'running');
  store.finish(running.record.id, 'done');
  assert.equal(code(() => store.confirm(running.record.id, running.hash(), [{ id: running.tags.id, decision: 'picked', reason: null, answerKind: 'kept' }])), 'ok');
  assert.equal(code(() => store.confirm(running.record.id, running.hash(), [{ id: running.tags.id, decision: 'later', reason: null, answerKind: 'changed' }])), 'finished');
  assert.equal(store.items(running.record.id).find(i => i.id === running.tags.id)!.decision, 'picked');
});

test('守り 3 の 4・2: 押したときにも名前の形を確かめ直す（DB の名前が崩れていれば入れない）。library の行と、範囲の外の選択肢は選べない', async t => {
  const s = await setup(t);
  const r = seed(s);
  s.app.db.prepare('UPDATE research_items SET name_or_label = ? WHERE id = ?').run('Tag search $(curl x)', r.tags.id);
  const shaped = await s.confirm(r.record.id, { shownHash: r.hash(), picks: [{ id: r.tags.id, decision: 'picked' }] });
  assert.deepEqual([shaped.status, shaped.body.code], [400, 'research.label_shell']);
  assert.equal(s.app.research.store.get(r.record.id)!.status, 'done');
  s.app.db.prepare("UPDATE research_runs SET status = 'cancelled', phase = 'products' WHERE id = ?").run(r.record.id);
  const store = s.app.research.store;
  s.app.db.prepare("UPDATE research_runs SET status = 'confirmed' WHERE id = ?").run(r.record.id);
  const lib = store.start({ projectId: s.projectId, phase: 'libraries', mode: 'batch', sourceConversationId: uuid(1) });
  const row = store.addSource(lib.id, { kind: 'library', name: 'markdown-it', url: ALPHA, evidence: {} });
  const choice = store.addChoice(lib.id, { label: 'How to save notes', options: ['Files', 'SQLite'], recommended: 1 });
  store.finish(lib.id, 'done');
  for (const pick of [{ id: row.id, decision: 'picked' }, { id: choice.id, decision: 2 }, { id: choice.id, decision: '1' }]) {
    const out = await s.confirm(lib.id, { shownHash: store.shownHash(lib.id), picks: [pick] });
    assert.equal(out.status, 400, JSON.stringify(pick));
  }
  s.adapter().scripts.push(reply('ok'));
  const out = await s.confirm(lib.id, { shownHash: store.shownHash(lib.id), picks: [{ id: choice.id, decision: 0 }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(s.generated().at(-1)!.content.includes('How to save notes -> Files'));
  assert.ok(!s.generated().at(-1)!.content.includes('markdown-it'), 'library names stay out of the plan conversation');
  assert.equal(store.items(lib.id).find(i => i.id === choice.id)!.answer_kind, 'changed');
  assert.equal(out.body.libraries, null, 'no third research');
  await waitFor(() => !s.app.engine.chatting, 'reply ended');
});
