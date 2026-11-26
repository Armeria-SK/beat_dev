import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { Conversations, ownerSpeech } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import { askedCards, buildDraft, coverageOf, prepareSpeech, SCAN_BUDGET, verifySource, type ClaimedSource } from '../src/projects/acceptance.ts';
import { ResearchStore } from '../src/research/store.ts';
import { previewJson } from '../src/shared/json-preview.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { redactJsonValue } from '../src/shared/redaction.ts';
import { ATTACHMENT_OPEN } from '../src/uploads/store.ts';
import { answerText, parseAsk } from '../web/src/ui/ask.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, withLoad, type Script } from './helpers.ts';
import { researchApp } from './helpers/research-app.ts';

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';

const STORAGE = 'Which storage should the app use?';
const ASK = {
  questions: [
    { question: STORAGE, header: 'Storage', options: [{ label: 'SQLite (Recommended)', description: 'One file next to the app' }, { label: 'JSON files' }] },
    { question: 'Which screens come first?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }, { label: 'Settings' }] },
  ],
};

function fixture() {
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1;
  let calls = 0;
  const conversations = new Conversations(db, () => clock++);
  const chat = (projectId: string | null = PROJECT) => conversations.create({ projectId }).id;
  const say = (conversationId: string, message: ChatMessage) => conversations.append(conversationId, message).id;
  const owner = (conversationId: string, content: string, extra: Record<string, unknown> = {}) => say(conversationId, { role: 'user', content, ...extra } as ChatMessage);
  const ask = (conversationId: string, input: unknown = ASK) => {
    const id = `call_${++calls}`;
    say(conversationId, { role: 'assistant', content: '', toolCalls: [{ id, name: 'ask_owner', arguments: input }] });
    return say(conversationId, { role: 'tool', toolCallId: id, name: 'ask_owner', content: 'The owner sees the questions as a card.' });
  };
  const speech = (projectId = PROJECT) => prepareSpeech(ownerSpeech(db, projectId), SCAN_BUDGET, [], askedCards(db, projectId));
  const check = (claimed: ClaimedSource) => verifySource(speech(), claimed);
  return { db, chat, say, owner, ask, speech, check };
}

const choice = (question: string, answer: string): ClaimedSource => ({ kind: 'owner_choice', question, answer });
const unverified = (question: string, answer: string) => ({ kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question, answer });
const CARD_ANSWER = (storage: string, screens: string) => `Answers:\n- Storage: ${storage}\n- Screens: ${screens}`;

test('ask_owner の答え（L803）: 持ち主が札で選んだ選択肢は owner_choice になり、札の問い・選んだ文・両方の発言の番号・会話が付く', () => {
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c);
  const answer = f.owner(c, CARD_ANSWER('JSON files', 'List, Detail'), { askAnswer: true });
  const expected = (question: string, option: string) => ({ kind: 'owner_choice', question, questionMessageId: asked, answer: option, answerMessageId: answer, conversationId: c });
  assert.deepEqual(f.check(choice(STORAGE, 'JSON files')), expected(STORAGE, 'JSON files'));
  assert.deepEqual(f.check(choice('which STORAGE should the app use?', ' json files ')), expected(STORAGE, 'JSON files'), '大文字小文字と空白の違いは同じ（札の文を残す）');
  assert.deepEqual(f.check(choice('Which screens come first?', 'Detail')), expected('Which screens come first?', 'Detail'), '複数選べる問いは、選んだどれでも');
});

test('ask_owner の答え（L803）: 札の "(Recommended)" は、書いても書かなくても同じ選択肢', () => {
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c);
  const answer = f.owner(c, CARD_ANSWER('SQLite (Recommended)', 'List'), { askAnswer: true });
  const expected = { kind: 'owner_choice', question: STORAGE, questionMessageId: asked, answer: 'SQLite (Recommended)', answerMessageId: answer, conversationId: c };
  assert.deepEqual(f.check(choice(STORAGE, 'SQLite')), expected);
  assert.deepEqual(f.check(choice(STORAGE, 'SQLite (Recommended)')), expected);
});

test('ask_owner の答え（L803・反対の試験）: 選んでいない選択肢・札に無い問い・問いや選択肢の一部・形が違う答えは、持ち主の選びにならない', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c);
  f.owner(c, CARD_ANSWER('JSON files', 'List, Detail'), { askAnswer: true });
  for (const [question, answer] of [
    [STORAGE, 'SQLite'],
    [STORAGE, 'Postgres'],
    ['Which screens come first?', 'Settings'],
    ['Should the app delete all data?', 'JSON files'],
    ['Which storage should the app', 'JSON files'],
    ['Which storage should the app use? And is it fast?', 'JSON files'],
    [STORAGE, 'JSON'],
    [STORAGE, 'files'],
    [STORAGE, 'JSON files, SQLite'],
  ] as const) assert.deepEqual(f.check(choice(question, answer)), unverified(question, answer), `${question} / ${answer}`);
});

