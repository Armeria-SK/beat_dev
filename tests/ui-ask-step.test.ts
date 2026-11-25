import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { ANSWER_GUARD_MS, choose, emptyPick, askStep, parseAsk, type OpenAsk } from '../web/src/ui/ask.ts';
import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// 質問カード: 1 問ずつ表示 → 答えると次へ → 最後にまとめて送る。複数の問いを 1 画面に並べない。

const INPUT = {
  questions: [
    { question: 'Which storage?', header: 'Storage', options: [{ label: 'SQLite' }, { label: 'JSON files' }] },
    { question: 'Which screens?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }] },
    { question: 'Which theme?', header: 'Theme', options: [{ label: 'Light' }, { label: 'Dark' }] },
  ],
};

type Props = { ask: OpenAsk; busy: boolean; onAnswer: (text: string) => void; clock?: () => number };

afterEach(async () => { await cleanup(); });

test('ui/ask-step: askStep は答えるまで次へ進ませず、最後の問いでだけ送れる', () => {
  const qs = parseAsk(JSON.stringify(INPUT))!;
  let picks = qs.map(emptyPick);
  assert.deepEqual(askStep(qs, picks, 0), { index: 0, total: 3, first: true, last: false, canNext: false, canSend: false });
  picks = [choose(qs[0]!, picks[0]!, 'SQLite'), picks[1]!, picks[2]!];
  assert.equal(askStep(qs, picks, 0).canNext, true);
  assert.equal(askStep(qs, picks, 1).last, false, '真ん中の問いは最後ではない');
  assert.equal(askStep(qs, picks, 2).canSend, false, '前の問いが空のうちは送れない');
  picks = [picks[0]!, choose(qs[1]!, picks[1]!, 'List'), choose(qs[2]!, picks[2]!, 'Dark')];
  const last = askStep(qs, picks, 2);
  assert.deepEqual([last.last, last.canNext, last.canSend], [true, false, true]);
  assert.equal(askStep(qs, picks, 99).index, 2, '範囲の外は最後の問いに丸める');
  assert.equal(askStep(qs, picks, -5).index, 0);
});

test('ui/ask-step: カードは 1 度に 1 問だけ出し、答えると次へ進み、最後にまとめて 1 回だけ送る', async () => {
  const { AskCard } = await loadTsx<{ AskCard: ComponentType<Props> }>('../web/src/ui/AskCard.tsx', import.meta.url);
  const sent: string[] = [];
  let now = 0;
  const ask: OpenAsk = { key: '1', questions: parseAsk(JSON.stringify(INPUT))! };
  const { container } = await render(createElement(AskCard, { ask, busy: false, onAnswer: text => sent.push(text), clock: () => now }));
  const buttons = () => [...container.querySelectorAll('button')];
  const named = (text: string) => buttons().find(b => b.textContent === text);
  const headings = () => [...container.querySelectorAll('h3')].map(h => h.textContent);

  assert.deepEqual(headings(), ['Which storage?'], '最初は 1 問目だけ');
  assert.equal(named('Answer'), undefined, '最後の問いまで送るボタンは出ない');
  assert.equal(named('Next')?.disabled, true, '答えるまで次へ進めない');
  assert.match(container.textContent ?? '', /Question 1 of 3/);

  await click(container.querySelectorAll('input')[1]);
  assert.equal(named('Next')?.disabled, false);
  await click(named('Next'));
  assert.deepEqual(headings(), ['Which screens?'], '次の問いに替わる（並ばない）');
  assert.ok(named('Back'), '戻れる');

  await click(named('Back'));
  assert.deepEqual(headings(), ['Which storage?']);
  assert.equal(container.querySelectorAll('input')[1] && (container.querySelectorAll('input')[1] as HTMLInputElement).checked, true, '戻っても答えは残る');
  await click(named('Next'));

  await click(container.querySelectorAll('input')[0]);
  await click(named('Next'));
  assert.deepEqual(headings(), ['Which theme?']);
  assert.equal(named('Answer')?.disabled, true, '最後の問いも答えるまで送れない');
  assert.deepEqual(sent, [], 'ここまで何も送っていない');
  await click(container.querySelectorAll('input')[1]);
  now += ANSWER_GUARD_MS;
  await click(named('Answer'));
  assert.equal(sent.length, 1, 'まとめて 1 回だけ送る');
  assert.equal(sent[0], 'Answers:\n- Storage: JSON files\n- Screens: List\n- Theme: Dark');
});

test('ui/ask-step: 問いが 1 つだけなら、今までどおり Next なしで答えて、出てすぐの 1 回の押下で送れる', async () => {
  const { AskCard } = await loadTsx<{ AskCard: ComponentType<Props> }>('../web/src/ui/AskCard.tsx', import.meta.url);
  const sent: string[] = [];
  const ask: OpenAsk = { key: '2', questions: parseAsk(JSON.stringify({ questions: [INPUT.questions[0]] }))! };
  // 時計は動かさない（0 のまま）。問いが替わったことが無いカードは、出てからの経過時間で送れなくならない。
  const { container } = await render(createElement(AskCard, { ask, busy: false, onAnswer: text => sent.push(text), clock: () => 0 }));
  const names = [...container.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(names, ['Answer']);
  await click(container.querySelectorAll('input')[0]);
  await click([...container.querySelectorAll('button')][0]);
  assert.deepEqual(sent, ['Answers:\n- Storage: SQLite']);
});

// Back で戻っても、前に入れた答え（選択・複数選択・「その他」の文）は消えない。進むのは Next / Back / 送るのボタンだけ。

async function mount() {
  const { AskCard } = await loadTsx<{ AskCard: ComponentType<Props> }>('../web/src/ui/AskCard.tsx', import.meta.url);
  const sent: string[] = [];
  const time = { now: 10_000 };
  const ask: OpenAsk = { key: 'k', questions: parseAsk(JSON.stringify(INPUT))! };
  const { container } = await render(createElement(AskCard, { ask, busy: false, onAnswer: text => sent.push(text), clock: () => time.now }));
  return {
    container, sent,
    tick: (ms: number) => { time.now += ms; },
    headings: () => [...container.querySelectorAll('h3')].map(h => h.textContent),
    inputs: () => [...container.querySelectorAll('input')],
    button: (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text),
    primary: () => container.querySelector<HTMLButtonElement>('.bt-card__actions .bt-btn--primary'),
    // 3 問とも答え、最後の問いまで進める。
    async answerAll() {
      await click(this.inputs()[0]);
      await click(this.button('Next'));
      await click(this.inputs()[0]);
      await click(this.button('Next'));
      await click(this.inputs()[1]);
    },
  };
}

// マウスのダブルクリックの 2 回目は detail = 2、キーボード（Enter / Space）の click は detail = 0。
const clickWith = (element: Element | null | undefined, detail: number) => update(() => {
  if (!element) throw new Error('clickWith: no element');
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail }));
});
const enter = async (target: Element | null | undefined, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
  if (!target) throw new Error('enter: no element');
  const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  await update(() => { target.dispatchEvent(event); });
  return event;
};

