import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, domQuiet, PlaywrightBrowser, PRESS_KEYS, QUIET_MAX_MS, QUIET_MS } from '../src/tools/browser/driver.ts';

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

// ── P6: select / press（本物の PlaywrightPage。Page の偽物で試す） ──

// 本物の #act を通る select。evaluate は、文字列（ラベル）を渡されたら「その選択肢がある」答え、要素を渡されたら同じ要素かの比べ
function selectRig(options: { hasOption?: boolean; elements?: string[]; quiet?: boolean } = {}) {
  const acted: string[] = [];
  let resolved = 0;
  const elements = options.elements ?? ['A', 'A'];
  const handleOf = (id: string) => ({
    id,
    ownerFrame: async () => MAIN,
    click: async () => { acted.push(`click ${id}`); },
    fill: async () => { acted.push(`fill ${id}`); },
    press: async (key: string) => { acted.push(`press ${key} ${id}`); },
    waitForElementState: async (state: string) => { acted.push(`wait ${state} ${id}`); },
    selectOption: async (value: unknown, o?: { timeout?: number }) => { acted.push(`select ${JSON.stringify(value)} ${id} ${o?.timeout}`); return ['v']; },
    dispose: async () => { acted.push(`dispose ${id}`); },
    evaluate: async (fn: (a: unknown, b: unknown) => boolean, arg: unknown) => (typeof arg === 'string' ? (options.hasOption ?? true) : fn(id, (arg as { id: string }).id)),
  });
  const page = {
    on: () => {},
    mainFrame: () => MAIN,
    getByRef: () => ({
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      evaluate: async () => ({ type: null, autocomplete: null, inForm: false, submits: false, tag: 'select' }),
      elementHandle: async () => handleOf(elements[Math.min(resolved++, elements.length - 1)]!),
    }),
    waitForLoadState: async () => {},
  } as unknown as Page;
  return { handle: new PlaywrightBrowser({} as BrowserContext).wrap(page), acted };
}

const selectTarget = { ref: 'f3e7', role: 'combobox', name: 'Size' };

test('P6 本物の select: 操作できる形（安定・有効）を待ち、選択肢があるのを見てから、確かめ（verify）のあと、ラベルだけで選ぶ（値・番号では選ばない）', async () => {
  const r = selectRig({ elements: ['A', 'A'] });
  const locate = await r.handle.locate(selectTarget);
  assert.equal(locate?.tag, 'select', '要素のタグを返す（select かの判定に使う）');
  r.acted.length = 0;
  await r.handle.select({ ...selectTarget, verify: async () => { r.acted.push('verify'); return true; } }, 'Medium', 1000);
  assert.deepEqual(r.acted.filter(a => !a.startsWith('dispose')), ['wait stable A', 'wait enabled A', 'verify', 'select {"label":"Medium"} A 1000']);
  assert.ok(r.acted.includes('dispose A'), '離す');
});