test('ask_owner の答え（L803・反対の試験）: 自分で書いた文（Something else）が混じる答えは、選んだと言わない。書いた文そのものも owner_choice にしない', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c);
  f.owner(c, CARD_ANSWER('Postgres', 'List, a map view'), { askAnswer: true });
  for (const [question, answer] of [[STORAGE, 'Postgres'], ['Which screens come first?', 'List'], ['Which screens come first?', 'a map view'], ['Which screens come first?', 'List, a map view']] as const) {
    assert.deepEqual(f.check(choice(question, answer)), unverified(question, answer), `${question} / ${answer}`);
  }
  const two = fixture();
  const tc = two.chat();
  two.ask(tc);
  two.owner(tc, CARD_ANSWER('SQLite (Recommended), JSON files', 'List'), { askAnswer: true });
  assert.deepEqual(two.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), '1 つしか選べない問いに 2 つ並んだ答えは、札の答えの形ではない');
});

test('ask_owner の答え（L803・反対の試験）: 札の答えに数えない発言（印が無い・AI が作った・まだ答えていない・別の製品の札・形が違う）では、選びにならない', () => {
  const plain = fixture();
  const pc = plain.chat();
  plain.ask(pc);
  plain.owner(pc, CARD_ANSWER('JSON files', 'List'));
  assert.deepEqual(plain.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), 'askAnswer の印が無い発言は、同じ文でも札の答えにしない');

  const generated = fixture();
  const gc = generated.chat();
  generated.ask(gc);
  generated.owner(gc, CARD_ANSWER('JSON files', 'List'), { askAnswer: true, generated: true });
  assert.deepEqual(generated.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), 'AI が作った発言は持ち主の答えではない');
  assert.deepEqual(askedCards(generated.db, PROJECT).map(card => card.answerMessageId), [null], '札の側でも、AI が作った発言は答えに数えない');

  const waiting = fixture();
  const wc = waiting.chat();
  waiting.ask(wc);
  assert.deepEqual(waiting.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), 'まだ答えていない札');

  const late = fixture();
  const lc = late.chat();
  late.ask(lc);
  late.owner(lc, 'Let me think about it first');
  late.owner(lc, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  assert.deepEqual(late.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), '札のあとの最初の持ち主の発言が札の答えでなければ、そのあとの発言は答えにしない');

  const elsewhere = fixture();
  const ec = elsewhere.chat(OTHER);
  elsewhere.ask(ec);
  elsewhere.owner(ec, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  assert.deepEqual(elsewhere.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), '別の製品の札');

  for (const answer of ['Answers:\n- Storage: JSON files', 'JSON files', `${CARD_ANSWER('JSON files', 'List')}\n- Extra: yes`, 'Answers:\n- Screens: List\n- Storage: JSON files']) {
    const shaped = fixture();
    const sc = shaped.chat();
    shaped.ask(sc);
    shaped.owner(sc, answer, { askAnswer: true });
    assert.deepEqual(shaped.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), JSON.stringify(answer));
  }
});

test('ask_owner の答え（L803・反対の試験）: AI が文章に書いた問いと選択肢、誤りで返った札、持ち主の「A」だけの返事は、選びにならない', () => {
  const f = fixture();
  const c = f.chat();
  f.say(c, { role: 'assistant', content: `1. ${STORAGE}\nA) SQLite\nB) JSON files` });
  f.owner(c, 'A');
  assert.deepEqual(f.check(choice(STORAGE, 'A')), unverified(STORAGE, 'A'));
  assert.deepEqual(f.check(choice(STORAGE, 'SQLite')), unverified(STORAGE, 'SQLite'));
  const id = 'call_failed';
  f.say(c, { role: 'assistant', content: '', toolCalls: [{ id, name: 'ask_owner', arguments: ASK }] });
  f.say(c, { role: 'tool', toolCallId: id, name: 'ask_owner', content: 'Call it once', isError: true });
  f.owner(c, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  assert.deepEqual(f.check(choice(STORAGE, 'JSON files')), unverified(STORAGE, 'JSON files'), '見せていない札');
});

test('ask_owner の答え（L803）: 新しい札の答えを先に当て、古い札の答えも残る', () => {
  const f = fixture();
  const c = f.chat();
  const first = f.ask(c);
  const firstAnswer = f.owner(c, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  f.owner(c, 'Uploads must resume after a restart, please');
  const second = f.ask(c, { questions: [{ question: STORAGE, header: 'Storage', options: [{ label: 'SQLite' }, { label: 'JSON files' }] }] });
  const secondAnswer = f.owner(c, 'Answers:\n- Storage: JSON files', { askAnswer: true });
  assert.deepEqual(f.check(choice(STORAGE, 'JSON files')), { kind: 'owner_choice', question: STORAGE, questionMessageId: second, answer: 'JSON files', answerMessageId: secondAnswer, conversationId: c });
  assert.deepEqual(f.check(choice('Which screens come first?', 'List')), { kind: 'owner_choice', question: 'Which screens come first?', questionMessageId: first, answer: 'List', answerMessageId: firstAnswer, conversationId: c });
});

const LONG_A = 'Keep every note in plain JSON files';
const LONG_B = 'Use one SQLite database file';
const ASK_LONG = {
  questions: [
    { question: STORAGE, header: 'Storage layout', options: [{ label: LONG_A }, { label: LONG_B }] },
    { question: 'Which screens come first?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }] },
  ],
};
const words = (quote: string): ClaimedSource => ({ kind: 'owner_words', quote });
const notFound = (quote: string) => ({ kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote });

test('札の答えの中の AI の文（P-R3-8）: 選択肢・見出しの文にしかない引用は owner_words として断り、選んだ選択肢としては owner_choice で認める', () => {
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c, ASK_LONG);
  const answer = f.owner(c, `Answers:\n- Storage layout: ${LONG_A}\n- Screens: List`, { askAnswer: true });
  for (const quote of [LONG_A, 'keep every note in plain', 'Storage layout: Keep every note', 'Answers:\n- Storage layout: Keep every note in plain JSON files']) {
    assert.deepEqual(f.check(words(quote)), notFound(quote), quote);
  }
  assert.deepEqual(f.check(choice(STORAGE, LONG_A)), { kind: 'owner_choice', question: STORAGE, questionMessageId: asked, answer: LONG_A, answerMessageId: answer, conversationId: c });
  assert.deepEqual(f.check(choice(STORAGE, LONG_B)), unverified(STORAGE, LONG_B), '選んでいない選択肢は、AI が足したのまま');
});

test('札の答えの中の AI の文（P-R3-8）: 持ち主が書いた文（Something else・札が開いている間の自由な返事）は、これまでどおり owner_words で当たる', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c, ASK_LONG);
  const typedAnswer = f.owner(c, 'Answers:\n- Storage layout: Postgres with a hosted backup\n- Screens: List, a map view of every note', { askAnswer: true });
  const free = f.owner(c, 'Notes must stay readable offline, whatever happens', { askAnswer: true });
  const hit = (quote: string) => { const source = f.check(words(quote)); return source.kind === 'owner_words' ? [source.quote, source.messageId] : source; };
  assert.deepEqual(hit('postgres with a hosted backup'), ['Postgres with a hosted backup', typedAnswer]);
  assert.deepEqual(hit('a map view of every note'), ['a map view of every note', typedAnswer]);
  assert.deepEqual(hit('notes must stay readable offline'), ['Notes must stay readable offline', free]);
  assert.deepEqual(f.check(words('a hosted backup of every note')), notFound('a hosted backup of every note'), '札の文を抜いた前後をつないだ引用は当てない');
});

