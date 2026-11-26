import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, AcceptanceItem } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { setExplainLanguage } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// bl-ui-small2（backlog 元 L274）: 直す欄を開いている項目を AI が消すと、打ちかけの文が黙って消えた。
// 「一覧が変わった」と知らせ、打ちかけの文を画面に残す（コピーして書き直せる）。
// 下書きの一覧の項目の番号は、AI が書き直すたびに並びの順で振り直される（A-1, A-2, ...）。だから「その番号が一覧にあるか」では決められない。
// 知らせは、直す欄が閉じたときに出して、閉じるまで残す。項目は、開いたときの文で呼ぶ。

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
// 下書き: 版は 0 のまま、番号は並びの順（AI が書き直すと全部振り直される）
const draftOf = (results: string[], tag: string): Acceptance => ({ version: 0, language: 'en', items: results.map((result, i) => item(`A-${i + 1}`, result)), not_doing: [], draft: true, hash: `d-${tag}`, frozen: null });

type Rendered = { container: HTMLElement; root: { render: (node: any) => void } };

function open(state: { current: Acceptance }, onSaved?: () => void) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const [route] = String(path).split('?');
    let out: unknown;
    if (route === `/api/projects/${PRODUCT}/plan`) out = { plan: PLAN };
    else if (route === `/api/projects/${PRODUCT}/acceptance`) out = { acceptance: state.current };
    else if (route === `/api/projects/${PRODUCT}/acceptance/edit` && init?.method === 'POST') { onSaved?.(); out = { acceptance: state.current }; }
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const element = (revision: string) => createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision, isGit: true });
  return { element };
}

const buttonNamed = (container: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label);
const editor = (container: HTMLElement) => container.querySelector<HTMLTextAreaElement>('textarea.ui-acc__input');
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section[aria-label="Acceptance"] li.ui-acc__row')];
const LOST_START = en['ui.acc.edit.lost']('').slice(0, en['ui.acc.edit.lost']('').indexOf('"'));
const lostNotices = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.bt-notice')].filter(n => n.textContent?.includes(LOST_START));
const lostNotice = (container: HTMLElement, opened: string) => lostNotices(container).find(n => n.textContent?.includes(en['ui.acc.edit.lost'](opened)));

async function openEditor(container: HTMLElement, at = 0): Promise<void> {
  const row = rows(container)[at]!;
  await click(row.querySelector('button.ui-acc__text'));
  await click(buttonNamed(row.querySelector('.ui-acc__detail')!, en['ui.acc.edit.edit']));
  assert.ok(editor(container), '前提: 直す欄が開いた');
}

async function show(state: { current: Acceptance }, onSaved?: () => void) {
  const pane = open(state, onSaved);
  const rendered = await render(pane.element('0'));
  await settleAll();
  let revision = 0;
  // AI が裏で一覧を書き直した、を画面に届ける（revision が変わると読み直す）
  const rewrite = async (next: Acceptance) => {
    state.current = next;
    revision += 1;
    await update(() => rendered.root.render(pane.element(String(revision))));
    await settleAll();
  };
  return { container: rendered.container as HTMLElement, rewrite };
}

test('bl-ui-small2/plan-lost: 直す欄に打ちかけの文があるまま、その項目を AI が消すと、「一覧が変わった」と知らせ、打ちかけの文を残す。閉じると消える', async () => {
  const state = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const { container, rewrite } = await show(state);
  await openEditor(container);
  await input(editor(container), 'It opens in under a second');
  assert.equal(lostNotices(container).length, 0, '前提: 消える前は知らせが無い');

  await rewrite(acceptance(3, [item('A-1', 'It opens', { removedIn: 3 }), item('A-2', 'It closes')]));
  assert.ok(!editor(container), '前提: 消えた項目の直す欄は無くなる');
  const notice = lostNotice(container, 'It opens');
  assert.ok(notice, '「一覧が変わった」の知らせが出る（項目は開いたときの文で呼ぶ）');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('It opens in under a second')), '打ちかけの文が画面に残る');
  assert.ok(notice.closest('[role="status"]'), '読み上げに届く欄の中');

  await click(buttonNamed(notice, en['ui.close']));
  assert.equal(lostNotices(container).length, 0, '閉じると知らせは消える');
});

