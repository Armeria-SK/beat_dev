import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChecklistItem } from '../web/src/api.ts';
import type { LiveDraft, RunNotice } from '../web/src/ui/live-state.ts';
import { cleanup, loadTsx, render, update } from './helpers/dom.ts';

// 失敗のあとに送った発言を、返事が保存される前に Stop したら、古い失敗に Retry などのボタンをまた付けない。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: LiveDraft | undefined; notices: RunNotice[]; liveChecklist: ChecklistItem[] | undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: (id: string, runId?: string) => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
});

async function renderChat(notices: RunNotice[], messages: unknown[]) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const out = url === `/api/conversations/${CHAT}/messages` ? {
      conversation: { id: CHAT, title: 'Chat', created_at: 0, last_message_at: 0, permission_mode: 'auto' }, messages, pending: [], builds: [], activeRun: null,
    } : url === `/api/conversations/${CHAT}/checklist` ? { items: [], tainted: false, updatedAt: null } : url === '/api/models' ? { models: [], routing: { chat: [] } } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { container } = await render(createElement(Conversation, {
    id: CHAT, listTitle: null, draft: undefined, notices, liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {},
  }));
  await settle();
  await settle();
  return container;
}

const retries = (container: HTMLElement) => [...container.querySelectorAll('.bt-thread button')].filter(b => b.textContent === 'Retry');

test('bl-ui-conversation/retry: 失敗のあとに送った発言を返事の保存前に Stop すると、古い失敗に Retry を付けない', async () => {
  const container = await renderChat([
    { runId: 'r1', kind: 'error', errorKind: 'timeout', errorMessage: 'first failure', after: 1 },
    { runId: 'r2', kind: 'stopped', after: 2 },
  ], [
    { id: 1, role: 'user', text: 'first try', runId: null, createdAt: 10 },
    { id: 2, role: 'user', text: 'second try', runId: null, createdAt: 20 },
  ]);
  assert.match(container.textContent ?? '', /first failure/u, '失敗の文は残す');
  assert.equal(retries(container).length, 0, 'Stop した新しい実行があるので、古い失敗は押せるものを持たない');
});

test('bl-ui-conversation/retry: 失敗のあとに Stop が無ければ、Retry は今までどおりその失敗に付く', async () => {
  const container = await renderChat([
    { runId: 'r1', kind: 'error', errorKind: 'timeout', errorMessage: 'failure', after: 1 },
  ], [
    { id: 1, role: 'user', text: 'first try', runId: null, createdAt: 10 },
  ]);
  assert.equal(retries(container).length, 1);
});

test('bl-ui-conversation/retry: 失敗より前に Stop した実行があっても、その失敗には Retry が付く（あとの Stop だけが古くする）', async () => {
  const container = await renderChat([
    { runId: 'r0', kind: 'stopped', after: 1 },
    { runId: 'r1', kind: 'error', errorKind: 'timeout', errorMessage: 'failure', after: 2 },
  ], [
    { id: 1, role: 'user', text: 'first try', runId: null, createdAt: 10 },
    { id: 2, role: 'user', text: 'second try', runId: null, createdAt: 20 },
  ]);
  assert.equal(retries(container).length, 1);
});