test('札の答えの中の AI の文（P-R3-8）: 札が見つからない「答え」の印の発言は、持ち主の言葉に数えない。印の無い発言と、ふつうの持ち主の言葉は変わらない', () => {
  const f = fixture();
  const c = f.chat();
  f.owner(c, 'Uploads must resume after a restart, please');
  f.owner(c, 'Exports must keep the original file names', { askAnswer: true });
  const typed = f.owner(c, 'Notes must stay readable offline, whatever happens');
  const hit = (quote: string) => { const source = f.check(words(quote)); return source.kind === 'owner_words' ? source.messageId : source; };
  assert.deepEqual(f.check(words('exports must keep the original file names')), notFound('exports must keep the original file names'));
  assert.equal(hit('notes must stay readable offline'), typed);
  assert.equal(typeof hit('uploads must resume after a restart'), 'number');
});

test('ask_owner の答え（L803）: 下書きでは持ち主の選びとして数えられ、受け入れの一覧の「まだ引用されていない発言」から外れる', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c);
  const answer = f.owner(c, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  const input = { items: [{ result: 'Notes are kept in JSON files', source: choice(STORAGE, 'JSON files'), check: { kind: 'look' as const } }, { result: 'Notes are kept in SQLite', source: choice(STORAGE, 'SQLite'), check: { kind: 'look' as const } }] };
  const { doc, verified, changed } = buildDraft(input, f.speech(), { language: null, taintedRuns: [] });
  assert.equal(verified, 1);
  assert.deepEqual(changed, { choice_unverified: 1 });
  assert.equal(doc.items[0]!.source.kind, 'owner_choice');
  assert.equal(doc.items[1]!.source.kind, 'ai_added');
  const coverage = coverageOf(doc, ownerSpeech(f.db, PROJECT));
  assert.equal(coverage.owner_choice, 1);
  assert.equal(coverage.ai_added, 1);
  assert.ok(!coverage.unreferenced.some(row => row.message_id === answer), '引用した答えは「引用されていない発言」に出ない');
});

const reasons = (store: ResearchStore, source: string, labels: readonly string[]) => {
  const run = store.start({ projectId: 'p1', phase: 'products', mode: 'batch', sourceConversationId: source });
  for (const label of labels) store.addFeature(run.id, { label, evidence: [] });
  store.finish(run.id, 'done');
  return Object.fromEntries(store.items(run.id).filter(i => i.kind === 'feature').map(i => [i.name_or_label, i.default_reason]));
};

test('ask_owner の札が開いている間の自由な返事（L820）: 持ち主が書いた文の機能の名前には「あなたが言った」が付く', () => {
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.ask(c);
  f.owner(c, 'Actually I want a Markdown preview pane, not any of those', { askAnswer: true });
  assert.deepEqual(reasons(store, c, ['Markdown preview pane', 'Version history of notes']), { 'Markdown preview pane': 'owner_said', 'Version history of notes': null });
});

test('ask_owner の札の答え（L820・反対の試験）: 札の選択肢の文・見出しの文は、持ち主が選んでも「あなたが言った」にならない。書いた文だけがなる', () => {
  const ask = {
    questions: [
      { question: 'Which features first?', header: 'Search and tags', multiSelect: true, options: [{ label: 'Full text search' }, { label: 'Full text search for every note' }, { label: 'Tag support everywhere' }] },
      { question: 'Anything else?', header: 'Other', options: [{ label: 'Version history of notes' }, { label: 'Nothing' }] },
    ],
  };
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.ask(c, ask);
  f.owner(c, 'Answers:\n- Search and tags: Full text search for every note, Tag support everywhere\n- Other: Version history of notes, Sync across all devices', { askAnswer: true });
  assert.deepEqual(
    reasons(store, c, ['Full text search for every note', 'Tag support everywhere', 'Search and tags', 'for every note', 'Version history of notes', 'Sync across all devices']),
    { 'Full text search for every note': null, 'Tag support everywhere': null, 'Search and tags': null, 'for every note': null, 'Version history of notes': null, 'Sync across all devices': 'owner_said' },
  );
});

