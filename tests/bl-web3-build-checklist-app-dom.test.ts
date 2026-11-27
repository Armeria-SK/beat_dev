import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import type { ChatBuild, ChecklistItem, Conversation, Project } from '../web/src/api.ts';

// Build の Checklist が変わるたびに、押した会話を読み直さない。出来事で届いた表を、そのまま画面に出す。

const g = globalThis as Record<string, unknown>;
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
type Listener = (e: { data: string }) => void;
const sources: Array<{ listeners: Map<string, Listener[]> }> = [];
g.EventSource = class {
  onmessage = null; onerror = null; onopen = null;
  listeners = new Map<string, Listener[]>();
  constructor() { sources.push(this); }
  addEventListener(type: string, run: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), run]); }
  removeEventListener() {}
  close() {}
};
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollTo ??= () => undefined;

const { App } = await loadTsx<{ App: ComponentType }>('../web/src/ui/App.tsx', import.meta.url);

afterEach(async () => {
  await cleanup();
  globalThis.fetch = (async () => json({ error: 'not_found' }, 404)) as typeof fetch;
  localStorage.clear();
  sources.length = 0;
  window.history.replaceState(null, '', '/');
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const shop = { id: 'p1', name: 'Shop', root: 'D:\\work\\shop', is_git: true, archived_at: null, waiting: { proposals: 0, questions: 0, pending: 0 } } as unknown as Project;
const convo = { id: 'c1', title: 'Parser', project_id: 'p1', archived: 0, has_summary: false, created_at: 1, updated_at: 1 } as unknown as Conversation;
const STARTED: ChatBuild = { id: 't1', status: 'running', waiting_kind: null, check_state: null, project_id: 'p1', created_at: 5, updated_at: 5, checklist: { items: [], tainted: false }, conversation_id: 'tc1', summary: null, summary_tainted: false };
const task = { id: 't1', title: 'Build: Parser', status: 'running', waiting_kind: null, check_state: null, project_id: 'p1', conversation_id: 'tc1', created_in_conversation: 'c1', acceptance_items: '["A-1"]', created_at: 5, updated_at: 5 };

async function startApp(calls: string[]) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    switch (url.pathname) {
      case '/api/onboarding': return json({ done: true, steps: { user: true, identity: true, persona: true, model: true } });
      case '/api/settings': return json({ config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
      case '/api/models': return json({ models: [], chatOrder: [] });
      case '/api/projects': return json({ projects: [shop] });
      case '/api/conversations': return json({ conversations: [convo] });
      case '/api/conversations/c1/messages': return json({ conversation: convo, messages: [], pending: [], activeRun: null, builds: [STARTED] });
      case '/api/conversations/c1/checklist': case '/api/conversations/tc1/checklist': return json({ items: [], tainted: false, updatedAt: null });
      default: return json({ error: 'not_found' }, 404);
    }
  }) as typeof fetch;
  localStorage.setItem('beat.onboardingSeen', '1');
  window.history.replaceState(null, '', '/#/c/c1');
  const { container } = await render(createElement(App));
  for (let i = 0; i < 4; i++) await settle();
  return container;
}

test('ui/App（DOM）: Build の Checklist が更新されても、押した会話は読み直さない。届いた表を、そのまま入力欄の上に出す', async () => {
  const calls: string[] = [];
  const container = await startApp(calls);
  const emit = async (event: unknown) => {
    await update(() => { for (const s of sources) for (const run of s.listeners.get('run') ?? []) run({ data: JSON.stringify(event) }); });
    await settle();
    await settle();
  };
  const loads = () => calls.filter(c => c === 'GET /api/conversations/c1/messages').length;
  await emit({ type: 'task.changed', task });
  assert.equal(container.querySelector('.bt-checklist.ui-pinned'), null, '表はまだ無い');
  const before = loads();
  const steps: ChecklistItem[] = [{ text: 'Read the plan', status: 'done' }, { text: 'Write the parser', status: 'in_progress' }, { text: 'Run the tests', status: 'pending' }];
  await emit({ type: 'checklist.updated', runId: 'r1', conversationId: 'tc1', items: steps, tainted: false });
  const pinned = () => container.querySelector('.bt-checklist.ui-pinned');
  assert.equal(pinned()?.querySelector('.bt-check--doing')?.textContent, 'Write the parser', '読み直さなくても、届いた表が出る');
  assert.equal(pinned()?.querySelector('.bt-checklist__head .bt-meta')?.textContent, '1 / 3');
  await emit({ type: 'checklist.updated', runId: 'r1', conversationId: 'tc1', items: steps.map(s => ({ ...s, status: 'done' as const })), tainted: false });
  assert.equal(pinned()?.querySelector('.bt-checklist__head .bt-meta')?.textContent, '3 / 3', '次の更新も同じ');
  assert.equal(loads(), before, '押した会話の読み直しは起きない');
});
