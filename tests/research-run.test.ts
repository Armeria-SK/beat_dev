import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ownerSpeech } from '../src/db/conversations.ts';
import { OwnerAct, OWNER_TEXT_MAX } from '../src/research/run.ts';
import { settled, uuid, waitFor } from './app-setup.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { ATTACHMENT_OPEN } from '../src/uploads/store.ts';
import { ProviderError } from '../src/providers/types.ts';
import { fail, reply, type Script } from './helpers.ts';
import { ALPHA, BETA, researchApp } from './helpers/research-app.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M3): 調べる記録の組み立て（R3.11 H2・M6・L3・L4、R3.12、R3.13 の 3〜4）

const BATCH_PART = () => [toolCall('web_search', { query: 'markdown notes app' }), toolCall('web_fetch', { url: ALPHA }), toolCall('research_record', { kind: 'similar', name: 'Alpha Notes', url: ALPHA }), reply('Recorded.')];

test('自動の始まり: 新しい製品で送ると、返事の実行が終わってから記録が 1 つ始まり、計画の会話に印は付かず、調べる会話は一覧・持ち主の言葉・タスクに出ない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('Tell me more.'), ...BATCH_PART());
  const chatRun = await s.send(1, 'I want a Markdown notes app with tags.');
  await s.settle();
  const [record] = s.records();
  assert.equal(s.records().length, 1);
  assert.deepEqual([record!.status, record!.auto, record!.phase, record!.mode, record!.source_conversation_id], ['done', 1, 'products', 'batch', uuid(1)]);
  assert.deepEqual(s.app.research.store.items(record!.id).map(i => i.name_or_label), ['Alpha Notes']);
  const parts = s.app.research.store.parts(record!.id);
  assert.equal(parts.length, 1);
  const chatEnded = s.app.runs.get(chatRun)!.ended_at!;
  const partStarted = (s.app.db.prepare('SELECT started_at FROM engine_runs WHERE id = ?').get(parts[0]!.runId) as { started_at: number }).started_at;
  assert.ok(partStarted >= chatEnded, 'the first part starts after the reply run ended');
  assert.equal(s.app.conversations.everTainted(uuid(1)), false);
  const listed = await s.json('/api/conversations', 'GET');
  assert.ok(!JSON.stringify(listed.body).includes(parts[0]!.conversationId));
  assert.ok(ownerSpeech(s.app.db, s.projectId).every(row => row.conversation_id === uuid(1)));
  const tasks = await s.json(`/api/tasks?project=${s.projectId}`, 'GET');
  assert.ok(!JSON.stringify(tasks.body).includes(parts[0]!.taskId));
  assert.equal(s.app.projects.counts(s.projectId).proposals, 0);
});

test('自動の始まり（H2）: 3 回送っても記録は 1 つ。飛ばした・失敗した・確定した製品では自動で始まらない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('a'), reply('part done'), reply('b'), reply('c'));
  await s.send(1, 'I want a notes app.');
  await s.settle();
  await s.send(1, 'With tags.');
  await s.send(1, 'And search.');
  assert.equal(s.records().length, 1);
  for (const status of ['skipped', 'failed', 'confirmed']) {
    s.app.db.prepare('UPDATE research_runs SET status = ?').run(status);
    s.adapter().scripts.push(reply('again'));
    await s.send(1, 'more');
    assert.equal(s.records().length, 1, status);
  }
});