test('ask_owner の札の答え（L820・反対の試験）: 札が無い・札より前の「答え」の印の発言は、これまでどおり「あなたが言った」にならない', () => {
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.owner(c, 'Sync across all devices please', { askAnswer: true });
  f.ask(c);
  const d = f.chat('p1');
  f.owner(d, 'Version history of notes please', { askAnswer: true });
  assert.deepEqual(reasons(store, c, ['Sync across all devices']), { 'Sync across all devices': null });
  assert.deepEqual(reasons(store, d, ['Version history of notes']), { 'Version history of notes': null });
});

test('ask_owner の札の答え（L820・反対の試験）: 書いた文の途中に札の文があっても、その前後をつないだ引用では当てない（札の文を抜いてつなげない）', () => {
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.ask(c);
  f.owner(c, 'Notes with attachments inside JSON files plus Markdown preview pane too', { askAnswer: true });
  assert.deepEqual(
    reasons(store, c, ['Notes with attachments inside', 'Markdown preview pane', 'attachments inside plus Markdown']),
    { 'Notes with attachments inside': 'owner_said', 'Markdown preview pane': 'owner_said', 'attachments inside plus Markdown': null },
  );
});

test('ask_owner の札の答え（L820・反対の試験）: 札が開いている間に送った添付の中身は、札の文を含んでいても持ち主の言葉にならない', () => {
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.ask(c);
  f.owner(c, `see the file
${ATTACHMENT_OPEN}: notes.txt (text)>>>
JSON files and Version history of notes
${storeText('en', 'attachment.close')}`, { askAnswer: true });
  assert.deepEqual(reasons(store, c, ['Version history of notes']), { 'Version history of notes': null });
});

test('札が開いている間の返事（L820・調べものの頼み）: 頼みに写す持ち主の文に、札の答えの中の持ち主が書いた部分と自由な返事が入り、AI が書いた選択肢・見出しの文は入らない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a Markdown notes app.');
  const c = uuid(1);
  s.app.conversations.append(c, { role: 'assistant', content: '', toolCalls: [{ id: 'call_card', name: 'ask_owner', arguments: ASK_LONG }] });
  s.app.conversations.append(c, { role: 'tool', toolCallId: 'call_card', name: 'ask_owner', content: 'shown' });
  s.app.conversations.append(c, { role: 'user', content: `Answers:\n- Storage layout: ${LONG_A}\n- Screens: List, a map view of every note`, askAnswer: true } as ChatMessage);
  s.app.conversations.append(c, { role: 'user', content: 'ZQ-FREE reply typed while the card was open', askAnswer: true } as ChatMessage);
  await s.settle();
  const owner = s.app.research.ownerText(c);
  assert.ok(owner.startsWith('I want a Markdown notes app.'));
  for (const text of ['a map view of every note', 'ZQ-FREE reply typed while the card was open']) assert.ok(owner.includes(text), text);
  for (const text of [LONG_A, 'Storage layout', 'Answers:', 'List']) assert.ok(!owner.includes(text), text);
  assert.equal(owner.split('\n\n').length, 3, '句読点だけの切れ端は頼みに入らない');
});

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function toolApp(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const dir = join(products, 'shop');
  mkdirSync(dir, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root: dir });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.id as string;
  const send = async (text: string) => {
    const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text, projectId, permissionMode: 'plan' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  const draft = () => (JSON.parse(readFileSync(join(s.paths.projects, projectId, 'conversation-plans', `${uuid(1)}.acceptance.json`), 'utf8')) as { items: Array<{ result: string; source: Record<string, unknown> }> }).items;
  return { ...s, send, draft, projectId };
}

const row = (result: string, source: Record<string, unknown>) => ({ result, check: 'look', ...source });

