import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { PlaywrightBrowser, type ElementBox, type ElementDetail, type ElementTarget } from '../src/tools/browser/driver.ts';
import type { BrowserGrant } from '../src/tools/browser/loopback.ts';
import { BrowserSession, pointerOf, type MirrorConversation } from '../src/tools/browser/session.ts';
import { FakeBrowserDriver, FakePage } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// 9-2b: Browser の欄の AI の指（view.pointer）。事前の判定の locate で読んだ要素の位置の中心を、押す・入れるで指にする

const PAGE_A = 'https://a.example.com/';
const PAGE_B = 'https://b.example.com/next';
const UPLOAD: ElementTarget = { ref: 'f2e1', role: 'button', name: 'Upload' };
const NAME: ElementTarget = { ref: 'f2e2', role: 'textbox', name: 'Name' };
// 偽のページで、表を撮らずに押す印（開いた文書で、Upload・Name の順に印を振る）
const refsOn = (page: FakePage): void => { assert.equal(page.refFor('button', 'Upload'), UPLOAD.ref); assert.equal(page.refFor('textbox', 'Name'), NAME.ref); };

const drivers = new WeakMap<BrowserSession, FakeBrowserDriver>();
const fakePage = (session: BrowserSession): FakePage => drivers.get(session)!.context!.pageList[0]! as FakePage;

