import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChecklistItem, Message } from '../web/src/api.ts';
import { ANSWER_GUARD_MS } from '../web/src/ui/ask.ts';
import type { LiveDraft } from '../web/src/ui/live-state.ts';

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: LiveDraft | undefined; notices: never[]; liveChecklist: ChecklistItem[] | undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
let sent: Array<{ path: string; body: any }> = [];

const INPUT = {
  questions: [
    { question: 'Which storage should the app use?', header: 'Storage', options: [{ label: 'SQLite (Recommended)', description: 'One file next to the app' }, { label: 'JSON files' }] },
    { question: 'Which screens come first?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }] },
  ],
};
const HISTORY: Message[] = [
  { id: 1, role: 'user', text: 'build me an app', runId: 'r1', createdAt: 10 },
  { id: 2, role: 'assistant', text: '', runId: 'r1', createdAt: 20, toolCalls: [{ id: 'c1', name: 'ask_owner', input: JSON.stringify(INPUT) }] },
  { id: 3, role: 'tool', text: 'The owner sees 2 question(s) as a card.', runId: 'r1', createdAt: 21, toolName: 'ask_owner', toolCallId: 'c1', isError: false },
];

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  sent = [];
  window.location.hash = '';
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

async function renderChat(options: { messages?: Message[]; draft?: LiveDraft; helper?: boolean } = {}) {
  let messages = options.messages ?? HISTORY;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(path);
    let out: unknown;
    if (method === 'POST' && url === `/api/conversations/${CHAT}/messages`) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sent.push({ path: url, body });
      messages = [...messages, { id: messages.length + 1, role: 'user', text: body.text, runId: 'r2', createdAt: 99 }];
      out = { runId: 'r2', queued: false };
    } else if (url === `/api/conversations/${CHAT}/messages`) {
      out = { conversation: { id: CHAT, title: 'App', created_at: 0, last_message_at: 0, permission_mode: 'plan', ...(options.helper ? { parent_run_id: 'r0' } : {}) }, messages, pending: [], builds: [] };
    } else if (url === `/api/conversations/${CHAT}/checklist`) out = { items: [], tainted: false, updatedAt: null };
    else if (url === '/api/models') out = { models: [], routing: { chat: [] } };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props = (revision: number, draft: LiveDraft | undefined): ConversationProps => ({
    id: CHAT, listTitle: null, draft, notices: [], liveChecklist: undefined, revision, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {},
  });
  const { container, root } = await render(createElement(Conversation, props(0, options.draft)));
  await settle();
  await settle();
  const rerender = async (revision: number, draft?: LiveDraft) => { await update(() => root.render(createElement(Conversation, props(revision, draft)))); await settle(); await settle(); };
  return { container, rerender };
}

const card = (c: HTMLElement) => c.querySelector<HTMLElement>('.ui-ask');
const choice = (c: HTMLElement, label: string) => byText(c, '.ui-ask .bt-choice', label)?.querySelector('input') ?? [...c.querySelectorAll<HTMLElement>('.ui-ask .bt-choice')].find(el => el.textContent?.startsWith(label))?.querySelector('input');
const answerButton = (c: HTMLElement) => byText(c, '.ui-ask .bt-btn', 'Answer') as HTMLButtonElement | undefined;
const nextButton = (c: HTMLElement) => byText(c, '.ui-ask .bt-btn', 'Next') as HTMLButtonElement | undefined;

