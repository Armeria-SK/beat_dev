import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, PlaywrightBrowser, type ViewportSize } from '../src/tools/browser/driver.ts';
import type { BrowserGrant } from '../src/tools/browser/loopback.ts';
import { BrowserSession, type MirrorConversation } from '../src/tools/browser/session.ts';
import { browserOpen } from '../src/tools/builtin/browser.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeBrowser, FakeBrowserDriver, FakePage } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// backlog L131（手で閉じたタブ）・L132 + L152（終わった実行の「動いている」の札）・L174（browser_open の画面の大きさ）

const PAGE = 'https://example.com/start';
const OTHER = 'https://example.com/other';

// 本物の Playwright のページと同じく、タブが閉じたら（こちらが閉じても、持ち主が手で閉じても）知らせ、画面の大きさを変えられる偽のページ
class TabPage extends FakePage {
  size: ViewportSize | undefined;
  readonly #closers: Array<() => void> = [];
  onClose(cb: () => void): void { this.#closers.push(cb); }
  async setViewport(size: ViewportSize): Promise<void> { this.size = size; }
  override async close(): Promise<void> { await super.close(); this.#fire(); }
  // 持ち主がブラウザの窓でこのタブを閉じた（beat は何も呼んでいない）
  closeByHand(): void {
    this.closed = true;
    this.browser.pageList = this.browser.pageList.filter(page => page !== this);
    this.#fire();
  }

  #fire(): void { for (const cb of this.#closers) cb(); }
}

interface Rig { driver: FakeBrowserDriver; session: BrowserSession; active: Set<string>; clock: { now: number }; pages(): TabPage[]; ctx(over?: Partial<ToolContext>): ToolContext }

function rig(t: { after: (fn: () => void | Promise<void>) => void; mock: { method: typeof import('node:test').mock.method } }, maxTabs = 4): Rig {
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.limits.maxTabs = maxTabs;
  t.mock.method(FakeBrowser.prototype, 'newPage', async function (this: FakeBrowser) {
    const page = new TabPage(this);
    this.pageList.push(page);
    return page;
  });
  const driver = new FakeBrowserDriver();
  driver.site(PAGE, { title: 'Start', text: 'start page' });
  driver.site(OTHER, { title: 'Other', text: 'other page' });
  const active = new Set<string>(['run-1']);
  const clock = { now: 1_000_000 };
  const session = new BrowserSession({ driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' }, now: () => clock.now, schedule: () => () => undefined, runActive: runId => active.has(runId) });
  t.after(() => session.close());
  const pages = (): TabPage[] => [...(driver.context?.pageList ?? []), ...(driver.current?.pageList ?? [])] as TabPage[];
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'run-1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, workspace: 'C:\\work', project: { id: 'p-a' },
    taint: { tainted: false, sources: [] }, log: () => undefined, services: { browser: session }, model: { id: 'm', vision: true }, ...over,
  } as unknown as ToolContext);
  return { driver, session, active, clock, pages, ctx };
}

const grant: BrowserGrant = { conversationId: 'c1', runId: 'run-1', attended: false, loopback: false, productId: 'p-a' };
const conversations: MirrorConversation = id => (id === 'c1' ? { attended: false } : undefined);
const chat: MirrorConversation = id => (id === 'c1' ? { attended: true } : undefined);
const failure = (code: BrowserFailure['code']) => (thrown: unknown): boolean => thrown instanceof BrowserFailure && thrown.code === code;
const call = () => ({ grant, signal: new AbortController().signal });

test('L131: 持ち主が手で閉じたタブは、一覧から消え、maxTabs の数にも入らない（また開ける）', async t => {
  const r = rig(t, 2);
  const [first, second] = await r.session.run(call(), async api => {
    const a = await api.openTab('work');
    await a.page.goto(PAGE, 1000);
    return [a, await api.openTab('work')] as const;
  });
  assert.equal(r.session.tabCount('c1'), 2);
  await assert.rejects(r.session.run(call(), api => api.openTab('work')), failure('tab_limit'), '上限の 2 枚');
  const [pageA] = r.pages();
  pageA!.closeByHand();
  assert.equal(r.session.tabCount('c1'), 1, '手で閉じたタブは数えない');
  assert.equal(r.session.status().tabs, 1);
  assert.equal(r.session.view('p-a', conversations), null, '閉じたタブを欄に映さない');
  assert.equal(r.session.frame(first.id, 'p-a', conversations), undefined);
  const third = await r.session.run(call(), async api => {
    assert.deepEqual(api.tabs().map(tab => tab.id), [second.id], '一覧に残るのは開いている 1 枚だけ');
    assert.throws(() => api.tab(first.id), failure('no_tab'));
    return api.openTab('work');
  });
  assert.equal(r.session.tabCount('c1'), 2, '空いた分で新しく開けた');
  assert.notEqual(third.id, first.id, 'タブの番号は使い回さない');
});

test('L131: beat が自分で閉じたタブは、これまでどおり 1 回だけ外れる（閉じた知らせで二重に外さない）', async t => {
  const r = rig(t, 2);
  await r.session.run(call(), async api => {
    const a = await api.openTab('work');
    const b = await api.openTab('work');
    assert.equal(await api.closeTab(a.id), true);
    assert.deepEqual(api.tabs().map(tab => tab.id), [b.id]);
    assert.equal(await api.closeTab(a.id), false);
  });
  assert.equal(r.session.tabCount('c1'), 1);
});

test('L131: 本物の PlaywrightPage は、ページの close の知らせを渡す', () => {
  const handlers = new Map<string, () => void>();
  const page = { on: (name: string, cb: () => void) => { handlers.set(name, cb); } } as unknown as Page;
  const wrapped = new PlaywrightBrowser({} as BrowserContext).wrap(page);
  let closed = 0;
  wrapped.onClose(() => { closed += 1; });
  handlers.get('close')!();
  assert.equal(closed, 1);
});

test('L132 + L152: 実行が終わったら、欄の「動いている」の札はすぐ消える。動いている実行・呼び出しの最中は出る', async t => {
  const r = rig(t);
  await r.session.run(call(), async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
    assert.equal(r.session.view('p-a', conversations)?.driving, true, '呼び出しの最中');
    r.active.delete('run-1');
    assert.equal(r.session.view('p-a', conversations)?.driving, true, '呼び出しの最中は、実行の様子に関わらず動いている');
    r.active.add('run-1');
  });
  assert.equal(r.session.view('p-a', conversations)?.driving, true, '実行が動いていて、最後の操作から間もない');
  r.active.delete('run-1');
  assert.equal(r.session.view('p-a', conversations)?.driving, false, '実行が終わった（最後の操作から 1 秒もたたない）');
  r.active.add('run-1');
  assert.equal(r.session.view('p-a', conversations)?.driving, true);
  r.clock.now += 61_000;
  assert.equal(r.session.view('p-a', conversations)?.driving, false, '実行が動いていても、最後の操作から 60 秒たてば止まっている（今までどおり）');
});

test('L132 + L152: 別の実行（runId）の終わりは、動いている実行のタブの札を消さない', async t => {
  const r = rig(t);
  r.active.add('run-2');
  await r.session.run({ grant: { ...grant, runId: 'run-2' }, signal: new AbortController().signal }, async api => {
    const tab = await api.openTab('work');
    await tab.page.goto(PAGE, 1000);
  });
  r.active.delete('run-1');
  assert.equal(r.session.view('p-a', conversations)?.driving, true);
  assert.equal(r.session.view('p-a', conversations)?.runId, 'run-2');
});

test('L174: browser_open の width で、そのタブの画面の幅を変える（高さは今のまま）。欄の大きさも同じ。省くと触らない', async t => {
  const r = rig(t);
  r.driver.site(PAGE, { title: 'Start', text: 'start page' });
  const opened = await browserOpen.execute({ url: PAGE, width: 375 }, r.ctx());
  assert.equal(opened.isError, undefined, opened.content);
  const [page] = r.pages();
  assert.deepEqual(page!.size, { width: 375, height: 800 }, '幅だけ変わり、高さは既定のまま');
  assert.deepEqual(r.session.view('p-a', chat)?.viewport, { width: 375, height: 800 }, '欄の大きさ（指の位置の割合）もこの大きさ');
  assert.deepEqual(page!.gotos, [PAGE]);

  const again = await browserOpen.execute({ url: OTHER, tab: 't1', width: 600 }, r.ctx());
  assert.equal(again.isError, undefined, again.content);
  assert.deepEqual(page!.size, { width: 600, height: 800 }, '開いているタブにも効く');
  assert.deepEqual(r.session.view('p-a', chat)?.viewport, { width: 600, height: 800 });

  const plain = await browserOpen.execute({ url: PAGE }, r.ctx());
  assert.equal(plain.isError, undefined, plain.content);
  const second = r.pages().find(candidate => candidate !== page)!;
  assert.equal(second.size, undefined, '大きさを指さなければ、ブラウザの大きさに触らない');
});

test('L174: width は整数で 200〜2560 の範囲だけ。ほかの引数は受けない（道具の説明に足す文は最小）', () => {
  const ok = (input: object): boolean => Value.Check(browserOpen.input, { url: PAGE, ...input });
  assert.equal(ok({}), true);
  assert.equal(ok({ width: 375 }), true);
  assert.equal(ok({ height: 667 }), false);
  assert.equal(ok({ width: 200 }), true);
  assert.equal(ok({ width: 2560 }), true);
  for (const bad of [{ width: 199 }, { width: 2561 }, { width: 0 }, { width: -1 }, { width: 375.5 }, { width: '375' }]) assert.equal(ok(bad), false, JSON.stringify(bad));
});

test('L174: 本物の PlaywrightPage は setViewportSize に幅と高さを渡す', async () => {
  const asked: unknown[] = [];
  const page = { on: () => undefined, setViewportSize: async (size: unknown) => { asked.push(size); } } as unknown as Page;
  await new PlaywrightBrowser({} as BrowserContext).wrap(page).setViewport({ width: 375, height: 667 });
  assert.deepEqual(asked, [{ width: 375, height: 667 }]);
});
