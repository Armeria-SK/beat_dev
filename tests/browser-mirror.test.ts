import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import type { BrowserGrant } from '../src/tools/browser/loopback.ts';
import { DRIVING_MS, SHOT_INTERVAL_MS, shortLabel } from '../src/tools/browser/mirror.ts';
import { BrowserSession, type BrowserTab, type MirrorConversation } from '../src/tools/browser/session.ts';
import { FakeBrowserDriver, type FakePage } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// 9-2a: Browser の欄の写し（BrowserSession.view / frame と、撮る時・撮らない時）

const PNG_A = Buffer.from('frame-a');
const PNG_B = Buffer.from('frame-b');
const PAGE_A = 'https://a.example.com/';
const PAGE_B = 'https://b.example.com/next';

interface Rig {
  session: BrowserSession;
  driver: FakeBrowserDriver;
  config: AppConfig;
  clock: { now: number };
  advance(ms: number): Promise<void>;
}

function rig(t: { after: (fn: () => void | Promise<void>) => void }): Rig {
  const config = testConfig();
  config.tools.browser.enabled = true;
  const driver = new FakeBrowserDriver();
  driver.site(PAGE_A, { title: 'Page A', png: PNG_A, rows: [{ role: 'button', name: 'Upload', effect: { navigate: PAGE_B } }] });
  driver.site(PAGE_B, { title: 'Page B', png: PNG_B });
  const clock = { now: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const session = new BrowserSession({
    driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' },
    now: () => clock.now,
    schedule: (fn, ms) => { const timer = { at: clock.now + ms, fn, live: true }; timers.push(timer); return () => { timer.live = false; }; },
  });
  t.after(() => session.close());
  const advance = async (ms: number) => {
    clock.now += ms;
    for (const timer of timers.filter(x => x.live && x.at <= clock.now)) { timer.live = false; timer.fn(); }
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { session, driver, config, clock, advance };
}

const grant = (conversationId: string, over: Partial<BrowserGrant> = {}): BrowserGrant => ({ conversationId, runId: `run-${conversationId}`, attended: true, loopback: false, productId: 'p-a', ...over });
const call = (g: BrowserGrant, signal = new AbortController().signal) => ({ grant: g, signal });
// DB の照らしの代わり: 会話 → 製品
const db = (map: Record<string, { product: string; attended?: boolean }>) => (productId: string): MirrorConversation => id => {
  const row = map[id];
  return row && row.product === productId ? { attended: row.attended ?? true } : undefined;
};

async function open(r: Rig, g: BrowserGrant, url = PAGE_A, kind: 'owner' | 'work' = 'owner'): Promise<BrowserTab> {
  return r.session.run(call(g), async api => {
    const tab = await api.openTab(kind);
    await tab.page.goto(url, 1000);
    await tab.page.text(100);
    return tab;
  });
}

test('shortLabel: 制御文字・書式の文字を落とし、空白をまとめ、60 文字まで', () => {
  assert.equal(shortLabel('Up\u0000lo\u001bad\u200f\u202e  now\nplease'), 'Up lo ad now please');
  assert.equal([...shortLabel('x'.repeat(100))].length, 60);
  assert.equal(shortLabel('\u0007\u0008'), '');
});

test('操作のあとに 1 枚撮る。次の操作で seq が増え、画像が変わる。いまの操作の言葉は強いものを残し、制御文字を含まない', async t => {
  const r = rig(t);
  const g = grant('c1');
  const conversations = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, g);
  const first = r.session.view('p-a', conversations)!;
  assert.equal(first.tab, tab.id);
  assert.equal(first.conversationId, 'c1');
  assert.equal(first.runId, 'run-c1');
  assert.equal(first.url, PAGE_A);
  assert.equal(first.title, 'Page A');
  assert.deepEqual(first.action, { kind: 'open', target: 'a.example.com' }, '開いたあとの読み直しで open を read にしない');
  assert.equal(first.driving, true);
  assert.deepEqual(first.viewport, { width: 1280, height: 800 });
  assert.deepEqual(first.profile, { kind: 'owner', path: 'C:\\data\\browser-profile' });
  assert.ok(first.seq > 0);
  assert.equal(first.at, r.clock.now);
  assert.deepEqual(r.session.frame(tab.id, 'p-a', conversations)?.data, PNG_A);
  // 押す（名前に制御文字）→ 移って画像が変わる
  r.driver.sites.get(PAGE_A)!.rows![0]!.name = 'Up\u0000load\u202e';
  await r.session.run(call(grant('c1', { runId: 'run-2' })), async api => {
    const mine = api.tab(tab.id);
    await mine.page.click({ role: 'button', name: 'Up\u0000load\u202e', nth: 0, count: 1 }, 1000);
    await mine.page.title();
  });
  const second = r.session.view('p-a', conversations)!;
  assert.ok(second.seq > first.seq);
  assert.equal(second.runId, 'run-2', 'タブを最後に動かした実行');
  assert.deepEqual(second.action, { kind: 'click', target: 'Up load' });
  assert.doesNotMatch(second.action.target, /\p{Cc}|\p{Cf}/u);
  assert.equal(second.url, PAGE_B);
  assert.deepEqual(r.session.frame(tab.id, 'p-a', conversations)?.data, PNG_B);
});

test('製品 A の view に、製品 B のタブと製品に属さない会話のタブは出ない。frame も返さない', async t => {
  const r = rig(t);
  const lookup = db({ a1: { product: 'p-a' }, b1: { product: 'p-b' }, free: { product: '' } });
  const tabA = await open(r, grant('a1'));
  const tabB = await open(r, grant('b1', { productId: 'p-b' }));
  const free = await open(r, grant('free', { productId: undefined }));
  assert.equal(r.session.view('p-a', lookup('p-a'))!.tab, tabA.id, 'B と製品の無い会話のほうが新しくても、A の view は A のタブ');
  assert.equal(r.session.view('p-b', lookup('p-b'))!.tab, tabB.id);
  assert.equal(r.session.frame(tabB.id, 'p-a', lookup('p-a')), undefined);
  assert.equal(r.session.frame(free.id, 'p-a', lookup('p-a')), undefined);
  assert.equal(r.session.frame(tabA.id, 'p-b', lookup('p-b')), undefined);
  assert.ok(r.session.frame(tabA.id, 'p-a', lookup('p-a')));
});

test('タブの製品と DB の照らしの両方が要る（片方だけでは出さない）', async t => {
  const r = rig(t);
  const tabB = await open(r, grant('b1', { productId: 'p-b' }));
  // DB が何でも「A の会話」と言っても、タブの製品が B なら出さない
  const permissive: MirrorConversation = () => ({ attended: true });
  assert.equal(r.session.view('p-a', permissive), null);
  assert.equal(r.session.frame(tabB.id, 'p-a', permissive), undefined);
  // タブの製品が A でも、DB でその製品の会話でなければ出さない
  const tabA = await open(r, grant('a1'));
  const none: MirrorConversation = () => undefined;
  assert.equal(r.session.view('p-a', none), null);
  assert.equal(r.session.frame(tabA.id, 'p-a', none), undefined);
});

test('持ち主のプロファイルのタブは、持ち主が見ている会話のものだけ出す（作業用のタブは人のいない実行のものも出す）', async t => {
  const r = rig(t);
  const owner = await open(r, grant('c1'));
  const unattended = db({ c1: { product: 'p-a', attended: false }, task1: { product: 'p-a', attended: false } })('p-a');
  assert.equal(r.session.view('p-a', unattended), null);
  assert.equal(r.session.frame(owner.id, 'p-a', unattended), undefined);
  const work = await open(r, grant('task1', { attended: false, loopback: true }), PAGE_A, 'work');
  const view = r.session.view('p-a', unattended)!;
  assert.equal(view.tab, work.id);
  assert.deepEqual(view.profile, { kind: 'work' });
});

test('製品に属さない会話のタブは撮らない（画像を覚えない）', async t => {
  const r = rig(t);
  let shots = 0;
  const tab = await r.session.run(call(grant('free', { productId: undefined })), async api => {
    const made = await api.openTab('owner');
    const page = r.driver.current!.pageList.at(-1)!;
    const original = page.screenshot.bind(page);
    page.screenshot = async () => { shots += 1; return original(); };
    await made.page.goto(PAGE_A, 1000);
    return made;
  });
  assert.equal(shots, 0);
  assert.equal(r.session.frame(tab.id, '', () => ({ attended: true })), undefined);
});

test('動いていない 60 秒後は driving: false、最後の画像は残る', async t => {
  const r = rig(t);
  const lookup = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, grant('c1'));
  const seq = r.session.view('p-a', lookup)!.seq;
  await r.advance(DRIVING_MS + 1);
  const later = r.session.view('p-a', lookup)!;
  assert.equal(later.driving, false);
  assert.equal(later.seq, seq);
  assert.deepEqual(r.session.frame(tab.id, 'p-a', lookup)?.data, PNG_A);
});

