import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';

// 340・347・348: 設定の鍵まわりの画面（Settings › Models の Key variable と鍵の欄、Select のメニュー）

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }
interface SelectProps { value: string | null; options: Array<{ value: string; label: string }>; label: string; onChange: (value: string) => void }
interface SecretProps { value: string; onChange: (value: string) => void; 'aria-label': string }

const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);
const { Select, SecretField } = await loadTsx<{ Select: ComponentType<SelectProps>; SecretField: ComponentType<SecretProps> }>('../web/src/ui/settings/controls.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

interface Sent { method: string; path: string; body: Json | null }

function serve(config: Json, extra: (path: string, method: string) => unknown = () => undefined): Sent[] {
  const sent: Sent[] = [];
  let current = structuredClone(config);
  const view = () => ({ config: current, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    let out: unknown = extra(String(path), method);
    if (out === undefined && String(path) === '/api/settings' && method === 'GET') out = view();
    if (out === undefined && String(path) === '/api/settings' && method === 'PUT') { current = body!.config; out = { ...view(), models: [] }; }
    if (out === undefined && String(path) === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const props = (): SettingsProps => ({ section: 'models', onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined });
const blur = (el: Element | null | undefined) => update(() => { el?.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].filter(b => b.textContent === text);

const configWith = (providers: Json[]): Json => {
  const config = defaultConfig() as Json;
  config.providers = providers;
  config.models = [{ id: 'm1', label: 'M1', provider: providers[0]!.id, model: 'm1', maxOutputTokens: 4096 }];
  config.routing = { ...config.routing, chat: ['m1'], background: [] };
  return config;
};

test('340（DOM）: Anthropic が 2 つあるとき、2 つ目の Key variable の欄を空にして保存すると、ID から作った名前が保存される（ANTHROPIC_API_KEY を共有しない）', async () => {
  const config = configWith([
    { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
    { id: 'claude2', kind: 'anthropic', apiKeyEnv: 'CLAUDE2_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
  ]);
  const sent = serve(config, path => (/\/api\/providers\/[^/]+\/key$/u.test(path) ? { set: false, last4: null } : undefined));
  const { container } = await render(createElement(Settings, props()));
  await settle();
  await click(container.querySelector('[data-row="provider:claude2"] button[aria-expanded]'));
  const field = container.querySelector<HTMLInputElement>('[data-row="provider:claude2:env"] input[aria-label="Key variable"]');
  assert.equal(field?.value, 'CLAUDE2_API_KEY');
  await input(field, '');
  await blur(field);
  await settle();
  await settle();
  const widen = container.querySelector('.ui-set__widen');
  assert.ok(widen, '鍵の名前が変わるので確かめが出る');
  await click(buttons(widen, 'Confirm')[0]);
  await settle();
  await settle();
  const put = sent.find(s => s.method === 'PUT' && s.path === '/api/settings');
  assert.ok(put, '保存した');
  assert.equal(put.body?.config.providers[1].apiKeyEnv, 'BEAT_CLAUDE2_API_KEY');
  assert.equal(put.body?.config.providers[0].apiKeyEnv, 'ANTHROPIC_API_KEY');
});

async function openKeyEntry() {
  const config = configWith([{ id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', maxParallel: 1, timeoutMs: 600_000 }]);
  const sent = serve(config, (path, method) => (path === '/api/providers/local/key' ? { set: method === 'PUT', last4: null } : undefined));
  const rendered = await render(createElement(Settings, props()));
  await settle();
  await click(buttons(rendered.container, 'Add key')[0]);
  const field = rendered.container.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(field, '鍵の欄が開く');
  return { ...rendered, sent, field };
}

const SECRET = 'Zk3qP9xW7mB2vN8cLd5Tq1';

test('347（DOM）: 入力中の鍵は、欄の value 属性にも画面の HTML にも写らない。それでも保存では、打った鍵がそのまま送られる', async () => {
  const { container, sent, field } = await openKeyEntry();
  await input(field, SECRET);
  assert.equal(field.value, SECRET, '前提: 欄の中身（プロパティ）には入っている');
  assert.equal(field.getAttribute('value'), null, 'value 属性には写さない');
  assert.equal(container.innerHTML.includes(SECRET), false, '画面の HTML のどこにも出ない');
  assert.equal(window.document.body.innerHTML.includes(SECRET), false);
  await click(buttons(container, 'Save')[0]);
  await settle();
  await settle();
  const put = sent.find(s => s.method === 'PUT' && s.path === '/api/providers/local/key');
  assert.deepEqual(put?.body, { key: SECRET });
});

test('347（DOM）: 打った鍵があるあいだ Save が押せ、Cancel で消して開き直すと空', async () => {
  const { container, field } = await openKeyEntry();
  assert.equal(buttons(container, 'Save')[0]?.disabled, true, '空のあいだは押せない');
  await input(field, SECRET);
  assert.equal(buttons(container, 'Save')[0]?.disabled, false);
  await click(buttons(container, 'Cancel')[0]);
  assert.equal(container.querySelector('input[type="password"]') === null, true, '閉じる');
  await click(buttons(container, 'Add key')[0]);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="password"]')?.value, '', '開き直すと空');
});

test('347（部品）: SecretField は、親が値を空に戻すと欄の中身も空に戻り、属性には何も写さない', async () => {
  const seen: string[] = [];
  const view = (value: string) => createElement(SecretField, { value, onChange: v => seen.push(v), 'aria-label': 'secret' });
  const { root, container } = await render(view(''));
  const field = container.querySelector<HTMLInputElement>('input[aria-label="secret"]')!;
  assert.equal(field.type, 'password');
  await input(field, SECRET);
  assert.deepEqual(seen, [SECRET], '打つと onChange に値が届く');
  assert.equal(field.getAttribute('value'), null);
  await update(() => { root.render(view(SECRET)); });
  assert.equal(field.value, SECRET);
  await update(() => { root.render(view('')); });
  assert.equal(field.value, '', '親が空に戻したら空');
  assert.equal(field.getAttribute('value'), null);
});

const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }];

async function openSelect() {
  const picked: string[] = [];
  const rendered = await render(createElement(Select, { value: 'a', options, label: 'Pick', onChange: v => picked.push(v) }));
  const opener = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Pick"]')!;
  await click(opener);
  assert.ok(rendered.container.querySelector('[role="menu"]'), '前提: メニューが開く');
  return { ...rendered, opener, picked };
}

const key = (target: Element, name: string, shift = false) => update(() => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true })); });

test('348（DOM）: Select のメニューは、Tab・Shift+Tab で外へ出ると閉じ、焦点は開いたボタンへ戻る（そこから Tab が続く）', async () => {
  for (const shift of [false, true]) {
    const { container, opener, picked } = await openSelect();
    const item = container.querySelector('[role="menuitemradio"]')!;
    await key(item, 'Tab', shift);
    assert.equal(container.querySelector('[role="menu"]') === null, true, `shift=${shift}: 閉じる`);
    assert.equal(document.activeElement === opener, true, `shift=${shift}: 焦点は開いたボタン`);
    assert.deepEqual(picked, [], '何も選ばない');
    await cleanup();
  }
});

test('348（DOM）: 矢印キーでは閉じない。Escape は今までどおり閉じて焦点をボタンへ戻す', async () => {
  const { container, opener } = await openSelect();
  const items = () => [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  await key(items()[0]!, 'ArrowDown');
  assert.ok(container.querySelector('[role="menu"]'), '矢印では開いたまま');
  assert.equal(document.activeElement === items()[1], true, '次の項目へ');
  await key(items()[1]!, 'Escape');
  assert.equal(container.querySelector('[role="menu"]') === null, true);
  assert.equal(document.activeElement === opener, true);
});
