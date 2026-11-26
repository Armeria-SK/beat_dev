import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import type { ModelChoice, ModelView, PendingMessage, UploadView } from '../web/src/api.ts';
import { composerDrafts, type RuntimeUse, type SlashContext, type SubmitKind } from '../web/src/ui/composer-state.ts';
import { cleanup, loadTsx, render } from './helpers/dom.ts';

// The model name the picker shows next to "auto" is the model the engine would use: the first usable one of the conversation list,
// and for a runtime model first in the list only where a runtime may be used (a fresh product conversation).

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

const ok = (id: string) => ({ modelId: id, status: 'ok', server: 's', required: 0, message: '', checkedAt: 0 });
const view = (id: string, over: Partial<ModelView>): ModelView => ({ id, label: id, provider: 'p', runtime: null, model: id, inChat: true, limits: { context: null, maxOutput: null, required: null }, efforts: [], probe: ok(id), cooldown: null, recentFailures: 0, ...over } as ModelView);
const MODELS = [view('api', { model: 'claude-opus-5-5' }), view('cc', { provider: '', runtime: 'claude-code', model: 'opus' })];

async function mount(over: Partial<ComposerProps>) {
  g.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props: ComposerProps = {
    draftKey: KEY, hasConversation: false, running: false, sending: false, pending: [], models: MODELS, chatOrder: ['cc', 'api'], modelId: null, effort: null, mode: 'auto',
    slash: { hasConversation: false, running: false, hasSummary: false, archived: false },
    onSubmit: async () => true, onStop: () => {}, onChoose: () => {}, onCancelPending: () => {}, onSlash: () => {}, onAttachFailed: () => {}, ...over,
  };
  const { container } = await render(createElement(Composer, props));
  return {
    label: container.querySelector<HTMLButtonElement>('button.bt-select')!.textContent!.trim(),
    field: container.querySelector<HTMLTextAreaElement>('textarea.bt-composer__input')!,
  };
}

test('the model name beside "auto": a runtime model first in the list shows in a fresh product conversation, and the usable provider model shows outside a product', async () => {
  const product = await mount({ product: true, runtime: { bound: null, allowed: true } });
  assert.equal(product.label, 'auto · opus');
  await cleanup();
  const plain = await mount({ runtime: { bound: null, allowed: false } });
  assert.equal(plain.label, 'auto · claude-opus-5-5', 'outside a product the engine falls through to the provider chain, so the screen names the first usable provider model');
});

test('the model name beside "auto" when the conversation list is auto: the server sends every provider model, the composer is open and names the first', async () => {
  const shown = await mount({ models: [MODELS[0]!], chatOrder: ['api'], runtime: { bound: null, allowed: true } });
  assert.equal(shown.label, 'auto · claude-opus-5-5');
  assert.equal(shown.field.disabled, false);
});