test('自動の始まり（守り 5・R3.12）: 計画書のある製品・ファイルのある製品・when が button / off・generated の送信では始まらない', async t => {
  for (const [label, setup] of [
    ['button', { configure: (c: { research?: unknown }) => { c.research = { when: 'button' }; } }],
    ['off', { configure: (c: { research?: unknown }) => { c.research = { when: 'off' }; } }],
  ] as const) {
    const s = await researchApp(t, setup as never);
    s.adapter().scripts.push(reply('ok'));
    await s.send(1, 'I want a notes app.');
    assert.equal(s.records().length, 0, label);
  }
  const files = await researchApp(t);
  writeFileSync(join(files.root, 'main.go'), 'package main');
  files.adapter().scripts.push(reply('ok'));
  await files.send(1, 'I want a notes app.');
  assert.equal(files.records().length, 0, 'a folder with code is not new');
  const generated = await researchApp(t);
  generated.adapter().scripts.push(reply('ok'));
  await generated.send(1, 'I want a notes app.', { generated: true });
  assert.equal(generated.records().length, 0, 'a generated send does not start research');
  const planned = await researchApp(t);
  planned.app.conversations.create({ id: uuid(1), projectId: planned.projectId });
  planned.app.plans.write(planned.projectId, uuid(1), '# Plan\n\nBuild it.', { by: 'owner', tainted: false, conversationId: uuid(1), runId: null });
  planned.adapter().scripts.push(reply('ok'));
  await planned.send(1, 'I want a notes app.');
  assert.equal(planned.records().length, 0, 'a product with a plan is not new');
});

test('頼みの形（守り 2・L4）: generated でない発言は決まった文と持ち主の文（2,000 字まで・添付と askAnswer と generated は無し）だけ', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a Markdown notes app.');
  s.app.conversations.append(uuid(1), { role: 'user', content: 'ZQ-ANSWER picked option', askAnswer: true });
  s.app.conversations.append(uuid(1), { role: 'user', content: 'ZQ-GENERATED text', generated: true });
  s.app.conversations.append(uuid(1), { role: 'assistant', content: 'ZQ-AI reply' });
  s.app.conversations.append(uuid(1), { role: 'user', content: 'ZQ-NOTE queued', note: 'pending' } as never);
  s.app.conversations.append(uuid(1), { role: 'user', content: `Owner words before the file\n${ATTACHMENT_OPEN}: notes.txt (text)>>>\nZQ-ATTACHED file text\n${storeText('en', 'attachment.close')}` });
  s.app.conversations.append(uuid(1), { role: 'user', content: `${'x'.repeat(2500)}` });
  await s.settle();
  const part = s.app.research.store.parts(s.records()[0]!.id)[0]!;
  const users = s.users(part.conversationId);
  assert.equal(users.length, 1);
  assert.equal(users[0]!.generated, undefined);
  const text = users[0]!.content;
  assert.ok(text.includes('I want a Markdown notes app.'));
  for (const marker of ['ZQ-ANSWER', 'ZQ-GENERATED', 'ZQ-AI']) assert.ok(!text.includes(marker), marker);
  // 印つきの行は頼みを作ったあとに足したので、絞りは ownerText の戻りで確かめる（審査 LOW）
  const owner = s.app.research.ownerText(uuid(1));
  assert.ok(owner.startsWith('I want a Markdown notes app.'));
  for (const marker of ['ZQ-ANSWER', 'ZQ-GENERATED', 'ZQ-AI', 'ZQ-NOTE', 'ZQ-ATTACHED']) assert.ok(!owner.includes(marker), marker);
  assert.ok(owner.includes('Owner words before the file'), 'the owner words next to an attachment are kept');
  assert.ok(owner.includes('xxxx'), 'a later owner message is still read');
  assert.equal(owner.length, OWNER_TEXT_MAX);
});