test('ui/ask-step: Back keeps every earlier answer (choices, several picks, Something else text) and Next shows them again', async () => {
  const card = await mount();
  await click(card.inputs()[2]);
  await input(card.container.querySelector('textarea'), 'flat files');
  await click(card.button('Next'));
  await click(card.inputs()[0]);
  await click(card.inputs()[1]);
  await click(card.button('Next'));
  await click(card.inputs()[1]);
  assert.deepEqual(card.headings(), ['Which theme?']);

  await click(card.button('Back'));
  assert.deepEqual(card.headings(), ['Which screens?']);
  assert.deepEqual(card.inputs().map(i => i.checked), [true, true, false], '2 問目: List と Detail が残る');

  await click(card.button('Back'));
  assert.deepEqual(card.headings(), ['Which storage?']);
  assert.deepEqual(card.inputs().map(i => i.checked), [false, false, true], '1 問目: Something else が残る');
  assert.equal(card.container.querySelector('textarea')?.value, 'flat files', '1 問目: 書いた文が残る');

  await click(card.button('Next'));
  await click(card.button('Next'));
  assert.deepEqual(card.headings(), ['Which theme?']);
  assert.deepEqual(card.inputs().map(i => i.checked), [false, true, false], '3 問目: Dark が残る');
  card.tick(ANSWER_GUARD_MS);
  await click(card.button('Answer'));
  assert.deepEqual(card.sent, ['Answers:\n- Storage: flat files\n- Screens: List, Detail\n- Theme: Dark']);
});

test('ui/ask-step: a double-click on Next after Back does not send: the click that continues is not also a click on Answer', async () => {
  const card = await mount();
  await card.answerAll();
  await click(card.button('Back'));
  assert.deepEqual(card.headings(), ['Which screens?']);

  const next = card.button('Next')!;
  await clickWith(next, 1);
  await clickWith(next, 2);
  assert.deepEqual(card.headings(), ['Which theme?'], '最後の問いまで進んだだけ');
  assert.deepEqual(card.sent, [], '2 回目のクリックで送らない');
});

test('ui/ask-step: the second click of a double-click lands on whatever now sits under the pointer: it never sends, a later single click does', async () => {
  const card = await mount();
  await card.answerAll();
  await click(card.button('Back'));

  await clickWith(card.primary(), 1);
  assert.deepEqual(card.headings(), ['Which theme?']);
  assert.equal(card.button('Answer')?.disabled, false, '答えはそろっていて、送れる状態');
  await clickWith(card.primary(), 2);
  assert.deepEqual(card.sent, [], 'ダブルクリックの 2 回目（detail 2）では送らない');

  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.primary(), 1);
  assert.equal(card.sent.length, 1, '改めて押せば送る');
  assert.equal(card.sent[0], 'Answers:\n- Storage: SQLite\n- Screens: List\n- Theme: Dark');
});

