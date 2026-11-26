import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, PlaywrightBrowser, type ActionEvents, type ElementTarget, type FocusFacts, type PressAt } from '../src/tools/browser/driver.ts';
import type { BrowserGrant } from '../src/tools/browser/loopback.ts';
import { BrowserSession, type MirrorConversation } from '../src/tools/browser/session.ts';
import { FakeBrowser, FakeBrowserDriver, FakePage } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// backlog L192（Stop のあとも、終わっていない操作がある間は「動いている」）・L193（開いてすぐ閉じたポップアップはタブに数えない）

const PAGE = 'https://example.com/start';
const OTHER = 'https://example.com/other';
const SITE = {
  title: 'Start', text: 'start page', snapshot: '- button "Go"\n- button "Pop"\n- combobox "Pick"',
  rows: [
    { role: 'button', name: 'Go' },
    { role: 'button', name: 'Pop', effect: { popups: 1 } },
    { role: 'combobox', name: 'Pick', tag: 'select', options: ['A'] },
  ],
};

// 押す・入れる・選ぶ・キー・開くが、gate が開くまで終わらない偽のページ（Stop で見捨てられても動き続ける本物の Playwright の操作の代わり）
class SlowPage extends FakePage {
  gate: Promise<void> = Promise.resolve();
  override async click(target: ElementTarget, timeoutMs: number): Promise<ActionEvents> { await this.gate; return super.click(target, timeoutMs); }
  override async fill(target: ElementTarget, text: string, submit: boolean, timeoutMs: number): Promise<ActionEvents> { await this.gate; return super.fill(target, text, submit, timeoutMs); }
  override async select(target: ElementTarget, label: string, timeoutMs: number): Promise<ActionEvents> { await this.gate; return super.select(target, label, timeoutMs); }
  override async press(key: string, expected: FocusFacts, timeoutMs: number, at?: PressAt): Promise<ActionEvents> { await this.gate; return super.press(key, expected, timeoutMs, at); }
  override async goto(url: string, timeoutMs: number): Promise<{ status: number | undefined }> { await this.gate; return super.goto(url, timeoutMs); }
}

type Hooks = { after: (fn: () => void | Promise<void>) => void; mock: { method: typeof import('node:test').mock.method } };

function rig(t: Hooks, maxTabs = 4) {
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.limits.maxTabs = maxTabs;
  t.mock.method(FakeBrowser.prototype, 'newPage', async function (this: FakeBrowser) {
    const page = new SlowPage(this);
    this.pageList.push(page);
    return page;
  });
  const driver = new FakeBrowserDriver();
  driver.site(PAGE, SITE).site(OTHER, { title: 'Other', text: 'other page' });
  const active = new Set<string>(['run-1']);
  const clock = { now: 1_000_000 };
  const session = new BrowserSession({ driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' }, now: () => clock.now, schedule: () => () => undefined, runActive: runId => active.has(runId) });
  t.after(() => session.close());
  return { driver, session, active, clock };
}

const grant: BrowserGrant = { conversationId: 'c1', runId: 'run-1', attended: false, loopback: false, productId: 'p-a' };
const conversations: MirrorConversation = id => (id === 'c1' ? { attended: false } : undefined);
const call = () => ({ grant, signal: new AbortController().signal });
const failure = (code: BrowserFailure['code']) => (thrown: unknown): boolean => thrown instanceof BrowserFailure && thrown.code === code;

type Kind = 'click' | 'fill' | 'select' | 'press' | 'goto';

test('L192: Stop で見捨てられた操作（押す・入れる・選ぶ・キー・開く）が終わっていない間は、実行が終わっていても欄の「動いている」の札を出し続ける。終われば消える', async t => {
  const kinds: Kind[] = ['click', 'fill', 'select', 'press', 'goto'];
  for (const kind of kinds) {
    const r = rig(t);
    let release!: () => void;
    let late: Promise<unknown> | undefined;
    await r.session.run(call(), async api => {
      const tab = await api.openTab('work');
      await tab.page.goto(PAGE, 1000);
      const page = r.driver.context!.pageList[0] as SlowPage;
      page.gate = new Promise<void>(resolve => { release = resolve; });
      const go = { ref: page.refFor('button', 'Go'), role: 'button', name: 'Go' };
      const pick = { ref: page.refFor('combobox', 'Pick'), role: 'combobox', name: 'Pick' };
      const none: FocusFacts = { where: 'none', tag: null, type: null, autocomplete: null, hint: '' };
      late = kind === 'click' ? tab.page.click(go, 1000)
        : kind === 'fill' ? tab.page.fill(go, 'x', false, 1000)
          : kind === 'select' ? tab.page.select(pick, 'A', 1000)
            : kind === 'press' ? tab.page.press('Enter', none, 1000, { url: page.url(), documentId: page.documentId() })
              : tab.page.goto(OTHER, 1000);
      late.catch(() => undefined);
    });
    r.active.delete('run-1');
    assert.equal(r.session.view('p-a', conversations)?.driving, true, `${kind}: Stop のあとも、操作が終わっていないので動いている`);
    release();
    await late!.catch(() => undefined);
    assert.equal(r.session.view('p-a', conversations)?.driving, false, `${kind}: 終わったら、実行が終わっているので札は消える`);
  }
});

test('L192: 終わっていない操作は数える（2 つ重なっていたら、1 つ終わっても、2 つとも終わるまで出す）。失敗で終わった操作も数から外れる', async t => {
  const r = rig(t);
  let releaseA!: () => void;
  let releaseB!: () => void;
  const pending: Array<Promise<unknown>> = [];
  await r.session.run(call(), async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
    const page = r.driver.context!.pageList[0] as SlowPage;
    const go = { ref: page.refFor('button', 'Go'), role: 'button', name: 'Go' };
    page.gate = new Promise<void>(resolve => { releaseA = resolve; });
    pending.push(tab.page.click(go, 1000));
    page.gate = new Promise<void>(resolve => { releaseB = resolve; });
    pending.push(tab.page.click({ ...go, ref: 'f9e9' }, 1000));
  });
  for (const one of pending) one.catch(() => undefined);
  r.active.delete('run-1');
  assert.equal(r.session.view('p-a', conversations)?.driving, true, '2 つ未完');
  releaseA();
  await pending[0]!.catch(() => undefined);
  assert.equal(r.session.view('p-a', conversations)?.driving, true, '1 つ終わっても、もう 1 つが残っている');
  releaseB();
  await pending[1]!.then(() => undefined, () => undefined);
  assert.equal(r.session.view('p-a', conversations)?.driving, false, '2 つとも終わった（2 つめは印が引けず失敗で終わった）');
});

test('L192: 操作が無い・終わっているなら、今までどおり（実行が終われば札は消え、動いている実行なら 60 秒で止まる）', async t => {
  const r = rig(t);
  await r.session.run(call(), async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
  });
  assert.equal(r.session.view('p-a', conversations)?.driving, true);
  r.active.delete('run-1');
  assert.equal(r.session.view('p-a', conversations)?.driving, false);
  r.active.add('run-1');
  r.clock.now += 61_000;
  assert.equal(r.session.view('p-a', conversations)?.driving, false);
});