test('1 件ずつ（D6・M6）: 窓の小さいモデルでは自動で 1 件ずつ。部分ごとに別の会話、候補の部分は印つきで始まり、候補の名前と URL は generated の発言にだけある。前の部分の機能の名前が渡り、同じ名前は 1 行にまとまって定番になる', async t => {
  const s = await researchApp(t, { contextLength: 24_000 });
  s.adapter().scripts.push(
    reply('ok'),
    toolCall('web_search', { query: 'markdown notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Alpha Notes', url: ALPHA }),
    toolCall('research_record', { kind: 'candidate', name: 'Beta App', url: BETA }),
    reply('two candidates'),
    toolCall('web_fetch', { url: ALPHA }),
    toolCall('web_fetch', { url: BETA }),
    toolCall('research_record', { kind: 'similar', name: 'Alpha Notes', url: ALPHA }),
    toolCall('research_record', { kind: 'feature', name: 'Live Markdown preview', evidence: [{ url: ALPHA, quote: 'It has Live Markdown preview and Tag search for notes.' }] }),
    reply('alpha done'),
    toolCall('web_fetch', { url: BETA }),
    toolCall('research_record', { kind: 'similar', name: 'Beta App', url: BETA }),
    toolCall('research_record', { kind: 'feature', name: 'Live Markdown preview', evidence: [{ url: BETA, quote: 'It has Live Markdown preview and Tag search for notes.' }] }),
    reply('beta done'),
  );
  await s.send(1, 'I want a Markdown notes app.');
  await s.settle();
  const record = s.records()[0]!;
  assert.equal(record.mode, 'one_by_one');
  const parts = s.app.research.store.parts(record.id);
  assert.deepEqual(parts.map(p => p.kind), ['first', 'candidate', 'candidate']);
  assert.equal(new Set(parts.map(p => p.conversationId)).size, 3);
  const first = s.app.conversations.messages(parts[0]!.conversationId);
  assert.ok(s.adapter().calls.some(call => call.tools.map(tool => tool.name).sort().join() === 'research_record,web_search'));
  assert.ok(first.length > 0);
  assert.equal(s.app.runs.get(parts[0]!.runId!)!.tainted, 1);
  for (const [i, part] of parts.slice(1).entries()) {
    assert.equal(s.app.runs.get(part.runId!)!.tainted, 1, 'a candidate part starts tainted');
    const users = s.users(part.conversationId);
    assert.equal(users[0]!.generated, undefined);
    assert.ok(!users[0]!.content.includes(i === 0 ? ALPHA : BETA), 'the candidate URL is not in the non-generated prompt');
    assert.equal(users[1]!.generated, true);
    assert.ok(users[1]!.content.includes(i === 0 ? ALPHA : BETA));
  }
  assert.ok(s.users(parts[2]!.conversationId)[1]!.content.includes('Live Markdown preview'), 'the second candidate part is told the feature names so far');
  const alphaFetches = s.tools(parts[1]!.conversationId).filter(m => m.name === 'web_fetch');
  assert.deepEqual(alphaFetches.map(m => m.isError === true), [false, true], 'a candidate part opens its own URL, not another candidate URL');
  const features = s.app.research.store.items(record.id).filter(i => i.kind === 'feature');
  assert.equal(features.length, 1);
  assert.equal(features[0]!.default_reason, 'standard');
});

test('ボタン（R3.12）: 持ち主の口で何度でも始められる（前が終わっていれば）。動いている間は 409、Origin の無い呼び出しは断られる', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(reply(`part ${i}`));
    const started = await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await s.settle();
  }
  assert.equal(s.records().length, 3);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  s.adapter().scripts.push(async function* () { await hold; yield { type: 'text', delta: 'slow' }; yield { type: 'done', stop: 'end_turn' }; });
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 409);
  const bare = await fetch(`${s.origin}/api/projects/${s.projectId}/research`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: uuid(1) }) });
  assert.ok(bare.status === 403 || bare.status === 401, String(bare.status));
  release();
  await s.settle();
});

test('始める道は持ち主の口だけ（R3.12・R3.13 の 3）: 持ち主の印が無い・きっかけが違うと断る。engine.send・タスク・道具からは始まらない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('ok'));
  const sent = s.app.engine.send(uuid(5), 'I want a notes app.', [], [], {}, { projectId: s.projectId });
  assert.ok(sent.ok);
  await waitFor(() => !s.app.engine.chatting, 'chat ended');
  assert.equal(s.records().length, 0, 'engine.send does not start research');
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code; } };
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(5), trigger: 'owner_button', owner: {} as OwnerAct })), 'not_owner');
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(5), trigger: 'tool' as never, owner: new OwnerAct() })), 'not_owner');
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(5), trigger: 'owner_confirm', owner: new OwnerAct() })), 'not_owner', 'owner_confirm cannot start a products record');
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(5), trigger: 'owner_confirm', owner: new OwnerAct(), phase: 'libraries' })), 'not_owner', 'owner_confirm only from the confirm route');
  assert.equal(code(() => s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(5), trigger: 'owner_button', owner: new OwnerAct(), phase: 'libraries' })), 'not_owner');
  assert.deepEqual(builtinTools().map(tool => tool.name).filter(name => name.includes('research')), ['research_record']);
  assert.equal(s.records().length, 0);
});

