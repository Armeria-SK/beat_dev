import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, domQuiet, PlaywrightBrowser, QUIET_MAX_MS, QUIET_MS } from '../src/tools/browser/driver.ts';

// 本物の PlaywrightPage の #locator: Playwright の印（getByRef）で要素を引く。印が 1 つの主フレームの要素を指さなければ、
// 探し直しは undefined、押す・入れるは page_changed で動かさない。つかんだあと、確かめ（verify）と、引き直した要素がつかんだ要素と同じかを見る。
// ブラウザは起動せず、Page の偽物で試す

const MAIN = { name: 'main' };
const CHILD = { name: 'iframe' };

// quiet: ページの evaluate（DOM が静まるのを待つ見張り）の代わり。省くと evaluate が無い（見張りが使えないページと同じ）
interface RigOptions { count?: number; frame?: object; snapshots?: string[]; quiet?: (arg: unknown) => Promise<unknown> }

// elements: getByRef で引くたびに返す要素の ID（並び。尽きたら最後のもの）。同じ ID なら同じ要素
function rig(options: RigOptions = {}, elements: string[] = ['A']) {
  const acted: string[] = [];
  let resolved = 0;
  const handleOf = (id: string) => ({
    id,
    ownerFrame: async () => options.frame ?? MAIN,
    click: async (o?: { trial?: boolean }) => { acted.push(o?.trial ? `trial ${id}` : `click ${id}`); },
    fill: async () => { acted.push(`fill ${id}`); },
    press: async (key: string) => { acted.push(`press ${key} ${id}`); },
    waitForElementState: async (state: string) => { acted.push(`wait ${state} ${id}`); },
    dispose: async () => { acted.push(`dispose ${id}`); },
    evaluate: async (fn: (a: unknown, b: unknown) => boolean, other: { id: string }) => fn(id, other.id),
  });
  const refs: string[] = [];
  const page = {
    on: () => {},
    mainFrame: () => MAIN,
    ariaSnapshot: async (o: unknown) => { acted.push(`snapshot ${JSON.stringify(o)}`); return options.snapshots?.shift() ?? ''; },
    getByRef: (ref: string) => {
      refs.push(ref);
      return {
        count: async () => options.count ?? 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        evaluate: async () => ({ type: null, autocomplete: null, inForm: false, submits: false }),
        // Locator のまま押すと、押す途中で探し直す。押すのは、印を引いたときにつかんだ要素（ElementHandle）
        click: async () => { acted.push('locator click'); },
        fill: async () => { acted.push('locator fill'); },
        elementHandle: async () => handleOf(elements[Math.min(resolved++, elements.length - 1)]!),
      };
    },
    waitForLoadState: async () => {},
    ...(options.quiet ? { evaluate: async (_fn: unknown, arg: unknown) => { acted.push(`quiet ${JSON.stringify(arg)}`); return options.quiet!(arg); } } : {}),
  } as unknown as Page;
  const handle = new PlaywrightBrowser({} as BrowserContext).wrap(page);
  return { handle, acted, refs };
}

const target = { ref: 'f3e7', role: 'button', name: 'Send' };

test('本物の #locator: 印の要素をつかんで押し、Locator では押さない。押したら離す', async () => {
  const same = rig();
  assert.deepEqual(await same.handle.locate(target), { visible: true, enabled: true, type: undefined, autocomplete: undefined, form: { inForm: false, submits: false } });
  assert.ok(same.refs.every(ref => ref === 'f3e7'), '探すのは Playwright の印だけ（役割・名前・何番目では探さない）');
  await same.handle.click(target, 1000);
  assert.deepEqual(same.acted.filter(a => !a.startsWith('dispose')), ['trial A', 'click A']);
  const typed = rig();
  await typed.handle.fill(target, 'x', true, 1000);
  assert.deepEqual(typed.acted.filter(a => !a.startsWith('dispose')), ['wait stable A', 'wait editable A', 'fill A', 'press Enter A']);
});