test('ask_owner の答え（L803・道具まで通し）: 札を出す → 持ち主が選ぶ → acceptance_write に owner_choice で書くと、AI が足したにならない。選んでいない選択肢と、選択肢の文を持ち主の言葉として引用したものは AI が足したのまま', async t => {
  const s = await toolApp(t);
  s.adapter().scripts = [call('ask_owner', ASK_LONG)];
  await s.send('I want a notes app. Uploads must resume after a restart, please');
  s.adapter().scripts = [
    call('acceptance_write', {
      items: [
        row('Notes are kept in plain JSON files', { source: 'owner_choice', question: STORAGE, answer: LONG_A }),
        row('Notes are kept in one SQLite file', { source: 'owner_choice', question: STORAGE, answer: LONG_B }),
        row('Notes are stored as plain files, quoted from the option', { source: 'owner_words', quote: LONG_A }),
        row('Uploads resume after a restart', { source: 'owner_words', quote: 'uploads must resume after a restart' }),
      ],
    }),
    reply('saved'),
  ];
  await s.send(`Answers:\n- Storage layout: ${LONG_A}\n- Screens: List`);
  const sources = s.draft().map(item => item.source);
  assert.equal(sources[0]!['kind'], 'owner_choice', JSON.stringify(sources[0]));
  assert.deepEqual([sources[0]!['question'], sources[0]!['answer']], [STORAGE, LONG_A]);
  assert.deepEqual(sources[1], { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: STORAGE, answer: LONG_B }, '選んでいない選択肢');
  assert.deepEqual(sources[2], { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: LONG_A }, '選択肢の文は持ち主の言葉ではない');
  assert.equal(sources[3]!['kind'], 'owner_words', 'ふつうの持ち主の言葉は変わらない');
  const conversation = s.app.conversations.messages(uuid(1));
  const answerRow = conversation.find(m => m.message.role === 'user' && (m.message as { askAnswer?: boolean }).askAnswer === true);
  assert.ok(answerRow, '札が開いている間に届いた答えには、サーバーが askAnswer を付ける');
  assert.equal(sources[0]!['answerMessageId'], answerRow!.id);
  assert.match(s.adapter().calls.at(-1)!.messages.filter(m => m.role === 'tool').at(-1)!.content, /1 confirmed in the conversation|2 confirmed in the conversation/u);
});

test('ask_owner の答え（L803・道具まで通し）: 札が出ていない会話の owner_choice は、答えが「Answers:」の形をしていても AI が足したのまま', async t => {
  const s = await toolApp(t);
  s.adapter().scripts = [reply('Which storage do you want?')];
  await s.send('I want a notes app');
  s.adapter().scripts = [call('acceptance_write', { items: [row('Notes are kept in plain JSON files', { source: 'owner_choice', question: STORAGE, answer: LONG_A })] }), reply('saved')];
  await s.send(`Answers:\n- Storage layout: ${LONG_A}\n- Screens: List`);
  assert.deepEqual(s.draft().map(item => item.source), [{ kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: STORAGE, answer: LONG_A }]);
});

test('ask_owner の答え（L803）: 札の読み込みは、札の答えの印がある会話だけを読む。答えが無い札だけの会話・別の製品の会話は読まない', () => {
  const f = fixture();
  const quiet = f.chat();
  f.ask(quiet);
  f.owner(quiet, 'I have not answered the card yet');
  const answered = f.chat();
  const asked = f.ask(answered);
  const answer = f.owner(answered, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  const other = f.chat(OTHER);
  f.ask(other);
  f.owner(other, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  assert.deepEqual(askedCards(f.db, PROJECT).map(card => [card.conversationId, card.questionMessageId, card.answerMessageId]), [[answered, asked, answer]]);
});

test('札の答えの中の AI の文（P-R3-8）: 見出しの文字が違う答えは札の答えの形ではない。選んだことにならず、選択肢の文は持ち主の言葉にもならない', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c, ASK_LONG);
  f.owner(c, `Answers:\n- Storage layou7: ${LONG_A}\n- Screens: List`, { askAnswer: true });
  assert.deepEqual(f.check(choice(STORAGE, LONG_A)), unverified(STORAGE, LONG_A));
  assert.deepEqual(f.check(words(LONG_A)), notFound(LONG_A));
});

test('札の答えの中の AI の文（P-R3-8）: 札が何枚もあるとき、答えに当てるのは直前の札で、その札の選択肢の文を外す', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c, ASK_LONG);
  f.owner(c, `Answers:\n- Storage layout: ${LONG_A}\n- Screens: List`, { askAnswer: true });
  const SECOND = 'Keep every note in a hosted database';
  f.ask(c, { questions: [{ question: 'Where should notes live?', header: 'Hosting', options: [{ label: SECOND }, { label: 'Stay on this laptop' }] }] });
  f.owner(c, `Answers:\n- Hosting: ${SECOND}`, { askAnswer: true });
  for (const quote of [LONG_A, SECOND]) assert.deepEqual(f.check(words(quote)), notFound(quote), quote);
});

test('札の答えの中の AI の文（P-R3-8）: 札は同じ会話のものだけを使う。札の無い会話の「答え」の印の発言は、ほかの会話に札があっても持ち主の言葉に数えない', () => {
  const f = fixture();
  const withCard = f.chat();
  f.ask(withCard, ASK_LONG);
  f.owner(withCard, `Answers:\n- Storage layout: ${LONG_A}\n- Screens: List`, { askAnswer: true });
  f.owner(f.chat(), 'Exports must keep the original file names', { askAnswer: true });
  assert.deepEqual(f.check(words('exports must keep the original file names')), notFound('exports must keep the original file names'));
});

const SIGN_IN = 'How should sign-in work?';
const PASSWORD = 'Password: at least 12 characters';
const ASK_SIGN_IN = {
  questions: [{ question: SIGN_IN, header: 'Auth: Okta', options: [{ label: PASSWORD }, { label: 'Email magic link only' }] }],
};
// 画面が実際に出す形（src/web/server.ts の messages と同じ伏せ字 → previewJson）から、持ち主が押して送る答えの文を組む
const shownAnswer = (ask: unknown, picked: readonly number[][]): string => {
  const questions = parseAsk(previewJson(redactJsonValue(ask), 16_000))!;
  return answerText(questions, questions.map((q, i) => ({ labels: picked[i]!.map(n => q.options[n]!.label), other: false, text: '' })), 'Answers:');
};

