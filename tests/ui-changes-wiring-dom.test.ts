import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import type { ChangedFile, Conversation, Project } from '../web/src/api.ts';

// beat 8-5b: Changes の欄のつなぎ目。usePanes の openChanges / changesUsed、Panes から欄へ渡す focus・onFocusUsed・onUndone・onOpenChanges・productRoot・editRevision、App の Undo の知らせと書いた回数での読み直し

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

const { usePanes } = await loadTsx<{ usePanes: (productId: string | null) => { shown: Array<{ view: string }>; changesFocus: { path: string; n: number } | null; openChanges: (path: string) => void; changesUsed: () => void } }>('../web/src/ui/Panes.tsx', import.meta.url);
const { Panes } = await loadTsx<{ Panes: ComponentType<Record<string, unknown>> }>('../web/src/ui/Panes.tsx', import.meta.url);
const { App } = await loadTsx<{ App: ComponentType }>('../web/src/ui/App.tsx', import.meta.url);

afterEach(async () => {
  await cleanup();
  globalThis.fetch = (async () => json({ error: 'not_found' }, 404)) as typeof fetch;
  localStorage.clear();
  sources.length = 0;
  window.history.replaceState(null, '', '/');
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const wait = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fileA: ChangedFile = { path: 'src/a.ts', status: 'modified', added: 1, removed: 0, hidden: false, undo: true, hunks: [['@@ -1,1 +1,2 @@', ' a', '+b']] };

function probe<T>(use: () => T): { current: T | null; node: ReturnType<typeof createElement> } {
  const out: { current: T | null } = { current: null };
  function Probe() { out.current = use(); return null; }
  return Object.assign(out, { node: createElement(Probe) });
}

test('ui/Panes: openChanges は押すたびに新しい focus（パスと回数）を渡して Changes の欄を開き、changesUsed で頼みを消す（作り直しで同じ頼みを使い直さない）', async () => {
  const panes = probe(() => usePanes('prod01'));
  await render(panes.node);
  await update(() => panes.current!.openChanges('src/a.ts'));
  const first = panes.current!.changesFocus;
  assert.equal(first?.path, 'src/a.ts');
  assert.ok(panes.current!.shown.some(p => p.view === 'changes'), JSON.stringify(panes.current!.shown));
  await update(() => panes.current!.changesUsed());
  assert.ok(panes.current!.changesFocus === null, '使ったら消える');
  await update(() => panes.current!.openChanges('src/a.ts'));
  const again = panes.current!.changesFocus as { path: string } | null;
  assert.equal(again?.path, 'src/a.ts', '同じパスでももう一度頼める');
});

const base = { views: ['changes', 'files'], narrow: false, single: true, room: 1, width: 420, reveal: false, toggle: () => {}, close: () => {}, select: () => {}, split: () => {}, begin: () => {}, drag: () => {}, nudge: () => {}, openPlan: () => {}, openPane: () => {}, revealed: () => {}, terminalFocus: null, openTerminal: () => {} };
const paneProps = { productId: 'p1', scope: 'c1', revision: '0', taskRevision: '0', backgroundRevision: '0', isGit: true, inert: false, pending: { count: 0 }, questions: { count: 0 }, kanban: { count: 0 } };

test('ui/Panes（DOM）: Changes の欄に focus・製品の場所・使ったときの知らせ・Undo の知らせを渡し、書いた回数が増えたら読み直す', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/projects/p1/changes') return json({ base: { kind: 'commit', ref: null, at: null }, files: [fileA], more: 0, redo: null });
    if (url.pathname === '/api/projects/p1/changes/undo') return json({ undone: ['src/a.ts'], refused: [], redo: 'b-wire', more: 0 });
    return json({ error: 'not_found' }, 404);
  }) as typeof fetch;
  let used = 0;
  const undone: unknown[] = [];
  const state = { ...base, shown: [{ view: 'changes', width: 420 }], changesFocus: { path: 'D:\\work\\shop\\src\\a.ts', n: 1 }, openChanges: () => {}, changesUsed: () => { used++; } };
  const props = { ...paneProps, panes: state, productRoot: 'D:\\work\\shop', editRevision: 0, onUndone: (n: unknown) => undone.push(n) };
  const { container, root } = await render(createElement(Panes, props));
  await settle();
  await settle();
  assert.ok(container.querySelector('.bt-diff[data-path="src/a.ts"]')?.classList.contains('is-focus'), 'focus と製品の場所が届く');
  assert.equal(used, 1, '使ったと Panes に返す');
  const gets = () => calls.filter(c => c === 'GET /api/projects/p1/changes').length;
  const before = gets();
  await update(() => root.render(createElement(Panes, { ...props, panes: { ...state, changesFocus: null }, editRevision: 1 })));
  await settle();
  assert.equal(gets(), before + 1, '書いた回数が増えたら読み直す');
  await click(byText(container, 'button', 'Undo'));
  await settle();
  assert.deepEqual(undone, [{ projectId: 'p1', batch: 'b-wire', undone: 1, refused: 0, more: 0 }], 'Undo の知らせが届く');
});

