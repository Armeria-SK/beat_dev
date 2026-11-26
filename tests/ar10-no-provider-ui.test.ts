import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { parseConfig, defaultConfig } from '../src/config/store.ts';
import type { ModelView, Project, Task, WaitReason } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { putRuntimeFirst, setupModelConfig, setupRuntimeConfig } from '../web/src/onboarding.ts';
import { noProviderNow, setNoProvider, subscribeNoProvider } from '../web/src/provider-state.ts';
import { noProviderConfig } from '../web/src/settings/model.ts';
import { buildAction } from '../web/src/ui/acceptance.ts';
import { chatModelCount, composerView, runtimeDown } from '../web/src/ui/composer-state.ts';
import { connectProblem, emptyConnect, modelFormOf, PROVIDERS } from '../web/src/ui/onboarding-steps.ts';
import { waitText } from '../web/src/ui/wait.ts';
import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// AR-10: 提供元が無いときの画面。はじめの設定で実行役を選べる・動かないものは押せないか理由が出る・実行役の会話に判定役が働かないことと許可の設定が出る・ログアウトで「つなぐものが無い」に戻る

type Json = Record<string, any>;
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  setNoProvider(false);
  globalThis.fetch = realFetch;
});

const bare = (): Json => ({ ...(defaultConfig() as Json), providers: [], models: [], runtimes: [], routing: { chat: [], background: [], retriesPerModel: 0 } });
const withProvider = (): Json => ({ ...bare(), providers: [{ id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', maxParallel: 1, timeoutMs: 600_000 }], models: [{ id: 'm1', label: '', provider: 'local', model: 'm1', vision: false }], routing: { chat: ['m1'], background: ['m1'], retriesPerModel: 0 } });

test('setupRuntimeConfig: 提供元のモデルが無いとき、実行役を入れてモデルを足し、会話の順番の先頭に置く（保存できる形）', () => {
  const made = setupRuntimeConfig(bare(), { kind: 'claude-code', model: ' sonnet ' });
  assert.deepEqual(made.config.runtimes, [{ id: 'claude-code', kind: 'claude-code', enabled: true }]);
  assert.deepEqual(made.config.models, [{ id: 'claude-code-sonnet', label: 'sonnet', runtime: 'claude-code', model: 'sonnet', vision: false }]);
  assert.equal(made.runtimeId, 'claude-code');
  assert.equal(made.modelId, 'claude-code-sonnet');
  assert.deepEqual(made.config.routing, { chat: ['claude-code-sonnet'], background: [], retriesPerModel: 0 }, 'a runtime model may only be first in chat; the background stays empty');
  assert.doesNotThrow(() => parseConfig(made.config));
  const again = setupRuntimeConfig(made.config, { kind: 'claude-code', model: 'sonnet' });
  assert.equal(again.config.models.length, 1, 'the same model is not added twice');
  assert.deepEqual(again.config.routing.chat, ['claude-code-sonnet']);
  assert.equal(bare().models.length, 0, 'the input is not changed');
});

test('setupRuntimeConfig: 提供元のモデルがあるときは、確かめる前の保存で会話の順番に触らない。確かめが通ったあとの putRuntimeFirst で、実行役のモデルが先頭に来る（提供元のモデルは後ろ。裏の順番は触らない）。切ってあった実行役の行は同じ id のまま入れ直す', () => {
  const owned = setupRuntimeConfig(withProvider(), { kind: 'codex', model: 'gpt-x' });
  assert.deepEqual(owned.config.routing, withProvider().routing, 'before the check passes the order is not touched');
  const first = putRuntimeFirst(owned.config, owned.modelId);
  assert.deepEqual(first.routing, { chat: [owned.modelId, 'm1'], background: ['m1'], retriesPerModel: 0 }, 'after the check passes: the runtime first, the provider models after it; the background order is not touched');
  assert.doesNotThrow(() => parseConfig(first));
  const emptyOrder = setupRuntimeConfig({ ...withProvider(), routing: { chat: [], background: [], retriesPerModel: 0 } }, { kind: 'codex', model: 'gpt-x' });
  assert.deepEqual(emptyOrder.config.routing.chat, [], 'an empty order stays empty before the check');
  assert.deepEqual(putRuntimeFirst(emptyOrder.config, emptyOrder.modelId).routing.chat, [emptyOrder.modelId, 'm1'], 'an empty order meant "every provider model": it stays so, after the runtime');
  const other = setupRuntimeConfig(first, { kind: 'claude-code', model: 'sonnet' });
  assert.deepEqual(other.config.routing.chat, [owned.modelId, 'm1'], 'a runtime that has not passed yet does not replace the one that did');
  assert.deepEqual(putRuntimeFirst(other.config, other.modelId).routing.chat, [other.modelId, 'm1'], 'once it passes it replaces the first one at the head');
  assert.deepEqual(putRuntimeFirst(first, owned.modelId), first, 'putting the same one first again changes nothing');
  assert.equal(putRuntimeFirst(first, 'm1'), first, 'a provider model id is never put in front by this');
  assert.equal(owned.config.runtimes[0].enabled, true);
  const off = { ...bare(), runtimes: [{ id: 'cc', kind: 'claude-code', enabled: false, permission: 'acceptEdits' }] };
  const back = setupRuntimeConfig(off, { kind: 'claude-code', model: 'opus' });
  assert.equal(back.runtimeId, 'cc');
  assert.deepEqual(back.config.runtimes, [{ id: 'cc', kind: 'claude-code', enabled: true, permission: 'acceptEdits' }], 'the permission the owner set stays');
  assert.equal(back.config.models[0].runtime, 'cc');
});

test('はじめの設定の取り直し: 実行役を試して選び直しても、会話の順番の先頭は「いま選んだもの」だけになる（前に試した実行役・綴りを直す前のモデルが先頭に残らない）', () => {
  const first = setupRuntimeConfig(bare(), { kind: 'claude-code', model: 'sonet' });
  assert.deepEqual(first.config.routing.chat, ['claude-code-sonet']);
  const fixed = setupRuntimeConfig(first.config, { kind: 'claude-code', model: 'sonnet' });
  assert.deepEqual(fixed.config.routing.chat, ['claude-code-sonnet'], 'a typo fixed: the corrected model is the default');
  const other = setupRuntimeConfig(first.config, { kind: 'codex', model: 'gpt-x' });
  assert.equal(other.config.routing.chat[0], other.modelId, 'Claude Code failed, Codex chosen: Codex is the default');
  assert.deepEqual(other.config.routing.chat, [other.modelId]);
  assert.doesNotThrow(() => parseConfig(other.config));
  const again = setupRuntimeConfig(other.config, { kind: 'codex', model: 'gpt-x' });
  assert.deepEqual(again.config, other.config, 'choosing the same thing again changes nothing');
});

test('はじめの設定の取り直し: 実行役を試したあとで提供元のモデルに切り替えて通ると、会話の順番も裏の順番も提供元のモデルだけになる（実行役の行は残るが、先頭ではない）', () => {
  const runtime = setupRuntimeConfig(bare(), { kind: 'claude-code', model: 'sonnet' });
  const form = modelFormOf({ ...emptyConnect('anthropic'), model: 'claude-sonnet-4-5', key: 'k' });
  const provider = setupModelConfig(runtime.config, form, null);
  assert.equal(provider.config.routing.chat[0], provider.modelId, 'the provider model is the default of the chat');
  assert.deepEqual(provider.config.routing.chat, [provider.modelId]);
  assert.deepEqual(provider.config.routing.background, [provider.modelId]);
  assert.equal((provider.config.models as Json[]).some(m => m.runtime === 'claude-code'), true, 'the runtime row stays (a model of it can still be picked)');
  assert.doesNotThrow(() => parseConfig(provider.config));
  const second = setupModelConfig(provider.config, modelFormOf({ ...emptyConnect('openai'), model: 'gpt-x', context: '32768' }), null);
  assert.deepEqual(second.config.routing.chat, [provider.modelId, second.modelId], 'with a provider model already there the order is kept and the new one goes last');
});

test('はじめの設定の取り直し（逆の順）: 先に提供元のモデルを試して、そのあと実行役を選んで確かめが通ると、会話の順番の先頭は実行役になる（提供元のモデルは後ろに残る）。通る前は先頭を替えない', () => {
  const provider = setupModelConfig(bare(), modelFormOf({ ...emptyConnect('anthropic'), model: 'claude-sonnet-4-5', key: 'rejected' }), null);
  assert.deepEqual(provider.config.routing.chat, [provider.modelId]);
  const runtime = setupRuntimeConfig(provider.config, { kind: 'claude-code', model: 'sonnet' });
  assert.deepEqual(runtime.config.routing.chat, [provider.modelId], 'the check has not passed: the default is not changed');
  const passed = putRuntimeFirst(runtime.config, runtime.modelId);
  assert.equal(passed.routing.chat[0], runtime.modelId, 'the last choice that passed is the default of the conversations');
  assert.deepEqual(passed.routing.chat, [runtime.modelId, provider.modelId]);
  assert.deepEqual(passed.routing.background, [provider.modelId], 'the background stays on the provider model');
  assert.doesNotThrow(() => parseConfig(passed));
  const back = setupModelConfig(passed, modelFormOf({ ...emptyConnect('anthropic'), model: 'claude-sonnet-4-5', key: 'k' }), provider.modelId);
  assert.deepEqual(back.config.routing.chat, [runtime.modelId, provider.modelId], 'trying the same provider model again keeps the order (the runtime passed last)');
});

test('はじめの設定の入力: 選べる「つなぐもの」に実行役が入り、実行役はモデル名だけで足りる（鍵・URL・長さは要らない）', () => {
  assert.deepEqual([...PROVIDERS], ['anthropic', 'openai', 'custom', 'runtime']);
  assert.equal(connectProblem({ ...emptyConnect('runtime'), model: '' }, false), 'model');
  assert.equal(connectProblem({ ...emptyConnect('runtime'), model: 'sonnet' }, false), null);
  assert.equal(connectProblem({ ...emptyConnect('anthropic'), model: 'm' }, false), 'key', 'the other choices keep their checks');
});

test('noProviderConfig: 提供元のモデルが 1 つも無い（実行役のモデルだけ・何も無い）設定だけ true', () => {
  assert.equal(noProviderConfig(bare()), true);
  assert.equal(noProviderConfig(setupRuntimeConfig(bare(), { kind: 'claude-code', model: 'sonnet' }).config), true);
  assert.equal(noProviderConfig(withProvider()), false);
  assert.equal(noProviderConfig(setupRuntimeConfig(withProvider(), { kind: 'claude-code', model: 'sonnet' }).config), false);
});

test('Build: 提供元が無いときは押せない（あるときは今までどおり）', () => {
  const acc = { frozen: false, draft: false, items: [], not_doing: [], unbuilt: [] } as never;
  const base = { state: 'ready', mode: 'read', acc, task: null as Task | null, isGit: true } as const;
  assert.deepEqual(buildAction({ ...base }), { kind: 'build', label: 'ui.plan.build', disabled: false });
  assert.deepEqual(buildAction({ ...base, noProvider: true }), { kind: 'build', label: 'ui.plan.build', disabled: true });
});

test('待ちの理由「提供元が要る」の文は、英語でも日本語でも出る', () => {
  const reason: WaitReason = { kind: 'no_provider' };
  assert.equal(waitText(reason), en['ui.wait.noProvider']);
  assert.match(String(en['ui.wait.noProvider']), /provider/u);
  assert.match(String(ja['ui.wait.noProvider']), /提供元/u);
});

test('「つなぐものが無い」に戻る: ログアウト・入っていない・切った・使えない注意の実行役のモデルは、会話に使えるモデルの数に入れない（確かめていない・分からないは入れる）', () => {
  const model = (runtime: string | null, messageCode: string | undefined, inChat = true): ModelView => ({
    id: 'm', label: 'm', provider: '', model: 'm', runtime, inChat, probe: messageCode ? { modelId: 'm', status: 'unreachable', server: '', required: 0, message: '', messageCode, checkedAt: 0 } : null,
  } as ModelView);
  for (const code of ['provider.probe.runtime_login', 'provider.probe.runtime_missing', 'provider.probe.runtime_off', 'provider.probe.runtime_blocked', 'provider.probe.no_runtime']) {
    assert.equal(runtimeDown(model('claude-code', code)), true, code);
    assert.equal(chatModelCount([model('claude-code', code)]), 0, code);
  }
  for (const code of ['provider.probe.runtime_ok', 'provider.probe.runtime_unchecked', 'provider.probe.runtime_unknown', undefined]) {
    assert.equal(chatModelCount([model('claude-code', code)]), 1, String(code));
  }
  assert.equal(chatModelCount([model(null, 'provider.probe.runtime_login')]), 1, 'a provider model is never judged by a runtime code');
  assert.equal(chatModelCount([model('claude-code', 'provider.probe.runtime_ok', false)]), 0, 'a model outside the chat order is not counted');
  const down = composerView({ hasConversation: false, running: false, mode: 'auto', chatModels: chatModelCount([model('claude-code', 'provider.probe.runtime_login')]), text: 'hi', attachments: 0, uploading: false, sending: false, product: true, planless: false });
  assert.equal(down.placeholder, 'noModel');
  assert.equal(down.disabled, true, 'logged out: the composer goes back to "no model configured"');
});

test('提供元の有無の置き場: 変わったときだけ聞いている所に知らせ、同じ値の入れ直しでは知らせない。聞くのをやめたあとは知らせない', () => {
  setNoProvider(false);
  assert.equal(noProviderNow(), false);
  const heard: boolean[] = [];
  const stop = subscribeNoProvider(() => { heard.push(noProviderNow()); });
  setNoProvider(false);
  assert.deepEqual(heard, [], 'the same value as now is not a change');
  setNoProvider(true);
  setNoProvider(true);
  assert.deepEqual(heard, [true], 'one change, one call');
  setNoProvider(false);
  assert.deepEqual(heard, [true, false]);
  stop();
  setNoProvider(true);
  assert.deepEqual(heard, [true, false], 'after stopping listening nothing is called');
  assert.equal(noProviderNow(), true);
});

interface ModelStepProps { profile: null; replay: boolean; start: number; onProfile: () => void; onDone: () => void; onSkip: () => void }
const { Onboarding } = await loadTsx<{ Onboarding: ComponentType<ModelStepProps> }>('../web/src/ui/Onboarding.tsx', import.meta.url);
const { ScoutModeSwitch } = await loadTsx<{ ScoutModeSwitch: ComponentType<{ project: Project }> }>('../web/src/ui/ScoutModeSwitch.tsx', import.meta.url);
const { RuntimeNote } = await loadTsx<{ RuntimeNote: ComponentType<{ runtimeId: string }> }>('../web/src/ui/RuntimeNote.tsx', import.meta.url);
const { Settings } = await loadTsx<{ Settings: ComponentType<{ section: string | undefined; onClose: () => void; held: (() => void) | null; onReplay: () => void; onSaved: () => void; onProfile: () => void }> }>('../web/src/ui/settings/Settings.tsx', import.meta.url);

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
const button = (root: ParentNode, label: string): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => text(b) === label);

interface World { config: Json; sent: string[]; check: Json; runtimeModels: Json[] }
const CHECKED = { checkedAt: 1, installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'subscription', issues: [], stop: null, usable: true };

function serve(config: Json, check: Json = CHECKED): World {
  const world: World = { config: structuredClone(config), sent: [], check, runtimeModels: [{ id: 'sonnet', label: 'Sonnet', efforts: [] }] };
  const view = () => ({ config: world.config, apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
  const rows = () => (['claude-code', 'codex'] as const).map(kind => {
    const found = (world.config.runtimes ?? []).find((r: Json) => r.kind === kind);
    const id = found?.id ?? kind;
    const enabled = found?.enabled === true;
    return { id, kind, configured: found !== undefined, enabled, permission: found?.permission ?? 'default', permissions: ['default', 'acceptEdits'], check: enabled ? world.check : null, models: enabled ? world.runtimeModels : null };
  });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
    if (method !== 'GET') world.sent.push(`${method} ${url}`);
    let out: unknown;
    const check = /^\/api\/runtimes\/([^/]+)\/check$/u.exec(url);
    const models = /^\/api\/runtimes\/([^/]+)\/models$/u.exec(url);
    if (url === '/api/settings' && method === 'GET') out = view();
    else if (url === '/api/settings' && method === 'PUT') { world.config = body!.config; out = { ...view(), models: [] }; }
    else if (url === '/api/models') out = { models: [], routing: world.config.routing };
    else if (url === '/api/runtimes') out = { runtimes: rows() };
    else if (check || models) out = rows().find(row => row.id === (check ?? models)![1]);
    else out = {};
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return world;
}

const onboard = async (world: World) => {
  const { container } = await render(createElement(Onboarding, { profile: null, replay: true, start: 3, onProfile: () => undefined, onDone: () => undefined, onSkip: () => undefined }));
  await settle(); await settle();
  assert.ok(world);
  return container;
};
const next = (c: ParentNode) => c.querySelector<HTMLButtonElement>('[data-next]')!;

test('はじめの設定: 「Claude Code or Codex」を選び、モデル名を入れて確かめると、設定に実行役とモデルが入り、確かめが 1 回走り、「使える」と出て先へ進める', async () => {
  const world = serve(bare());
  const c = await onboard(world);
  assert.ok(button(c, 'Claude Code or Codex'), 'the provider choices include the runtimes');
  assert.equal(next(c).disabled, true);
  await click(button(c, 'Claude Code or Codex'));
  assert.match(text(c.querySelector('[data-runtime-onboarding]')), /No API key or local model is needed/u);
  assert.equal(c.querySelector('input[type="password"]'), null, 'no key field for a runtime');
  assert.deepEqual([...c.querySelectorAll('.bt-form-row > .bt-label')].map(el => text(el)).filter(s => /URL|Context|API key/u.test(s)), []);
  await click(button(c, 'Test connection'));
  assert.deepEqual(world.sent, [], 'a missing model name sends nothing');
  assert.equal(c.querySelector('.bt-del[role="alert"]') !== null, true);
  await input(c.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(c, 'Test connection'));
  await settle(); await settle();
  assert.deepEqual(world.sent, ['PUT /api/settings', 'POST /api/runtimes/claude-code/check']);
  assert.deepEqual(world.config.runtimes, [{ id: 'claude-code', kind: 'claude-code', enabled: true }]);
  assert.equal(world.config.models[0].runtime, 'claude-code');
  assert.deepEqual(world.config.routing.chat, ['claude-code-sonnet']);
  assert.match(text(c), /Ready/u);
  assert.equal(next(c).disabled, false, 'the step can be passed with a usable runtime');
});

test('はじめの設定（提供元が動いている人がもう一度やり直す）: 実行役の確かめが通らなかったら、会話の順番は替えない。通ったときだけ、実行役が先頭に来る（提供元のモデルは後ろ）', async () => {
  const failing = serve(withProvider(), { ...CHECKED, auth: 'login_required', usable: false });
  const c = await onboard(failing);
  await click(button(c, 'Claude Code or Codex'));
  await input(c.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(c, 'Test connection'));
  await settle(); await settle();
  assert.match(text(c), /Signed out/u);
  assert.deepEqual(failing.config.routing.chat, ['m1'], 'a failed check leaves the order as it was: the conversations keep going to the provider');
  assert.deepEqual(failing.sent, ['PUT /api/settings', 'POST /api/runtimes/claude-code/check'], 'one save before the check, none after it');
  assert.equal(failing.config.models.some((m: Json) => m.runtime === 'claude-code'), true, 'the runtime and its model are saved (so that the check can run)');
  assert.equal(next(c).disabled, true);

  const passing = serve(withProvider());
  const d = await onboard(passing);
  await click(button(d, 'Claude Code or Codex'));
  await input(d.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(d, 'Test connection'));
  await settle(); await settle();
  assert.deepEqual(passing.config.routing, { chat: ['claude-code-sonnet', 'm1'], background: ['m1'], retriesPerModel: 0 }, 'the check passed: the runtime is first, the provider model follows, the background is untouched');
  assert.deepEqual(passing.sent, ['PUT /api/settings', 'POST /api/runtimes/claude-code/check', 'PUT /api/settings'], 'the order is saved only after the check');
  assert.equal(next(d).disabled, false);
});

test('はじめの設定: ログインが要る実行役は先へ進めず、ログインの案内（beat は代わりにしない）を出す。別の実行役を選び直すと、前の結果は消える', async () => {
  const world = serve(bare(), { ...CHECKED, auth: 'login_required', usable: false });
  const c = await onboard(world);
  await click(button(c, 'Claude Code or Codex'));
  await input(c.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(c, 'Test connection'));
  await settle(); await settle();
  assert.match(text(c), /Signed out/u);
  assert.match(text(c.querySelector('[data-runtime-signin]')), /claude auth login/u);
  assert.equal(next(c).disabled, true, 'a signed-out runtime does not pass the step');
  await click(button(c, 'Codex'));
  assert.equal(c.querySelector('[data-runtime-signin]'), null, 'another runtime starts from nothing');
  assert.equal(next(c).disabled, true);
});

test('はじめの設定: 「List models」は実行役を入れてから、その一覧を読み込む', async () => {
  const world = serve(bare());
  const c = await onboard(world);
  await click(button(c, 'Claude Code or Codex'));
  await click(button(c, 'List models'));
  await settle(); await settle();
  assert.deepEqual(world.sent, ['PUT /api/settings', 'POST /api/runtimes/claude-code/models']);
  assert.deepEqual(world.config.runtimes, [{ id: 'claude-code', kind: 'claude-code', enabled: true }]);
  assert.deepEqual(world.config.models, [], 'no model is added by listing');
  assert.deepEqual([...c.querySelectorAll('#ui-ob-model-names option')].map(o => o.getAttribute('value')), ['sonnet']);
});

test('はじめの設定: 実行役のモデル名は、一覧を読み込んであれば一覧と照らし、無ければ「名前は確かめていない」と画面に出す。名前を直したら、もう一度確かめるまで先へ進めない', async () => {
  const world = serve(bare());
  const c = await onboard(world);
  await click(button(c, 'Claude Code or Codex'));
  await click(button(c, 'List models'));
  await settle(); await settle();
  assert.deepEqual([...c.querySelectorAll('#ui-ob-model-names option')].map(o => o.getAttribute('value')), ['sonnet']);
  world.sent.length = 0;
  await input(c.querySelector('input[list="ui-ob-model-names"]'), 'sonet');
  await click(button(c, 'Test connection'));
  await settle(); await settle();
  assert.deepEqual(world.sent, [], 'a name that is not in the loaded list saves nothing and checks nothing');
  assert.equal(text(c.querySelector('.bt-del[role="alert"]')), en['ui.ob.model.problem.runtimeModel']);
  assert.equal(c.querySelector('input[list="ui-ob-model-names"]')!.getAttribute('aria-invalid'), 'true');
  assert.equal(next(c).disabled, true);
  await input(c.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(c, 'Test connection'));
  await settle(); await settle();
  assert.deepEqual(world.sent, ['PUT /api/settings', 'POST /api/runtimes/claude-code/check']);
  assert.equal(next(c).disabled, false);
  assert.equal(c.querySelector('[data-runtime-untested]'), null, 'the name was found in the list: nothing is left untested');

  const plain = serve(bare());
  const d = await onboard(plain);
  await click(button(d, 'Claude Code or Codex'));
  await input(d.querySelector('input[list="ui-ob-model-names"]'), 'sonnet');
  await click(button(d, 'Test connection'));
  await settle(); await settle();
  assert.equal(next(d).disabled, false);
  assert.equal(text(d.querySelector('[data-runtime-untested]')), en['ui.ob.model.runtimeUntested'], 'without a list, the screen says the name was not tested');
  await input(d.querySelector('input[list="ui-ob-model-names"]'), 'sonnet-2');
  assert.equal(next(d).disabled, true, 'a changed name needs a new check');
  assert.equal(d.querySelector('[data-runtime-untested]'), null);
});

const project = { id: 'p1', name: 'prod', root: '/x', check_command: 'npm test', scout_mode: 'off', remotes: [] } as unknown as Project;

test('考える役の切り替え: 提供元が無いときは Research only・Research and pre-fix を押せず、理由を出す。Off はいつも選べる', async () => {
  serve(bare());
  setNoProvider(true);
  const c = (await render(createElement(ScoutModeSwitch, { project }))).container;
  const options = [...c.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
  assert.deepEqual(options.map(o => [o.dataset.mode, o.disabled]), [['off', false], ['research', true], ['fix', true]]);
  assert.equal(options[1]!.title, en['ui.np.scout']);
  assert.match(text(options[1]), /needs a provider/u);
  await update(() => setNoProvider(false));
  assert.deepEqual([...c.querySelectorAll<HTMLButtonElement>('button[data-mode]')].map(o => o.disabled), [false, false, false], 'the reason goes away when a provider is added');
});

test('実行役の会話の上: どの実行役か・いまの許可の設定・beat の判定役が働かないことを出す。許可が読めないときは名前と判定役の説明だけ', async () => {
  serve({ ...bare(), runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true, permission: 'acceptEdits' }] });
  const c = (await render(createElement(RuntimeNote, { runtimeId: 'claude-code' }))).container;
  await settle(); await settle();
  const line = text(c.querySelector('[data-runtime-note]'));
  assert.match(line, /Claude Code · permission: /u);
  assert.match(line, new RegExp(String(en['ui.set.runtime.permLabel.acceptEdits']).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(line, /beat's judge does not act on this conversation/u);
  assert.match(line, /Pending/u);
  globalThis.fetch = (async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const failed = (await render(createElement(RuntimeNote, { runtimeId: 'codex' }))).container;
  await settle(); await settle();
  const bareLine = text(failed.querySelector('[data-runtime-note]'));
  assert.match(bareLine, /^codex · beat's judge does not act/u);
  assert.doesNotMatch(bareLine, /permission/u);
});

test('Settings の役の行・裏の作業・学習: 提供元のモデルが無いときだけ理由の行が出る', async () => {
  const props = (section: string) => ({ section, onClose: () => undefined, held: null, onReplay: () => undefined, onSaved: () => undefined, onProfile: () => undefined });
  serve(bare());
  const none = (await render(createElement(Settings, props('models')))).container;
  await settle(); await settle();
  assert.match(text(none.querySelector('[data-no-provider="roles"]')), /No provider model is set/u);
  const background = (await render(createElement(Settings, props('background')))).container;
  await settle(); await settle();
  assert.match(text(background.querySelector('[data-no-provider="background"]')), /background work, reviews and learning wait/u);
  const skills = (await render(createElement(Settings, props('skills')))).container;
  await settle(); await settle();
  assert.match(text(skills.querySelector('[data-no-provider="grow"]')), /Learning from conversations runs on a provider model/u);
  serve(withProvider());
  for (const section of ['models', 'background', 'skills']) {
    const some = (await render(createElement(Settings, props(section)))).container;
    await settle(); await settle();
    assert.equal(some.querySelector('[data-no-provider]'), null, `with a provider model nothing is shown (${section})`);
  }
});

test('辞書: 提供元が無いときの文は、日本語の説明にもある（英語のままにならない）', () => {
  for (const key of ['ui.np.build', 'ui.np.schedule', 'ui.np.scout', 'ui.np.research', 'ui.np.roles', 'ui.np.background', 'ui.np.grow', 'ui.np.short', 'ui.conv.runtimeText', 'ui.ob.model.runtimeNote', 'ui.ob.model.problem.runtimeModel', 'ui.ob.model.runtimeUntested'] as const) {
    assert.ok(typeof ja[key] === 'string' && (ja[key] as string).length > 0, key);
    assert.notEqual(ja[key], en[key], key);
  }
  for (const [name, dict] of [['en', en], ['ja', ja]] as const) {
    for (const key of ['ui.wait.noProvider', 'ui.np.build', 'ui.np.schedule', 'ui.np.scout', 'ui.np.research'] as const) {
      assert.doesNotMatch(String((dict as Json)[key]), /Settings › Providers/u, `${name} ${key}: Providers is a group inside Settings › Models`);
      assert.match(String((dict as Json)[key]), /Settings › Models › Providers/u, `${name} ${key}`);
    }
  }
  assert.doesNotMatch(String(ja['ui.conv.runtimeText']), /秘密|守っているファイル|製品の外/u, 'the Japanese text does not promise more than the English one (what is refused outside the product depends on a setting)');
  assert.doesNotMatch(String(en['ui.conv.runtimeText']), /secret|outside/iu);
});

// 動かないものの画面（Build・定期の仕事・考える役の空の欄・調べもの）。提供元が無いときだけ、押せない形か理由の文が出る

const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<{ productId: string; conversationId?: string; revision: string; taskRevision?: string; isGit: boolean }> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);
const { Schedule } = await loadTsx<{ Schedule: ComponentType<{ revision: number; projects: Project[] }> }>('../web/src/ui/screens/Schedule.tsx', import.meta.url);
const { ScoutEmpty } = await loadTsx<{ ScoutEmpty: ComponentType<{ state: Json; mode: string; now: number; onThinkNow: () => Promise<void> }> }>('../web/src/ui/panes/KanbanPane.tsx', import.meta.url);
const { ResearchSection } = await loadTsx<{ ResearchSection: ComponentType<{ productId: string; conversationId: string | undefined; revision: string }> }>('../web/src/ui/panes/ResearchSection.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const later = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

test('Build（計画の欄）: 提供元が無いときは Build のボタンが押せず、理由の文が出る。提供元が入ると押せる', async () => {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path).split('?')[0];
    if (url === `/api/projects/${PRODUCT}/plan`) return json(200, { plan: { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false } });
    if (url === `/api/projects/${PRODUCT}/acceptance`) return json(200, { acceptance: { version: 0, language: 'en', items: [], not_doing: [], draft: true, hash: 'ah', frozen: null }, coverage: { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 } });
    if (url === `/api/projects/${PRODUCT}/research`) return json(404, { error: 'not_found' });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  setNoProvider(true);
  const { container } = await render(createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision: '0', taskRevision: '0', isGit: true }));
  await later(); await later(); await later();
  const build = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => text(b) === 'Build with this plan');
  assert.ok(build(), 'the Build button is shown');
  assert.equal(build()!.disabled, true, 'but it cannot be pressed');
  assert.equal(text(container.querySelector('[data-no-provider="build"]')), en['ui.np.build']);
  await update(() => setNoProvider(false));
  assert.equal(build()!.disabled, false, 'a provider model turns it back on');
  assert.equal(container.querySelector('[data-no-provider="build"]'), null);
});

test('定期の仕事の画面: 提供元が無いときだけ、「待っている」理由の注意書きが出る', async () => {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    if (url === '/api/tasks') return json(200, { active: [], finished: [], awaiting: [], repeating: [] });
    if (url.startsWith('/api/schedule')) return json(200, { from: 0, to: 1, slots: [], templates: [], ranTruncated: false });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  setNoProvider(true);
  const { container } = await render(createElement(Schedule, { revision: 0, projects: [] }));
  await later(); await later(); await later();
  assert.ok(text(container).includes(String(en['ui.np.schedule'])), 'the reason is shown');
  await update(() => setNoProvider(false));
  assert.doesNotMatch(text(container), /Scheduled jobs need a provider model/u);
});

test('考える役の空の欄: 提供元が無いときは「モデルを選べ」ではなく「提供元が要る」と出て、Think now は押せない', async () => {
  const state = (s: string) => ({ state: s, examined: 0, area: null, lastChangeAt: null, note: null });
  const props = (s: string, mode: string) => ({ state: state(s), mode, now: 1, onThinkNow: async () => undefined });
  setNoProvider(true);
  const off = (await render(createElement(ScoutEmpty, props('off', 'research')))).container;
  assert.equal(text(off.querySelector('.ui-scout__meta')), en['ui.np.scout']);
  const idle = (await render(createElement(ScoutEmpty, props('idle', 'research')))).container;
  const think = button(idle, 'Think now')!;
  assert.equal(think.disabled, true);
  assert.equal(think.title, en['ui.np.scout']);
  setNoProvider(false);
  await cleanup();
  const normal = (await render(createElement(ScoutEmpty, props('off', 'research')))).container;
  assert.equal(text(normal.querySelector('.ui-scout__meta')), en['ui.scout.offMetaModel'], 'with a provider model the old text is kept');
  const ready = (await render(createElement(ScoutEmpty, props('idle', 'research')))).container;
  assert.equal(button(ready, 'Think now')!.disabled, false);
});

test('調べもの: 提供元が無いときは Start が押せず、理由の文が出る。ある（または調べを始められない）ときは今までどおり', async () => {
  const view = { settings: { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] }, products: null, libraries: null, suggestedCheck: null };
  globalThis.fetch = (async () => json(200, view)) as typeof fetch;
  setNoProvider(true);
  const { container } = await render(createElement(ResearchSection, { productId: PRODUCT, conversationId: CHAT, revision: '0' }));
  await later(); await later(); await later();
  const start = [...container.querySelectorAll<HTMLButtonElement>('.ui-rs__start button')].find(b => text(b) === en['ui.rs.start']);
  assert.ok(start, 'the Start button stays visible');
  assert.equal(start!.disabled, true);
  assert.equal(text(container.querySelector('[data-no-provider="research"]')), en['ui.np.research']);
  await update(() => setNoProvider(false));
  const live = [...container.querySelectorAll<HTMLButtonElement>('.ui-rs__start button')].find(b => text(b) === en['ui.rs.start']);
  assert.equal(live!.disabled, false);
  assert.equal(container.querySelector('[data-no-provider="research"]'), null);
});

const { Conversation } = await loadTsx<{ Conversation: ComponentType<Json> }>('../web/src/ui/Conversation.tsx', import.meta.url);

test('会話の画面: 実行役の会話には上に注意書き（実行役の名前・許可・判定役が働かないこと）が出て、beat のモデルの会話には出ない', async () => {
  const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
  const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  try {
    for (const runtimeId of ['claude-code', null]) {
      globalThis.fetch = (async (path: string | URL | Request) => {
        const url = String(path);
        if (url === `/api/conversations/${CHAT}/messages`) return json(200, { conversation: { id: CHAT, title: 'Parser', created_at: 0, last_message_at: 0, permission_mode: 'auto', runtime_id: runtimeId }, messages: [{ id: 1, role: 'user', text: 'hi', runId: 'r1', createdAt: 10 }], pending: [], builds: [], activeRun: null });
        if (url === `/api/conversations/${CHAT}/checklist`) return json(200, { items: [], tainted: false, updatedAt: null });
        if (url === '/api/models') return json(200, { models: [], routing: { chat: [] } });
        if (url === '/api/runtimes') return json(200, { runtimes: [{ id: 'claude-code', kind: 'claude-code', configured: true, enabled: true, permission: 'default', permissions: ['default', 'acceptEdits'], check: null, models: null }] });
        return json(404, { error: 'not_found' });
      }) as typeof fetch;
      const { container } = await render(createElement(Conversation, { id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {} }));
      await later(); await later(); await later();
      const note = container.querySelector('[data-runtime-note]');
      if (runtimeId === null) assert.equal(note, null, 'a conversation on a beat model has no runtime note');
      else {
        assert.ok(note, 'a runtime conversation shows the note');
        assert.match(text(note), /Claude Code · permission: /u);
        assert.match(text(note), /beat's judge does not act on this conversation/u);
      }
      await cleanup();
    }
  } finally {
    g.matchMedia = real.matchMedia;
    g.ResizeObserver = real.ResizeObserver;
  }
});
