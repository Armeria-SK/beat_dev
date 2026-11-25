import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChecklistItem } from '../web/src/api.ts';
import type { LiveDraft, RunNotice } from '../web/src/ui/live-state.ts';
import { cleanup, loadTsx, render, update } from './helpers/dom.ts';

// 会話は、経路の発言の番号（#/c/<id>/m/<発言>）があれば、開いたとき・同じ会話のままハッシュだけ替わったときに、その発言まで飛ぶ。
// 飛んだあとは、読み直しや新しい発言で下へ引き戻さない。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: LiveDraft | undefined; notices: RunNotice[]; liveChecklist: ChecklistItem[] | undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: (id: string, runId?: string) => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
const proto = window.Element.prototype as unknown as { scrollIntoView?: ((this: Element, options?: unknown) => void) | undefined };
const realScroll = proto.scrollIntoView;
let scrolled: string[] = [];
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 20)));

const MESSAGES = [
  { id: 1, role: 'user', text: 'first question', runId: null, createdAt: 10 },
  { id: 2, role: 'assistant', text: 'first answer', runId: 'r1', createdAt: 11 },
  { id: 3, role: 'user', text: 'second question', runId: null, createdAt: 20 },
  { id: 4, role: 'assistant', text: '', runId: 'r2', createdAt: 21, toolCalls: [{ id: 'k', name: 'file_search', input: '{}' }] },
  { id: 5, role: 'tool', text: 'found nothing', runId: 'r2', createdAt: 22, toolName: 'file_search', toolCallId: 'k', isError: false },
  { id: 6, role: 'assistant', text: 'second answer', runId: 'r2', createdAt: 23 },
];

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  proto.scrollIntoView = realScroll;
  window.location.hash = '';
  scrolled = [];
});

async function renderChat(hash: string, revision = 0) {
  window.location.hash = hash;
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const out = url === `/api/conversations/${CHAT}/messages` ? {
      conversation: { id: CHAT, title: 'Chat', created_at: 0, last_message_at: 0, permission_mode: 'auto' }, messages: MESSAGES, pending: [], builds: [], activeRun: null,
    } : url === `/api/conversations/${CHAT}/checklist` ? { items: [], tainted: false, updatedAt: null } : url === '/api/models' ? { models: [], routing: { chat: [] } } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  proto.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.getAttribute('data-msg') ?? ''); };
  const props = (rev: number): ConversationProps => ({ id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: rev, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {} });
  const { container, root } = await render(createElement(Conversation, props(revision)));
  await settle();
  await settle();
  const rerender = async (rev: number) => { await update(() => root.render(createElement(Conversation, props(rev)))); await settle(); await settle(); };
  return { container, rerender };
}

const hashTo = async (hash: string) => { window.location.hash = hash; await settle(); await settle(); };

test('bl-ui-conversation/jump: #/c/<id>/m/<発言> で開くと、その発言まで飛ぶ', async () => {
  await renderChat(`#/c/${CHAT}/m/3`);
  assert.deepEqual(scrolled, ['3'], 'その発言の 1 つだけを画面の真ん中へ');
});

test('bl-ui-conversation/jump: 発言の印が無い経路では飛ばない（下に貼り付いたまま）', async () => {
  await renderChat(`#/c/${CHAT}`);
  assert.deepEqual(scrolled, []);
});

test('bl-ui-conversation/jump: 同じ会話を開いたまま経路の発言だけ替わっても飛ぶ。続けて別の発言へも飛べる', async () => {
  await renderChat(`#/c/${CHAT}`);
  assert.deepEqual(scrolled, []);
  await hashTo(`#/c/${CHAT}/m/1`);
  assert.deepEqual(scrolled, ['1']);
  await hashTo(`#/c/${CHAT}/m/6`);
  assert.deepEqual(scrolled, ['1', '6']);
});

test('bl-ui-conversation/jump: 道具の行などで表に出ていない発言は、その前でいちばん近い発言へ飛ぶ。会話に無い番号は飛ばない', async () => {
  await renderChat(`#/c/${CHAT}/m/5`);
  assert.deepEqual(scrolled, ['3'], '5 番は道具の結果。前の表に出ている発言は 3 番');
  await hashTo(`#/c/${CHAT}/m/999`);
  assert.deepEqual(scrolled, ['3'], '読み込んだ最後の発言より先の番号は、まだ無い発言なので動かない');
  await hashTo(`#/c/${CHAT}/m/0`);
  assert.deepEqual(scrolled, ['3'], '0 番は発言の印として読まない');
});

function watchBottom(container: HTMLElement): number[] {
  const thread = container.querySelector('.bt-thread') as HTMLElement;
  const writes: number[] = [];
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(thread, 'scrollTop', { configurable: true, get: () => 0, set: (value: number) => { writes.push(value); } });
  return writes;
}

test('bl-ui-conversation/jump: 飛んだあと、読み直し（revision の更新）で同じ発言へ飛び直さず、下へ引き戻さない', async () => {
  const { container, rerender } = await renderChat(`#/c/${CHAT}/m/3`);
  assert.equal(scrolled.length, 1);
  const writes = watchBottom(container);
  await rerender(1);
  await rerender(2);
  assert.equal(scrolled.length, 1, '読み直しで飛び直さない');
  assert.deepEqual(writes, [], '読み直しで下へ引き戻さない');
});

test('bl-ui-conversation/jump: 発言の印が無ければ、読み直しのたびに今までどおり下へ貼り付く（上の「引き戻さない」を確かめる物差し）', async () => {
  const { container, rerender } = await renderChat(`#/c/${CHAT}`);
  const writes = watchBottom(container);
  await rerender(1);
  assert.ok(writes.includes(1000), `下へ貼り付く: ${writes.join(',')}`);
});

test('bl-ui-conversation/jump: 別の会話の印には飛ばない', async () => {
  await renderChat('#/c/someone-else/m/3');
  assert.deepEqual(scrolled, []);
});

test('bl-ui-conversation/jump: 設定などの別の画面を挟んで同じ印の経路に戻っても、飛び直さない（自分で動かした位置を奪わない）', async () => {
  await renderChat(`#/c/${CHAT}/m/3`);
  assert.deepEqual(scrolled, ['3']);
  await hashTo('#/settings');
  await hashTo(`#/c/${CHAT}/m/3`);
  assert.deepEqual(scrolled, ['3'], '設定を開いて閉じただけでは飛び直さない');
  await hashTo('#/kanban');
  await hashTo(`#/c/${CHAT}/m/3`);
  assert.deepEqual(scrolled, ['3'], 'ほかの画面を挟んでも飛び直さない');
});

test('bl-ui-conversation/jump: 同じ会話の印の無い経路を挟んだあとなら、同じ印へまた飛べる（飛び直しを止める記録は、その会話の印の無い経路で消える）', async () => {
  await renderChat(`#/c/${CHAT}/m/3`);
  await hashTo(`#/c/${CHAT}`);
  await hashTo(`#/c/${CHAT}/m/3`);
  assert.deepEqual(scrolled, ['3', '3']);
});
