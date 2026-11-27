import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import { accessWidening, keyEntryAccess } from '../web/src/settings/access.ts';
import { GEMINI_URL } from '../web/src/settings/model.ts';

// AR-1: Settings › Models › Add provider の Gemini。新しい送り先も、ほかの外の提供元と同じ「この PC の外へ送る」確かめを通る

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }
const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].filter(b => b.textContent === text);

const GEMINI_PROVIDER = { id: 'gemini', kind: 'openai_compatible', baseUrl: GEMINI_URL, server: 'gemini', maxParallel: 2, timeoutMs: 600_000 };

function serve(config: Json): Array<{ method: string; path: string; body: Json | null }> {
  const sent: Array<{ method: string; path: string; body: Json | null }> = [];
  let current = structuredClone(config);
  const view = () => ({ config: current, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    let out: unknown;
    if (String(path) === '/api/settings' && method === 'GET') out = view();
    if (String(path) === '/api/settings' && method === 'PUT') { current = body!.config; out = { ...view(), models: [] }; }
    if (String(path) === '/api/models') out = { models: [], chatOrder: [] };
    if (/\/api\/providers\/[^/]+\/key$/u.test(String(path))) out = { set: false, last4: null };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

test('Settings の Add provider に Gemini がある。選ぶと公式の入口・server: gemini の提供元ができ、外へ送る確かめを通ってから保存される（鍵は入らない）', async () => {
  const config = defaultConfig() as Json;
  const sent = serve(config);
  const { container } = await render(createElement(Settings, { section: 'models', onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined }));
  await settle();
  await click(buttons(container, 'Add provider')[0]);
  const seg = container.querySelector('.bt-seg[aria-label="Kind"]') ?? container.querySelector('.ui-set__form .bt-seg');
  assert.ok(seg, 'the add form is open');
  assert.deepEqual([...seg.querySelectorAll('button')].map(b => b.textContent), ['Anthropic', 'OpenAI', 'Gemini', 'Custom']);
  await click(buttons(seg, 'Gemini')[0]);
  await click(buttons(container.querySelector('.ui-set__form')!, 'Add')[0]);
  await settle();
  const widen = container.querySelector('.ui-set__widen');
  assert.ok(widen, 'a provider outside this PC is confirmed like the others');
  assert.match(widen.textContent ?? '', new RegExp(`Send provider "gemini" to an address outside this PC: ${GEMINI_URL.replaceAll('.', '\\.')}`, 'u'));
  assert.equal(sent.some(s => s.method === 'PUT'), false, 'nothing is saved before the confirmation');
  await click(buttons(widen, 'Confirm')[0]);
  await settle();
  await settle();
  const put = sent.find(s => s.method === 'PUT' && s.path === '/api/settings');
  assert.ok(put, 'saved');
  const saved = (put.body!.config.providers as Json[]).find(p => p.id === 'gemini');
  assert.deepEqual(saved, GEMINI_PROVIDER);
  assert.equal(parseConfig(structuredClone(put.body!.config)).providers.find(p => p.id === 'gemini')?.server, 'gemini', 'the server accepts the saved settings');
});

test('Gemini の提供元は、送り先を足す確かめ（provider-url）・鍵を入れる確かめ（provider-key-send）の両方に、ほかの外の提供元と同じ形で出る。この PC の中のものは出ない', () => {
  const before = defaultConfig() as Json;
  const after = { ...before, providers: [...before.providers, GEMINI_PROVIDER] };
  assert.deepEqual(accessWidening(before, after), [{ kind: 'provider-url', id: 'gemini', url: GEMINI_URL }]);
  assert.deepEqual(keyEntryAccess(GEMINI_PROVIDER), [{ kind: 'provider-key-send', id: 'gemini', url: GEMINI_URL }]);
  assert.deepEqual(keyEntryAccess({ ...GEMINI_PROVIDER, baseUrl: 'http://127.0.0.1:9/v1beta/openai' }), []);
});
