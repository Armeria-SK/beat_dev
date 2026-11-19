import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { toolText } from '../src/shared/messages/tools.ts';
import type { ChecklistItem } from '../web/src/api.ts';
import type { LiveDraft, RunNotice } from '../web/src/ui/live-state.ts';

// 会話のお知らせは起きた位置に入って話とともに上へ流れ、最後の発言の下に貼り付かない。断られた道具は道具の行の中だけに理由を出し、AI に向けた一文は出さない。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: LiveDraft | undefined; notices: RunNotice[]; liveChecklist: ChecklistItem[] | undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000002';
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

const DENIED = toolText('en', 'pipeline.denied', { reasons: 'This is outside the allowed folders: D:/elsewhere' });

async function renderChat(notices: RunNotice[]) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const out = url === `/api/conversations/${CHAT}/messages` ? {
      conversation: { id: CHAT, title: 'Search', created_at: 0, last_message_at: 0, permission_mode: 'auto' },
      messages: [
        { id: 1, role: 'user', text: 'find three.module', runId: 'r1', createdAt: 10 },
        { id: 2, role: 'assistant', text: '', runId: 'r1', createdAt: 11, toolCalls: [{ id: 'k', name: 'file_search', input: JSON.stringify({ name: 'three.module*.js', path: 'D:/elsewhere' }) }] },
        { id: 3, role: 'tool', text: DENIED, runId: 'r1', createdAt: 12, toolName: 'file_search', toolCallId: 'k', isError: true },
        { id: 4, role: 'assistant', text: 'First answer.', runId: 'r1', createdAt: 13 },
        { id: 5, role: 'user', text: 'and next?', runId: 'r2', createdAt: 20 },
        { id: 6, role: 'assistant', text: 'Second answer.', runId: 'r2', createdAt: 21 },
      ],
      pending: [], builds: [], activeRun: null,
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

const shape = (container: HTMLElement): string[] => [...container.querySelector('.bt-thread')!.children].map(el => {
  if (el.classList.contains('bt-tools')) return 'tools';
  if (el.classList.contains('bt-msg--owner') || el.querySelector('.bt-msg--owner')) return `owner:${el.textContent!.trim()}`;
  if (el.classList.contains('bt-notice')) return `notice:${el.textContent!.trim()}`;
  if (el.classList.contains('ui-reply') || el.querySelector('.ui-reply')) return 'reply';
  return el.className;
}).filter(s => !/^bt-msg bt-meta|^$/u.test(s));

test('ui/Conversation（DOM）: 要約・context の知らせは起きた位置（その発言の後）に出て、あとの発言はその下に続く。最後の返事の下に貼り付かない', async () => {
  const container = await renderChat([
    { runId: 'r1', kind: 'compaction', summarized: 3, after: 1 },
    { runId: 'r2', kind: 'warning', code: 'context_trimmed', message: 'trimmed', params: { count: 2 }, after: 5 },
  ]);
  const rows = shape(container);
  const at = (prefix: string) => rows.findIndex(r => r.startsWith(prefix));
  assert.ok(at('owner:find three.module') < at('notice:') && at('notice:') < at('tools'), `要約の知らせは最初の発言のすぐ後: ${rows.join(' / ')}`);
  const trimmed = rows.findIndex((r, i) => i > at('owner:and next?') && r.startsWith('notice:'));
  assert.ok(trimmed > at('owner:and next?') && trimmed < rows.lastIndexOf('reply'), `context の知らせは 2 つ目の発言と 2 つ目の返事の間: ${rows.join(' / ')}`);
  assert.equal(rows.at(-1), 'reply', '会話の最後は返事（お知らせが下に残らない）');
});

test('ui/Conversation（DOM）: 「許したフォルダの外」で断られた道具は、道具の行の中だけに理由を出し、AI に向けた一文（Think of another way…）は画面に出さない', async () => {
  const container = await renderChat([]);
  const thread = container.querySelector('.bt-thread')!;
  assert.equal(thread.querySelectorAll(':scope > .bt-notice').length, 0, '会話に別の警告の行は無い');
  const out = thread.querySelector('.bt-tool .ui-tool__out')!;
  assert.match(out.textContent!, /^Not run \(denied\):\n- This is outside the allowed folders: D:\/elsewhere$/u);
  assert.doesNotMatch(thread.textContent!, /Think of another way/u);
});
