import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../web/src/api.ts';
import { answerText, choose, complete, emptyPick, openAsk, parseAsk, type AskQuestion } from '../web/src/ui/ask.ts';

const INPUT = {
  questions: [
    { question: 'Which storage?', header: 'Storage', options: [{ label: 'SQLite (Recommended)', description: 'One file' }, { label: 'JSON files' }] },
    { question: 'Which screens?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }, { label: 'Settings' }] },
  ],
};

const asked = (id = 2, callId = 'c1', input: unknown = INPUT): Message[] => [
  { id: id - 1, role: 'assistant', text: '', runId: 'r1', createdAt: 1, toolCalls: [{ id: callId, name: 'ask_owner', input: JSON.stringify(input) }] },
  { id, role: 'tool', text: 'The owner sees 2 question(s) as a card.', runId: 'r1', createdAt: 2, toolName: 'ask_owner', toolCallId: callId, isError: false },
];
const owner = (id: number, extra: Partial<Message> = {}): Message => ({ id, role: 'user', text: 'hi', runId: null, createdAt: id, ...extra });

test('ui/ask: openAsk finds the last successful ask_owner call that no owner message answered', () => {
  const open = openAsk([owner(0), ...asked()]);
  assert.equal(open?.key, '2');
  assert.deepEqual(open?.questions.map(q => [q.header, q.multiSelect, q.options.map(o => o.label)]), [['Storage', false, ['SQLite (Recommended)', 'JSON files']], ['Screens', true, ['List', 'Detail', 'Settings']]]);
  assert.equal(open?.questions[0]!.options[0]!.description, 'One file');
});

test('ui/ask: any later owner message closes the card (an answer, or typed text instead); beat notes do not', () => {
  assert.equal(openAsk([...asked(), owner(3)]), null, 'owner message after the ask');
  assert.notEqual(openAsk([...asked(), owner(3, { note: 'pending' })]), null, 'a Pending note is not the owner');
  assert.notEqual(openAsk([...asked(), owner(3, { note: 'continue' })]), null, 'a continue note is not the owner');
});

test('ui/ask: an ask that failed, or with input that does not parse, shows no card', () => {
  const failed = asked();
  failed[1] = { ...failed[1]!, isError: true };
  assert.equal(openAsk(failed), null);
  assert.equal(openAsk(asked(2, 'c1', { questions: [] })), null);
  assert.equal(openAsk(asked(2, 'c1', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'only one' }] }] })), null);
  const lost = asked();
  lost[0] = { ...lost[0]!, toolCalls: [{ id: 'other', name: 'ask_owner', input: JSON.stringify(INPUT) }] };
  assert.equal(openAsk(lost), null, 'no matching call');
  assert.equal(parseAsk('not json'), null);
});

test('ui/ask: the newest open ask wins over an older answered one', () => {
  const messages = [...asked(2, 'c1'), owner(3), ...asked(5, 'c2', { questions: [{ question: 'Q?', header: 'Later', options: [{ label: 'a' }, { label: 'b' }] }] })];
  assert.equal(openAsk(messages)?.questions[0]!.header, 'Later');
});

test('ui/ask: complete needs a pick per question, and text when Something else is chosen', () => {
  const qs = parseAsk(JSON.stringify(INPUT))!;
  let picks = qs.map(emptyPick);
  assert.equal(complete(qs, picks), false, 'nothing preselected');
  picks = [choose(qs[0]!, picks[0]!, 'JSON files'), picks[1]!];
  assert.equal(complete(qs, picks), false, 'second question open');
  picks = [picks[0]!, choose(qs[1]!, picks[1]!, null)];
  assert.equal(complete(qs, picks), false, 'Something else with empty text');
  picks = [picks[0]!, { ...picks[1]!, text: '  ' }];
  assert.equal(complete(qs, picks), false, 'blank text');
  picks = [picks[0]!, { ...picks[1]!, text: 'A map view' }];
  assert.equal(complete(qs, picks), true);
});

test('ui/ask: single choice replaces; multiSelect toggles and keeps the option order; Something else is exclusive only for single choice', () => {
  const [single, multi] = parseAsk(JSON.stringify(INPUT)) as [AskQuestion, AskQuestion];
  let p = choose(single, emptyPick(), 'SQLite (Recommended)');
  p = choose(single, p, 'JSON files');
  assert.deepEqual(p.labels, ['JSON files']);
  p = choose(single, p, null);
  assert.deepEqual([p.labels, p.other], [[], true]);
  let m = choose(multi, emptyPick(), 'Settings');
  m = choose(multi, m, 'List');
  assert.deepEqual(m.labels, ['List', 'Settings']);
  m = choose(multi, m, null);
  assert.deepEqual([m.labels, m.other], [['List', 'Settings'], true]);
  m = choose(multi, m, 'List');
  assert.deepEqual(m.labels, ['Settings']);
});

test('ui/ask: invisible or control characters never reach the card or the answer text', () => {
  const tag = String.fromCodePoint(0xE0072, 0xE0075, 0xE006E);
  const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const qs = parseAsk(JSON.stringify({ questions: [{ question: 'Which​ one?', header: 'H‮', options: [{ label: `Keep (Recommended)${tag}`, description: 'one\nfile⁦' }, { label: 'b' }] }] }))!;
  assert.ok(qs, 'still shown');
  for (const value of [qs[0]!.question, qs[0]!.header, ...qs[0]!.options.flatMap(o => [o.label, o.description])]) assert.ok(!hidden.test(value), JSON.stringify(value));
  assert.equal(qs[0]!.options[0]!.label, 'Keep (Recommended)');
  assert.equal(qs[0]!.options[0]!.description, 'one file');
  const text = answerText(qs, [{ labels: [qs[0]!.options[0]!.label], other: false, text: '' }], 'Answers:');
  assert.ok(!/[\p{Cf}]/u.test(text), JSON.stringify(text));
  assert.equal(text, 'Answers:\n- H: Keep (Recommended)');
  assert.equal(parseAsk(JSON.stringify({ questions: [{ question: 'Q?', header: 'H', options: [{ label: '​' }, { label: 'b' }] }] })), null, 'a label that is only hidden characters');
});

test('ui/ask: answerText is a lead line and one line per question, labels as written', () => {
  const qs = parseAsk(JSON.stringify(INPUT))!;
  const text = answerText(qs, [{ labels: ['SQLite (Recommended)'], other: false, text: '' }, { labels: ['List', 'Detail'], other: true, text: 'a map\nview ' }], 'Answers:');
  assert.equal(text, 'Answers:\n- Storage: SQLite (Recommended)\n- Screens: List, Detail, a map view');
});