test('飛ばす: 動いている記録を止めて skipped にし、次から自動では始まらない', async t => {
  let release!: () => void;
  const s = await researchApp(t, { hold: { search: new Promise<void>(resolve => { release = resolve; }) } });
  s.adapter().scripts.push(reply('ok'), toolCall('web_search', { query: 'notes' }), reply('never'));
  await s.send(1, 'I want a notes app.');
  await waitFor(() => s.records().length === 1 && s.app.research.store.parts(s.records()[0]!.id)[0]?.runId != null, 'part running');
  const skipped = await s.json(`/api/research/${s.records()[0]!.id}/skip`, 'POST', {});
  release();
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(skipped.body.research.status, 'skipped');
  s.adapter().scripts.push(reply('more'));
  await s.send(1, 'more');
  assert.equal(s.records().length, 1);
});

test('止まる（守り 4・R3.13 の 4）: 部分の中で例外が出ても記録は failed で終わり、ボタンで次を始められる。再起動の片付けで running は failed', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  const original = s.app.engine.runResearch.bind(s.app.engine);
  s.app.engine.runResearch = () => { throw new Error('boom'); };
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  assert.equal(s.records()[0]!.status, 'failed');
  s.app.engine.runResearch = original;
  s.adapter().scripts.push(reply('fine'));
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  assert.equal(s.records()[0]!.status, 'done');
  s.app.db.prepare("INSERT INTO research_runs (id, project_id, phase, mode, status, created_at) VALUES ('stale', ?, 'products', 'batch', 'running', 1)").run(s.projectId);
  assert.equal(s.app.research.recover(), 1);
  assert.equal(s.app.research.store.get('stale')!.status, 'failed');
});

test('譲る（D5・P-R3-7）: 会話を送ると同じ提供元の調べる部分が止まり、会話が終わってから同じ調べる会話で続きが始まる。開けたページの表は続きに引き継がれる', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  s.adapter().scripts.push(
    toolCall('web_search', { query: 'notes' }),
    toolCall('web_fetch', { url: ALPHA }),
    async function* (req) { entered(); await new Promise<void>((resolve, reject) => { const signal = (req as { signal?: AbortSignal }).signal; signal?.addEventListener('abort', () => reject(new Error('aborted'))); setTimeout(resolve, 3000); }); yield { type: 'text', delta: 'late' }; yield { type: 'done', stop: 'end_turn' }; },
  );
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await inside;
  s.adapter().scripts.push(reply('chat answer'), toolCall('research_record', { kind: 'similar', name: 'Alpha Notes', url: ALPHA }), reply('continued'));
  await s.send(2, 'another question');
  await s.settle();
  const record = s.records()[0]!;
  const parts = s.app.research.store.parts(record.id);
  assert.equal(parts.length, 1);
  const users = s.users(parts[0]!.conversationId);
  assert.equal(users.at(-1)!.content, 'Continue the research from where it stopped.');
  assert.equal(users.at(-1)!.generated, true);
  assert.deepEqual(s.app.research.store.items(record.id).map(i => i.name_or_label), ['Alpha Notes'], 'the page opened before yielding is still known to the continuation');
});

test('D14: 記録があるときだけ、計画の会話の tail の状態の行に数と状態が出る（名前は出ない）', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('first'), ...BATCH_PART(), reply('second'));
  await s.send(1, 'I want a notes app.');
  const firstTail = s.adapter().calls[0]!.system.tail ?? '';
  assert.ok(!firstTail.includes('research before building'), 'the first request has no research line');
  await s.settle();
  await s.send(1, 'ok');
  const tail = s.adapter().calls.at(-1)!.system.tail ?? '';
  assert.match(tail, /research before building: 1 rows waiting for the owner/u);
  assert.ok(!tail.includes('Alpha Notes'));
});