test('P6 本物の select: 有効な選択肢が無ければ、確かめにも選ぶにも進まず、アプリの決まった文で断る（Playwright の待ちに入らない）', async () => {
  const r = selectRig({ hasOption: false });
  let verified = 0;
  await assert.rejects(r.handle.select({ ...selectTarget, verify: async () => { verified += 1; return true; } }, 'Huge', 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'act_failed' && e.key === 'browser.select_no_option' && !JSON.stringify(e.params).includes('Huge'));
  assert.equal(verified, 0);
  assert.ok(!r.acted.some(a => a.startsWith('select')));
  assert.ok(r.acted.includes('dispose A'));
});

test('P6 本物の select: 確かめ（verify）が false、または引き直した要素がつかんだ要素と違えば、選ばない', async () => {
  const refused = selectRig();
  await assert.rejects(refused.handle.select({ ...selectTarget, verify: async () => false }, 'Medium', 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(refused.acted.filter(a => a.startsWith('select')), []);
  const swapped = selectRig({ elements: ['A', 'A', 'A', 'B'] });
  await assert.rejects(swapped.handle.select({ ...selectTarget, verify: async () => true }, 'Medium', 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(swapped.acted.filter(a => a.startsWith('select')), [], 'つかんだ要素と違う要素は選ばない');
  const kept = selectRig();
  await kept.handle.select({ ...selectTarget, verify: async () => true }, 'Medium', 1000);
  assert.deepEqual(kept.acted.filter(a => a.startsWith('select')), ['select {"label":"Medium"} A 1000']);
});

const NO_FOCUS = { where: 'none', tag: null, type: null, autocomplete: null, hint: '' } as const;
const ON_INPUT = { where: 'element', tag: 'input', type: 'text', autocomplete: null, hint: 'Name' } as const;

// 焦点の読み: evaluateHandle（ページの中の activeElementOf）→ asElement → evaluate（focusFacts）。facts は読むたびに先頭から出す（尽きたら最後のもの）
function pressRig(facts: Array<Record<string, unknown>>, options: { element?: boolean; reads?: 'throw' } = {}) {
  const acted: string[] = [];
  const queue = [...facts];
  const element = {
    evaluate: async () => { acted.push('facts'); if (options.reads === 'throw') throw new Error('Execution context was destroyed'); return queue.length > 1 ? queue.shift() : queue[0]; },
    press: async (key: string, o?: { timeout?: number }) => { acted.push(`element.press ${key} ${o?.timeout}`); },
    dispose: async () => { acted.push('element.dispose'); },
  };
  const page = {
    on: () => {},
    mainFrame: () => MAIN,
    evaluateHandle: async () => {
      acted.push('evaluateHandle');
      if (options.reads === 'throw') throw new Error('Target closed');
      return { asElement: () => (options.element === false ? null : element), dispose: async () => { acted.push('js.dispose'); } };
    },
    keyboard: { press: async (key: string) => { acted.push(`keyboard.press ${key}`); } },
    waitForLoadState: async () => {},
  } as unknown as Page;
  return { handle: new PlaywrightBrowser({} as BrowserContext).wrap(page), acted };
}

test('P6 本物の focus: 焦点のある要素の事実を返す。要素が無い（焦点が無い）なら none。読めなければ page_changed', async () => {
  assert.deepEqual(await pressRig([ON_INPUT]).handle.focus(), ON_INPUT);
  assert.deepEqual(await pressRig([], { element: false }).handle.focus(), NO_FOCUS);
  const gone = pressRig([ON_INPUT], { reads: 'throw' });
  await assert.rejects(gone.handle.focus(), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
});

test('P6 本物の press: 焦点のある要素の事実が判定したときと同じなら、その要素をつかんだまま、その要素に押す（ページの焦点に送らない）。押したら離す', async () => {
  const r = pressRig([ON_INPUT, ON_INPUT]);
  await r.handle.press('Tab', ON_INPUT, 1000);
  assert.deepEqual(r.acted, ['evaluateHandle', 'facts', 'element.press Tab 1000', 'element.dispose']);
  assert.ok(!r.acted.some(a => a.startsWith('keyboard')));
});

test('P6 本物の press: 焦点が無い（none）なら、ページのキーボードに送る', async () => {
  const r = pressRig([NO_FOCUS]);
  await r.handle.press('ArrowDown', NO_FOCUS, 1000);
  assert.ok(r.acted.includes('keyboard.press ArrowDown'));
  assert.ok(!r.acted.some(a => a.startsWith('element.press')));
  assert.ok(r.acted.includes('element.dispose'), 'つかんだ body は離す');
  const empty = pressRig([], { element: false });
  await empty.handle.press('Tab', NO_FOCUS, 1000);
  assert.ok(empty.acted.includes('keyboard.press Tab'));
});

test('P6 本物の press: 焦点の事実が、判定したときと違えば（種類・タグ・属性・手がかり・場所のどれか）押さない', async () => {
  const changes: Array<Record<string, unknown>> = [
    { ...ON_INPUT, type: 'password' }, { ...ON_INPUT, tag: 'select' }, { ...ON_INPUT, autocomplete: 'cc-number' }, { ...ON_INPUT, hint: 'Card number' },
    { where: 'frame', tag: 'iframe', type: null, autocomplete: null, hint: '' }, NO_FOCUS,
  ];
  for (const now of changes) {
    const r = pressRig([now]);
    await assert.rejects(r.handle.press('Tab', ON_INPUT, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed', JSON.stringify(now));
    assert.ok(!r.acted.some(a => a.startsWith('element.press') || a.startsWith('keyboard')), JSON.stringify(now));
    assert.ok(r.acted.includes('element.dispose'), '離す');
  }
  const none = pressRig([ON_INPUT]);
  await assert.rejects(none.handle.press('Tab', NO_FOCUS, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed', '焦点が無いと判定したあとに、要素に焦点が移った');
  assert.ok(!none.acted.some(a => a.startsWith('element.press') || a.startsWith('keyboard')));
});

test('P6 本物の press: 焦点が枠（iframe など）の中にあるときは、判定したときと同じ事実でも押さない（呼び出す側が通しても、driver が断る）', async () => {
  const frame = { where: 'frame', tag: 'iframe', type: null, autocomplete: null, hint: '' } as const;
  const r = pressRig([frame]);
  await assert.rejects(r.handle.press('Tab', frame, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.ok(!r.acted.some(a => a.startsWith('element.press') || a.startsWith('keyboard')));
});

test('P6 本物の press: 決めた 10 個以外の鍵は、ページに何もせずに断る（Enter・Space・修飾つき・削除・文字・大小違い・前後の空白）', async () => {
  for (const key of ['Enter', 'NumpadEnter', 'Space', ' ', 'Shift+Tab', 'Control+a', 'Alt+ArrowLeft', 'Meta+ArrowLeft', 'Delete', 'Backspace', 'a', 'F5', 'tab', 'ESCAPE', 'Tab ', 'Tab+Enter', '', 'Enter\n', 'toString', '__proto__', 'constructor']) {
    const r = pressRig([NO_FOCUS]);
    await assert.rejects(r.handle.press(key, NO_FOCUS, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'blocked' && e.key === 'browser.press_key', JSON.stringify(key));
    assert.deepEqual(r.acted, [], `${JSON.stringify(key)}: ページに触らない`);
  }
  for (const key of PRESS_KEYS) {
    const r = pressRig([NO_FOCUS]);
    await r.handle.press(key, NO_FOCUS, 1000);
    assert.ok(r.acted.includes(`keyboard.press ${key}`), key);
  }
});

test('P6 本物の press: 読む・押すの途中で投げても、離して page_changed で止まる。待ちは 1 秒まで・押したあとの待ちは click と同じ', async () => {
  const gone = pressRig([ON_INPUT], { reads: 'throw' });
  await assert.rejects(gone.handle.press('Tab', ON_INPUT, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  const slow = pressRig([ON_INPUT, ON_INPUT]);
  await slow.handle.press('Tab', ON_INPUT, 30_000);
  assert.ok(slow.acted.includes('element.press Tab 1000'), '本当の操作の待ちは 1 秒まで（確かめてから押すまでを短くする）');
  const ms = await timed(() => pressRig([NO_FOCUS]).handle.press('Home', NO_FOCUS, 1000));
  assert.ok(ms >= 200 && ms < 250 + 400, `押したあとは、click と同じ待ち（250 ms と読み込みの合図）: ${Math.round(ms)} ms`);
});
