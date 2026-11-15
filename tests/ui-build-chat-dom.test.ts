import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, ChatBuild, Task } from '../web/src/api.ts';

// Build を押した会話に Build の様子（待ち・動いている・持ち主を待つ・終わり・失敗）が出る。Plan の欄の札は Queued / Running / Waiting for you を分ける。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}
interface PlanProps { productId: string; conversationId?: string; revision: string; taskRevision?: string; isGit: boolean }

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);
const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
g.addEventListener ??= window.addEventListener.bind(window);
g.removeEventListener ??= window.removeEventListener.bind(window);
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
let sent: Array<{ path: string; body: unknown }> = [];

function serve(routes: (path: string, method: string) => unknown): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') sent.push({ path: String(path), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null });
    const out = routes(String(path), method);
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  sent = [];
  window.location.hash = '';
});

const build = (status: ChatBuild['status'], extra: Partial<ChatBuild> = {}): ChatBuild => ({
  id: 'b1', status, waiting_kind: null, check_state: null, project_id: PRODUCT, created_at: 30, updated_at: 30, checklist: { items: [], tainted: false }, ...extra,
});

const STEPS = [{ text: 'Read the plan', status: 'done' as const }, { text: 'Write the parser', status: 'in_progress' as const }, { text: 'Run the tests', status: 'pending' as const }];

