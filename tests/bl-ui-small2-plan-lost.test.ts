import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, AcceptanceItem } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { setExplainLanguage } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// bl-ui-small2（backlog 元 L274）: 直す欄を開いている項目を AI が消すと、打ちかけの文が黙って消えた。
// 「一覧が変わった」と知らせ、打ちかけの文を画面に残す（コピーして書き直せる）。

interface PlanProps { productId: string; conversationId?: string; revision: string; isGit: boolean }

const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
const PLAN = { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false };

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const settleAll = async () => { for (let i = 0; i < 4; i++) await settle(); };

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.location.hash = '';
  localStorage.clear();
  setExplainLanguage('en');
});

const item = (id: string, result: string, over: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id, result, source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null, ...over,
});
const acceptance = (version: number, items: AcceptanceItem[]): Acceptance => ({ version, language: 'en', items, not_doing: [], draft: false, hash: `h${version}`, frozen: null });

function open(state: { current: Acceptance }) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const [route] = String(path).split('?');
    const out = route === `/api/projects/${PRODUCT}/plan` ? { plan: PLAN } : route === `/api/projects/${PRODUCT}/acceptance` ? { acceptance: state.current } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const element = (revision: string) => createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision, isGit: true });
  return { element };
}

const buttonNamed = (container: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label);
const editor = (container: HTMLElement) => container.querySelector<HTMLTextAreaElement>('textarea.ui-acc__input');
const lostNotice = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.bt-notice')].find(n => n.textContent?.includes(en['ui.acc.edit.lost']('A-1')));

async function openEditor(container: HTMLElement): Promise<void> {
  await click(container.querySelector('li.ui-acc__row button.ui-acc__text'));
  await click(buttonNamed(container.querySelector('.ui-acc__detail')!, en['ui.acc.edit.edit']));
  assert.ok(editor(container), '前提: 直す欄が開いた');
}

// AI が裏で A-1 を消し、受け入れの一覧が新しい版に替わった、を画面に届ける（revision が変わると読み直す）
async function aiRemovesFirst(rendered: { root: { render: (node: any) => void } }, pane: ReturnType<typeof open>, state: { current: Acceptance }): Promise<void> {
  state.current = acceptance(3, [item('A-1', 'It opens', { removedIn: 3 }), item('A-2', 'It closes')]);
  await update(() => rendered.root.render(pane.element('1')));
  await settleAll();
}

test('bl-ui-small2/plan-lost: 直す欄に打ちかけの文があるまま、その項目を AI が消すと、「一覧が変わった」と知らせ、打ちかけの文を残す。閉じると消える', async () => {
  const state = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const pane = open(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await openEditor(rendered.container);
  await input(editor(rendered.container), 'It opens in under a second');
  assert.ok(!lostNotice(rendered.container), '前提: 消える前は知らせが無い');

  await aiRemovesFirst(rendered, pane, state);
  assert.ok(!editor(rendered.container), '前提: 消えた項目の直す欄は無くなる');
  const notice = lostNotice(rendered.container);
  assert.ok(notice, '「一覧が変わった」の知らせが出る');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('It opens in under a second')), '打ちかけの文が画面に残る');
  assert.ok(notice.closest('[role="status"]'), '読み上げに届く欄の中');

  await click(buttonNamed(notice, en['ui.close']));
  assert.ok(!lostNotice(rendered.container), '閉じると知らせは消える');
});

test('bl-ui-small2/plan-lost: コマンドで確かめる項目なら、結果の文とコマンドの両方を残す', async () => {
  const state = { current: acceptance(2, [item('A-1', 'It opens', { check: { kind: 'command', command: 'npm test' } }), item('A-2', 'It closes')]) };
  const pane = open(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await openEditor(rendered.container);
  await input(editor(rendered.container), 'It opens fast');
  await input(rendered.container.querySelector('input.bt-field--mono'), 'npm run smoke');
  await aiRemovesFirst(rendered, pane, state);
  const notice = lostNotice(rendered.container);
  assert.ok(notice, '知らせが出る');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('It opens fast · npm run smoke')), '結果とコマンドの両方が残る');
});

test('bl-ui-small2/plan-lost: 知らせを出さない場合 — 何も打っていない欄、閉じたあとの欄、項目が残っている欄', async () => {
  // 何も打たないまま項目が消えても、無くなる文は無い
  const untouched = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const pane1 = open(untouched);
  const first = await render(pane1.element('0'));
  await settleAll();
  await openEditor(first.container);
  await aiRemovesFirst(first, pane1, untouched);
  assert.ok(!lostNotice(first.container), '打っていない欄は知らせない');
  await cleanup();

  // 打ったあと Cancel で閉じたなら、そのあと消えても知らせない
  const closed = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const pane2 = open(closed);
  const second = await render(pane2.element('0'));
  await settleAll();
  await openEditor(second.container);
  await input(editor(second.container), 'It opens fast');
  await click(buttonNamed(second.container, en['ui.acc.edit.cancel']));
  await aiRemovesFirst(second, pane2, closed);
  assert.ok(!lostNotice(second.container), '閉じた欄は知らせない');
  assert.ok(!byText(second.container, 'p, span, strong', en['ui.acc.edit.lostText']('It opens fast')), '残る文も出ない');
  await cleanup();

  // AI が別の項目を足しただけで、直している項目が残っているなら、直す欄は開いたまま・知らせは無い
  const kept = { current: acceptance(2, [item('A-1', 'It opens')]) };
  const pane3 = open(kept);
  const third = await render(pane3.element('0'));
  await settleAll();
  await openEditor(third.container);
  await input(editor(third.container), 'It opens fast');
  kept.current = acceptance(3, [item('A-1', 'It opens'), item('A-2', 'Added by the AI')]);
  await update(() => third.root.render(pane3.element('1')));
  await settleAll();
  assert.ok(editor(third.container), '項目が残っているので、直す欄は開いたまま');
  assert.ok(!lostNotice(third.container), '項目が残っているなら知らせない');
});

test('bl-ui-small2/plan-lost: 説明の言語を日本語にすると、知らせも日本語で出る（打った文はそのまま）', async () => {
  setExplainLanguage('ja');
  const state = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const pane = open(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await openEditor(rendered.container);
  await input(editor(rendered.container), 'It opens fast');
  await aiRemovesFirst(rendered, pane, state);
  const text = rendered.container.textContent ?? '';
  assert.ok(text.includes(ja['ui.acc.edit.lost']('A-1')), '知らせの題が日本語');
  assert.ok(text.includes(ja['ui.acc.edit.lostText']('It opens fast')), '打ちかけの文の前置きが日本語で、文はそのまま');
  assert.ok(!text.includes(en['ui.acc.edit.lost']('A-1')), '英語の題は出ない');
});