// beat R の審査（MEDIUM-1）: 待つところ（きっかけの返事・会話が空くのを待つ）で止められても、飛ばす・消すはすぐ返る
const held = (hold: Promise<void>, entered?: () => void) => async function* (req: unknown) {
  entered?.();
  const signal = (req as { signal?: AbortSignal }).signal;
  await new Promise<void>((resolve, reject) => { if (signal?.aborted) reject(new Error('aborted')); signal?.addEventListener('abort', () => reject(new Error('aborted'))); void hold.then(resolve); });
  yield { type: 'text' as const, delta: 'late' };
  yield { type: 'done' as const, stop: 'end_turn' as const };
};

test('飛ばす（MEDIUM-1）: きっかけの返事を待っているあいだ（部分 0）でも、飛ばすはすぐ skipped で返る', async t => {
  const s = await researchApp(t);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  s.adapter().scripts.push(held(hold));
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'I want a notes app.', projectId: s.projectId });
  assert.equal(sent.status, 202);
  await waitFor(() => s.records()[0]?.status === 'running' && s.app.research.store.parts(s.records()[0]!.id).length === 0, 'record waiting for the reply');
  const res = await s.api(`/api/research/${s.records()[0]!.id}/skip`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { research: { status: string } }).research.status, 'skipped');
  assert.equal(s.app.engine.chatting, true, 'the reply is still being written');
  release();
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.research.store.parts(s.records()[0]!.id).length, 0, 'no part starts after the skip');
});

test('会話を消す（MEDIUM-1）: 調べる部分がほかの会話の返事に譲って待っているあいだでも、元の会話を消すとすぐ返り、記録は cancelled', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  s.adapter().scripts.push(held(new Promise(() => undefined), entered));
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await inside;
  s.adapter().scripts.push(held(hold));
  const other = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: 'another question', projectId: s.projectId });
  assert.equal(other.status, 202);
  const record = s.records()[0]!;
  await waitFor(() => { const runId = s.app.research.store.parts(record.id)[0]?.runId; return runId != null && s.app.runs.get(runId)?.ended_at != null; }, 'the research part yielded');
  const res = await s.api(`/api/conversations/${uuid(1)}`, { method: 'DELETE', signal: AbortSignal.timeout(1000) });
  assert.equal(res.status, 200);
  assert.equal(s.app.research.store.get(record.id)!.status, 'cancelled');
  release();
  await settled(s.app, other.body.runId);
  assert.equal(s.app.research.store.parts(record.id).length, 1, 'no continuation after the delete');
});

test('会話を消す（LOW-3）: 止めて待つあいだにボタンから始まった記録も、消す前に止める', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  s.adapter().scripts.push(held(new Promise(() => undefined)));
  const original = s.app.research.stopForSource.bind(s.app.research);
  let first = true;
  s.app.research.stopForSource = async id => {
    await original(id);
    if (!first) return;
    first = false;
    s.app.research.start({ projectId: s.projectId, sourceConversationId: uuid(1), trigger: 'owner_button', owner: new OwnerAct() });
  };
  const res = await s.api(`/api/conversations/${uuid(1)}`, { method: 'DELETE', signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 200);
  assert.equal(s.records().length, 1);
  assert.deepEqual(s.records().map(r => r.status), ['cancelled'], 'the record started meanwhile is not left running');
  await Promise.all(s.records().map(r => s.app.research.waitFor(r.id)));
});

test('閉じる（LOW-4）: 記録が返事を待っているあいだに App を閉じても、閉じた DB に書きに行かず、拒否が残らない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(held(new Promise(() => undefined)));
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'I want a notes app.', projectId: s.projectId });
  assert.equal(sent.status, 202);
  await waitFor(() => s.records()[0]?.status === 'running', 'record waiting for the reply');
  const id = s.records()[0]!.id;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => { process.off('unhandledRejection', onRejection); });
  const close = s.app.close.bind(s.app);
  s.app.close = () => undefined;
  close();
  await s.app.research.waitFor(id);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(rejections.map(r => String(r)), []);
  assert.ok(!s.logs.some(line => line.includes(`research ${id}`)), s.logs.filter(line => line.includes('research')).join('\n'));
});

