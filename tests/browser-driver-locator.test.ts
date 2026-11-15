import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserFailure, PlaywrightBrowser } from '../src/tools/browser/driver.ts';

// 本物の PlaywrightPage の #locator: 読んだときと数が違えば、探し直しは undefined、押す・入れるは page_changed で動かさない。ブラウザは起動せず、Page の偽物で試す

function rig(count: number) {
  const acted: string[] = [];
  const page = {
    on: () => {},
    getByRole: () => ({
      count: async () => count,
      nth: (i: number) => ({
        isVisible: async () => true,
        isEnabled: async () => true,
        evaluate: async () => ({ type: null, autocomplete: null }),
        click: async () => { acted.push(`click ${i}`); },
        fill: async () => { acted.push(`fill ${i}`); },
      }),
    }),
    waitForLoadState: async () => {},
  } as unknown as Page;
  const handle = new PlaywrightBrowser({} as BrowserContext).wrap(page);
  return { handle, acted };
}

const target = { role: 'button', name: 'Send', nth: 1, count: 2 };

test('本物の #locator: 数が読んだときと違えば、探し直さず、押さず、入れない（page_changed）', async () => {
  const same = rig(2);
  assert.deepEqual(await same.handle.locate(target), { visible: true, enabled: true, type: undefined, autocomplete: undefined });
  await same.handle.click(target, 1000);
  assert.deepEqual(same.acted, ['click 1']);

  for (const changed of [1, 3]) {
    const r = rig(changed);
    assert.equal(await r.handle.locate(target), undefined, `数 ${changed}`);
    await assert.rejects(r.handle.click(target, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    await assert.rejects(r.handle.fill(target, 'x', true, 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'page_changed');
    assert.deepEqual(r.acted, [], `数 ${changed}`);
  }
});
