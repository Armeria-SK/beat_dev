import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import type { ModelChoice, PendingMessage, UploadView } from '../web/src/api.ts';
import { composerDrafts, createDrafts, type SlashContext, type SubmitKind } from '../web/src/ui/composer-state.ts';
import { cleanup, loadTsx, render, update } from './helpers/dom.ts';

// 添付の送り上げ中に会話が消えたら、消えた会話の書きかけ（添付）をメモリに残さない。消した ID を覚えて断る作りにはしない（覚えるのは、送り上げの最中のものだけ）。

interface ComposerProps {
  draftKey: string; hasConversation: boolean; running: boolean; sending: boolean; pending: PendingMessage[]; models: null; chatOrder: string[]; modelId: string | null; effort: string | null; mode: PermissionMode; slash: SlashContext;
  onSubmit: (kind: SubmitKind, text: string, attachments: UploadView[]) => Promise<boolean>; onStop: () => void; onChoose: (choice: ModelChoice) => void; onCancelPending: (id: string) => void; onSlash: () => void; onAttachFailed: (error: unknown) => void;
}

const { Composer } = await loadTsx<{ Composer: ComponentType<ComposerProps> }>('../web/src/ui/Composer.tsx', import.meta.url);

const KEY = 'aaaaaaaa-0000-4000-8000-0000000000c3';
const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000c4';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const upload = (name: string): UploadView => ({ id: `u-${name}`, name, mime: 'text/plain', kind: 'text', size: 3, chars: 3, pages: null });

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  composerDrafts.forget(KEY);
  composerDrafts.forget(OTHER);
});

// 送り上げは、こちらが返事を出すまで終わらない。pending に出た順で出せる。
function mountComposer(draftKey: string) {
  const pending: Array<{ name: string; finish: () => void }> = [];
  globalThis.fetch = ((path: string | URL | Request) => {
    const name = new URL(String(path), 'http://localhost').searchParams.get('name') ?? '';
    return new Promise<Response>(resolve => {
      pending.push({ name, finish: () => resolve(new Response(JSON.stringify({ upload: upload(name) }), { status: 200, headers: { 'Content-Type': 'application/json' } })) });
    });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props: ComposerProps = {
    draftKey, hasConversation: true, running: false, sending: false, pending: [], models: null, chatOrder: [], modelId: null, effort: null, mode: 'auto',
    slash: { hasConversation: true, running: false, hasSummary: false, archived: false },
    onSubmit: async () => true, onStop: () => {}, onChoose: () => {}, onCancelPending: () => {}, onSlash: () => {}, onAttachFailed: () => {},
  };
  const mounted = render(createElement(Composer, props));
  return {
    mounted, pending,
    async pick(container: HTMLElement, ...names: string[]) {
      const field = container.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(field, 'files', { configurable: true, value: names.map(name => new window.File(['abc'], name, { type: 'text/plain' })) });
      await update(() => { field.dispatchEvent(new window.Event('change', { bubbles: true })); });
      await settle();
    },
  };
}

test('bl-ui-conversation/drafts: 送り上げの最中に会話が消えたら（forget）、あとから届いた添付を、消えた会話の書きかけとして残さない', async () => {
  const rig = mountComposer(KEY);
  const { container } = await rig.mounted;
  await rig.pick(container, 'a.txt');
  assert.equal(rig.pending.length, 1, '送り上げが始まった');
  composerDrafts.forget(KEY);
  rig.pending[0]!.finish();
  await settle();
  await settle();
  assert.deepEqual(composerDrafts.files(KEY), [], '消えた会話の書きかけに添付が残らない');
});

test('bl-ui-conversation/drafts: 会話が消えたあとは、複数の添付の残りの送り上げもしない', async () => {
  const rig = mountComposer(KEY);
  const { container } = await rig.mounted;
  await rig.pick(container, 'a.txt', 'b.txt');
  composerDrafts.forget(KEY);
  rig.pending[0]!.finish();
  await settle();
  await settle();
  assert.equal(rig.pending.length, 1, '2 つ目の添付は送り上げに出さない');
  assert.deepEqual(composerDrafts.files(KEY), []);
});

test('bl-ui-conversation/drafts: 別の会話が消えても、送り上げ中の添付は書きかけに残る。画面を離れて（外れて）から届いた分も、消えていなければ書きかけに残る', async () => {
  const rig = mountComposer(KEY);
  const { container } = await rig.mounted;
  await rig.pick(container, 'a.txt', 'b.txt');
  composerDrafts.forget(OTHER);
  rig.pending[0]!.finish();
  await settle();
  await settle();
  assert.deepEqual(composerDrafts.files(KEY).map(f => f.name), ['a.txt']);
  await cleanup();
  rig.pending[1]!.finish();
  await settle();
  await settle();
  assert.deepEqual(composerDrafts.files(KEY).map(f => f.name), ['a.txt', 'b.txt'], '外れたあとに届いた分も、戻ってきたとき見える書きかけに入る');
});

test('bl-ui-conversation/drafts: 書きかけの入れ物は、送り上げが終われば何も覚えていない（消した ID を溜めない）', () => {
  const drafts = createDrafts();
  const done = drafts.claim('c1');
  assert.equal(done.live(), true);
  done.release();
  drafts.forget('c1');
  assert.equal(done.live(), true, '終えた送り上げは、あとの forget の影響を受けない（何も覚えていない）');
  const held = drafts.claim('c1');
  const other = drafts.claim('c2');
  drafts.forget('c1');
  assert.deepEqual([held.live(), other.live()], [false, true], 'forget は同じ会話の送り上げだけ止める');
  held.release();
  other.release();
  const fresh = drafts.claim('c1');
  assert.equal(fresh.live(), true, '消えたあとに同じ ID で始めた送り上げは生きている');
});