test('bl-ui-small2/plan-lost: コマンドで確かめる項目なら、結果の文とコマンドの両方を残す。長い項目の文は途中で切って呼ぶ', async () => {
  const long = `It opens ${'x'.repeat(80)}`;
  const state = { current: acceptance(2, [item('A-1', long, { check: { kind: 'command', command: 'npm test' } }), item('A-2', 'It closes')]) };
  const { container, rewrite } = await show(state);
  await openEditor(container);
  await input(editor(container), 'It opens fast');
  await input(container.querySelector('input.bt-field--mono'), 'npm run smoke');
  await rewrite(acceptance(3, [item('A-1', long, { removedIn: 3 }), item('A-2', 'It closes')]));
  const notice = lostNotice(container, `${long.slice(0, 59)}…`);
  assert.ok(notice, '知らせが出る。呼び名は 60 文字までで切る');
  assert.ok(!notice.textContent?.includes('x'.repeat(70)), '長い文をそのまま出さない');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('It opens fast · npm run smoke')), '結果とコマンドの両方が残る');
});

test('bl-ui-small2/plan-lost: 下書きは AI が書き直すたびに番号が振り直される。知らせは閉じるまで残り、あとの書き直しで項目の番号が戻っても消えない', async () => {
  const state = { current: draftOf(['one', 'two', 'three'], '0') };
  const { container, rewrite } = await show(state);
  await openEditor(container, 2);
  await input(editor(container), 'three, but better');

  await rewrite(draftOf(['one', 'two'], '1'));
  assert.ok(lostNotice(container, 'three')?.textContent?.includes(en['ui.acc.edit.lostText']('three, but better')), '1 回目の書き直し: 知らせと打ちかけの文が出る');

  await rewrite(draftOf(['one', 'two', 'four'], '2'));
  assert.equal(rows(container).length, 3, '前提: A-3 がまた一覧に載った');
  const notice = lostNotice(container, 'three');
  assert.ok(notice, '2 回目の書き直し（A-3 が戻った）でも、知らせは消えない');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('three, but better')), '打ちかけの文も画面に残る');

  await click(buttonNamed(notice, en['ui.close']));
  assert.equal(lostNotices(container).length, 0, '閉じると消える');
});

test('bl-ui-small2/plan-lost: 下書きで先頭の項目が消えて番号がずれても、知らせは「A-3 が消えた」とは言わず、持ち主が直していた文で呼ぶ（その項目は A-2 として残っている）', async () => {
  const state = { current: draftOf(['one', 'two', 'three'], '0') };
  const { container, rewrite } = await show(state);
  await openEditor(container, 2);
  await input(editor(container), 'three, but better');
  await rewrite(draftOf(['two', 'three'], '1'));
  assert.equal(rows(container).length, 2);
  assert.ok(rows(container)[1]!.textContent?.includes('three'), '前提: 持ち主の項目は A-2 として残っている');
  const notice = lostNotice(container, 'three');
  assert.ok(notice, '開いたときの文で呼ぶ');
  assert.ok(!notice.textContent?.includes('A-3'), '番号では呼ばない');
  assert.ok(notice.textContent?.includes(en['ui.acc.edit.lostText']('three, but better')));
});

test('bl-ui-small2/plan-lost: 下書きで手前の項目が消え、直す欄の下に別の項目が来たら、直す欄を閉じて知らせる。何も打っていなければ、閉じるだけで知らせない', async () => {
  const typed = { current: draftOf(['one', 'two', 'three'], '0') };
  const first = await show(typed);
  await openEditor(first.container, 1);
  await input(editor(first.container), 'two, but better');
  await first.rewrite(draftOf(['two', 'three'], '1'));
  assert.ok(!editor(first.container), '別の項目の下に直す欄を残さない');
  assert.ok(lostNotice(first.container, 'two')?.textContent?.includes(en['ui.acc.edit.lostText']('two, but better')), '打ちかけの文を残して知らせる');
  await cleanup();

  const untouched = { current: draftOf(['one', 'two', 'three'], '0') };
  const second = await show(untouched);
  await openEditor(second.container, 1);
  await second.rewrite(draftOf(['two', 'three'], '1'));
  assert.ok(!editor(second.container), '何も打っていなくても、別の項目の下に直す欄は残さない');
  assert.equal(lostNotices(second.container).length, 0, '無くなる文が無いので知らせない');
});