test('札の答えの中の AI の文（伏せ字）: 画面で伏せ字になった選択肢・見出しを選んでも、その文は持ち主の言葉にならず、選んだ選択肢としては owner_choice で認める', () => {
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c, ASK_SIGN_IN);
  const text = shownAnswer(ASK_SIGN_IN, [[0]]);
  assert.equal(text, 'Answers:\n- Auth: [REDACTED]: Password: [REDACTED] least 12 characters', '画面は選択肢と見出しを伏せ字にして出す');
  const answer = f.owner(c, text, { askAnswer: true });
  for (const quote of ['least 12 characters', 'Password: [REDACTED] least 12 characters', 'Auth: [REDACTED]']) assert.deepEqual(f.check(words(quote)), notFound(quote), quote);
  const shown = 'Password: [REDACTED] least 12 characters';
  const expected = { kind: 'owner_choice', question: SIGN_IN, questionMessageId: asked, answer: shown, answerMessageId: answer, conversationId: c };
  assert.deepEqual(f.check(choice(SIGN_IN, PASSWORD)), expected, 'AI が書いた形で言っても、画面に出た形で言っても同じ');
  assert.deepEqual(f.check(choice(SIGN_IN, shown)), expected);
  assert.deepEqual(f.check(choice(SIGN_IN, 'Email magic link only')), unverified(SIGN_IN, 'Email magic link only'), '選んでいない選択肢');
});

test('札の答えの中の AI の文（伏せ字・調べもの）: 伏せ字になった選択肢の文は、機能の名前に「あなたが言った」を付けない。持ち主が書いた文は付く', () => {
  const ask = { questions: [{ question: 'How should people sign in?', header: 'Sign-in', multiSelect: true, options: [{ label: 'Auth: OAuth with Google sign-in' }, { label: 'Email magic link only' }] }] };
  const f = fixture();
  const store = new ResearchStore(f.db);
  const c = f.chat('p1');
  f.ask(c, ask);
  assert.equal(shownAnswer(ask, [[0]]), 'Answers:\n- Sign-in: Auth: [REDACTED] with Google sign-in');
  f.owner(c, shownAnswer(ask, [[0]]), { askAnswer: true });
  f.owner(c, 'Answers:\n- Sign-in: Auth: [REDACTED] with Google sign-in, Passkeys for every account', { askAnswer: true });
  assert.deepEqual(reasons(store, c, ['Google sign-in', 'Passkeys for every account']), { 'Google sign-in': null, 'Passkeys for every account': 'owner_said' });
});

test('札の答えの中の AI の文（伏せ字・調べものの頼み）: 頼みに写す持ち主の文に、伏せ字になった選択肢の文は入らない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('ok'));
  await s.send(1, 'I want a notes app with accounts.');
  const c = uuid(1);
  s.app.conversations.append(c, { role: 'assistant', content: '', toolCalls: [{ id: 'call_card', name: 'ask_owner', arguments: ASK_SIGN_IN }] });
  s.app.conversations.append(c, { role: 'tool', toolCallId: 'call_card', name: 'ask_owner', content: 'shown' });
  s.app.conversations.append(c, { role: 'user', content: shownAnswer(ASK_SIGN_IN, [[0]]), askAnswer: true } as ChatMessage);
  await s.settle();
  assert.equal(s.app.research.ownerText(c), 'I want a notes app with accounts.');
});

test('札の答えの中の AI の文（伏せ字・画面の通し）: 本物の画面の経路で伏せ字になった選択肢を選んでも、その文は AI が足したのまま。選んだ選択肢は owner_choice', async t => {
  const s = await toolApp(t);
  const ask = { questions: [{ question: SIGN_IN, header: 'Sign-in', options: [{ label: PASSWORD }, { label: 'Email magic link only' }] }] };
  s.adapter().scripts = [call('ask_owner', ask)];
  await s.send('I want a notes app with accounts, please');
  const messages = await s.json(`/api/conversations/${uuid(1)}/messages`, 'GET');
  const shownCall = (messages.body.messages as Array<{ toolCalls?: Array<{ name: string; input: string }> }>).flatMap(m => m.toolCalls ?? []).find(c => c.name === 'ask_owner')!;
  assert.match(shownCall.input, /Password: \[REDACTED\] least 12 characters/u, '本物の画面の経路は選択肢を伏せ字にして出す');
  const questions = parseAsk(shownCall.input)!;
  s.adapter().scripts = [
    call('acceptance_write', { items: [
      row('Sign-in uses a password of at least 12 characters', { source: 'owner_choice', question: SIGN_IN, answer: PASSWORD }),
      row('Sign-in is by email link only', { source: 'owner_choice', question: SIGN_IN, answer: 'Email magic link only' }),
      row('Passwords need at least 12 characters', { source: 'owner_words', quote: 'least 12 characters' }),
    ] }),
    reply('saved'),
  ];
  await s.send(answerText(questions, [{ labels: [questions[0]!.options[0]!.label], other: false, text: '' }], 'Answers:'));
  assert.deepEqual(s.draft().map(item => item.source['kind']), ['owner_choice', 'ai_added', 'ai_added']);
  assert.equal(s.draft()[0]!.source['answer'], 'Password: [REDACTED] least 12 characters');
  assert.deepEqual(s.draft()[2]!.source, { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'least 12 characters' });
});

