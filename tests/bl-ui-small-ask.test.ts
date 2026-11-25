import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { ANSWER_GUARD_MS, parseAsk, type OpenAsk } from '../web/src/ui/ask.ts';
import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';

// B6 ui-small: 質問カードの Next / Back を素早く 2 回押しても 1 問しか動かない／キーボードで問いを替えたら焦点の輪が見える

const INPUT = {
  questions: [
    { question: 'Which storage?', header: 'Storage', options: [{ label: 'SQLite' }, { label: 'JSON files' }] },
    { question: 'Which screens?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }] },
    { question: 'Which theme?', header: 'Theme', options: [{ label: 'Light' }, { label: 'Dark' }] },
  ],
};

type Props = { ask: OpenAsk; busy: boolean; onAnswer: (text: string) => void; clock?: () => number };

afterEach(async () => { await cleanup(); });

async function mount() {
  const { AskCard } = await loadTsx<{ AskCard: ComponentType<Props> }>('../web/src/ui/AskCard.tsx', import.meta.url);
  const sent: string[] = [];
  const time = { now: 10_000 };
  const ask: OpenAsk = { key: 'k', questions: parseAsk(JSON.stringify(INPUT))! };
  const { container } = await render(createElement(AskCard, { ask, busy: false, onAnswer: text => sent.push(text), clock: () => time.now }));
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text);
  const card = {
    container, sent,
    tick: (ms: number) => { time.now += ms; },
    headings: () => [...container.querySelectorAll('h3')].map(h => h.textContent),
    inputs: () => [...container.querySelectorAll('input')],
    button,
    async go(text: 'Next' | 'Back') { time.now += ANSWER_GUARD_MS; await click(button(text)); },
  };
  // 3 問とも答え、最後の問いまで進めたあと 1 問目まで戻る（戻ったあとの Next は、答え済みの問いを次々に通れる）
  await click(card.inputs()[0]);
  await card.go('Next');
  await click(card.inputs()[0]);
  await card.go('Next');
  await click(card.inputs()[1]);
  await card.go('Back');
  await card.go('Back');
  assert.deepEqual(card.headings(), ['Which storage?']);
  card.tick(ANSWER_GUARD_MS);
  return card;
}

// マウスのダブルクリックの 2 回目は detail = 2、タップは 2 回とも detail = 1 のことがある、キーボードは detail = 0。
const clickWith = (element: Element | null | undefined, detail: number) => update(() => {
  if (!element) throw new Error('clickWith: no element');
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail }));
});

test('bl-ui-small/ask: Next をダブルクリックしても 1 問しか進まない（2 回目の detail 2 は、次の問いの Next に当たらない）', async () => {
  const card = await mount();
  await clickWith(card.button('Next'), 1);
  assert.deepEqual(card.headings(), ['Which screens?']);
  await clickWith(card.button('Next'), 2);
  assert.deepEqual(card.headings(), ['Which screens?'], '2 回目では 3 問目まで飛ばない');
  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.button('Next'), 2);
  assert.deepEqual(card.headings(), ['Which screens?'], '窓が過ぎていても、ダブルクリックの 2 回目（detail 2）は受けない');
});

test('bl-ui-small/ask: ダブルタップ（2 回とも detail 1）でも、問いが替わってすぐの Next / Back は受けない。窓が過ぎたら 1 回の押下で動く', async () => {
  const card = await mount();
  await clickWith(card.button('Next'), 1);
  await clickWith(card.button('Next'), 1);
  assert.deepEqual(card.headings(), ['Which screens?'], '2 回目のタップで 3 問目まで飛ばない');
  card.tick(ANSWER_GUARD_MS - 1);
  await clickWith(card.button('Next'), 1);
  assert.deepEqual(card.headings(), ['Which screens?'], '窓の中では何回押しても動かない');
  card.tick(1);
  await clickWith(card.button('Next'), 1);
  assert.deepEqual(card.headings(), ['Which theme?'], '窓が過ぎたら 1 回で進む');

  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.button('Back'), 1);
  assert.deepEqual(card.headings(), ['Which screens?']);
  await clickWith(card.button('Back'), 1);
  assert.deepEqual(card.headings(), ['Which screens?'], 'Back の 2 回目のタップで 1 問目まで飛ばない');
  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.button('Back'), 2);
  assert.deepEqual(card.headings(), ['Which screens?'], 'Back のダブルクリックの 2 回目（detail 2）も受けない');
  await clickWith(card.button('Back'), 1);
  assert.deepEqual(card.headings(), ['Which storage?'], '改めて 1 回押せば戻る');
});

test('bl-ui-small/ask: キーボード（Enter / Space の click は detail 0）の 1 回の押下は、窓が過ぎていれば Next も Back も 1 問ずつ動かす。答えは消えない', async () => {
  const card = await mount();
  await clickWith(card.button('Next'), 0);
  assert.deepEqual(card.headings(), ['Which screens?']);
  assert.deepEqual(card.inputs().map(i => i.checked), [true, false, false], '2 問目の答え（List）は残る');
  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.button('Next'), 0);
  assert.deepEqual(card.headings(), ['Which theme?']);
  card.tick(ANSWER_GUARD_MS);
  await clickWith(card.button('Back'), 0);
  assert.deepEqual(card.headings(), ['Which screens?']);
  assert.deepEqual(card.sent, []);
});

const CSS = readFileSync(new URL('../web/src/ui/styles/ask.css', import.meta.url), 'utf8');

test('bl-ui-small/ask: 焦点の輪は、問いを替えたあとのグループで、キーボードのときは消えない（outline: none は :focus:not(:focus-visible) の中だけ）', async () => {
  const outlineNone = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(m => ({ selector: m[1]!.trim(), body: m[2]! })).filter(rule => /outline\s*:\s*none/u.test(rule.body));
  const onGroup = outlineNone.filter(rule => rule.selector.includes('.bt-choices'));
  assert.ok(onGroup.length > 0, 'マウスで替えたあとに輪を消す規則は残す');
  for (const rule of onGroup) assert.match(rule.selector, /:focus:not\(:focus-visible\)/u, `キーボードの焦点まで消している: ${rule.selector}`);

  // キーボードで Next を押したあと、焦点は新しい問いのグループへ移る。ブラウザがそこを :focus-visible と見る（キーボードで移ったとき）なら、
  // 焦点の輪を消す規則はグループに当たらない。jsdom は :focus-visible を入力の経緯から決めるので、ここでは「:focus-visible が真」として規則の選び方を調べる。
  const card = await mount();
  await clickWith(card.button('Next'), 0);
  const group = card.container.querySelector('fieldset')!;
  assert.equal(document.activeElement, group, '問いが替わったら、焦点は新しい問いのグループへ');
  const hiding = outlineNone.map(rule => rule.selector).filter(selector => group.matches(selector.replace(/:focus-visible/gu, '*')));
  assert.deepEqual(hiding, [], 'キーボードで移ったときに焦点の輪を消す規則がグループに当たっている');
});
