import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';

// Settings › Appearance の Explanation language（beat i18n I-1）を描いて押す。

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }

const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

function serveSettings(config: Json): Json[] {
  const puts: Json[] = [];
  let current = structuredClone(config);
  const view = () => ({ config: current, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    let out: unknown;
    if (String(path) === '/api/settings' && method === 'GET') out = view();
    if (String(path) === '/api/settings' && method === 'PUT') { current = (JSON.parse(String(init?.body)) as Json).config; puts.push(current); out = { ...view(), models: [] }; }
    if (String(path) === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return puts;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const props: SettingsProps = { section: 'appearance', onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined };

test('Settings › Appearance（DOM）: Explanation language を 日本語 にすると ui.explainLanguage だけを保存し、行の説明が日本語・題は英語になり、ブラウザに控える。English で戻る', async () => {
  const config = defaultConfig() as Json;
  config.timezone = 'Europe/Berlin';
  const puts = serveSettings(config);
  const { container } = await render(createElement(Settings, props));
  await settle();
  const row = () => container.querySelector('[data-row="look:explain"]')!;
  const option = (label: string) => [...row().querySelectorAll<HTMLButtonElement>('.bt-seg__opt')].find(b => b.textContent === label);
  assert.equal(row().querySelector('.bt-setting__title')?.textContent, 'Explanation language');
  assert.equal(row().querySelector('.bt-setting__desc')?.textContent, en['ui.set.look.explainDesc']);
  assert.deepEqual([...row().querySelectorAll('.bt-seg__opt')].map(b => b.textContent), ['Auto (English)', 'English', '日本語']);
  assert.equal(option('Auto (English)')?.getAttribute('aria-pressed'), 'true');

  await click(option('日本語'));
  await settle(); await settle();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0]!.ui, { explainLanguage: 'ja' });
  assert.equal(puts[0]!.timezone, 'Europe/Berlin', 'ほかの項目は変えない');
  assert.equal(option('日本語')?.getAttribute('aria-pressed'), 'true');
  assert.equal(row().querySelector('.bt-setting__desc')?.textContent, ja['ui.set.look.explainDesc']);
  assert.equal(container.querySelector('[data-row="look:reduce"] .bt-setting__desc')?.textContent, ja['ui.set.look.reduceDesc']);
  assert.equal(row().querySelector('.bt-setting__title')?.textContent, 'Explanation language', '題は名前なので英語のまま');
  assert.equal(container.querySelector('[data-row="look:reduce"] .bt-setting__title')?.textContent, 'Reduce motion');
  assert.equal(localStorage.getItem('beat.explainLanguage'), 'ja', '設定が届くまでのちらつき止めに控える');

  await click(option('English'));
  await settle(); await settle();
  assert.deepEqual(puts.at(-1)!.ui, { explainLanguage: 'en' });
  assert.equal(row().querySelector('.bt-setting__desc')?.textContent, en['ui.set.look.explainDesc']);
  assert.equal(localStorage.getItem('beat.explainLanguage'), 'en');
});