test('札の答えの中の AI の文（選択肢が境目をまたぐ）: 見出しを含む選択肢を選んでも、その選択肢の後ろの文は持ち主の言葉にならない', () => {
  const ask = { questions: [{ question: 'Where are notes kept?', header: 'Where notes are kept', options: [{ label: 'Keep them in local JSON files' }, { label: 'Where notes are kept: Keep them' }] }] };
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c, ask);
  const answer = f.owner(c, 'Answers:\n- Where notes are kept: Keep them in local JSON files', { askAnswer: true });
  assert.deepEqual(f.check(words('in local JSON files')), notFound('in local JSON files'));
  assert.deepEqual(f.check(choice('Where are notes kept?', 'Keep them in local JSON files')), { kind: 'owner_choice', question: 'Where are notes kept?', questionMessageId: asked, answer: 'Keep them in local JSON files', answerMessageId: answer, conversationId: c });
});

test('札の答えの中の AI の文（選択肢が境目をまたぐ）: 複数選べる問いで、つなぎ目の ", " をまたぐ別の選択肢があっても、選んだ選択肢の前の文は持ち主の言葉にならない', () => {
  const ask = { questions: [{ question: 'What should happen to data?', header: 'Plan', multiSelect: true, options: [{ label: 'Store data in the cloud now' }, { label: 'please confirm this choice ok' }, { label: 'now, please confirm this choice ok' }] }] };
  const f = fixture();
  const c = f.chat();
  f.ask(c, ask);
  const answer = f.owner(c, 'Answers:\n- Plan: Store data in the cloud now, please confirm this choice ok', { askAnswer: true });
  for (const quote of ['Store data in the cloud', 'please confirm this choice ok']) assert.deepEqual(f.check(words(quote)), notFound(quote), quote);
  assert.equal((f.check(choice('What should happen to data?', 'Store data in the cloud now')) as { answerMessageId?: number }).answerMessageId, answer);
  assert.equal((f.check(choice('What should happen to data?', 'please confirm this choice ok')) as { answerMessageId?: number }).answerMessageId, answer);
  assert.equal(f.check(choice('What should happen to data?', 'now, please confirm this choice ok')).kind, 'ai_added', '選ばなかった選択肢');
  const typed = f.owner(c, 'Answers:\n- Plan: Store data in the cloud now, Keep a local copy of everything', { askAnswer: true });
  const hit = f.check(words('keep a local copy of everything'));
  assert.deepEqual(hit.kind === 'owner_words' ? hit.messageId : hit, typed, '持ち主が書いた文は、選択肢のあとでも当たる');
});

test('受け入れの一覧の「まだ引用されていない発言」（札の答え）: 選んだ選択肢だけの答えは引用済み。持ち主が書いた文が混じる答えは、選んだ選択肢を引用しても引用されていないまま', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c);
  const pure = f.owner(c, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  f.ask(c);
  const mixed = f.owner(c, CARD_ANSWER('SQLite (Recommended)', 'Notes must sync over the train wifi offline'), { askAnswer: true });
  const input = { items: [
    { result: 'Notes are kept in JSON files', source: choice(STORAGE, 'JSON files'), check: { kind: 'look' as const } },
    { result: 'Notes are kept in SQLite', source: choice(STORAGE, 'SQLite'), check: { kind: 'look' as const } },
  ] };
  const { doc, verified } = buildDraft(input, f.speech(), { language: null, taintedRuns: [] });
  assert.equal(verified, 2);
  const left = coverageOf(doc, ownerSpeech(f.db, PROJECT), undefined, askedCards(f.db, PROJECT)).unreferenced.map(row => row.message_id);
  assert.deepEqual(left, [mixed]);
  assert.ok(!left.includes(pure));
});

test('札の答えの中の AI の文（伏せ字）: 伏せ字になる前の形（AI が書いた見出し・選択肢）で組まれた答えも、同じに扱う', () => {
  const f = fixture();
  const c = f.chat();
  const asked = f.ask(c, ASK_SIGN_IN);
  const answer = f.owner(c, `Answers:\n- Auth: Okta: ${PASSWORD}`, { askAnswer: true });
  assert.deepEqual(f.check(words('least 12 characters')), notFound('least 12 characters'));
  assert.deepEqual(f.check(choice(SIGN_IN, PASSWORD)), { kind: 'owner_choice', question: SIGN_IN, questionMessageId: asked, answer: 'Password: [REDACTED] least 12 characters', answerMessageId: answer, conversationId: c });
});

test('札の答えの中の AI の文（伏せ字）: 伏せ字で同じ文になる選択肢・つなぎ方が何通りにも読める答えは、どの選択肢を選んだとも言い切れないので owner_choice にしない', () => {
  const hosting = { questions: [{ question: 'Which hosting?', header: 'Hosting', options: [{ label: 'Password: abc1' }, { label: 'Password: xyz2' }] }] };
  const f = fixture();
  const c = f.chat();
  f.ask(c, hosting);
  f.owner(c, shownAnswer(hosting, [[0]]), { askAnswer: true });
  assert.equal(shownAnswer(hosting, [[0]]), shownAnswer(hosting, [[1]]), '伏せ字で 2 つの選択肢が同じ文になる');
  for (const answer of ['Password: abc1', 'Password: xyz2']) assert.deepEqual(f.check(choice('Which hosting?', answer)), unverified('Which hosting?', answer), answer);
  const plan = { questions: [{ question: 'Which plan?', header: 'Plan', multiSelect: true, options: [{ label: 'Keep notes' }, { label: 'Keep notes, sync' }, { label: 'sync' }] }] };
  const g = fixture();
  const d = g.chat();
  g.ask(d, plan);
  g.owner(d, 'Answers:\n- Plan: Keep notes, sync', { askAnswer: true });
  for (const answer of ['Keep notes', 'Keep notes, sync', 'sync']) assert.deepEqual(g.check(choice('Which plan?', answer)), unverified('Which plan?', answer), answer);
});

