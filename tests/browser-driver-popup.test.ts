import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { PlaywrightBrowser, seedPreferences } from '../src/tools/browser/driver.ts';
import type { PageHandle } from '../src/tools/browser/driver.ts';

// T-03b: 窓（タブ）の見分けと、プロファイルの権限。本物のブラウザは起動せず、BrowserContext / Page の偽物で試す

type Listener = (page: Page) => void;
interface FakePage { opener: () => Promise<FakePage | null>; on: () => void; url: () => string; name: string }

function fakePage(name: string, opener: () => Promise<FakePage | null> = async () => null): FakePage {
  return { opener, on: () => {}, url: () => 'about:blank', name };
}

// newPage() の戻りより先に 'page' の出来事が届く（本物と同じ順）。popup は newPage の最中に割り込める
function rig(createPage: (emit: (page: FakePage) => void) => Promise<FakePage>) {
  const listeners: Listener[] = [];
  const emit = (page: FakePage): void => { for (const listener of listeners) listener(page as unknown as Page); };
  const context = {
    on: (event: string, listener: Listener) => { if (event === 'page') listeners.push(listener); },
    route: async () => {},
    newPage: async () => { const page = await createPage(emit); return page as unknown as Page; },
    pages: () => [] as Page[],
  } as unknown as BrowserContext;
  const browser = new PlaywrightBrowser(context);
  const popups: string[] = [];
  const nameOf = (handle: PageHandle): string => ((handle as unknown as { page: unknown }).page as FakePage).name;
  return { browser, emit, popups, watch: async () => { await browser.install(); browser.onPage(handle => popups.push(nameOf(handle))); } };
}
const settle = (): Promise<void> => new Promise(done => setTimeout(done, 20));

test('自分で開いたタブ（opener が無い）は popup として扱わない', async () => {
  const r = rig(async emit => { const page = fakePage('mine'); emit(page); return page; });
  await r.watch();
  await r.browser.newPage();
  await settle();
  assert.deepEqual(r.popups, []);
});

test('opener を持つ窓は popup として知らせる（newPage の最中に届いても、自分のタブにされない）', async () => {
  const parent = fakePage('parent');
  const r = rig(async emit => {
    // newPage の最中に、ページが window.open した窓が先に届き、そのあと自分のタブが届く
    emit(fakePage('popup', async () => parent));
    const page = fakePage('mine');
    emit(page);
    return page;
  });
  await r.watch();
  const mine = await r.browser.newPage();
  await settle();
  assert.equal(((mine as unknown as { page: FakePage }).page).name, 'mine');
  assert.deepEqual(r.popups, ['popup']);
});

test('newPage の外で届いた窓（opener あり・noopener）は popup として知らせる', async () => {
  const r = rig(async () => fakePage('mine'));
  await r.watch();
  r.emit(fakePage('p1', async () => fakePage('x')));
  r.emit(fakePage('p2'));
  await settle();
  assert.deepEqual(r.popups.sort(), ['p1', 'p2']);
});

test('newPage の最中に届いた opener の無い窓のうち、戻ったタブ以外は popup として知らせる（noopener の窓を自分のタブにしない）', async () => {
  const r = rig(async emit => {
    emit(fakePage('noopener'));
    const page = fakePage('mine');
    emit(page);
    return page;
  });
  await r.watch();
  await r.browser.newPage();
  await settle();
  assert.deepEqual(r.popups, ['noopener']);
});

test('プロファイルの権限: seedPreferences はプロファイルと Default を 0o700 で作る（Windows では権限は無視される）', t => {
  const base = mkdtempSync(join(tmpdir(), 'clive-seed-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const profile = join(base, 'browser-profile');
  seedPreferences(profile);
  assert.equal(JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8')).credentials_enable_service, false);
  if (process.platform === 'win32') return;
  assert.equal(statSync(profile).mode & 0o777, 0o700);
  assert.equal(statSync(join(profile, 'Default')).mode & 0o777, 0o700);
});

test('seedPreferences のソース: mkdirSync に mode 0o700 を付け、既にあるプロファイルも 0o700 に直す', () => {
  const text = readFileSync(resolve(import.meta.dirname, '..', 'src', 'tools', 'browser', 'driver.ts'), 'utf8').replace(/\r/gu, '');
  const body = /export function seedPreferences[\s\S]*?\n\}\n/u.exec(text)?.[0] ?? '';
  assert.ok(body.length > 0);
  const calls = body.match(/mkdirSync\([^)]*\)/gu) ?? [];
  assert.ok(calls.length >= 2, 'プロファイルと Default の両方を作る');
  for (const call of calls) assert.match(call, /mode:\s*0o700/u, call);
  assert.match(body, /chmodSync\(profileDir,\s*0o700\)/u);
});

test('opener() が例外を投げた窓は、安全側に倒して popup として扱う（自分で開いたタブだけは除く）', async () => {
  const boom = async (): Promise<FakePage | null> => { throw new Error('Target closed'); };
  // newPage の外
  const r1 = rig(async () => fakePage('mine'));
  await r1.watch();
  r1.emit(fakePage('broken', boom));
  await settle();
  assert.deepEqual(r1.popups, ['broken']);
  // newPage の最中: 自分のタブは popup にしない。ほかの窓は、戻ったあとに popup として知らせる
  const r2 = rig(async emit => {
    emit(fakePage('broken2', boom));
    const page = fakePage('mine2', boom);
    emit(page);
    return page;
  });
  await r2.watch();
  await r2.browser.newPage();
  await settle();
  assert.deepEqual(r2.popups, ['broken2']);
});