async function renderChat(builds: ChatBuild[]) {
  serve(path => {
    if (path === `/api/conversations/${CHAT}/messages`) {
      return {
        conversation: { id: CHAT, title: 'Parser', created_at: 0, last_message_at: 0, permission_mode: 'plan' },
        messages: [{ id: 1, role: 'user', text: 'plan it', runId: 'r1', createdAt: 10 }, { id: 2, role: 'assistant', text: 'The plan is in the Plan pane.', runId: 'r1', createdAt: 20 }],
        pending: [], builds, activeRun: null,
      };
    }
    if (path === `/api/conversations/${CHAT}/checklist`) return { items: [], tainted: false, updatedAt: null };
    if (path === '/api/models') return { models: [], routing: { chat: [] } };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { container } = await render(createElement(Conversation, {
    id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {},
  }));
  await settle();
  await settle();
  return container;
}

const row = (container: HTMLElement) => container.querySelector('.bt-thread [data-build="b1"]');
const actions = (el: Element | null) => [...(el?.querySelectorAll('.bt-notice__action, .bt-notice--fail .bt-btn') ?? [])].map(b => b.textContent);

test('ui/Conversation（DOM）: 待っている Build は返事の後ろに「Build queued」と Open task。押すとタスクの画面へ', async () => {
  const container = await renderChat([build('ready')]);
  const el = row(container)!;
  assert.ok(el, 'Build の行がある');
  assert.equal(el.previousElementSibling?.classList.contains('ui-reply'), true, '押した時刻の位置（返事の後ろ）');
  assert.match(el.textContent!, /^Build queued/u);
  assert.deepEqual(actions(el), ['Open task']);
  assert.equal(container.querySelector('.ui-pinned'), null, '待っているあいだは Checklist を出さない');
  await click(byText(el, 'button', 'Open task'));
  assert.equal(window.location.hash, '#/tasks/b1');
});

test('ui/Conversation（DOM）: 動いている Build は「Build running」で、タスクの Checklist を入力欄の上に固定する（いまの段が doing）', async () => {
  const container = await renderChat([build('running', { checklist: { items: STEPS, tainted: false } })]);
  assert.match(row(container)!.textContent!, /^Build running/u);
  const pinned = container.querySelector('.bt-checklist.ui-pinned')!;
  assert.ok(pinned, '入力欄の上に固定');
  assert.equal(pinned.parentElement?.classList.contains('bt-thread'), false, '会話の流れの外');
  assert.equal(pinned.querySelector('.bt-check--doing')?.textContent, 'Write the parser');
  assert.equal(pinned.querySelector('.bt-checklist__head .bt-meta')?.textContent, '1 / 3');
  assert.equal(row(container)!.querySelector('.bt-checklist'), null, '流れの中には重ねない');
});

test('ui/Conversation（DOM）: 持ち主を待つ Build は、待っているものの行き先（Pending / Questions）と Open task を出す', async () => {
  const approval = await renderChat([build('waiting', { waiting_kind: 'approval', checklist: { items: STEPS, tainted: false } })]);
  assert.match(row(approval)!.textContent!, /^Build waiting for your approval/u);
  assert.deepEqual(actions(row(approval)), ['Open Pending', 'Open task']);
  assert.equal(approval.querySelector('.ui-pinned'), null, '止まっているあいだは固定しない');
  assert.ok(row(approval)!.querySelector('.bt-checklist'), 'そこまでの Checklist は流れの中に');
  await click(byText(row(approval)!, 'button', 'Open Pending'));
  assert.equal(window.location.hash, `#/pending/${PRODUCT}`);
  await cleanup();
  const question = await renderChat([build('waiting', { waiting_kind: 'question' })]);
  assert.match(row(question)!.textContent!, /^Build waiting for your answer/u);
  assert.deepEqual(actions(row(question)), ['Open Questions', 'Open task']);
  await click(byText(row(question)!, 'button', 'Open Questions'));
  assert.equal(window.location.hash, `#/questions/${PRODUCT}`);
  await cleanup();
  const other = await renderChat([build('waiting')]);
  assert.match(row(other)!.textContent!, /^Build waiting for you/u);
  assert.deepEqual(actions(row(other)), ['Open task']);
});

test('ui/Conversation（DOM）: 終わった Build は「Build done」（確かめ待ちならそう言う）、失敗は fail の Notice と Open task、取り消しは「Build stopped」', async () => {
  const done = await renderChat([build('done', { checklist: { items: STEPS.map(s => ({ ...s, status: 'done' as const })), tainted: false } })]);
  assert.match(row(done)!.textContent!, /^Build done/u);
  assert.ok(row(done)!.querySelector('.bt-checklist:not(.ui-pinned)'), '終わったら Checklist は流れの中に');
  await cleanup();
  const check = await renderChat([build('done', { check_state: 'awaiting' })]);
  assert.match(row(check)!.textContent!, /^Build done · waiting for your check/u);
  assert.deepEqual(actions(row(check)), ['Open task']);
  await cleanup();
  const failed = await renderChat([build('failed')]);
  const alert = row(failed)!.querySelector('.bt-notice--fail[role="alert"]')!;
  assert.ok(alert, 'fail の Notice');
  assert.equal(alert.querySelector('strong')?.textContent, 'Build failed');
  assert.deepEqual(actions(row(failed)), ['Open task']);
  await cleanup();
  const stopped = await renderChat([build('cancelled')]);
  assert.match(row(stopped)!.textContent!, /^Build stopped/u);
});

const acceptance = (frozen: boolean): Acceptance => ({
  version: frozen ? 1 : 0, language: 'en', items: [], not_doing: [], draft: !frozen, hash: 'ah',
  frozen: frozen ? { version: 1, hash: 'ah', plan_hash: 'p1', created_at: 1, source: 'build', build_task_id: 'b1' } : null,
  ...(frozen ? { open_build_task_id: 'b1' } : {}),
});

const task = (status: Task['status']): Task => ({
  id: 'b1', title: 'Build: Parser', body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 1, updated_at: 1, completed_at: null, project_id: PRODUCT,
});

const PLAN = { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false };

test('ui/PlanPane（DOM）: Build はその会話の id を送る。札は ready で Queued、running で Running、waiting で Waiting for you', async () => {
  let status: Task['status'] = 'ready';
  let built = false;
  serve((path, method) => {
    if (path === `/api/projects/${PRODUCT}/plan`) return { plan: PLAN };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance(built), coverage: { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 } };
    if (path === `/api/projects/${PRODUCT}/build` && method === 'POST') { built = true; return { task: task('ready'), version: 1 }; }
    if (path === '/api/tasks/b1') return { task: task(status), events: [], runs: [] };
    if (path === `/api/projects/${PRODUCT}/deviations`) return { deviations: { rows: [], unreadable: 0, unusable: false }, flags: { checked: false, reason: 'no_git' } };
    return undefined;
  });
  const props = { productId: PRODUCT, conversationId: CHAT, revision: '0', isGit: true };
  const { root } = await render(createElement(PlanPane, { ...props, taskRevision: '0' }));
  await settle();
  const container = document.body;
  await click(byText(container, 'button', 'Build with this plan'));
  await settle();
  assert.deepEqual(sent, [{ path: `/api/projects/${PRODUCT}/build`, body: { planHash: 'p1', acceptanceHash: 'ah', conversationId: CHAT } }]);
  const pill = () => container.querySelector('.bt-pane__bar .bt-pill, [role="status"] .bt-pill');
  assert.equal(pill()?.textContent, 'Queued');
  assert.equal(pill()?.classList.contains('bt-pill--running'), false, '待っているあいだは動かない札');
  for (const [next, label, tone] of [['running', 'Running', 'bt-pill--running'], ['waiting', 'Waiting for you', 'bt-pill--waiting']] as const) {
    status = next;
    await update(() => root.render(createElement(PlanPane, { ...props, taskRevision: next })));
    await settle();
    assert.equal(pill()?.textContent, label, next);
    assert.ok(pill()?.classList.contains(tone), next);
  }
});
