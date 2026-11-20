import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import type { Project } from '../web/src/api.ts';

// beat R (M7・R-4): Settings の「Look before building」と、製品の設定の節

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }
const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);
const { ProductResearch } = await loadTsx<{ ProductResearch: ComponentType<{ project: Project }> }>('../web/src/ui/screens/ProductResearch.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

function serve(config: Json, research?: () => Json): { saved: Json[]; patches: Json[] } {
  const saved: Json[] = [];
  const patches: Json[] = [];
  let current = structuredClone(config);
  const view = () => ({ config: current, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    let out: unknown;
    if (url === '/api/settings' && method === 'GET') out = view();
    if (url === '/api/settings' && method === 'PUT') { current = body!.config; saved.push(current); out = { ...view(), models: [] }; }
    if (url === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    if (url.endsWith('/research') && research) out = research();
    if (method === 'PATCH') { patches.push(body!); out = { project: {} }; }
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { saved, patches };
}
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const blur = (el: Element | null | undefined) => update(() => { el?.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
const button = (root: ParentNode, text: string, group?: string) =>
  [...(group ? root.querySelector(`[aria-label="${group}"]`)! : root).querySelectorAll('button')].find(b => b.textContent === text);

test('Settings › Look before building: いつ・調べ方・上限・言語を保存し、保存した設定は本物の形の確かめを通る。好きと避けたいの両方には入らない', async () => {
  const config = defaultConfig() as Json;
  const { saved } = serve(config);
  const { container } = await render(createElement(Settings, { section: 'research', onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined }));
  await settle();
  assert.ok([...container.querySelectorAll('.bt-panel__title')].some(h => h.textContent === 'Look before building'));
  await click(button(container, 'Only when I press it'));
  await settle();
  assert.equal(saved.at(-1)!.research.when, 'button');
  await click(button(container, 'One by one'));
  await settle();
  assert.equal(saved.at(-1)!.research.mode, 'one_by_one');
  const searches = container.querySelector<HTMLInputElement>('input[aria-label="Searches"]')!;
  await input(searches, '5');
  await blur(searches);
  await settle();
  assert.deepEqual(saved.at(-1)!.research.limits, { searches: 5 });
  await click(button(container, 'Go', 'Preferred languages'));
  await settle();
  assert.deepEqual(saved.at(-1)!.research.preferLanguages, ['Go']);
  await click(button(container, 'Go', 'Languages to avoid'));
  await settle();
  assert.equal(saved.at(-1)!.research.preferLanguages, undefined, 'moved out of the preferred list');
  assert.deepEqual(saved.at(-1)!.research.avoidLanguages, ['Go']);
  await click(container.querySelector('[role="switch"][aria-label="Ask about the language"]'));
  await settle();
  assert.equal(saved.at(-1)!.research.askLanguage, false);
  assert.deepEqual(parseConfig(saved.at(-1)!).research, { when: 'button', mode: 'one_by_one', limits: { searches: 5 }, avoidLanguages: ['Go'], askLanguage: false });
});

test('製品の設定の節: Global のままなら上書きなし。行を変えて保存すると researchSettings を送り、範囲の外の数では押せない', async () => {
  const settings = { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] };
  const { patches } = serve(defaultConfig() as Json, () => ({ settings, own: null, products: null, libraries: null, suggestedCheck: null }));
  const { container } = await render(createElement(ProductResearch, { project: { id: 'p1' } as Project }));
  await settle();
  const save = () => button(container, 'Save research settings')!;
  assert.equal(save().disabled, true, 'nothing changed yet');
  const when = container.querySelector<HTMLSelectElement>('#ui-ps-rs-when')!;
  await update(() => { when.value = 'off'; when.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const minutes = [...container.querySelectorAll<HTMLLabelElement>('label.bt-form-row')].find(l => l.textContent?.startsWith('Minutes'))!.querySelector('input')!;
  await input(minutes, '500');
  assert.equal(save().disabled, true, 'an out-of-range number cannot be saved');
  await input(minutes, '7');
  await click(save());
  await settle();
  assert.deepEqual(patches, [{ researchSettings: { when: 'off', limits: { minutes: 7 } } }]);
});
