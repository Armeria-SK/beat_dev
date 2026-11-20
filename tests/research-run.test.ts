import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ownerSpeech } from '../src/db/conversations.ts';
import { OwnerAct, OWNER_TEXT_MAX } from '../src/research/run.ts';
import { uuid, waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
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
  s.app.conversations.append(uuid(1), { role: 'user', content: `${'x'.repeat(2500)}` });
  await s.settle();
  const part = s.app.research.store.parts(s.records()[0]!.id)[0]!;
  const users = s.users(part.conversationId);
  assert.equal(users.length, 1);
  assert.equal(users[0]!.generated, undefined);
  const text = users[0]!.content;
  assert.ok(text.includes('I want a Markdown notes app.'));
  for (const marker of ['ZQ-ANSWER', 'ZQ-GENERATED', 'ZQ-AI']) assert.ok(!text.includes(marker), marker);
  assert.ok(s.app.research.ownerText(uuid(1)).length <= OWNER_TEXT_MAX);
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
