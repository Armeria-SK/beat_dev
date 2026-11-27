import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import type { ModelChoice, ModelView, PendingMessage, UploadView } from '../web/src/api.ts';
import { composerDrafts, type RuntimeUse, type SlashContext, type SubmitKind } from '../web/src/ui/composer-state.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { cleanup, loadTsx, render } from './helpers/dom.ts';
import { rig } from './helpers/runtime-rig.ts';

// The model name the picker shows next to "auto" is the model the engine would use: the first usable one of the conversation list,
// and for a runtime model first in the list only where a runtime may be used (a fresh product conversation).
// The models and the order the composer gets are what the real server sends for GET /api/models, not a shape written by hand.

interface ComposerProps {
  draftKey: string; hasConversation: boolean; product?: boolean; running: boolean; sending: boolean; pending: PendingMessage[]; models: ModelView[] | null; chatOrder: string[]; modelId: string | null; effort: string | null; mode: PermissionMode; runtime?: RuntimeUse; slash: SlashContext;
  onSubmit: (kind: SubmitKind, text: string, attachments: UploadView[]) => Promise<boolean>; onStop: () => void; onChoose: (choice: ModelChoice) => void; onCancelPending: (id: string) => void; onSlash: () => void; onAttachFailed: (error: unknown) => void;
}

const { Composer } = await loadTsx<{ Composer: ComponentType<ComposerProps> }>('../web/src/ui/Composer.tsx', import.meta.url);

const KEY = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };

afterEach(async () => {
  await cleanup();
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  composerDrafts.forget(KEY);
});

type Served = { models: ModelView[]; chatOrder: string[] };
type Start = Awaited<ReturnType<typeof startApp>>;
const serve = async (s: Start): Promise<Served> => (await s.json('/api/models', 'GET')).body as Served;

async function mount(served: Served, over: Partial<ComposerProps>) {
  g.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props: ComposerProps = {
    draftKey: KEY, hasConversation: false, running: false, sending: false, pending: [], models: served.models, chatOrder: served.chatOrder, modelId: null, effort: null, mode: 'auto',
    slash: { hasConversation: false, running: false, hasSummary: false, archived: false },
    onSubmit: async () => true, onStop: () => {}, onChoose: () => {}, onCancelPending: () => {}, onSlash: () => {}, onAttachFailed: () => {}, ...over,
  };
  const { container } = await render(createElement(Composer, props));
  return {
    label: container.querySelector<HTMLButtonElement>('button.bt-select')!.textContent!.trim(),
    field: container.querySelector<HTMLTextAreaElement>('textarea.bt-composer__input')!,
  };
}

test('the model name beside "auto": a runtime model first in the list shows in a fresh product conversation, and the usable provider model shows outside a product', async t => {
  const r = await rig(t);
  await r.check();
  const served = await serve(r.s);
  assert.deepEqual(served.chatOrder, ['cc', 'm1'], 'the server sends the list with the runtime model first');
  const product = await mount(served, { product: true, runtime: { bound: null, allowed: true } });
  assert.equal(product.label, 'auto · sonnet');
  await cleanup();
  const plain = await mount(served, { runtime: { bound: null, allowed: false } });
  assert.equal(plain.label, 'auto · m1-name', 'outside a product the engine falls through to the provider chain, so the screen names the first usable provider model');
  assert.equal(r.s.app.engine.effortChoices(null, null, false).modelId, 'm1', 'and that is the model the engine uses there');
});

test('the model name beside "auto" when the conversation list is auto: the server sends every provider model, the composer is open and names the first', async t => {
  const s = await startApp(t, {
    models: [fakeModel('m1')],
    configure: config => {
      config.runtimes = [{ id: 'cc', kind: 'claude-code', enabled: true }];
      config.models.push({ id: 'rt1', runtime: 'cc', model: 'opus', vision: false });
      config.routing.chat = [];
    },
  });
  assert.deepEqual(s.app.config().routing.chat, [], 'the stored list is empty (auto)');
  const served = await serve(s);
  assert.deepEqual(served.chatOrder, ['m1'], 'the server sends the list the engine uses: the provider model, not the runtime model');
  const shown = await mount(served, { runtime: { bound: null, allowed: true } });
  assert.equal(shown.label, 'auto · m1-name');
  assert.equal(shown.field.disabled, false);
});

test('the model name beside "auto" when the first runtime of the list is switched off: the screen names the provider model behind it, as the engine does', async t => {
  const s = await startApp(t, {
    models: [fakeModel('m1'), { id: 'rt1', runtime: 'cc', model: 'opus', vision: false }],
    configure: config => { config.runtimes = [{ id: 'cc', kind: 'claude-code', enabled: false }]; config.routing.chat = ['rt1', 'm1']; },
  });
  const served = await serve(s);
  assert.deepEqual(served.chatOrder, ['m1'], 'the switched-off runtime is not in the order the server sends');
  const product = await mount(served, { product: true, runtime: { bound: null, allowed: true } });
  assert.equal(product.label, 'auto · m1-name');
  assert.equal(s.app.engine.effortChoices(null, null, true).modelId, 'm1', 'and that is where the engine sends the first message');

  s.adapter().probeResult = { status: 'unreachable', message: 'offline' };
  await s.app.status.probeAll(s.app.config());
  await cleanup();
  const offline = await mount(await serve(s), { product: true, runtime: { bound: null, allowed: true } });
  const named = s.app.engine.effortChoices(null, null, true).modelId;
  assert.equal(named, 'm1', 'with nothing usable the engine names the first model of its order, not the switched-off runtime');
  assert.equal(offline.label, `auto · ${s.app.config().models.find(m => m.id === named)!.model}`, 'the composer shows the same model');
});