test('L193: 開いてすぐ自分で閉じたポップアップは、タブに数えない。次のタブも開ける（maxTabs = 2）', async t => {
  const r = rig(t, 2);
  const original = FakeBrowser.prototype.popup;
  t.mock.method(FakeBrowser.prototype, 'popup', function (this: FakeBrowser) {
    const page = original.call(this);
    page.closed = true;
    this.pageList = this.pageList.filter(other => other !== page);
    return page;
  });
  const grabbed = await r.session.run(call(), async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
    const page = r.driver.context!.pageList[0] as SlowPage;
    const pop = { ref: page.refFor('button', 'Pop'), role: 'button', name: 'Pop' };
    return api.withPopups(() => tab.page.click(pop, 1000));
  });
  assert.deepEqual([grabbed.opened.length, grabbed.closed], [0, 0], '閉じたポップアップは、開いた窓にも、上限で閉じた窓にも入れない');
  assert.equal(r.session.tabCount('c1'), 1);
  assert.equal(r.session.status().tabs, 1);
  const next = await r.session.run(call(), api => api.openTab('work'));
  assert.equal(r.session.tabCount('c1'), 2, '空いた分で次のタブを開けた');
  assert.ok(next.id);
});

test('L193: 閉じていないポップアップは今までどおりタブになる。上限の 2 枚に着いたら、あふれた分は閉じて数だけ返す', async t => {
  const r = rig(t, 2);
  const grabbed = await r.session.run(call(), async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
    const page = r.driver.context!.pageList[0] as SlowPage;
    const pop = { ref: page.refFor('button', 'Pop'), role: 'button', name: 'Pop' };
    const first = await api.withPopups(() => tab.page.click(pop, 1000));
    const second = await api.withPopups(() => tab.page.click(pop, 1000));
    return { first, second };
  });
  assert.deepEqual([grabbed.first.opened.length, grabbed.first.closed], [1, 0]);
  assert.deepEqual([grabbed.second.opened.length, grabbed.second.closed], [0, 1]);
  assert.equal(r.session.tabCount('c1'), 2);
  await assert.rejects(r.session.run(call(), api => api.openTab('work')), failure('tab_limit'));
});

test('L193: 本物の PlaywrightPage は、ページが閉じているかを渡す', () => {
  let closed = false;
  const page = { isClosed: () => closed, on: () => undefined } as unknown as Page;
  const wrapped = new PlaywrightBrowser({} as BrowserContext).wrap(page);
  assert.equal(wrapped.isClosed?.(), false);
  closed = true;
  assert.equal(wrapped.isClosed?.(), true);
});