test('一定間隔の撮影: 欄が読んでいて動いているあいだだけ。読まれていなければ撮らない', async t => {
  const r = rig(t);
  const lookup = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, grant('c1'));
  const page = r.driver.current!.pageList.at(-1)!;
  let shots = 0;
  const original = page.screenshot.bind(page);
  page.screenshot = async () => { shots += 1; return original(); };
  // 読まれていない: 時間がたっても撮らない
  await r.advance(SHOT_INTERVAL_MS * 3);
  assert.equal(shots, 0);
  const before = r.session.view('p-a', lookup)!.seq;
  page.mutate({ title: 'Changed', png: PNG_B });
  await r.advance(SHOT_INTERVAL_MS);
  assert.equal(shots, 1);
  const after = r.session.view('p-a', lookup)!;
  assert.ok(after.seq > before);
  assert.equal(after.title, 'Changed');
  assert.deepEqual(r.session.frame(tab.id, 'p-a', lookup)?.data, PNG_B);
  // 動いていない（最後の操作から 60 秒）なら、読まれていても撮らない
  await r.advance(DRIVING_MS);
  const count = shots;
  r.session.view('p-a', lookup);
  await r.advance(SHOT_INTERVAL_MS);
  assert.equal(shots, count);
});

test('一定間隔の撮影はロックを握らない: 撮影が終わらなくても、呼び出しは待たない。呼び出しのあいだは撮らない', async t => {
  const r = rig(t);
  const lookup = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, grant('c1'));
  const page = r.driver.current!.pageList.at(-1)!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let shots = 0;
  page.screenshot = async () => { shots += 1; await gate; return PNG_A; };
  r.session.view('p-a', lookup);
  await r.advance(SHOT_INTERVAL_MS);
  assert.equal(shots, 1, '撮影が始まって止まっている');
  // 撮影が止まっていても、呼び出しは走り終わる
  const done = await Promise.race([
    r.session.run(call(grant('c1')), async api => { api.tab(tab.id); return 'ran'; }),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 500)),
  ]);
  assert.equal(done, 'ran');
  release();
  await r.advance(0);
  // 呼び出しのあいだ（ロック中）は、時が来ても撮らない
  let hold!: () => void;
  const held = new Promise<void>(resolve => { hold = resolve; });
  page.screenshot = async () => { shots += 1; return PNG_A; };
  const count = shots;
  const running = r.session.run(call(grant('c1')), async () => { await held; });
  r.session.view('p-a', lookup);
  await r.advance(SHOT_INTERVAL_MS);
  await r.advance(SHOT_INTERVAL_MS);
  assert.equal(shots, count);
  hold();
  await running;
});