test('ui/ask-step: a double-tap (two clicks that both report detail 1) right after Back does not send, whatever the input device reports; a click once the window has passed does', async () => {
  const card = await mount();
  await card.answerAll();
  await click(card.button('Back'));

  await clickWith(card.button('Next'), 1);
  assert.deepEqual(card.headings(), ['Which theme?'], '1 回目のタップで最後の問いへ。Answer が同じ場所に出る');
  await clickWith(card.primary(), 1);
  assert.deepEqual(card.sent, [], '2 回目のタップ（detail 1）では送らない');
  card.tick(ANSWER_GUARD_MS - 1);
  await clickWith(card.primary(), 1);
  assert.deepEqual(card.sent, [], '窓の中では、何回押しても送らない');
  card.tick(1);
  await clickWith(card.primary(), 1);
  assert.deepEqual(card.sent, ['Answers:\n- Storage: SQLite\n- Screens: List\n- Theme: Dark'], '窓が過ぎたら、1 回の押下で送る');
});

test('ui/ask-step: Answer reached by Tab and pressed with the keyboard (click with detail 0, later than the window) sends at once', async () => {
  const card = await mount();
  await card.answerAll();
  card.tick(ANSWER_GUARD_MS);
  card.primary()!.focus();
  await clickWith(document.activeElement, 0);
  assert.equal(card.sent.length, 1);
  assert.equal(card.sent[0], 'Answers:\n- Storage: SQLite\n- Screens: List\n- Theme: Dark');
});

test('ui/ask-step: two quick keyboard presses (Enter / Space click with detail 0) neither send nor skip a question', async () => {
  const card = await mount();
  await card.answerAll();
  await click(card.button('Back'));

  const next = card.button('Next')!;
  next.focus();
  await clickWith(next, 0);
  assert.deepEqual(card.headings(), ['Which theme?']);
  assert.notEqual(document.activeElement?.tagName, 'BUTTON', '進んだあとは、押したボタンにフォーカスを残さない');
  await clickWith(document.activeElement, 0);
  assert.deepEqual(card.sent, [], '2 回目の押下では送らない');
  assert.deepEqual(card.headings(), ['Which theme?']);

  await click(card.button('Back'));
  await click(card.button('Back'));
  assert.deepEqual(card.headings(), ['Which storage?']);
  const first = card.button('Next')!;
  first.focus();
  await clickWith(first, 0);
  await clickWith(document.activeElement, 0);
  assert.deepEqual(card.headings(), ['Which screens?'], '2 回目の押下で答え済みの問いを飛ばさない');
  assert.deepEqual(card.sent, []);
});

test('ui/ask-step: focus follows the question: it moves to the new question on Next and Back, and is not taken when the card first appears', async () => {
  const card = await mount();
  assert.equal(card.container.contains(document.activeElement), false, '出たときは入力欄などのフォーカスを奪わない');
  const group = () => card.container.querySelector('fieldset');

  await click(card.inputs()[0]);
  await click(card.button('Next'));
  assert.equal(document.activeElement, group());
  assert.equal(group()?.getAttribute('aria-label'), 'Which screens?');

  await click(card.button('Back'));
  assert.equal(document.activeElement, group(), 'Back で押したボタンが消えても、フォーカスは body に落ちない');
  assert.equal(group()?.getAttribute('aria-label'), 'Which storage?');
});

test('ui/ask-step: Enter does nothing to the card: a newline in the Something else field, nothing during IME composition, and no send on the last question', async () => {
  const card = await mount();
  await click(card.inputs()[2]);
  const field = card.container.querySelector('textarea');
  await input(field, 'flat files');
  const newline = await enter(field);
  assert.deepEqual(card.headings(), ['Which storage?'], '文を打つ欄の Enter は改行のまま（進まない）');
  assert.equal(newline.defaultPrevented, false, '改行を奪わない');
  assert.deepEqual(card.sent, []);
  for (const init of [{ isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
    await enter(field, init);
    await enter(card.inputs()[2], init);
    assert.deepEqual(card.headings(), ['Which storage?'], `変換中の Enter では何もしない: ${JSON.stringify(init)}`);
    assert.deepEqual(card.sent, []);
  }

  await click(card.inputs()[0]);
  await click(card.button('Next'));
  await click(card.inputs()[0]);
  await click(card.button('Next'));
  await click(card.inputs()[1]);
  await enter(card.inputs()[1]);
  await enter(card.inputs()[1], { isComposing: true });
  assert.deepEqual(card.headings(), ['Which theme?']);
  assert.deepEqual(card.sent, [], '最後の問いがそろっていても、Enter では送らない（送るのは Answer ボタンだけ）');
});