test('ボタンの元の会話（審査 LOW-5）: タスクの会話・ほかの製品の会話・無い会話からは始まらない（409）', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.app.conversations.create({ id: uuid(7), kind: 'task', title: 'A task', projectId: s.projectId });
  mkdirSync(join(s.root, '..', 'Other'), { recursive: true });
  const other = (await s.json('/api/projects', 'POST', { root: join(s.root, '..', 'Other') })).body.project.id as string;
  s.app.conversations.create({ id: uuid(8), projectId: other });
  for (const [label, id] of [['task conversation', uuid(7)], ['other product', uuid(8)], ['missing', uuid(9)]] as const) {
    const out = await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: id });
    assert.equal(out.status, 409, `${label}: ${JSON.stringify(out.body)}`);
  }
  assert.equal(s.records().length, 0);
});

test('libraries の段（審査 LOW-5）: いちばん新しい products の記録が確定していなければ、古い記録を確定しても libraries は始まらない', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  for (const text of ['first', 'second']) {
    s.adapter().scripts.push(reply(text));
    assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
    await s.settle();
  }
  const older = s.records().at(-1)!;
  assert.equal(s.records().length, 2);
  const out = await s.json(`/api/research/${older.id}/confirm`, 'POST', { shownHash: s.app.research.store.shownHash(older.id), picks: [] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(!out.body.libraries, 'no libraries record in the reply');
  assert.equal(s.records().filter(r => r.phase === 'libraries').length, 0);
  assert.ok(s.logs.some(line => line.includes('the libraries research did not start')));
});

test('確定（審査 LOW-5）: 持ち主の印が無い確定は断る', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'), reply('part'));
  await s.send(1, 'I want a notes app.');
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  const record = s.records()[0]!;
  assert.throws(() => s.app.research.confirm(record.id, { shownHash: s.app.research.store.shownHash(record.id), picks: [] }, {} as OwnerAct), (error: { code?: string }) => error.code === 'not_owner');
  assert.equal(s.app.research.store.get(record.id)!.status, 'done');
});

test('譲る（B1）: 道具を呼んだ直後に譲っても、続きの部分は結果の無い呼び出しで断られず、記録は partial にならない', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  s.adapter().strictToolPairs = true;
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  s.adapter().scripts.push(async function* (req) {
    yield { type: 'tool_call' as const, call: { id: 'call_y', name: 'web_search', arguments: { query: 'notes' } } };
    yield { type: 'done' as const, stop: 'tool_use' as const };
    entered();
    const signal = (req as { signal?: AbortSignal }).signal;
    await new Promise<void>(resolve => { if (!signal || signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  });
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await inside;
  s.adapter().scripts.push(reply('chat answer'), reply('continued'));
  await s.send(2, 'another question');
  await s.settle();
  const record = s.records()[0]!;
  const runs = (s.app.db.prepare('SELECT ok, error_message FROM engine_runs WHERE conversation_id = ? ORDER BY started_at').all(s.app.research.store.parts(record.id)[0]!.conversationId) as Array<{ ok: number; error_message: string | null }>);
  assert.equal(runs.length, 2, 'the part yielded once and continued');
  assert.equal(runs[1]!.ok, 1, runs[1]!.error_message ?? '');
  assert.deepEqual([record.status, record.partial], ['done', 0]);
});

test('止まり方（B1）: 部分の実行が提供元の誤りで終わると、記録は「上限で止まった」ではなく failed', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  const broken = () => fail(new ProviderError('provider_error', 'http 400', { retryable: false }));
  s.adapter().scripts.push(broken(), broken());
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.stop_reason, record.partial], ['failed', 'failed', 0]);
});

