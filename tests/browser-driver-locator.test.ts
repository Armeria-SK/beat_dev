import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, PlaywrightBrowser } from '../src/tools/browser/driver.ts';

// 本物の PlaywrightPage の #locator: Playwright の印（getByRef）で要素を引く。印が 1 つの主フレームの要素を指さなければ、
// 探し直しは undefined、押す・入れるは page_changed で動かさない。つかんだあと、確かめ（verify）と、引き直した要素がつかんだ要素と同じかを見る。
// ブラウザは起動せず、Page の偽物で試す

const MAIN = { name: 'main' };
const CHILD = { name: 'iframe' };

interface RigOptions { count?: number; frame?: object; snapshots?: string[] }

// elements: getByRef で引くたびに返す要素の ID（並び。尽きたら最後のもの）。同じ ID なら同じ要素
function rig(options: RigOptions = {}, elements: string[] = ['A']) {
  const acted: string[] = [];
  let resolved = 0;
  const handleOf = (id: string) => ({
    id,
    ownerFrame: async () => options.frame ?? MAIN,
    click: async () => { acted.push(`click ${id}`); },
    fill: async () => { acted.push(`fill ${id}`); },
    press: async (key: string) => { acted.push(`press ${key} ${id}`); },
    dispose: async () => {},
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
  assert.deepEqual(same.acted, ['click A']);
  const typed = rig();
  await typed.handle.fill(target, 'x', true, 1000);
  assert.deepEqual(typed.acted, ['fill A', 'press Enter A']);
});

test('本物の #locator: 印が 0 件・2 件（最後の表に無い・作り直された要素）なら、探し直さず、押さず、入れない（page_changed）', async () => {
  for (const count of [0, 2]) {
    const r = rig({ count });
    assert.equal(await r.handle.locate(target), undefined, `数 ${count}`);
    await assert.rejects(r.handle.click(target, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    await assert.rejects(r.handle.fill(target, 'x', true, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    assert.deepEqual(r.acted, [], `数 ${count}`);
  }
});

test('本物の #locator: 主フレームでない要素（iframe の中）は、探し直さず、押さない', async () => {
  const r = rig({ frame: CHILD });
  assert.equal(await r.handle.locate(target), undefined);
  await assert.rejects(r.handle.click(target, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(r.acted, []);
});

test('本物の #act: 確かめ（verify）が false なら押さない。true でも、引き直した要素がつかんだ要素と違えば押さない', async () => {
  const refused = rig();
  await assert.rejects(refused.handle.click({ ...target, verify: async () => false }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.deepEqual(refused.acted, []);
  // 引く順: 主フレームの確かめ・つかむ・（確かめのあと）主フレームの確かめ・引き直し。引き直しだけが B（同じ印が別の要素を指した）
  const swapped = rig({}, ['A', 'A', 'A', 'B']);
  let verified = 0;
  await assert.rejects(swapped.handle.click({ ...target, verify: async () => { verified++; return true; } }, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
  assert.equal(verified, 1);
  assert.deepEqual(swapped.acted, [], 'つかんだ要素と違う要素は押さない');
  const kept = rig({}, ['A', 'A']);
  await kept.handle.click({ ...target, verify: async () => true }, 1000);
  assert.deepEqual(kept.acted, ['click A'], '同じ要素なら押す');
});

test('本物の snapshot: ai の形だけを撮る（ふつうの形を撮ると印が引けなくなる）', async () => {
  const r = rig({ snapshots: ['- button "Send" [ref=e2]'] });
  assert.equal(await r.handle.snapshot(), '- button "Send" [ref=e2]');
  assert.deepEqual(r.acted, ['snapshot {"mode":"ai"}']);
  assert.equal(r.handle.documentId(), 0);
});
