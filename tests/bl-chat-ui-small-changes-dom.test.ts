import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import type { ChangedFile, Conversation, Project } from '../web/src/api.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';

// L144: Build の中でシェルの命令がファイルを変えても、開いている Changes の欄が読み直す

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
const fileA: ChangedFile = { path: 'src/a.ts', status: 'modified', added: 1, removed: 0, hidden: false, undo: true, hunks: [['@@ -1,1 +1,2 @@', ' a', '+b']] };
const shop = { id: 'p1', name: 'Shop', root: 'D:\\work\\shop', is_git: true, archived_at: null, waiting: { proposals: 0, questions: 0, pending: 0 } } as unknown as Project;
const convo = { id: 'c1', title: 'Retry', project_id: 'p1', archived: 0, has_summary: false, created_at: 1, updated_at: 1 } as unknown as Conversation;

const result = (name: string, ok = true, decision = 'allow', conversationId = 'c1') => ({ type: 'event' as const, hidden: false, event: { type: 'tool.result' as const, runId: 'r1', conversationId, callId: name, name, ok, decision, preview: '' } });

test('L144: シェルの命令（shell_run）が ok で終わるたびに、その会話の「書いた回数」が増える。失敗・断られた命令と、出力を読む・止めるだけの道具（shell_output・shell_stop）や読むだけの道具では増えない', () => {
  let state = EMPTY;
  for (const action of [result('shell_run'), result('shell_run', false), result('shell_run', true, 'deny'), result('shell_output'), result('shell_stop'), result('file_read')]) state = reduce(state, action).state;
  assert.equal(state.edits.get('c1'), 1);
  assert.equal(state.edits.get('c2'), undefined);
});

function serveApp(calls: string[]) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    switch (url.pathname) {
      case '/api/onboarding': return json({ done: true, steps: { user: true, identity: true, persona: true, model: true } });
      case '/api/settings': return json({ config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' });
      case '/api/models': return json({ models: [], routing: { chat: [], background: [] } });
      case '/api/projects': return json({ projects: [shop] });
      case '/api/conversations': return json({ conversations: [convo] });
      case '/api/conversations/c1/messages': return json({ conversation: convo, messages: [], pending: [], activeRun: null });
      case '/api/conversations/c1/checklist': return json({ items: [], tainted: false, updatedAt: null });
      case '/api/projects/p1/changes': return json({ base: { kind: 'commit', ref: null, at: null }, files: [fileA], more: 0, redo: null });
      default: return json({ error: 'not_found' }, 404);
    }
  }) as typeof fetch;
}

test('L144（App の DOM）: この製品の Build（task の会話）で shell_run が終わったら、開いている Changes の欄を読み直す。ほかの製品の Build・読むだけの道具では読み直さない', async () => {
  const calls: string[] = [];
  serveApp(calls);
  localStorage.setItem('beat.onboardingSeen', '1');
  localStorage.setItem('beat.panes', JSON.stringify([{ view: 'changes', width: 440 }]));
  window.history.replaceState(null, '', '/#/c/c1');
  const { container } = await render(createElement(App));
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(container.querySelector('.bt-diff[data-path="src/a.ts"]'), 'Changes の欄が開く');
  const emit = async (event: unknown) => {
    await update(() => { for (const s of sources) for (const run of s.listeners.get('run') ?? []) run({ data: JSON.stringify(event) }); });
    await settle();
  };
  const gets = () => calls.filter(c => c === 'GET /api/projects/p1/changes').length;
  const task = { id: 't1', title: 'Build', status: 'running', waiting_kind: null, check_state: null, project_id: 'p1', conversation_id: 'tc1', created_at: 1, updated_at: 5 };
  await emit({ type: 'task.changed', task });
  await emit({ type: 'task.changed', task: { ...task, id: 't2', project_id: 'p9', conversation_id: 'tc9', updated_at: 6 } });
  const tool = (conversationId: string, name: string) => ({ type: 'tool.result', runId: 'r1', conversationId, callId: `${conversationId}-${name}`, name, ok: true, decision: 'allow', preview: '' });
  const before = gets();
  await emit(tool('tc9', 'shell_run'));
  assert.equal(gets(), before, 'ほかの製品の Build では読み直さない');
  await emit(tool('tc1', 'file_read'));
  assert.equal(gets(), before, '読むだけの道具では読み直さない');
  await emit(tool('tc1', 'shell_run'));
  assert.equal(gets(), before + 1, 'この製品の Build の shell_run で読み直す');
});