test('止まり方（B1）: 持ち主が部分の実行を止めると、記録は partial で、理由は stopped', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  s.adapter().scripts.push(async function* (req) {
    entered();
    const signal = (req as { signal?: AbortSignal }).signal;
    await new Promise<void>((_, reject) => { if (signal?.aborted) reject(new Error('aborted')); signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    yield { type: 'done' as const, stop: 'end_turn' as const };
  });
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await inside;
  const runId = s.app.research.store.parts(s.records()[0]!.id)[0]!.runId!;
  assert.equal((await s.json(`/api/runs/${runId}/stop`, 'POST', {})).status, 200);
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.partial, record.stop_reason], ['done', 1, 'stopped']);
});

test('検索ができない（B3）: どの検索も断られた記録は「何も無かった」ではなく failed・search_blocked で、知らせもそう言う', async t => {
  const s = await researchApp(t, { blockSearch: true, configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes app' }), toolCall('web_search', { query: 'markdown notes' }), reply('Nothing found.'));
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.stop_reason, s.app.research.store.items(record.id).length], ['failed', 'search_blocked', 0]);
  const notice = s.app.notifications.list().find(n => n.title.includes('could not search the web'));
  assert.ok(notice, s.app.notifications.list().map(n => n.title).join('\n'));
  assert.ok(!(notice.body ?? '').includes('rows are waiting'));
  const view = await s.json(`/api/projects/${s.projectId}/research`, 'GET');
  assert.equal(view.body.products.stopReason, 'search_blocked');
});