test('遅れて終わった古い撮影は、あとの操作の画像を上書きしない', async t => {
  const r = rig(t);
  const lookup = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, grant('c1'));
  const page = r.driver.current!.pageList.at(-1)!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = page.screenshot.bind(page);
  page.screenshot = async () => { await gate; return Buffer.from('stale'); };
  r.session.view('p-a', lookup);
  await r.advance(SHOT_INTERVAL_MS);
  // 古い撮影が止まっているあいだに、押して移る（呼び出しの終わりの 1 枚は新しい画像）
  page.screenshot = original;
  await r.session.run(call(grant('c1')), async api => { await api.tab(tab.id).page.click({ role: 'button', name: 'Upload', nth: 0, count: 1 }, 1000); });
  assert.deepEqual(r.session.frame(tab.id, 'p-a', lookup)?.data, PNG_B);
  release();
  await r.advance(0);
  assert.deepEqual(r.session.frame(tab.id, 'p-a', lookup)?.data, PNG_B);
});

test('道具の browser_screenshot の画像も写しになる。タブを閉じたら画像も view も消える', async t => {
  const r = rig(t);
  const lookup = db({ c1: { product: 'p-a' } })('p-a');
  const tab = await open(r, grant('c1'));
  const page = r.driver.current!.pageList.at(-1)!;
  page.mutate({ png: PNG_B });
  await r.session.run(call(grant('c1')), async api => { await api.tab(tab.id).page.screenshot(); });
  assert.deepEqual(r.session.frame(tab.id, 'p-a', lookup)?.data, PNG_B);
  assert.equal(r.session.view('p-a', lookup)!.action.kind, 'screenshot');
  await r.session.run(call(grant('c1')), async api => { await api.closeTab(tab.id); });
  assert.equal(r.session.frame(tab.id, 'p-a', lookup), undefined);
  assert.equal(r.session.view('p-a', lookup), null);
});

test('見張りを付けたページも、元のページの持ち物はそのまま見える', async t => {
  const r = rig(t);
  const tab = await open(r, grant('c1'));
  const page = tab.page as unknown as FakePage;
  assert.deepEqual(page.gotos, [PAGE_A]);
  assert.equal(page.browser, r.driver.current);
  assert.notEqual(tab.page, r.driver.current!.pageList.at(-1), '道具が触るのは見張りを付けた写し');
});
