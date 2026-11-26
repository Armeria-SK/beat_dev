import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import { BLOCKING_ISSUES, PERMISSIONS, RUNTIME_ISSUES } from '../src/runtimes/types.ts';
import type { RuntimeIssue, RuntimeView } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { t } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { addModel, addRuntimeModel, updateRuntime } from '../web/src/settings/model.ts';
import { setConversation } from '../web/src/ui/settings/view.ts';
import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// AR-6: Settings › Models の Runtimes の行。確かめは「Check」を押したときだけ、ログインは案内だけ、許可の設定は閉じた一覧だけ

interface SettingsProps { section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }
const { Settings } = await loadTsx<{ Settings: ComponentType<SettingsProps> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);
const { stateLine, issueLine } = await loadTsx<{
  stateLine: (t: typeof import('../web/src/i18n/index.ts').t, view: Pick<RuntimeView, 'enabled' | 'check'>) => string;
  issueLine: (t: typeof import('../web/src/i18n/index.ts').t, issue: RuntimeIssue) => string;
}>('../web/src/ui/settings/runtimes.tsx', import.meta.url);

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

interface Sent { method: string; path: string; body: Json | null }

const CHECKED = { checkedAt: Date.now(), installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'subscription', issues: [], stop: null, usable: true };

interface World { config: Json; checks: Record<string, Json | null>; models: Record<string, Json[] | null>; failModels: boolean; sent: Sent[] }