// 止められた先は休むので、「ほかが答えた」を見るには検索先を 2 つにする（1 つ目の頼みだけが止められる）
test('検索ができない（B3）: 一部の検索だけ断られ、ほかが答えたなら search_blocked にしない（done）', async t => {
  const s = await researchApp(t, { blockSearch: 1, configure: c => { c.research = { when: 'button' }; c.tools.web.engines = ['duckduckgo-html', 'bing']; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes app' }), toolCall('web_search', { query: 'markdown notes' }), reply('Nothing to record.'));
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.stop_reason], ['done', null]);
});

test('検索ができない（B3）: 結果 0 件で答えた検索は「見つからなかった」のまま（done）。ほかの検索が断られても', async t => {
  const s = await researchApp(t, { blockSearch: 1, emptySearch: true, configure: c => { c.research = { when: 'button' }; c.tools.web.engines = ['duckduckgo-html', 'bing']; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes app' }), toolCall('web_search', { query: 'markdown notes' }), reply('Nothing to record.'));
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.stop_reason], ['done', null]);
});

test('検索ができない（B3）: 検索が全部断られたまま時間切れで止まっても、理由は search_blocked（時間切れではない）', async t => {
  let clock = Date.now();
  const s = await researchApp(t, { blockSearch: true, now: () => clock, configure: c => { c.research = { when: 'button' }; } });
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app.');
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes app' }), async function* (req) {
    entered();
    const signal = (req as { signal?: AbortSignal }).signal;
    await new Promise<void>((_, reject) => { if (signal?.aborted) reject(new Error('aborted')); signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    yield { type: 'done' as const, stop: 'end_turn' as const };
  });
  assert.equal((await s.json(`/api/projects/${s.projectId}/research`, 'POST', { conversationId: uuid(1) })).status, 202);
  await inside;
  clock += 24 * 60 * 60_000;
  s.adapter().scripts.push(reply('chat answer'));
  await s.send(2, 'another question');
  await s.settle();
  const record = s.records()[0]!;
  assert.deepEqual([record.status, record.stop_reason], ['failed', 'search_blocked']);
});

test('止まり方（B1）: 1 件ずつのとき、候補の部分が提供元の誤りで失敗しても残りの候補を調べ、記録は done・partial・part_failed', async t => {
  const s = await researchApp(t, { contextLength: 24_000 });
  const broken = () => fail(new ProviderError('provider_error', 'http 400', { retryable: false }));
  s.adapter().scripts.push(
    reply('ok'),
    toolCall('web_search', { query: 'markdown notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Alpha Notes', url: ALPHA }),
    toolCall('research_record', { kind: 'candidate', name: 'Beta App', url: BETA }),
    reply('two candidates'),
    broken(), broken(),
    toolCall('web_fetch', { url: BETA }),
    toolCall('research_record', { kind: 'similar', name: 'Beta App', url: BETA }),
    reply('beta done'),
  );
  await s.send(1, 'I want a Markdown notes app.');
  await s.settle();
  const record = s.records()[0]!;
  assert.equal(record.mode, 'one_by_one');
  assert.deepEqual(s.app.research.store.parts(record.id).map(p => [p.kind, p.end]), [['first', 'done'], ['candidate', 'failed'], ['candidate', 'done']]);
  assert.deepEqual([record.status, record.partial, record.stop_reason], ['done', 1, 'part_failed']);
  assert.deepEqual(s.app.research.store.items(record.id).filter(i => i.kind === 'similar').map(i => i.name_or_label), ['Beta App']);
});

test('止まり方（B1）: 1 件ずつのとき、どの部分も提供元の誤りで失敗したら記録は failed', async t => {
  const s = await researchApp(t, { contextLength: 24_000 });
  const broken = () => fail(new ProviderError('provider_error', 'http 400', { retryable: false }));
  s.adapter().scripts.push(reply('ok'), broken(), broken());
  await s.send(1, 'I want a Markdown notes app.');
  await s.settle();
  const record = s.records()[0]!;
  assert.equal(record.mode, 'one_by_one');
  assert.deepEqual(s.app.research.store.parts(record.id).map(p => [p.kind, p.end]), [['first', 'failed']]);
  assert.deepEqual([record.status, record.stop_reason, record.partial], ['failed', 'failed', 0]);
});

test('止まり方（B1）: 1 件ずつのとき、最初の部分が失敗し、候補の部分は時間切れで始まらなかったら、始まらなかった部分を数えず記録は failed（partial なし）', async t => {
  let clock = Date.now();
  const s = await researchApp(t, { contextLength: 24_000, now: () => clock });
  const brokenLate = (): Script => async function* () { clock += 24 * 60 * 60_000; throw new ProviderError('provider_error', 'http 400', { retryable: false }); };
  s.adapter().scripts.push(
    reply('ok'),
    toolCall('web_search', { query: 'markdown notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Alpha Notes', url: ALPHA }),
    brokenLate(), brokenLate(),
  );
  await s.send(1, 'I want a Markdown notes app.');
  await s.settle();
  const record = s.records()[0]!;
  assert.equal(record.mode, 'one_by_one');
  assert.deepEqual(s.app.research.store.parts(record.id).map(p => [p.kind, p.end]), [['first', 'failed']], 'the candidate part never started');
  assert.deepEqual([record.status, record.stop_reason, record.partial], ['failed', 'failed', 0]);
});

test('自動の始まり: 外の実行役に結ばれた会話を元にしては始まらない（確定が runtime_source で断られるので、提供元のトークンを無駄にしない）。結ばれていなければ、同じ状態から始まる', async t => {
  const s = await researchApp(t);
  s.app.conversations.create({ id: uuid(1), projectId: s.projectId });
  s.app.conversations.append(uuid(1), { role: 'user', content: 'I want a Markdown notes app.' });
  assert.equal(s.app.conversations.bindRuntime(uuid(1), 'claude-code'), true);
  const input = { projectId: s.projectId, sourceConversationId: uuid(1), owner: new OwnerAct() };
  assert.equal(await s.app.research.autoStart(input), undefined);
  assert.equal(s.records().length, 0, 'no record was made');
  assert.equal(s.adapter().calls.length, 0, 'no provider model was called');

  s.app.db.prepare('UPDATE conversations SET runtime_id = NULL WHERE id = ?').run(uuid(1));
  s.adapter().scripts.push(reply('Recorded.'));
  const started = await s.app.research.autoStart(input);
  assert.ok(started, 'the same product and conversation start research once the conversation is not bound to a runtime');
  await s.settle();
});
