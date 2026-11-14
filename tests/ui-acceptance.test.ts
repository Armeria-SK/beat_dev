import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Acceptance, AcceptanceItem, PlanDoc } from '../web/src/api.ts';
import { t } from '../web/src/i18n/index.ts';
import { acceptanceMeta, checkLabel, conversationLink, itemDetails, outsideContent, showAcceptance, shownItems, shownNotDoing, sourceLabel, stateLabel } from '../web/src/ui/acceptance.ts';

// 受け入れの一覧の表示（beat 3-1b-u）。画面を持たない決まり: 並べ方・札の言葉・開いた中身（web/src/ui/acceptance.ts）。

const item = (id: string, over: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id, result: `Result ${id}`, source: { kind: 'owner_words', quote: 'resume after a restart', messageId: 4, conversationId: 'c1' },
  check: { kind: 'command', command: 'npm test -- resume' }, state: 'open', evidence: [], changedIn: null, removedIn: null, ...over,
});
const acc = (over: Partial<Acceptance> = {}): Acceptance => ({
  version: 0, language: 'en', items: [], not_doing: [], draft: true, hash: 'h', frozen: null, ...over,
});
const doc = (over: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# Plan', hash: 'p1', updated_at: 1, updated_by: 'ai', tainted: false, writing: false, reviewLocked: false, ...over });

test('ui/acceptance: 項目は番号の数の順（A-2 は A-10 より前）。外した項目は出さない', () => {
  const a = acc({ items: [item('A-10'), item('A-2'), item('A-1'), item('A-3', { removedIn: 2 })] });
  assert.deepEqual(shownItems(a).map(i => i.id), ['A-1', 'A-2', 'A-10']);
  const n = acc({ not_doing: [{ id: 'N-11', text: 'x', source: { kind: 'ai_added' } }, { id: 'N-2', text: 'y', source: { kind: 'ai_added' } }] });
  assert.deepEqual(shownNotDoing(n).map(i => i.id), ['N-2', 'N-11']);
});

test('ui/acceptance: 出どころの札は Your words / Your answer / AI added / You edited', () => {
  assert.equal(t(sourceLabel({ kind: 'owner_words', quote: 'q' })), 'Your words');
  assert.equal(t(sourceLabel({ kind: 'owner_choice', question: 'Which one?', answer: 'A' })), 'Your answer');
  assert.equal(t(sourceLabel({ kind: 'ai_added' })), 'AI added');
  assert.equal(t(sourceLabel({ kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'q' })), 'AI added', 'AI が言った種類ではなく、コードが付けた種類で出す');
  assert.equal(t(sourceLabel({ kind: 'owner_edit' })), 'You edited');
});

test('ui/acceptance: 確かめ方の札は Command / Look / Read。状態はこの段では Open だけを出す', () => {
  assert.equal(t(checkLabel({ kind: 'command', command: 'npm test' })), 'Command');
  assert.equal(t(checkLabel({ kind: 'look' })), 'Look');
  assert.equal(t(checkLabel({ kind: 'read' })), 'Read');
  const open = stateLabel('open');
  assert.ok(open);
  assert.equal(t(open), 'Open');
  assert.equal(stateLabel('met'), null, '済 / 未確認は 5-3b で出す');
  assert.equal(stateLabel('unverified'), null);
});

test('ui/acceptance: 開いた中身は 引用 / 質問と答え / コマンド を文字のまま返す', () => {
  const words = itemDetails(item('A-1'));
  assert.deepEqual(words, [
    { label: 'ui.acc.detail.quote', text: 'resume after a restart' },
    { label: 'ui.acc.detail.command', text: 'npm test -- resume', mono: true },
  ]);
  const choice = itemDetails(item('A-2', { source: { kind: 'owner_choice', question: 'Which storage? A) disk B) S3', answer: 'A' }, check: { kind: 'look' } }));
  assert.deepEqual(choice, [
    { label: 'ui.acc.detail.question', text: 'Which storage? A) disk B) S3' },
    { label: 'ui.acc.detail.answer', text: 'A' },
    { label: 'ui.acc.detail.check', note: 'ui.acc.detail.look' },
  ]);
  const html = itemDetails(item('A-3', { source: { kind: 'owner_words', quote: '<img src=x onerror=alert(1)>' }, check: { kind: 'read' } }));
  assert.deepEqual(html[0], { label: 'ui.acc.detail.quote', text: '<img src=x onerror=alert(1)>' }, '引用の文字をそのまま渡す（変えない・削らない）');
  assert.deepEqual(html[1], { label: 'ui.acc.detail.check', note: 'ui.acc.detail.read' });
});

test('ui/acceptance: 答えの見出しは "Answer"。持ち主の答えと決めつけない（AI が言っただけの答えにも使う）', () => {
  assert.equal(t('ui.acc.detail.answer'), 'Answer');
  assert.equal(t('ui.acc.detail.question'), 'Question');
});

test('ui/acceptance: AI が別の種類を言ったのに確かめられなかった項目は、言った種類と理由を出し、引用もあれば出す', () => {
  const claimed = itemDetails(item('A-4', { source: { kind: 'ai_added', claimed: 'owner_words', reason: 'too_short', quote: 'OK' } }));
  assert.deepEqual(claimed.slice(0, 3), [
    { label: 'ui.acc.detail.claimed', note: 'ui.acc.claimed.words' },
    { label: 'ui.acc.detail.why', note: 'ui.acc.reason.too_short' },
    { label: 'ui.acc.detail.quote', text: 'OK' },
  ]);
  assert.equal(t('ui.acc.detail.claimed'), 'Claimed');
  assert.equal(t('ui.acc.claimed.words'), 'Your words');
  assert.equal(t('ui.acc.claimed.choice'), 'Your answer');
  const notNext = itemDetails(item('A-5', { source: { kind: 'ai_added', claimed: 'owner_choice', reason: 'not_next_reply', question: 'Which one? A) x B) y', answer: 'B' } }));
  assert.deepEqual(notNext.slice(0, 4), [
    { label: 'ui.acc.detail.claimed', note: 'ui.acc.claimed.choice' },
    { label: 'ui.acc.detail.why', note: 'ui.acc.reason.not_next_reply' },
    { label: 'ui.acc.detail.question', text: 'Which one? A) x B) y' },
    { label: 'ui.acc.detail.answer', text: 'B' },
  ]);
  assert.equal(t('ui.acc.reason.not_found'), 'Not found in your messages');
  const plain = itemDetails(item('A-6', { source: { kind: 'ai_added' } }));
  assert.deepEqual(plain, [{ label: 'ui.acc.detail.command', text: 'npm test -- resume', mono: true }], 'ただの AI added は出どころの行を出さない');
  assert.deepEqual(itemDetails({ id: 'N-1', text: 'No login', source: { kind: 'owner_words', quote: 'no login needed' } }), [{ label: 'ui.acc.detail.quote', text: 'no login needed' }], 'しないことには確かめ方が無い');
});

test('ui/acceptance: あなたの言葉の項目は、引用の下にその発言の全文（サーバーが 500 字までに切ったもの）を "You wrote" として文字のまま出す', () => {
  const withContext = itemDetails(item('A-7', { source: { kind: 'owner_words', quote: 'not slow', context: 'It must be fast, not slow <b>at all</b>.', messageId: 3 } }));
  assert.deepEqual(withContext.slice(0, 2), [
    { label: 'ui.acc.detail.quote', text: 'not slow' },
    { label: 'ui.acc.detail.context', text: 'It must be fast, not slow <b>at all</b>.' },
  ]);
  assert.equal(t('ui.acc.detail.context'), 'You wrote');
  assert.deepEqual(itemDetails(item('A-8')).map(d => d.label), ['ui.acc.detail.quote', 'ui.acc.detail.command'], '全文が無ければ行を出さない');
});

test('ui/acceptance: 選択肢の答えはまだ確かめない（choice_unverified）。質問と答えは Claimed: Your answer の下に出る', () => {
  const choice = itemDetails(item('A-9', { source: { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: 'Which? A) x B) y', answer: 'A' } }));
  assert.deepEqual(choice.slice(0, 4), [
    { label: 'ui.acc.detail.claimed', note: 'ui.acc.claimed.choice' },
    { label: 'ui.acc.detail.why', note: 'ui.acc.reason.choice_unverified' },
    { label: 'ui.acc.detail.question', text: 'Which? A) x B) y' },
    { label: 'ui.acc.detail.answer', text: 'A' },
  ]);
  assert.equal(t('ui.acc.reason.choice_unverified'), 'choices are not verified yet');
  assert.equal(t(sourceLabel({ kind: 'owner_choice', question: 'q', answer: 'A' })), 'Your answer', '確かめた選択の札は残す（あとで戻る）');
});

test('ui/acceptance: あなたの言葉の項目には、その発言の会話を開くリンク（今ある会話の経路。会話の ID は URL の形に直す）', () => {
  assert.equal(conversationLink({ kind: 'owner_words', quote: 'q', messageId: 4, conversationId: 'c1' }), '#/c/c1');
  assert.equal(conversationLink({ kind: 'owner_words', quote: 'q', messageId: 4, conversationId: 'a/b"><x' }), '#/c/a%2Fb%22%3E%3Cx');
  assert.equal(conversationLink({ kind: 'owner_words', quote: 'q' }), null, '会話が分からなければ出さない');
  assert.equal(conversationLink({ kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'q' }), null);
  assert.equal(conversationLink({ kind: 'owner_choice', question: 'q', answer: 'A', conversationId: 'c1' }), null);
  assert.equal(t('ui.acc.showInConversation'), 'Show in conversation');
});

test('ui/acceptance: 履歴が多すぎて 1 回の書き込みで確かめきれなかった理由の言葉', () => {
  const d = itemDetails(item('A-11', { source: { kind: 'ai_added', claimed: 'owner_words', reason: 'scan_budget', quote: 'long ago' } }));
  assert.deepEqual(d[1], { label: 'ui.acc.detail.why', note: 'ui.acc.reason.scan_budget' });
  assert.equal(t('ui.acc.reason.scan_budget'), 'Too much history to check in one write');
});

test('ui/acceptance: 下書きのあいだは "Draft — locked when you build"、固定のあとは版の番号', () => {
  assert.equal(acceptanceMeta(acc()), 'Draft — locked when you build');
  assert.equal(acceptanceMeta(acc({ draft: false, version: 2 })), 'v2');
});

test('ui/acceptance: 一覧の節は、項目かしないことがあるか、固定したときだけ出す', () => {
  assert.equal(showAcceptance(null), false);
  assert.equal(showAcceptance(acc()), false, '空の下書きは出さない');
  assert.equal(showAcceptance(acc({ items: [item('A-1', { removedIn: 1 })] })), false, '外した項目だけなら空と同じ');
  assert.equal(showAcceptance(acc({ items: [item('A-1')] })), true);
  assert.equal(showAcceptance(acc({ not_doing: [{ id: 'N-1', text: 'x', source: { kind: 'ai_added' } }] })), true);
  assert.equal(showAcceptance(acc({ draft: false, version: 1 })), true, '空の一覧で固定した版も出す');
});

test('ui/acceptance: 外の文を読んだあとに書いた計画書か一覧なら 1 行出す', () => {
  assert.equal(outsideContent(null, null), false);
  assert.equal(outsideContent(doc(), acc()), false);
  assert.equal(outsideContent(doc({ tainted: true }), null), true);
  assert.equal(outsideContent(doc(), acc({ tainted: true })), true);
  assert.equal(t('ui.acc.outside'), 'Written after reading text from elsewhere');
});

test('ui/acceptance: 質問票の答えの出どころ（owner_answer）は「Your answer」の札と答えの文、前の出どころを出す。知らない種類でも落ちない（beat 5-u2）', () => {
  const was = { kind: 'owner_words' as const, quote: 'resume after a restart' };
  const answered = item('A-1', { source: { kind: 'owner_answer', questionId: 7, answer: 'Keep the old file', picked: 'text', was } });
  assert.equal(t(sourceLabel(answered.source)), 'Your answer');
  const shown = itemDetails(answered).map(d => [t(d.label), 'text' in d ? d.text : t(d.note)]);
  assert.deepEqual(shown.slice(0, 3), [['Answer', 'Keep the old file'], ['Before your answer', 'Your words'], ['Quote', 'resume after a restart']]);
  const strange = item('A-2', { source: { kind: 'from_the_future', quote: 'still shown' } as unknown as AcceptanceItem['source'] });
  assert.equal(t(sourceLabel(strange.source)), 'Other');
  assert.deepEqual(itemDetails(strange).slice(0, 1).map(d => 'text' in d ? d.text : ''), ['still shown']);
  const oddClaim = item('A-3', { source: { kind: 'ai_added', claimed: 'owner_dream', reason: 'mystery' } as unknown as AcceptanceItem['source'] });
  assert.ok(itemDetails(oddClaim).every(d => typeof t(d.label) === 'string' && ('text' in d || typeof d.note === 'string')), '知らない claimed で空の札を作らない');
});