function rig(t: { after: (fn: () => void | Promise<void>) => void; mock: { method: typeof import('node:test').mock.method } }, boxes: Record<string, ElementBox>) {
  const config = testConfig();
  config.tools.browser.enabled = true;
  const driver = new FakeBrowserDriver();
  driver.site(PAGE_A, { title: 'Page A', rows: [{ role: 'button', name: 'Upload' }, { role: 'textbox', name: 'Name' }] });
  driver.site(PAGE_B, { title: 'Page B' });
  const real = FakePage.prototype.locate;
  t.mock.method(FakePage.prototype, 'locate', async function (this: FakePage, target: ElementTarget): Promise<ElementDetail | undefined> {
    const detail = await real.call(this, target);
    const box = boxes[target.name];
    return detail && box ? { ...detail, box } : detail;
  });
  const session = new BrowserSession({ driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' }, now: () => 1_000_000, schedule: () => () => undefined });
  t.after(() => session.close());
  drivers.set(session, driver);
  return session;
}

const grant: BrowserGrant = { conversationId: 'c1', runId: 'run-1', attended: true, loopback: false, productId: 'p-a' };
const conversations: MirrorConversation = id => (id === 'c1' ? { attended: true } : undefined);

test('pointerOf: 同じ要素の位置の中心。別の要素・見える範囲の外は無し', () => {
  const box = { x: 100, y: 200, width: 40, height: 20 };
  assert.deepEqual(pointerOf({ target: UPLOAD, box }, UPLOAD), { x: 120, y: 210 });
  assert.equal(pointerOf({ target: UPLOAD, box }, { ...UPLOAD, ref: 'f2e9' }), undefined, '別の要素');
  assert.equal(pointerOf({ target: UPLOAD, box }, NAME), undefined);
  assert.equal(pointerOf(undefined, UPLOAD), undefined);
  assert.equal(pointerOf({ target: UPLOAD, box: { x: 100, y: 1200, width: 40, height: 20 } }, UPLOAD), undefined, '下に隠れた要素（押すときにスクロールされる）');
  assert.equal(pointerOf({ target: UPLOAD, box: { x: -60, y: 10, width: 40, height: 20 } }, UPLOAD), undefined);
  assert.deepEqual(pointerOf({ target: UPLOAD, box: { x: 1260, y: 780, width: 40, height: 40 } }, UPLOAD), { x: 1280, y: 800 }, '端はちょうど含む');
});

test('view.pointer: locate のあとに押すと、その要素の中心。入れるも同じ。開き直すと消える', async t => {
  const session = rig(t, { Upload: { x: 600, y: 380, width: 80, height: 40 }, Name: { x: 10, y: 20, width: 200, height: 30 } });
  const tab = await session.run({ grant, signal: new AbortController().signal }, async api => {
    const opened = await api.openTab('work');
    await opened.page.goto(PAGE_A, 1000);
    return opened;
  });
  refsOn(fakePage(session));
  assert.equal(session.view('p-a', conversations)?.pointer, null, '開いただけでは指は無い');

  await session.run({ grant, signal: new AbortController().signal }, async api => {
    const mine = api.tab(tab.id);
    assert.ok(await mine.page.locate(UPLOAD));
    await mine.page.click(UPLOAD, 1000);
  });
  assert.deepEqual(session.view('p-a', conversations)?.pointer, { x: 640, y: 400 });

  await session.run({ grant, signal: new AbortController().signal }, async api => {
    const mine = api.tab(tab.id);
    await mine.page.locate(NAME);
    await mine.page.fill(NAME, 'beat', false, 1000);
  });
  assert.deepEqual(session.view('p-a', conversations)?.pointer, { x: 110, y: 35 });

  await session.run({ grant, signal: new AbortController().signal }, async api => {
    const mine = api.tab(tab.id);
    await mine.page.locate(UPLOAD);
    await mine.page.fill(NAME, 'again', false, 1000);
  });
  assert.equal(session.view('p-a', conversations)?.pointer, null, '最後に読んだ位置が別の要素なら指を出さない');

  await session.run({ grant, signal: new AbortController().signal }, async api => {
    const mine = api.tab(tab.id);
    await mine.page.locate(UPLOAD);
    await mine.page.click(UPLOAD, 1000);
    await mine.page.goto(PAGE_B, 1000);
  });
  assert.equal(session.view('p-a', conversations)?.pointer, null, '開き直したら指は消える');
});

test('P6 view.pointer / action: select は押すと同じ（locate で読んだ要素の中心・欄の言葉は click）。press は指を動かさず、欄の言葉は type（名前なし）', async t => {
  const session = rig(t, { Size: { x: 600, y: 380, width: 80, height: 40 } });
  drivers.get(session)!.sites.get(PAGE_A)!.rows!.push({ role: 'combobox', name: 'Size', tag: 'select', options: ['Small', 'Large'] });
  const tab = await session.run({ grant, signal: new AbortController().signal }, async api => {
    const opened = await api.openTab('work');
    await opened.page.goto(PAGE_A, 1000);
    return opened;
  });
  const size: ElementTarget = { ref: fakePage(session).refFor('combobox', 'Size'), role: 'combobox', name: 'Size' };
  await session.run({ grant, signal: new AbortController().signal }, async api => {
    const mine = api.tab(tab.id);
    assert.ok(await mine.page.locate(size));
    await mine.page.select(size, 'Large', 1000);
  });
  assert.deepEqual(session.view('p-a', conversations)?.pointer, { x: 640, y: 400 });
  assert.deepEqual(session.view('p-a', conversations)?.action, { kind: 'click', target: 'Size' });
  await session.run({ grant, signal: new AbortController().signal }, async api => {
    await api.tab(tab.id).page.press('Tab', { where: 'none', tag: null, type: null, autocomplete: null, hint: '' }, 1000);
  });
  assert.deepEqual(session.view('p-a', conversations)?.action, { kind: 'type', target: '' });
  assert.deepEqual(session.view('p-a', conversations)?.pointer, { x: 640, y: 400 }, 'press は指を動かさない');
  assert.deepEqual(fakePage(session).acts.map(a => a.kind), ['select', 'press']);
});

// 本物の PlaywrightPage.locate: 要素の位置（boundingBox）を box に。読めない・投げるときは box を持たず、事前の判定は今までどおり
const MAIN_FRAME = {};
function playwrightPage(boundingBox: (options?: { timeout?: number }) => Promise<{ x: number; y: number; width: number; height: number } | null>) {
  const page = {
    on: () => {},
    mainFrame: () => MAIN_FRAME,
    getByRef: () => ({
      count: async () => 1, elementHandle: async () => ({ ownerFrame: async () => MAIN_FRAME, dispose: async () => {} }),
      isVisible: async () => true, isEnabled: async () => true, evaluate: async () => ({ type: null, autocomplete: null, inForm: false, submits: false }), boundingBox,
    }),
    waitForLoadState: async () => {},
  } as unknown as Page;
  return new PlaywrightBrowser({} as BrowserContext).wrap(page);
}

test('PlaywrightPage.locate: 要素の位置を box に入れる。読めなければ box なしで、ほかは同じ', async () => {
  const base = { visible: true, enabled: true, type: undefined, autocomplete: undefined, form: { inForm: false, submits: false } };
  assert.deepEqual(await playwrightPage(async () => ({ x: 1.5, y: 2, width: 30, height: 10 })).locate(UPLOAD), { ...base, box: { x: 1.5, y: 2, width: 30, height: 10 } });
  assert.deepEqual(await playwrightPage(async () => null).locate(UPLOAD), base);
  assert.deepEqual(await playwrightPage(async () => { throw new Error('detached'); }).locate(UPLOAD), base, '位置が読めなくても事前の判定を落とさない');
  const asked: Array<{ timeout?: number } | undefined> = [];
  await playwrightPage(async options => { asked.push(options); return null; }).locate(UPLOAD);
  assert.deepEqual(asked, [{ timeout: 1000 }], '位置の読みは 1 秒で諦める（事前の判定を待たせない）');
});