test('ui/Panes（DOM）: Files の欄の「Open in Changes」は openChanges を呼ぶ', async () => {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = new URL(String(path), 'http://x');
    if (url.pathname.endsWith('/files')) return json({ dir: '', entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file', mark: 'M' }], truncated: false, ignoreChecked: true });
    return json({ path: 'a.ts', size: 2, modifiedAt: 1, mark: 'M', hidden: false, binary: false, truncated: false, text: 'x\n' });
  }) as typeof fetch;
  const opened: string[] = [];
  const state = { ...base, shown: [{ view: 'files', width: 420 }], changesFocus: null, openChanges: (path: string) => opened.push(path), changesUsed: () => {} };
  const { container } = await render(createElement(Panes, { ...paneProps, panes: state }));
  await settle();
  await click(container.querySelector('[data-path="a.ts"]'));
  await settle();
  await click(container.querySelector('.ui-files__changes'));
  assert.deepEqual(opened, ['a.ts']);
});

const shop = { id: 'p1', name: 'Shop', root: 'D:\\work\\shop', is_git: true, archived_at: null, waiting: { proposals: 0, questions: 0, pending: 0 } } as unknown as Project;
const convo = { id: 'c1', title: 'Retry', project_id: 'p1', archived: 0, has_summary: false, created_at: 1, updated_at: 1 } as unknown as Conversation;

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
      case '/api/projects/p1/changes/undo': return json({ undone: ['src/a.ts'], refused: [], redo: 'b-app', more: 0 });
      default: return json({ error: 'not_found' }, 404);
    }
  }) as typeof fetch;
}

async function startApp(calls: string[]) {
  serveApp(calls);
  localStorage.setItem('beat.onboardingSeen', '1');
  localStorage.setItem('beat.panes', JSON.stringify([{ view: 'changes', width: 440 }]));
  window.history.replaceState(null, '', '/#/c/c1');
  const { container } = await render(createElement(App));
  for (let i = 0; i < 4; i++) await settle();
  return container;
}

test('ui/App（DOM）: Changes の欄の Undo は、いまの会話に「Undid 1 file」と Redo の知らせを入れる', async () => {
  const calls: string[] = [];
  const container = await startApp(calls);
  const diff = container.querySelector('.bt-diff[data-path="src/a.ts"]');
  assert.ok(diff, `欄が開く: ${calls.join(', ')}`);
  await click(byText(diff as HTMLElement, 'button', 'Undo'));
  await wait(300);
  const notice = [...container.querySelectorAll('.bt-notice')].find(n => !n.closest('.ui-changes'));
  assert.match(notice?.textContent ?? '', /Undid 1 file/u, '会話の知らせ');
  assert.ok(notice && byText(notice as HTMLElement, 'button', 'Redo'), 'Redo が付く');
});

test('ui/App（DOM）: この製品の会話で書く道具が終わったら、開いている Changes の欄を読み直す。ほかの道具では読み直さない', async () => {
  const calls: string[] = [];
  const container = await startApp(calls);
  assert.ok(container.querySelector('.bt-diff[data-path="src/a.ts"]'));
  const gets = () => calls.filter(c => c === 'GET /api/projects/p1/changes').length;
  const send = async (name: string) => {
    const event = { type: 'tool.result', runId: 'r1', conversationId: 'c1', callId: name, name, ok: true, decision: 'allow', preview: '' };
    await update(() => { for (const s of sources) for (const run of s.listeners.get('run') ?? []) run({ data: JSON.stringify(event) }); });
    await settle();
  };
  const before = gets();
  await send('file_read');
  assert.equal(gets(), before, '読むだけの道具では読み直さない');
  await send('file_edit');
  assert.equal(gets(), before + 1, '書く道具で読み直す');
});

test('ui/App（DOM）: この製品の Build（task の会話）で書く道具が終わっても、開いている Changes の欄を読み直す', async () => {
  const calls: string[] = [];
  const container = await startApp(calls);
  assert.ok(container.querySelector('.bt-diff[data-path="src/a.ts"]'));
  const emit = async (event: unknown) => {
    await update(() => { for (const s of sources) for (const run of s.listeners.get('run') ?? []) run({ data: JSON.stringify(event) }); });
    await settle();
  };
  const gets = () => calls.filter(c => c === 'GET /api/projects/p1/changes').length;
  const task = { id: 't1', title: 'Build', status: 'running', waiting_kind: null, check_state: null, project_id: 'p1', conversation_id: 'tc1', created_at: 1, updated_at: 5 };
  await emit({ type: 'task.changed', task });
  await emit({ type: 'task.changed', task: { ...task, id: 't2', project_id: 'p9', conversation_id: 'tc9', updated_at: 6 } });
  const before = gets();
  await emit({ type: 'tool.result', runId: 'r9', conversationId: 'tc9', callId: 'x', name: 'file_edit', ok: true, decision: 'allow', preview: '' });
  assert.equal(gets(), before, 'ほかの製品の Build では読み直さない');
  await emit({ type: 'tool.result', runId: 'r1', conversationId: 'tc1', callId: 'y', name: 'file_edit', ok: true, decision: 'allow', preview: '' });
  assert.equal(gets(), before + 1, 'この製品の Build で読み直す');
});