test('bl-ui-small2/plan-lost: 知らせを出さない場合 — 何も打っていない・Cancel・Esc・Save・打って元に戻した・項目が残っている', async () => {
  const base = () => ({ current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) });
  const removeFirst = (container: HTMLElement, rewrite: (next: Acceptance) => Promise<void>, version: number, text = 'It opens') =>
    rewrite(acceptance(version, [item('A-1', text, { removedIn: version }), item('A-2', 'It closes')])).then(() => assert.equal(rows(container).length, 1, '前提: 項目が消えた'));

  // 何も打たないまま項目が消えても、無くなる文は無い
  const a = await show(base());
  await openEditor(a.container);
  await removeFirst(a.container, a.rewrite, 3);
  assert.equal(lostNotices(a.container).length, 0, '打っていない欄は知らせない');
  await cleanup();

  // Cancel で閉じたあとに消えても知らせない
  const b = await show(base());
  await openEditor(b.container);
  await input(editor(b.container), 'It opens fast');
  await click(buttonNamed(b.container, en['ui.acc.edit.cancel']));
  await removeFirst(b.container, b.rewrite, 3);
  assert.equal(lostNotices(b.container).length, 0, 'Cancel で閉じた欄は知らせない');
  await cleanup();

  // Esc で閉じたあとに消えても知らせない
  const c = await show(base());
  await openEditor(c.container);
  await input(editor(c.container), 'It opens fast');
  await update(() => { editor(c.container)!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.ok(!editor(c.container), '前提: Esc で閉じた');
  await removeFirst(c.container, c.rewrite, 3);
  assert.equal(lostNotices(c.container).length, 0, 'Esc で閉じた欄は知らせない');
  await cleanup();

  // Save: 自分の保存で一覧が読み直されて項目の文が変わっても、失われた文は無い（保存した）。そのあと消えても知らせない
  const dState = base();
  const d = await show(dState, () => { dState.current = acceptance(3, [item('A-1', 'It opens fast'), item('A-2', 'It closes')]); });
  await openEditor(d.container);
  await input(editor(d.container), 'It opens fast');
  await click(buttonNamed(d.container, en['ui.acc.edit.save']));
  await settleAll();
  assert.ok(!editor(d.container), '前提: 保存して直す欄が閉じた');
  assert.ok(rows(d.container)[0]!.textContent?.includes('It opens fast'), '前提: 保存した文が一覧に載った');
  assert.equal(lostNotices(d.container).length, 0, '保存したのに「保存していない」と知らせない');
  await removeFirst(d.container, d.rewrite, 4, 'It opens fast');
  assert.equal(lostNotices(d.container).length, 0, '保存して閉じた欄は、そのあと消えても知らせない');
  await cleanup();

  // 打って、元の文に戻したなら、無くなる文は無い（直す欄は開いたまま消える）
  const e = await show(base());
  await openEditor(e.container);
  await input(editor(e.container), 'It opens fast');
  await input(editor(e.container), 'It opens');
  await removeFirst(e.container, e.rewrite, 3);
  assert.equal(lostNotices(e.container).length, 0, '元に戻した欄は知らせない');
  await cleanup();

  // AI が別の項目を足しただけで、直している項目が残っているなら、直す欄は開いたまま・知らせは無い
  const f = await show({ current: acceptance(2, [item('A-1', 'It opens')]) });
  await openEditor(f.container);
  await input(editor(f.container), 'It opens fast');
  await f.rewrite(acceptance(3, [item('A-1', 'It opens'), item('A-2', 'Added by the AI')]));
  assert.ok(editor(f.container), '項目が残っているので、直す欄は開いたまま');
  assert.equal(editor(f.container)!.value, 'It opens fast', '打った文もそのまま');
  assert.equal(lostNotices(f.container).length, 0, '項目が残っているなら知らせない');
});

test('bl-ui-small2/plan-lost: 説明の言語を日本語にすると、知らせも日本語で出る（打った文と項目の文はそのまま）', async () => {
  setExplainLanguage('ja');
  const state = { current: acceptance(2, [item('A-1', 'It opens'), item('A-2', 'It closes')]) };
  const { container, rewrite } = await show(state);
  await openEditor(container);
  await input(editor(container), 'It opens fast');
  await rewrite(acceptance(3, [item('A-1', 'It opens', { removedIn: 3 }), item('A-2', 'It closes')]));
  const text = container.textContent ?? '';
  assert.ok(text.includes(ja['ui.acc.edit.lost']('It opens')), '知らせの題が日本語');
  assert.ok(text.includes(ja['ui.acc.edit.lostText']('It opens fast')), '打ちかけの文の前置きが日本語で、文はそのまま');
  assert.ok(!text.includes(en['ui.acc.edit.lost']('It opens')), '英語の題は出ない');
});