test('本物の #locator: 印が 0 件・2 件（最後の表に無い・作り直された要素）なら、探し直さず、押さず、入れない（page_changed）', async () => {
  for (const count of [0, 2]) {
    const r = rig({ count });
    assert.equal(await r.handle.locate(target), undefined, `数 ${count}`);
    await assert.rejects(r.handle.click(target, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    await assert.rejects(r.handle.fill(target, 'x', true, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    assert.deepEqual(r.acted.filter(x => !x.startsWith('dispose')), [], `数 ${count}`);
  }
});

test('本物の #locator: 主フレームでない要素（iframe の中）は、探し直さず、押さない', async () => {
  const r = rig({ frame: CHILD });
  assert.equal(await r.handle.locate(target), undefined);
  await assert.rejects(r.handle.click(target, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(r.acted.filter(x => !x.startsWith('dispose')), []);
});

test('本物の #act: 確かめ（verify）が false なら押さない。true でも、引き直した要素がつかんだ要素と違えば押さない', async () => {
  const refused = rig();
  await assert.rejects(refused.handle.click({ ...target, verify: async () => false }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(refused.acted.filter(a => a.startsWith('click')), []);
  // 引く順: 主フレームの確かめ・つかむ・（確かめのあと）主フレームの確かめ・引き直し。引き直しだけが B（同じ印が別の要素を指した）
  const swapped = rig({}, ['A', 'A', 'A', 'B']);
  let verified = 0;
  await assert.rejects(swapped.handle.click({ ...target, verify: async () => { verified++; return true; } }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.equal(verified, 1);
  assert.deepEqual(swapped.acted.filter(a => a.startsWith('click')), [], 'つかんだ要素と違う要素は押さない');
  const kept = rig({}, ['A', 'A']);
  await kept.handle.click({ ...target, verify: async () => true }, 1000);
  assert.deepEqual(kept.acted.filter(a => a.startsWith('click')), ['click A'], '同じ要素なら押す');
});

test('本物の snapshot: ai の形だけを撮る（ふつうの形を撮ると印が引けなくなる）', async () => {
  const r = rig({ snapshots: ['- button "Send" [ref=e2]'] });
  assert.equal(await r.handle.snapshot(), '- button "Send" [ref=e2]');
  assert.deepEqual(r.acted, ['snapshot {"mode":"ai"}']);
  assert.equal(r.handle.documentId(), 0);
});

test('本物の #act: 操作できる形になるまでの待ち（試しの押し・入れられる状態）は確かめより前。確かめは待ちのあと、本当の操作の直前', async () => {
  const r = rig({}, ['A', 'A']);
  await r.handle.click({ ...target, verify: async () => { r.acted.push('verify'); return true; } }, 1000);
  assert.deepEqual(r.acted.filter(a => !a.startsWith('dispose')), ['trial A', 'verify', 'click A']);
  const typed = rig({}, ['A', 'A']);
  await typed.handle.fill({ ...target, verify: async () => { typed.acted.push('verify'); return true; } }, 'x', false, 1000);
  assert.deepEqual(typed.acted.filter(a => !a.startsWith('dispose')), ['wait stable A', 'wait editable A', 'verify', 'fill A']);
});

test('本物の #act: 確かめや引き直しが投げても、押さず、つかんだ要素は離す', async () => {
  const thrown = rig();
  await assert.rejects(thrown.handle.click({ ...target, verify: async () => { throw new Error('closed'); } }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.ok(!thrown.acted.includes('click A'));
  assert.ok(thrown.acted.includes('dispose A'), 'つかんだ要素を離す');
  // 引き直し（getByRef().count()）が投げる: 移動のあと・閉じたタブ
  const r = rig({}, ['A']);
  let calls = 0;
  const original = (r.handle as unknown as { page: { getByRef: (ref: string) => { count: () => Promise<number> } } }).page.getByRef;
  (r.handle as unknown as { page: { getByRef: unknown } }).page.getByRef = (ref: string) => {
    const loc = original(ref);
    return { ...loc, count: async () => { if (++calls > 1) throw new Error('Target closed'); return loc.count(); } };
  };
  await assert.rejects(r.handle.click({ ...target, verify: async () => true }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.ok(!r.acted.includes('click A'));
  assert.equal(r.acted.filter(a => a === 'dispose A').length >= 1, true, 'つかんだ要素を離す');
});

// ── P3b: 押したあと、差分を撮る前に DOM が静まるのを待つ（300 ms 動かなくなるまで、最大 1.5 秒） ──

const timed = async (work: () => Promise<unknown>): Promise<number> => { const start = performance.now(); await work(); return performance.now() - start; };

test('P3b: 押したあとの待ちは、ページの見張りが答えなくても 1.5 秒で止まる（こちらの時計で切る）', async () => {
  const r = rig({ quiet: () => new Promise(() => undefined) }, ['A', 'A']);
  const ms = await timed(() => r.handle.click({ ...target, verify: async () => true }, 1000));
  assert.ok(ms >= 250 + QUIET_MAX_MS - 50 && ms < 250 + QUIET_MAX_MS + 600, `${Math.round(ms)} ms`);
  assert.ok(r.acted.includes(`quiet ${JSON.stringify({ quietMs: QUIET_MS, maxMs: QUIET_MAX_MS })}`), r.acted.join(' / '));
  assert.ok(r.acted.indexOf('click A') < r.acted.findIndex(a => a.startsWith('quiet')), '待つのは押したあと');
});

test('P3b: 見張りが使えないページ（evaluate が無い・投げる）では、今の待ち（250 ms と読み込みの合図）だけに戻る。静まったらすぐ返る', async () => {
  for (const r of [rig({}, ['A', 'A']), rig({ quiet: async () => { throw new Error('Execution context was destroyed'); } }, ['A', 'A'])]) {
    const ms = await timed(() => r.handle.fill({ ...target, verify: async () => true }, 'x', false, 1000));
    assert.ok(ms < 250 + 400, `${Math.round(ms)} ms`);
    assert.ok(r.acted.includes('fill A'));
  }
  const quick = rig({ quiet: async () => true }, ['A', 'A']);
  assert.ok(await timed(() => quick.handle.click({ ...target, verify: async () => true }, 1000)) < 250 + 400);
});

test('P3b: ページの中の見張り domQuiet: 静まれば true、動き続ければ maxMs で false、見張りが無ければすぐ false', async () => {
  const g = globalThis as { MutationObserver?: unknown; document?: unknown };
  const saved = { observer: g.MutationObserver, document: g.document };
  try {
    g.MutationObserver = undefined;
    g.document = undefined;
    assert.equal(await domQuiet({ quietMs: 30, maxMs: 300 }), false, '見張りが無い');
    let timer: ReturnType<typeof setInterval> | undefined;
    let disconnected = 0;
    // busy: 20 ms ごとに変化を知らせる偽の見張り
    const fake = (busy: boolean) => class {
      #cb: () => void;
      constructor(cb: () => void) { this.#cb = cb; }
      observe(): void { if (busy) timer = setInterval(() => { this.#cb(); }, 20); }
      disconnect(): void { disconnected += 1; clearInterval(timer); }
    };
    g.document = { documentElement: {} };
    g.MutationObserver = fake(false);
    let start = performance.now();
    assert.equal(await domQuiet({ quietMs: 30, maxMs: 300 }), true);
    assert.ok(performance.now() - start < 200, '静まったら quietMs で返る');
    g.MutationObserver = fake(true);
    start = performance.now();
    assert.equal(await domQuiet({ quietMs: 30, maxMs: 300 }), false);
    const ms = performance.now() - start;
    assert.ok(ms >= 280 && ms < 500, `動き続けると maxMs で止まる: ${Math.round(ms)} ms`);
    assert.equal(disconnected, 2, '終わったら見張りを外す');
  } finally {
    g.MutationObserver = saved.observer;
    g.document = saved.document;
  }
});
