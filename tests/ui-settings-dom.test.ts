import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { en } from '../web/src/i18n/en.ts';

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }

const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  calls = [];
});

let calls: Array<{ method: string; path: string; signal: AbortSignal | null }> = [];

interface Sent { method: string; path: string; body: Json | null }

function serveSettings(config: Json, extra: (path: string, method: string) => unknown = () => undefined): Sent[] {
  const sent: Sent[] = [];
  let current = structuredClone(config);
  const view = () => ({ config: current, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    calls.push({ method, path: String(path), signal: init?.signal ?? null });
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    let out: unknown = await extra(String(path), method);
    if (out === undefined && String(path) === '/api/settings' && method === 'GET') out = view();
    if (out === undefined && String(path) === '/api/settings' && method === 'PUT') { current = body!.config; out = { ...view(), models: [] }; }
    if (out === undefined && String(path) === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const props = (over: Partial<SettingsProps> = {}): SettingsProps => ({ section: undefined, onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined, ...over });
const blur = (el: Element | null | undefined) => update(() => { el?.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].filter(b => b.textContent === text);

test('Settings › Hooks（DOM）: 「Tools」の欄（Protect files と自分で足したフック）は、空にして離れると保存した値へ戻り、保存しない。値を入れて離れるとその値で保存する', async () => {
  const config = defaultConfig() as Json;
  config.tools.hooks.preToolUse = [structuredClone(DEFAULT_PROTECT_FILES), { matcher: 'shell_run', command: ['node', 'check.js'], timeoutMs: 30_000, onError: 'deny' }];
  const sent = serveSettings(config);
  const { container } = await render(createElement(Settings, props({ section: 'hooks' })));
  await settle();
  for (const edit of buttons(container, 'Edit')) await click(edit);
  const fields = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Tools"]')];
  assert.equal(fields.length, 2, 'Protect files の欄と、自分で足すフックの欄');
  for (const [i, field] of fields.entries()) {
    const saved = field.value;
    await input(field, '');
    await blur(field);
    await settle();
    assert.equal(field.value, saved, `欄 ${i}: 空のままにしない`);
    assert.equal(sent.length, 0, `欄 ${i}: 空では保存しない`);
    await input(field, `file_write_${i}`);
    await blur(field);
    await settle();
    await settle();
    const widen = container.querySelector('.ui-set__widen');
    assert.ok(widen, `欄 ${i}: 値を入れて離れたら保存へ進む（フックの変更は確かめを出す）`);
    await click(buttons(widen, 'Confirm')[0]);
    await settle();
    await settle();
    const put = sent.at(-1);
    assert.equal(put?.method, 'PUT', `欄 ${i}: 値を入れたら保存する`);
    assert.equal(put?.body?.config.tools.hooks.preToolUse[i].matcher, `file_write_${i}`);
    sent.length = 0;
  }
});

const withModels = (judge: string[] = []): Json => {
  const config = defaultConfig() as Json;
  config.providers = [{ id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', maxParallel: 1, timeoutMs: 600_000 }];
  config.models = ['qwen', 'gemma', 'phi'].map(id => ({ id, label: id.toUpperCase(), provider: 'local', model: id, maxOutputTokens: 4096 }));
  config.routing = { ...config.routing, chat: ['qwen'], background: [], ...(judge.length ? { judge } : {}) };
  return config;
};

async function openModels(config: Json) {
  const sent = serveSettings(config);
  const { container } = await render(createElement(Settings, props({ section: 'models' })));
  await settle();
  return { container, sent };
}

async function commitText(container: HTMLElement, field: HTMLInputElement | null, text: string) {
  await input(field, text);
  await blur(field);
  await settle();
  await settle();
  const widen = container.querySelector('.ui-set__widen');
  if (widen) { await click(buttons(widen, 'Confirm')[0]); await settle(); await settle(); }
}

test('Settings › Models（DOM）: 提供元・モデルの ID を変えて保存しても、開いていた行は開いたまま（新しい ID の行が開く）', async () => {
  const { container, sent } = await openModels(withModels());
  const providerRow = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Name"]')];
  await click(buttons(container, 'Edit')[0]);
  assert.equal(providerRow().length, 1, '提供元の行が開いている');
  await commitText(container, providerRow()[0]!, 'home');
  assert.equal(sent.at(-1)?.body?.config.providers[0].id, 'home', '保存した');
  assert.equal(providerRow()[0]?.value, 'home', '新しい ID の行が開いたまま');

  const modelIds = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="ID"]')];
  await click(buttons(container, 'Edit')[0]);
  assert.deepEqual(modelIds().map(f => f.value), ['qwen']);
  await commitText(container, modelIds()[0]!, 'qwen3');
  assert.deepEqual(sent.at(-1)?.body?.config.models.map((m: Json) => m.id), ['qwen3', 'gemma', 'phi']);
  assert.deepEqual(modelIds().map(f => f.value), ['qwen3'], '新しい ID の行が開いたまま');
});

test('Settings › Models（DOM）: モデルの Remove は、行の確かめ（Remove model）を通してから消す', async () => {
  const { container, sent } = await openModels(withModels());
  await click(container.querySelector('button[aria-label="Remove GEMMA"]'));
  await settle();
  assert.equal(sent.length, 0, '押しただけでは消さない');
  const confirm = buttons(container, 'Remove model')[0];
  assert.ok(confirm, '確かめの行が出る');
  await click(confirm);
  await settle();
  await settle();
  const widen = container.querySelector('.ui-set__widen');
  if (widen) { await click(buttons(widen, 'Confirm')[0]); await settle(); await settle(); }
  assert.deepEqual(sent.at(-1)?.body?.config.models.map((m: Json) => m.id), ['qwen', 'phi']);
});

test('Settings › Models（DOM）: 設定ファイルで routing.judge に 2 つ以上書いてあるとき、先頭のあとの判定役を Judge の行の下に出す（backlog 522）', async () => {
  const { container } = await openModels(withModels(['gemma', 'phi', 'qwen']));
  assert.equal(container.querySelector('[data-below="roles:judge"] .bt-meta')?.textContent, en['ui.set.models.judgeBackups']('PHI, QWEN'), 'ラベルの名前で、ファイルの順に出す');
  await cleanup();
  const { container: plain } = await openModels(withModels(['gemma']));
  assert.ok(plain.querySelector('[data-row="roles:judge"]'));
  assert.equal(plain.querySelector('[data-below="roles:judge"]'), null, '1 つだけなら出さない');
});

const esc = async (target: EventTarget): Promise<KeyboardEvent> => {
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await update(() => { target.dispatchEvent(event); });
  return event;
};

async function openAdvanced(config: Json, extra?: (path: string, method: string) => unknown, over: Partial<SettingsProps> = {}) {
  const sent = serveSettings(config, extra);
  const { container } = await render(createElement(Settings, props({ section: 'advanced', ...over })));
  await settle();
  await click(buttons(container, 'Open config file')[0]);
  await settle();
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Config file"]')!;
  return { container, sent, editor };
}

test('Settings の Esc の順番（DOM）: 書きかけがあれば、枠の中の Esc も枠の外の Esc も受けて（preventDefault）帯で聞き、閉じない。書きかけが無ければ受けずに App の閉じるへ渡す', async () => {
  let closed = 0;
  const { container, editor } = await openAdvanced(defaultConfig() as Json, undefined, { onClose: () => { closed += 1; } });
  assert.equal((await esc(document.body)).defaultPrevented, false, '書きかけが無い');
  await input(editor, '{}');
  const inside = await esc(editor);
  assert.equal(inside.defaultPrevented, true, '枠の中の Esc を受ける');
  const leave = container.querySelector('.ui-set__leave');
  assert.ok(leave, '帯で聞く');
  await click(buttons(leave, en['ui.set.leave.keep'])[0]);
  assert.equal(container.querySelector('.ui-set__leave'), null);
  const outside = await esc(document.body);
  assert.equal(outside.defaultPrevented, true, '枠の外の Esc も受ける');
  assert.ok(container.querySelector('.ui-set__leave'));
  assert.equal(closed, 0, 'まだ閉じない');
  await click(buttons(container.querySelector('.ui-set__leave')!, en['ui.set.leave.discard'])[0]);
  assert.equal(closed, 1, 'Discard で閉じる');
});

test('Settings の Esc の順番（DOM）: 枠の外の Esc は window の捕まえる段で受けるので、先に window の泡の段で待つ App の「閉じる」にも、受け済み（defaultPrevented）で届く', async () => {
  const seen: boolean[] = [];
  const app = (e: Event) => { if ((e as KeyboardEvent).key === 'Escape') seen.push(e.defaultPrevented); };
  window.addEventListener('keydown', app);
  try {
    const { editor } = await openAdvanced(defaultConfig() as Json);
    await input(editor, '{}');
    await esc(document.body);
    assert.deepEqual(seen, [true], 'App の泡の段より先に受ける');
  } finally {
    window.removeEventListener('keydown', app);
  }
});

test('Settings の Esc の順番（DOM）: 枠の中の部品が受けた Esc（行の確かめを閉じる）は、window の段では見ない。書きかけがあっても帯で聞かない', async () => {
  const { container, editor } = await openAdvanced(defaultConfig() as Json);
  await input(editor, '{}');
  await click(container.querySelector('[data-row="adv:reset"] button'));
  const confirm = container.querySelector('.ui-confirm button');
  assert.ok(confirm, '行の確かめが出ている');
  const event = await esc(confirm);
  assert.equal(event.defaultPrevented, true, '確かめが Esc を受ける');
  assert.equal(container.querySelector('.ui-confirm'), null, '確かめは閉じる');
  assert.equal(container.querySelector('.ui-set__leave'), null, '帯は出ない');
});

test('Settings の保存（DOM）: 保存の読み直しと書き込みは、順番待ちの signal を付けて送る（時間切れで止められる。backlog 196）', async () => {
  const { container, editor } = await openAdvanced(defaultConfig() as Json);
  const edited = JSON.parse(editor.value) as Json;
  edited.worker.maxRunsPerHour = 7;
  await input(editor, JSON.stringify(edited, null, 2));
  const before = calls.length;
  await click(buttons(container, 'Save')[0]);
  await settle();
  await settle();
  const during = calls.slice(before).filter(c => c.path === '/api/settings');
  assert.deepEqual(during.map(c => c.method), ['GET', 'PUT', 'GET']);
  assert.ok(during[0]!.signal instanceof AbortSignal, '読み直しに signal');
  assert.ok(during[1]!.signal instanceof AbortSignal, '書き込みに signal');
});

test('Settings › Advanced の Reset（DOM）: 確かめてから Reset する。確かめの材料の読み取りと Reset の通信には、順番待ちの signal を付ける（時間切れで止められる。backlog 279）', async () => {
  const { container, sent } = await openAdvanced(defaultConfig() as Json, (path, method) => {
    if (path === '/api/settings/reset' && method === 'GET') return { config: defaultConfig() };
    if (path === '/api/settings/reset' && method === 'POST') return { config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json', models: [], backup: 'config.json.bak' };
    return undefined;
  });
  await click(container.querySelector('[data-row="adv:reset"] button'));
  assert.equal(sent.length, 0, '押しただけでは Reset しない');
  await click(container.querySelector('[data-below="adv:reset"] .ui-confirm button.bt-btn--danger'));
  await settle();
  await settle();
  await settle();
  const reset = calls.filter(c => c.path === '/api/settings/reset');
  assert.deepEqual(reset.map(c => c.method), ['GET', 'POST']);
  for (const call of reset) assert.ok(call.signal instanceof AbortSignal, `${call.method} に signal`);
  const check = calls.filter(c => c.path === '/api/settings' && c.method === 'GET').at(-2);
  assert.ok(check?.signal instanceof AbortSignal, 'Reset の前の今の設定の読み取りにも signal');
});

test('Settings › Skills（DOM）: Grow skills sits above Ask before registering; turning it Off saves skills.grow = false without a confirmation and dims Ask before registering with its value kept', async () => {
  const config = defaultConfig() as Json;
  config.skills = { askBeforeRegister: false };
  const sent = serveSettings(config, path => (path === '/api/skills' ? { skills: [] } : path === '/api/review' ? { skillDrafts: [] } : path === '/api/tools' ? { tools: [] } : undefined));
  const { container } = await render(createElement(Settings, props({ section: 'skills' })));
  await settle();
  const rows = [...container.querySelectorAll('.bt-setting')].map(r => r.getAttribute('data-row'));
  assert.deepEqual(rows.slice(0, 2), ['skills:grow', 'skills:ask']);
  const sw = (label: string) => container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
  assert.equal(sw('Grow skills').getAttribute('aria-checked'), 'true', 'missing key reads as On');
  assert.equal(sw('Ask before registering').disabled, false);
  const dim = () => sw('Ask before registering').parentElement?.getAttribute('data-grow');
  assert.equal(dim(), 'on', 'not dimmed while growth is On');
  await click(sw('Grow skills'));
  await settle();
  await settle();
  assert.equal(container.querySelector('.ui-set__widen'), null, 'no confirmation sheet');
  const put = sent.at(-1);
  assert.equal(put?.method, 'PUT');
  assert.deepEqual(put?.body?.config.skills, { askBeforeRegister: false, grow: false });
  assert.equal(sw('Grow skills').getAttribute('aria-checked'), 'false');
  assert.equal(sw('Ask before registering').disabled, true, 'dimmed while growth is Off');
  assert.equal(dim(), 'off');
  assert.equal(sw('Ask before registering').getAttribute('aria-checked'), 'false', 'its value is kept');
  const text = container.querySelector('[data-row="skills:grow"]')!.textContent!;
  assert.match(text, /^Grow skillsbeat only uses the skills you already have/u);
  assert.match(container.querySelector('[data-row="skills:ask"]')!.textContent!, /Applies when Grow skills is on/u);
});

// model-auto: モデルの長さ・返事の上限・必要な長さは Advanced にたたみ、いま使っている値を「Auto: …」で見せる
function withAutoModels(): { config: Json; models: Json[] } {
  const config = defaultConfig() as Json;
  config.providers = [{ id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', maxParallel: 1, timeoutMs: 600_000 }];
  config.models = [
    { id: 'qwen', label: 'QWEN', provider: 'local', model: 'qwen', contextLength: 131072, vision: false },
    { id: 'blind', label: 'BLIND', provider: 'local', model: 'blind', vision: false },
  ];
  config.routing = { ...config.routing, chat: ['qwen'], background: [] };
  const probe = (id: string, status: string) => ({ modelId: id, status, server: 'generic', required: 61_440, message: '', checkedAt: 1 });
  const models = [
    { id: 'qwen', label: 'QWEN', provider: 'local', model: 'qwen', contextLength: 131072, limits: { context: 131072, maxOutput: 32_000, required: 61_440 }, inChat: true, probe: probe('qwen', 'ok') },
    { id: 'blind', label: 'BLIND', provider: 'local', model: 'blind', limits: { context: null, maxOutput: null, required: 61_440 }, inChat: false, probe: probe('blind', 'unknown') },
  ];
  return { config, models };
}

async function openAutoModels() {
  const { config, models } = withAutoModels();
  const sent = serveSettings(config, path => (path === '/api/models' ? { models, routing: config.routing } : undefined));
  const { container } = await render(createElement(Settings, props({ section: 'models' })));
  await settle();
  return { container, sent };
}

const modelEdit = (container: HTMLElement, id: string) => container.querySelector(`[data-row="model:${id}"] button[aria-expanded]`);
const advancedToggle = (container: HTMLElement, id: string) => container.querySelector(`[data-row="model:${id}:advanced"] button[aria-expanded]`);
const field = (container: HTMLElement, label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const descOf = (container: HTMLElement, row: string) => container.querySelector(`[data-row="${row}"] .bt-setting__desc`)?.textContent ?? '';

test('Settings › Models（DOM）model-auto: Advanced は閉じて始まり、ふだんは 1 行の読みものだけ。開くと Auto: の値が見え、Least context needed は読むだけ', async () => {
  const { container } = await openAutoModels();
  await click(modelEdit(container, 'qwen'));
  assert.equal(advancedToggle(container, 'qwen')?.getAttribute('aria-expanded'), 'false', 'Advanced は閉じている');
  assert.equal(field(container, 'Context length'), null, '閉じている間は長さの欄が無い');
  assert.equal(field(container, 'Longest reply'), null);
  assert.equal(descOf(container, 'model:qwen:advanced'), 'Context 131,072 · Reply up to 32,000 · Needs 61,440');
  await click(advancedToggle(container, 'qwen'));
  assert.equal(advancedToggle(container, 'qwen')?.getAttribute('aria-expanded'), 'true');
  assert.equal(field(container, 'Longest reply')?.value, '', '書いていなければ空');
  assert.equal(field(container, 'Longest reply')?.placeholder, 'Auto: 32,000');
  assert.equal(descOf(container, 'model:qwen:out'), 'Auto: 32,000');
  assert.equal(field(container, 'Context length')?.value, '131072');
  assert.match(descOf(container, 'model:qwen:ctx'), /^Set by you · Use auto$/u);
  assert.equal(field(container, 'Least context needed'), null, '必要な長さは書けない');
  assert.equal(container.querySelector('[data-row="model:qwen:min"] .bt-setting__end')?.textContent, 'Auto: 61,440');
  assert.equal(descOf(container, 'model:qwen:min'), 'beat computes this');
});

test('Settings › Models（DOM）model-auto: Longest reply を書くと保存し、Use auto でその項目を消す', async () => {
  const { container, sent } = await openAutoModels();
  await click(modelEdit(container, 'qwen'));
  await click(advancedToggle(container, 'qwen'));
  await commitText(container, field(container, 'Longest reply'), '512');
  assert.equal(sent.at(-1)?.body?.config.models[0].maxOutputTokens, 512);
  assert.match(descOf(container, 'model:qwen:out'), /^Set by you · Use auto$/u);
  const useAuto = [...container.querySelectorAll('[data-row="model:qwen:out"] button')].find(b => b.textContent === 'Use auto');
  await click(useAuto);
  await settle();
  await settle();
  const widen = container.querySelector('.ui-set__widen');
  if (widen) { await click(buttons(widen, 'Confirm')[0]); await settle(); await settle(); }
  assert.equal('maxOutputTokens' in sent.at(-1)!.body!.config.models[0], false, 'Use auto で項目が消える');
  assert.equal(sent.at(-1)?.body?.config.models[0].contextLength, 131072, 'ほかの値は残る');
});

test('Settings › Models（DOM）model-auto: 長さが分からない（unknown）モデルだけ、Context length が Advanced の外に出て入力を求める', async () => {
  const { container } = await openAutoModels();
  await click(modelEdit(container, 'blind'));
  assert.equal(advancedToggle(container, 'blind')?.getAttribute('aria-expanded'), 'false');
  assert.ok(field(container, 'Context length'), 'Advanced を開かなくても長さの欄がある');
  assert.equal(descOf(container, 'model:blind:ctx'), en['ui.set.model.contextNeeded']);
  await click(modelEdit(container, 'blind'));
  await click(modelEdit(container, 'qwen'));
  assert.equal(field(container, 'Context length'), null, 'unknown でないモデルは Advanced の中だけ');
});