test('ui/ask-dom: the card is docked above the composer, one question at a time, with chips, descriptions and Something else; nothing preselected', async () => {
  const { container } = await renderChat();
  const ask = card(container);
  assert.ok(ask, 'card shown');
  assert.ok(ask.compareDocumentPosition(container.querySelector('.bt-composer')!) & 4, 'composer follows the card');
  assert.ok(!container.querySelector('.bt-thread .ui-ask'), 'not inside the thread');
  const questions = () => [...ask.querySelectorAll('.bt-question__q')].map(h => h.textContent);
  const chips = () => [...ask.querySelectorAll('.ui-ask__header')].map(h => h.textContent);
  assert.deepEqual(questions(), ['Which storage should the app use?'], 'only the first question is shown');
  assert.deepEqual(chips(), ['Storage']);
  assert.ok(ask.textContent!.includes('One file next to the app'));
  assert.equal(ask.querySelectorAll('.bt-choice').length, 3, 'two options + Something else');
  assert.equal(ask.querySelectorAll('input[type=radio]').length, 3);
  assert.equal(ask.querySelectorAll('input[type=checkbox]').length, 0);
  assert.equal(ask.querySelectorAll('input:checked').length, 0);
  assert.equal(answerButton(container), undefined, 'no Answer button before the last question');
  assert.equal(nextButton(container)?.disabled, true);
  await click(choice(container, 'SQLite (Recommended)'));
  await click(nextButton(container));
  assert.deepEqual(questions(), ['Which screens come first?'], 'the second question replaces the first');
  assert.deepEqual(chips(), ['Screens']);
  assert.equal(ask.querySelectorAll('.bt-choice').length, 3);
  assert.equal(ask.querySelectorAll('input[type=checkbox]').length, 3, 'multiSelect uses checkboxes');
  assert.equal(ask.querySelectorAll('input:checked').length, 0);
  assert.equal(answerButton(container)?.disabled, true);
});

test('ui/ask-dom: Answer is enabled only when every question has a pick; Something else needs text; it sends the composed answer through the send path, and the card closes', async () => {
  const { container } = await renderChat();
  assert.equal(nextButton(container)?.disabled, true, 'first question open');
  await click(choice(container, 'SQLite (Recommended)'));
  assert.equal(nextButton(container)?.disabled, false);
  await click(nextButton(container));
  assert.equal(answerButton(container)?.disabled, true, 'second question open');
  await click(choice(container, 'List'));
  await click(choice(container, 'Detail'));
  assert.equal(answerButton(container)?.disabled, false);
  const others = [...container.querySelectorAll<HTMLElement>('.ui-ask .bt-choice')].filter(el => el.textContent === 'Something else');
  assert.equal(others.length, 1, 'only the open question shows its Something else');
  await click(others[0]!.querySelector('input'));
  assert.ok(container.querySelector('.ui-ask__other'), 'the text field appears');
  assert.equal(answerButton(container)?.disabled, true, 'empty Something else');
  await input(container.querySelector('.ui-ask__other'), 'A map view');
  assert.equal(answerButton(container)?.disabled, false);
  // 問いが替わってすぐの Answer は受けない（ダブルクリック・ダブルタップで送らないため）。待たずに、時計だけ進める。
  const realNow = performance.now.bind(performance);
  const later = mock.method(performance, 'now', () => realNow() + ANSWER_GUARD_MS);
  try { await click(answerButton(container)); } finally { later.mock.restore(); }
  await settle();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.text, 'Answers:\n- Storage: SQLite (Recommended)\n- Screens: List, Detail, A map view');
  assert.equal(card(container) === null, true, 'the owner message closes the card');
  assert.ok([...container.querySelectorAll('.ui-owner')].some(el => el.textContent?.includes('- Storage: SQLite (Recommended)')), 'shown as an owner bubble');
});

test('ui/ask-dom: typing in the composer instead (any later owner message) closes the card', async () => {
  const { container } = await renderChat({ messages: [...HISTORY, { id: 4, role: 'user', text: 'Just pick for me', runId: 'r2', createdAt: 30 }] });
  assert.equal(card(container) === null, true);
});

test('ui/ask-dom: hidden while a run is going and in helper conversations; back after a reload while still unanswered', async () => {
  const running = await renderChat({ draft: { runId: 'r2', conversationId: CHAT, modelId: 'm', text: '' } });
  assert.equal(card(running.container) === null, true, 'hidden while running');
  await running.rerender(1, undefined);
  assert.ok(card(running.container), 'shown once the run ended');
  await cleanup();
  const again = await renderChat();
  assert.ok(card(again.container), 'a fresh render from the same history shows it again (reload)');
  await cleanup();
  const helper = await renderChat({ helper: true });
  assert.equal(card(helper.container) === null, true, 'not in a helper conversation');
});