function serve(config: Json, seed: Partial<Pick<World, 'checks' | 'models' | 'failModels'>> = {}): World {
  const world: World = { config: structuredClone(config), checks: seed.checks ?? {}, models: seed.models ?? {}, failModels: seed.failModels ?? false, sent: [] };
  const view = () => ({ config: world.config, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  const modelViews = () => (world.config.models as Json[]).map(m => ({ id: m.id, label: m.label ?? m.id, provider: m.provider ?? '', runtime: m.runtime ?? null, model: m.model, inChat: world.config.routing.chat.includes(m.id), limits: { context: null, maxOutput: null, required: null }, probe: m.runtime ? { modelId: m.id, status: 'ok', server: 'claude-code', required: 0, message: 'ready', messageCode: 'provider.probe.runtime_ok', messageParams: { id: m.runtime }, checkedAt: 1 } : null }));
  const rows = () => (['claude-code', 'codex'] as const).map(kind => {
    const found = (world.config.runtimes ?? []).find((r: Json) => r.kind === kind);
    const id = found?.id ?? kind;
    const enabled = found?.enabled === true;
    const permissions = [...PERMISSIONS[kind]] as string[];
    return { id, kind, configured: found !== undefined, enabled, permission: permissions.includes(found?.permission) ? found.permission : permissions[0], permissions, check: enabled ? world.checks[id] ?? null : null, models: enabled ? world.models[id] ?? null : null };
  });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    if (method !== 'GET') world.sent.push({ method, path: url, body });
    let out: unknown;
    let status = 200;
    const check = /^\/api\/runtimes\/([^/]+)\/check$/u.exec(url);
    const models = /^\/api\/runtimes\/([^/]+)\/models$/u.exec(url);
    if (url === '/api/settings' && method === 'GET') out = view();
    else if (url === '/api/settings' && method === 'PUT') { world.config = body!.config; out = { ...view(), models: modelViews() }; }
    else if (url === '/api/models') out = { models: modelViews(), routing: world.config.routing };
    else if (url === '/api/runtimes') out = { runtimes: rows() };
    else if (check) {
      world.checks[check[1]!] ??= CHECKED;
      out = rows().find(row => row.id === check[1]);
    } else if (models) {
      if (world.failModels) { status = 502; out = { error: 'runtime_unavailable', message: 'Could not get the model list from the runtime "claude-code": boom', code: 'http.runtime_models_failed' }; }
      else { world.models[models[1]!] = [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { id: 'opus', label: 'opus', efforts: [] }]; out = rows().find(row => row.id === models[1]); }
    } else { status = 404; out = { error: 'not found' }; }
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return world;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const props = (): SettingsProps => ({ section: 'models', onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined });
const row = (root: ParentNode, key: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-row="${key}"]`);
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
const button = (root: ParentNode, label: string): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => text(b) === label);
const menu = async (root: ParentNode, key: string): Promise<string[]> => {
  await click(row(root, key)?.querySelector('button[aria-haspopup="menu"]'));
  return [...(row(root, key)?.parentElement?.querySelectorAll('[role="menuitemradio"]') ?? document.querySelectorAll('[role="menuitemradio"]'))].map(el => text(el));
};

const base = (extra: Json = {}): Json => {
  const config = defaultConfig() as Json;
  config.providers = [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 }];
  config.models = [{ id: 'm1', label: 'M1', provider: 'anthropic', model: 'm1', maxOutputTokens: 4096 }];
  config.routing = { ...config.routing, chat: ['m1'], background: [] };
  return { ...config, ...extra };
};

async function open(world: World) {
  const { container } = await render(createElement(Settings, props()));
  await settle();
  await settle();
  assert.ok(world.config);
  return container;
}

test('without any runtime in the settings: a row for each kind, both turned off, nothing is checked, and no detail rows', async () => {
  const world = serve(base());
  const c = await open(world);
  assert.equal(text(c.querySelector('[data-row="runtime:claude-code"] .bt-setting__title')), 'Claude Code');
  assert.equal(text(c.querySelector('[data-row="runtime:codex"] .bt-setting__title')), 'Codex');
  for (const id of ['claude-code', 'codex']) {
    assert.match(text(row(c, `runtime:${id}`)), /Turned off\. beat does not start it/u);
    assert.equal(row(c, `runtime:${id}:permission`), null, 'a turned-off runtime has no permission row');
    assert.equal(button(row(c, `runtime:${id}`)!, 'Check'), undefined, 'a turned-off runtime cannot be checked');
  }
  assert.deepEqual(world.sent, [], 'opening the screen starts nothing');
});

test('turning a runtime on adds a turned-off-by-default row to the settings, then checks it once; nothing else was sent', async () => {
  const world = serve(base());
  const c = await open(world);
  await click(row(c, 'runtime:claude-code')!.querySelector('[role="switch"]'));
  await settle(); await settle(); await settle();
  assert.deepEqual(world.sent.map(s => `${s.method} ${s.path}`), ['PUT /api/settings', 'POST /api/runtimes/claude-code/check']);
  assert.deepEqual(world.sent[0]!.body!.config.runtimes, [{ id: 'claude-code', kind: 'claude-code', enabled: true }]);
  const line = text(row(c, 'runtime:claude-code'));
  assert.match(line, /Version 2\.1\.331 \(a version beat has checked\)/u);
  assert.match(line, /Signed in with your subscription/u);
  assert.match(line, /Ready/u);
});

test('state line: installed + unchecked version + API-key login; not installed; signed out', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), {
    checks: { 'claude-code': { ...CHECKED, version: '2.1.400', verified: false, login: 'other', usable: false }, codex: { ...CHECKED, installed: false, version: null, auth: 'unknown', login: null, usable: false } },
  });
  const c = await open(world);
  const claude = text(row(c, 'runtime:claude-code'));
  assert.match(claude, /Version 2\.1\.400 \(not a version beat has checked; it may still work\)/u);
  assert.match(claude, /Signed in with an API key or another login, not a subscription\. beat does not use it/u);
  assert.match(claude, /Not ready/u, 'a login that is not a subscription is not ready, as the server says it is not usable');
  assert.match(text(row(c, 'runtime:codex')), /Not installed, or not found on this computer/u);
  assert.match(text(row(c, 'runtime:codex')), /Not installed/u);
  world.checks.codex = { ...CHECKED, auth: 'login_required', login: null, usable: false };
  const again = await render(createElement(Settings, props()));
  await settle(); await settle();
  assert.match(text(row(again.container, 'runtime:codex')), /Not signed in/u);
  assert.match(text(row(again.container, 'runtime:codex')), /Signed out/u);
});

test('what the check found is said under the row: unwritable folders, a sandbox that is not ready, a version that is too old, and the tools a conversation stopped on', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), {
    checks: {
      codex: { ...CHECKED, version: '0.172.0', issues: [{ code: 'sandbox_not_ready', detail: 'updateRequired' }, { code: 'world_writable', detail: 'C:/shared/a, C:/shared/b (+7)' }, { code: 'writable_scan_failed' }], usable: false },
      'claude-code': { ...CHECKED, issues: [{ code: 'too_old', detail: '2.1.296' }], stop: { code: 'tools_unreviewed', detail: 'Foo, Bar' }, usable: false },
    },
  });
  const c = await open(world);
  const lines = (id: string) => [...c.querySelectorAll(`[data-below="runtime:${id}"] [data-issue]`)].map(el => [el.getAttribute('data-issue'), text(el)]);
  assert.deepEqual(lines('codex'), [
    ['world_writable', 'Folders the sandbox cannot protect: C:/shared/a, C:/shared/b (+7)'],
    ['writable_scan_failed', 'The check for folders the sandbox cannot protect did not finish'],
  ], 'the sandbox line that now sits on the description line is not said a second time below');
  assert.match(text(row(c, 'runtime:codex')!.querySelector('.bt-setting__desc')), /The Windows sandbox is not ready \(updateRequired\), so beat will not start a conversation yet\./u);
  assert.deepEqual(lines('claude-code').map(([code]) => code), ['tools_unreviewed']);
  assert.match(lines('claude-code')[0]![1]!, /tools beat has not reviewed \(Foo, Bar\)/u);
  assert.match(text(row(c, 'runtime:claude-code')!.querySelector('.bt-setting__desc')), /Version 2\.1\.296 or newer is needed\. Update it$/u);
  assert.match(text(row(c, 'runtime:codex')), /Not ready/u);
});

// 持ち主が見た画面: Codex の札は「Not ready」なのに、説明の行は「版 OK・契約でログイン・確かめた」だけで、理由は下の小さな行にしか無かった
test('a runtime that is Not ready because of a blocking issue says why on its description line, right after the good facts, and a non-blocking issue stays below only', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), {
    checks: {
      codex: { ...CHECKED, version: '0.172.0', issues: [{ code: 'sandbox_not_ready', detail: 'updateRequired' }, { code: 'too_old', detail: '0.180.0' }, { code: 'world_writable', detail: 'C:/shared/a' }], usable: false },
      'claude-code': { ...CHECKED, issues: [{ code: 'world_writable', detail: 'C:/shared/a' }], usable: true },
    },
  });
  const c = await open(world);
  const desc = (id: string) => text(row(c, `runtime:${id}`)!.querySelector('.bt-setting__desc'));
  const below = (id: string) => [...c.querySelectorAll(`[data-below="runtime:${id}"] [data-issue]`)].map(el => el.getAttribute('data-issue'));
  assert.match(desc('codex'), /^Version 0\.172\.0 \(a version beat has checked\) · Signed in with your subscription · checked [^·]+ · The Windows sandbox is not ready \(updateRequired\), so beat will not start a conversation yet\. Run Codex once yourself, outside beat, and finish the sandbox setup or update it asks for, then press Check$/u);
  assert.match(text(row(c, 'runtime:codex')!.querySelector('.bt-pill')), /^Not ready$/u);
  assert.deepEqual(below('codex'), ['too_old', 'world_writable'], 'only the first blocking issue moves up; the second blocking one and the non-blocking one stay below');
  assert.doesNotMatch(desc('claude-code'), /sandbox|needed/u, 'a Ready runtime has nothing to explain on its description line');
  assert.deepEqual(below('claude-code'), ['world_writable']);
});

// 札が Not ready（usable false）のとき、説明の行に出る注意は、会話を始められなくする種類（BLOCKING_ISSUES）だけ。ほかの種類は、usable が false でも出さない（ログインが契約でないときなど、別の理由で Not ready のとき）
test('on a Not ready runtime, the description line carries an issue iff its code is in BLOCKING_ISSUES, for every issue code', () => {
  const view = (code: RuntimeIssue['code']): RuntimeView => ({
    id: 'codex', kind: 'codex', configured: true, enabled: true, permission: 'read-only', permissions: ['read-only'], models: null,
    check: { ...CHECKED, version: '0.172.0', issues: [{ code, detail: 'x' }], stop: null, usable: false } as NonNullable<RuntimeView['check']>,
  });
  for (const code of RUNTIME_ISSUES) {
    const said = stateLine(t, view(code)).includes(issueLine(t, { code, detail: 'x' }));
    assert.equal(said, BLOCKING_ISSUES.has(code), `${code}: said on the description line iff it blocks a start`);
  }
});

// 会話を断られたあと Settings を開く流れ: サーバーは、断った注意（始められなくする最初の 1 件）をそのまま stop にも覚える
test('the stop that repeats the issue already on the description line is not said again below; a stop with another state is', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), {
    checks: {
      codex: { ...CHECKED, version: '0.172.0', issues: [{ code: 'sandbox_not_ready', detail: 'updateRequired' }], stop: { code: 'sandbox_not_ready', detail: 'updateRequired' }, usable: false },
      'claude-code': { ...CHECKED, issues: [{ code: 'too_old', detail: '2.1.296' }], stop: { code: 'too_old', detail: '2.1.290' }, usable: false },
    },
  });
  const c = await open(world);
  const below = (id: string) => [...c.querySelectorAll(`[data-below="runtime:${id}"] [data-issue]`)].map(el => [el.getAttribute('data-issue'), text(el)]);
  assert.match(text(row(c, 'runtime:codex')!.querySelector('.bt-setting__desc')), /The Windows sandbox is not ready \(updateRequired\)/u);
  assert.deepEqual(below('codex'), [], 'the same code and state as the description line: said once');
  assert.match(text(row(c, 'runtime:claude-code')!.querySelector('.bt-setting__desc')), /Version 2\.1\.296 or newer is needed\. Update it$/u);
  assert.deepEqual(below('claude-code'), [['too_old', 'Version 2.1.290 or newer is needed. Update it']], 'a stop that names another state is still said below');
});

// 札が Signed out のときの理由は「ログインしていない」。ほかの注意（囲いの準備）を説明の行に混ぜず、下の行に残す
test('a signed-out runtime says it is not signed in on the description line, and its sandbox issue stays below', async () => {
  const world = serve(base({ runtimes: [{ id: 'codex', kind: 'codex', enabled: true }] }), {
    checks: { codex: { ...CHECKED, version: '0.172.0', auth: 'login_required', login: null, issues: [{ code: 'sandbox_not_ready', detail: 'updateRequired' }], usable: false } },
  });
  const c = await open(world);
  const desc = text(row(c, 'runtime:codex')!.querySelector('.bt-setting__desc'));
  assert.match(desc, /Not signed in/u);
  assert.doesNotMatch(desc, /sandbox/u);
  assert.match(text(row(c, 'runtime:codex')!.querySelector('.bt-pill')), /^Signed out$/u);
  assert.deepEqual([...c.querySelectorAll('[data-below="runtime:codex"] [data-issue]')].map(el => el.getAttribute('data-issue')), ['sandbox_not_ready']);
});

test('the sandbox message tells the owner what to do for every non-ready state (set up, update, unknown), in English and in Japanese', () => {
  const asks = [
    [en, /Run Codex once yourself, outside beat, and finish the sandbox setup or update it asks for, then press Check$/u],
    [ja, /beat の外で Codex を一度自分で動かし、Codex が求める囲いの準備や更新をすませてから「Check」を押してください$/u],
  ] as const;
  for (const [table, pattern] of asks) {
    for (const state of ['updateRequired', 'notConfigured', 'unknown']) {
      const message = table['ui.set.runtime.issueSandboxDesc'](state);
      assert.ok(message.includes(`（${state}）`) || message.includes(`(${state})`), `${state} is shown`);
      assert.match(message, pattern);
    }
  }
});

test('the permission row offers only the closed list for the runtime, never a value that allows everything, and saving a choice writes only that value', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), { checks: { 'claude-code': CHECKED, codex: CHECKED } });
  const c = await open(world);
  for (const [id, labels] of [['claude-code', ['Ask first', 'Allow edits']], ['codex', ['Read only', 'Write in folder']]] as const) {
    const key = `runtime:${id}:permission`;
    assert.deepEqual(await menu(c, key), labels, id);
    await click(row(c, key)!.querySelector('button[aria-haspopup="menu"]'));
  }
  const key = 'runtime:claude-code:permission';
  const desc = text(row(c, key)!.querySelector('.bt-setting__desc'));
  assert.match(desc, /Asks before changes and commands/u);
  assert.match(desc, /beat's judge does not run here; Claude Code's own settings also apply\. Reading commands, and reading files in the product folder, run without asking/u);
  await click(row(c, key)!.querySelector('button[aria-haspopup="menu"]'));
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el => text(el) === 'Allow edits'));
  await settle(); await settle();
  const put = world.sent.filter(s => s.method === 'PUT').at(-1)!;
  assert.equal(put.body!.config.runtimes[0].permission, 'acceptEdits');
  assert.equal(put.body!.config.runtimes[1].permission, undefined, 'the other runtime is untouched');
});

test('sign-in is only a pointer to the runtime itself, and there is no MCP warning or MCP switch (the owner ruled the runtimes run the owner\'s own tools as they are)', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true }] }), { checks: { 'claude-code': CHECKED, codex: CHECKED } });
  const c = await open(world);
  assert.match(text(row(c, 'runtime:claude-code:signin')), /run "claude auth login" in a terminal\. beat never signs in for you or keeps your login/u);
  assert.match(text(row(c, 'runtime:codex:signin')), /run "codex login" in a terminal/u);
  assert.equal(row(c, 'runtime:codex:signin')!.querySelector('button, input, [role="switch"]'), null, 'a pointer, not a control');
  const group = [...c.querySelectorAll('.bt-group')].find(g => text(g.querySelector('.bt-group__title')) === 'Runtimes')!;
  assert.ok(group, 'a Runtimes group');
  assert.ok(!/mcp/iu.test(text(group)), 'no MCP wording in the Runtimes group');
  assert.equal(group.querySelectorAll('[role="switch"]').length, 2, 'only the two enable switches');
  const notes = [...group.querySelectorAll('[data-runtime-note]')].map(el => [el.getAttribute('data-runtime-note'), text(el)]);
  assert.deepEqual(notes.map(([kind]) => kind), ['claude-code'], 'one compact note, for Claude Code only');
  assert.match(notes[0]![1]!, /product folder's Claude Code settings are not read/u);
  assert.match(notes[0]![1]!, /agents, skills \(allowed-tools\), permissions\.allow and worktree settings still apply/u);
  assert.match(notes[0]![1]!, /sub-agent it starts never asks beat for approval/u);
  assert.match(notes[0]![1]!, /deny rules reach outside the working folder, or cover Grep and Glob, is not confirmed/u);
});

test('an unchecked Codex version says it starts read-only whatever the permission row shows; a checked version, a missing Codex and Claude Code say nothing of the kind', async () => {
  const runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }, { id: 'codex', kind: 'codex', enabled: true, permission: 'workspace-write' }];
  const world = serve(base({ runtimes }), { checks: { 'claude-code': { ...CHECKED, version: '2.1.400', verified: false }, codex: { ...CHECKED, version: '0.199.0', verified: false } } });
  const notesFor = async (): Promise<string[][]> => {
    const { container } = await render(createElement(Settings, props()));
    await settle(); await settle();
    return [...container.querySelectorAll('[data-runtime-readonly]')].map(el => [el.getAttribute('data-runtime-readonly')!, text(el)]);
  };
  assert.deepEqual(await notesFor(), [['codex', 'This Codex version is not one beat has checked, so it starts read-only whatever is set above']], 'only Codex, and only for the unchecked version');
  world.checks.codex = { ...CHECKED, version: '0.172.0', verified: true };
  assert.deepEqual(await notesFor(), [], 'a version beat has checked starts with the permission that is set');
  world.checks.codex = { ...CHECKED, installed: false, version: null, verified: false, auth: 'unknown', login: null, usable: false };
  assert.deepEqual(await notesFor(), [], 'a Codex that is not installed has no version to speak of');
});

test('Check asks the server once and shows the new state', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] }));
  const c = await open(world);
  assert.match(text(row(c, 'runtime:claude-code')), /Not checked yet\. Press Check/u);
  await click(button(row(c, 'runtime:claude-code')!, 'Check'));
  await settle(); await settle();
  assert.deepEqual(world.sent.map(s => `${s.method} ${s.path}`), ['POST /api/runtimes/claude-code/check']);
  assert.match(text(row(c, 'runtime:claude-code')), /Version 2\.1\.331/u);
});

test('Load models lists the runtime\'s own models; picking one adds a model that points at the runtime (no provider) with its depths, and it is not offered again', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] }), { checks: { 'claude-code': CHECKED } });
  const c = await open(world);
  await click(button(row(c, 'runtime:claude-code:models')!, 'Load models'));
  await settle(); await settle();
  assert.deepEqual(world.sent.map(s => `${s.method} ${s.path}`), ['POST /api/runtimes/claude-code/models']);
  await click(row(c, 'runtime:claude-code:models')!.querySelector('button[aria-haspopup="menu"]'));
  assert.deepEqual([...document.querySelectorAll('[role="menuitemradio"]')].map(el => text(el)), ['Sonnet (sonnet)', 'opus']);
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el => text(el) === 'Sonnet (sonnet)'));
  await settle(); await settle();
  const put = world.sent.find(s => s.method === 'PUT')!;
  const added = (put.body!.config.models as Json[]).find(m => m.runtime === 'claude-code')!;
  assert.deepEqual(added, { id: 'claude-code-sonnet', label: 'Sonnet', runtime: 'claude-code', model: 'sonnet', vision: false, efforts: ['low', 'high'] });
  assert.ok(!('provider' in added));
  assert.deepEqual(put.body!.config.routing.chat, ['m1'], 'adding a model does not change which model is used');
  assert.ok(row(c, 'model:claude-code-sonnet'), 'the new model shows in the Models group');
  assert.match(text(row(c, 'model:claude-code-sonnet')), /claude-code · sonnet/u);
  assert.equal(row(c, 'model:claude-code-sonnet:provider'), null);
});

test('a model list that could not be read says so and falls back to typing the model name', async () => {
  const world = serve(base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] }), { checks: { 'claude-code': CHECKED }, failModels: true });
  const c = await open(world);
  await click(button(row(c, 'runtime:claude-code:models')!, 'Load models'));
  await settle(); await settle();
  const below = c.querySelector('[data-below="runtime:claude-code:models"]')!;
  assert.match(text(below), /The list could not be read \(.*boom\)\. You can type a model name instead/u);
  await input(below.querySelector('input'), 'sonnet');
  await click(button(below, 'Add'));
  await settle(); await settle();
  const put = world.sent.find(s => s.method === 'PUT')!;
  assert.deepEqual((put.body!.config.models as Json[]).find(m => m.runtime)!, { id: 'claude-code-sonnet', label: 'sonnet', runtime: 'claude-code', model: 'sonnet', vision: false });
});

test('Conversation can pick a runtime model; Judge, Scout, Fallback and Background never offer one', async () => {
  const config = base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] });
  config.models = [{ id: 'm1', label: 'M1', provider: 'anthropic', model: 'm1', maxOutputTokens: 4096 }, { id: 'm2', label: 'M2', provider: 'anthropic', model: 'm2', maxOutputTokens: 4096 }, { id: 'rt', label: 'RT', runtime: 'claude-code', model: 'sonnet', vision: false }];
  const world = serve(config, { checks: { 'claude-code': CHECKED } });
  const c = await open(world);
  const picks = async (scope: ParentNode | null | undefined): Promise<string[]> => {
    await click(scope?.querySelector('button[aria-haspopup="menu"]'));
    const labels = [...document.querySelectorAll('[role="menuitemradio"]')].map(el => text(el)).filter(label => /^(M1|M2|RT)$/u.test(label));
    await click(scope?.querySelector('button[aria-haspopup="menu"]'));
    return labels;
  };
  assert.deepEqual((await picks(row(c, 'roles:conversation'))).sort(), ['M1', 'M2', 'RT']);
  assert.deepEqual((await picks(row(c, 'roles:judge'))).sort(), ['M1', 'M2']);
  assert.deepEqual((await picks(row(c, 'roles:scout'))).sort(), ['M1', 'M2']);
  assert.deepEqual((await picks(c.querySelector('[data-order="fallback"]'))).sort(), ['M2']);
  assert.deepEqual((await picks(c.querySelector('[data-order="background"]'))).sort(), ['M1', 'M2']);
});

test('the model row for a runtime model shows its runtime and a Ready / Not checked mark, with no provider, context or output rows', async () => {
  const config = base({ runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] });
  config.models = [{ id: 'rt', label: 'RT', runtime: 'claude-code', model: 'sonnet', vision: false }];
  config.routing = { ...config.routing, chat: ['rt'] };
  const world = serve(config, { checks: { 'claude-code': CHECKED } });
  const c = await open(world);
  const model = row(c, 'model:rt')!;
  assert.match(text(model), /claude-code · sonnet/u);
  assert.match(text(model), /Ready/u);
  await click(model.querySelector('button[aria-expanded]'));
  assert.equal(row(c, 'model:rt:provider'), null);
  assert.equal(row(c, 'model:rt:advanced'), null);
  assert.ok(row(c, 'model:rt:model'));
});

// ---------------------------------------------------------------- 設定を書き換える部分（画面を使わない）

test('config helpers: a runtime row is added turned off, patches stick, and a runtime model never lands in the "fill all" routing or the conversation tail', () => {
  const config = { runtimes: [], models: [{ id: 'rt', runtime: 'claude-code', model: 'sonnet' }, { id: 'm1', provider: 'p', model: 'm1' }], providers: [{ id: 'p' }], routing: { chat: [], background: [] } };
  const added = updateRuntime(config, { id: 'codex', kind: 'codex' }, { permission: 'workspace-write' });
  assert.deepEqual(added.runtimes, [{ id: 'codex', kind: 'codex', enabled: false, permission: 'workspace-write' }]);
  assert.deepEqual(updateRuntime(added, { id: 'codex', kind: 'codex' }, { enabled: true }).runtimes, [{ id: 'codex', kind: 'codex', enabled: true, permission: 'workspace-write' }]);
  assert.deepEqual(updateRuntime(added, { id: 'codex', kind: 'codex' }, { permission: undefined }).runtimes, [{ id: 'codex', kind: 'codex', enabled: false }], 'an undefined patch removes the key');
  const filled = addModel(config);
  assert.deepEqual(filled.config.routing.chat, ['m1', filled.id], 'the "fill all" routing leaves the runtime model out (it may only be the first of chat on purpose)');
  const withRuntimeFirst = { ...config, routing: { chat: ['rt', 'm1'], background: [] } };
  assert.deepEqual(setConversation(withRuntimeFirst, 'm1').routing.chat, ['m1'], 'the runtime model leaving the head is not kept as a backup');
  assert.deepEqual(setConversation(withRuntimeFirst, 'rt').routing.chat, ['rt', 'm1']);
  const made = addRuntimeModel(config, 'claude-code', { id: 'Opus 4', label: 'Opus 4', efforts: [] });
  assert.equal(made.id, 'claude-code-opus-4');
  assert.deepEqual((made.config.models as Json[]).at(-1), { id: 'claude-code-opus-4', label: 'Opus 4', runtime: 'claude-code', model: 'Opus 4', vision: false });
});
