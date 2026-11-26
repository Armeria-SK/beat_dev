import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversations, ownerSpeech } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { askedCards, buildDraft, coverageOf, prepareSpeech, SCAN_BUDGET, verifySource, type ClaimedSource } from '../src/projects/acceptance.ts';
import { ResearchStore } from '../src/research/store.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { ATTACHMENT_OPEN } from '../src/uploads/store.ts';

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

test('ask_owner の答え（L803）: 新しい札の答えを先に当て、古い札の答えも残る。持ち主の言葉（owner_words）の確かめは札があってもなくても同じ', () => {
  const f = fixture();
  const c = f.chat();
  const first = f.ask(c);
  const firstAnswer = f.owner(c, CARD_ANSWER('JSON files', 'List'), { askAnswer: true });
  const typed = f.owner(c, 'Uploads must resume after a restart, please');
  const second = f.ask(c, { questions: [{ question: STORAGE, header: 'Storage', options: [{ label: 'SQLite' }, { label: 'JSON files' }] }] });
  const secondAnswer = f.owner(c, 'Answers:\n- Storage: JSON files', { askAnswer: true });
  assert.deepEqual(f.check(choice(STORAGE, 'JSON files')), { kind: 'owner_choice', question: STORAGE, questionMessageId: second, answer: 'JSON files', answerMessageId: secondAnswer, conversationId: c });
  assert.deepEqual(f.check(choice('Which screens come first?', 'List')), { kind: 'owner_choice', question: 'Which screens come first?', questionMessageId: first, answer: 'List', answerMessageId: firstAnswer, conversationId: c });
  const withoutCards = prepareSpeech(ownerSpeech(f.db, PROJECT), SCAN_BUDGET);
  for (const quote of ['uploads must resume after a restart', 'JSON files', 'Answers:\n- Storage: JSON files', 'nothing like this was said']) {
    assert.deepEqual(verifySource(f.speech(), { kind: 'owner_words', quote }), verifySource(withoutCards, { kind: 'owner_words', quote }), quote);
  }
  assert.equal((verifySource(f.speech(), { kind: 'owner_words', quote: 'uploads must resume after a restart' }) as { messageId?: number }).messageId, typed);
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