test('札の答えの中の AI の文（伏せ字）: 画面に出す上限の近くまで大きな札でも、伏せ字を通した形で選んだ選択肢が owner_choice になる', () => {
  const long = (n: number) => 'x'.repeat(n);
  const big = { questions: Array.from({ length: 4 }, (_, q) => ({
    question: `Question ${q}? ${long(470)}`, header: `Part ${q}`,
    options: Array.from({ length: 4 }, (_, o) => ({ label: q === 0 && o === 0 ? `Password: at least 12 characters ${long(30)}` : `Option ${q}-${o} ${long(60)}`, description: long(290) })),
  })) };
  const f = fixture();
  const c = f.chat();
  f.ask(c, big);
  assert.ok(JSON.stringify(big).length > 4000 && JSON.stringify(big).length < 16_000);
  const answer = f.owner(c, shownAnswer(big, [[0], [1], [2], [3]]), { askAnswer: true });
  for (const q of [0, 3]) {
    const claimed = big.questions[q]!;
    assert.equal((f.check(choice(claimed.question, claimed.options[q === 0 ? 0 : 3]!.label)) as { answerMessageId?: number }).answerMessageId, answer, `question ${q}`);
  }
  assert.match(shownAnswer(big, [[0], [1], [2], [3]]), /Password: \[REDACTED\] least 12 characters x+/u, '伏せ字を通した形で組まれる');
});

test('札の答えの中の AI の文（伏せ字）: 札の答えの形でない発言（札が開いている間の自由な返事）に画面に出た選択肢の文をそのまま写しても、持ち主の言葉にならない', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c, ASK_SIGN_IN);
  f.owner(c, 'Password: [REDACTED] least 12 characters', { askAnswer: true });
  assert.deepEqual(f.check(words('least 12 characters')), notFound('least 12 characters'));
});

test('札の答えの中の AI の文: 問いごとの自分で書いた文は別々の発言のように扱い、2 つの問いにまたがる引用は当てない', () => {
  const f = fixture();
  const c = f.chat();
  f.ask(c, ASK_LONG);
  const answer = f.owner(c, 'Answers:\n- Storage layout: Notes stay readable offline always\n- Screens: Home page stays very simple', { askAnswer: true });
  const hit = (quote: string) => { const source = f.check(words(quote)); return source.kind === 'owner_words' ? source.messageId : source; };
  assert.equal(hit('notes stay readable offline always'), answer);
  assert.equal(hit('home page stays very simple'), answer);
  assert.deepEqual(f.check(words('readable offline always home page stays')), notFound('readable offline always home page stays'));
});

// 札を出す → 持ち主が答える → acceptance_write で選んだ選択肢を owner_choice で書く → 本物の画面の経路（GET /api/projects/:id/acceptance）の coverage
async function coverageAfter(t: Parameters<typeof startApp>[0], answer: string) {
  const s = await toolApp(t);
  s.adapter().scripts = [call('ask_owner', ASK)];
  await s.send('I want a notes app, please');
  s.adapter().scripts = [call('acceptance_write', { items: [row('Notes are kept in SQLite', { source: 'owner_choice', question: STORAGE, answer: 'SQLite' })] }), reply('saved')];
  await s.send(answer);
  const written = s.draft();
  assert.equal(written[0]!.source['kind'], 'owner_choice');
  const view = await s.json(`/api/projects/${s.projectId}/acceptance?conversationId=${uuid(1)}`, 'GET');
  assert.equal(view.status, 200, JSON.stringify(view.body));
  return { coverage: view.body.coverage as { owner_choice: number; unreferenced: Array<{ message_id: number; text: string }> }, answerId: written[0]!.source['answerMessageId'] as number };
}

test('受け入れの一覧の「まだ引用されていない発言」（札の答え・画面の経路）: 選んだ選択肢と持ち主が書いた文が同じ答えにあれば、選んだ選択肢を引用しても、その答えは引用されていないまま', async t => {
  const { coverage, answerId } = await coverageAfter(t, CARD_ANSWER('SQLite (Recommended)', 'Notes must sync over the train wifi offline'));
  assert.equal(coverage.owner_choice, 1);
  assert.deepEqual(coverage.unreferenced.map(m => m.message_id).filter(id => id === answerId), [answerId]);
  assert.match(coverage.unreferenced.find(m => m.message_id === answerId)!.text, /train wifi offline/u);
});

test('受け入れの一覧の「まだ引用されていない発言」（札の答え・画面の経路）: 選んだ選択肢だけの答えは、選んだ選択肢を引用すると引用済みになる', async t => {
  const { coverage, answerId } = await coverageAfter(t, CARD_ANSWER('SQLite (Recommended)', 'List'));
  assert.equal(coverage.owner_choice, 1);
  assert.ok(!coverage.unreferenced.some(m => m.message_id === answerId));
});
