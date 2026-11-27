import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, ChatBuild, ChecklistItem, Task } from '../web/src/api.ts';
import type { LiveDraft } from '../web/src/ui/live-state.ts';
import { buildToolItem } from '../web/src/ui/thread.ts';

// Build を押した会話に Build の様子（待ち・動いている・持ち主を待つ・終わり・失敗）が出る。Plan の欄の札は Queued / Running / Waiting for you を分ける。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: LiveDraft | undefined; notices: never[]; liveChecklist: ChecklistItem[] | undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
  buildLive?: unknown; waits?: Record<string, { kind: string }>; panes?: unknown;
}
interface PlanProps { productId: string; conversationId?: string; revision: string; taskRevision?: string; isGit: boolean }
interface PanesProps { panes: unknown; productId: string; scope: string; revision: string; taskRevision: string; isGit: boolean; inert: boolean; pending: never; questions: never }

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);
const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);
const { Panes } = await loadTsx<{ Panes: ComponentType<PanesProps> }>('../web/src/ui/Panes.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
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
  id: 'b1', status, waiting_kind: null, check_state: null, project_id: PRODUCT, created_at: 30, updated_at: 30, checklist: { items: [], tainted: false }, conversation_id: null, summary: null, summary_tainted: false, ...extra,
});

const STEPS = [{ text: 'Read the plan', status: 'done' as const }, { text: 'Write the parser', status: 'in_progress' as const }, { text: 'Run the tests', status: 'pending' as const }];

async function renderChat(first: ChatBuild[], over: Partial<ConversationProps> = {}) {
  let builds = first;
  serve(path => {
    if (path === `/api/conversations/${CHAT}/messages`) {
      return {
        conversation: { id: CHAT, title: 'Parser', created_at: 0, last_message_at: 0, permission_mode: 'plan' },
        messages: [{ id: 1, role: 'user', text: 'plan it', runId: 'r1', createdAt: 10 }, { id: 2, role: 'assistant', text: 'The plan is in the Plan pane.', runId: 'r1', createdAt: 20 }],
        pending: [], builds, activeRun: null,
      };
    }
    if (path === `/api/conversations/${CHAT}/checklist`) return { items: [], tainted: false, updatedAt: null };
    if (path === '/api/models') return { models: [], chatOrder: [] };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props = (revision: number): ConversationProps => ({
    id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {}, ...over,
  });
  const { container, root } = await render(createElement(Conversation, props(0)));
  await settle();
  await settle();
  const next = async (later: ChatBuild[], revision: number) => {
    builds = later;
    await update(() => root.render(createElement(Conversation, props(revision))));
    await settle();
    await settle();
  };
  return { container, next };
}

const row = (container: HTMLElement) => [...container.querySelectorAll('.bt-thread > .bt-notice')].find(n => /^Build /u.test(n.textContent ?? ''));
const listAfter = (container: HTMLElement) => { const next = row(container)?.nextElementSibling; return next?.matches('.bt-checklist') ? next : null; };
const actions = (el: Element | undefined) => [...(el?.querySelectorAll('.bt-notice__action, .bt-btn') ?? [])].map(b => b.textContent);

test('ui/Conversation（DOM）: 待っている Build は返事の後ろに「Build queued」と Open task を、会話の流れの直下（返事と同じ幅の決まり）に出す。押すとタスクの画面へ', async () => {
  const { container } = await renderChat([build('ready')]);
  const el = row(container)!;
  assert.ok(el, 'Build の行が .bt-thread の直下にある');
  assert.equal(el.parentElement?.classList.contains('bt-thread'), true);
  assert.equal(el.previousElementSibling?.classList.contains('ui-reply'), true, '押した時刻の位置（返事の後ろ）');
  assert.match(el.textContent!, /^Build queued/u);
  assert.deepEqual(actions(el), ['Open task']);
  assert.equal(container.querySelector('.ui-pinned'), null, '待っているあいだは Checklist を出さない');
  await click(byText(el, 'button', 'Open task'));
  assert.equal(window.location.hash, '#/tasks/b1');
});

test('ui/Conversation（DOM）: 動いている Build は「Build running」で、タスクの Checklist を入力欄の上に固定する（いまの段が doing）', async () => {
  const { container } = await renderChat([build('running', { checklist: { items: STEPS, tainted: false } })]);
  assert.match(row(container)!.textContent!, /^Build running/u);
  const pinned = container.querySelector('.bt-checklist.ui-pinned')!;
  assert.ok(pinned, '入力欄の上に固定');
  assert.equal(pinned.closest('.bt-thread'), null, '会話の流れの外');
  assert.equal(pinned.querySelector('.bt-check--doing')?.textContent, 'Write the parser');
  assert.equal(pinned.querySelector('.bt-checklist__head .bt-meta')?.textContent, '1 / 3');
  assert.equal(listAfter(container), null, '流れの中には重ねない');
});

test('ui/Conversation（DOM）: 会話の返事が自分の Checklist を固定しているあいだは、動いている Build の Checklist は固定しない（固定は 1 つだけ）', async () => {
  const draft: LiveDraft = { runId: 'r9', conversationId: CHAT, modelId: 'm', text: '' };
  const { container } = await renderChat([build('running', { checklist: { items: STEPS, tainted: false } })], { draft, liveChecklist: [{ text: 'Answer the owner', status: 'in_progress' }] });
  const pinned = [...container.querySelectorAll('.ui-pinned')];
  assert.equal(pinned.length, 1);
  assert.match(pinned[0]!.textContent!, /Answer the owner/u, '会話の返事の一覧が先');
});

test('ui/Conversation（DOM）: 持ち主を待つ Build は、待っているものの行き先（Pending / Questions）と Open task を出す', async () => {
  const approval = (await renderChat([build('waiting', { waiting_kind: 'approval', checklist: { items: STEPS, tainted: false } })])).container;
  assert.match(row(approval)!.textContent!, /^Build waiting for your approval/u);
  assert.deepEqual(actions(row(approval)), ['Open Pending', 'Open task']);
  assert.equal(approval.querySelector('.ui-pinned'), null, '止まっているあいだは固定しない');
  assert.ok(listAfter(approval), 'そこまでの Checklist は行のすぐ下、会話の流れの直下に');
  assert.equal(listAfter(approval)!.parentElement?.classList.contains('bt-thread'), true);
  await click(byText(row(approval)!, 'button', 'Open Pending'));
  assert.equal(window.location.hash, `#/pending/${PRODUCT}`);
  await cleanup();
  const question = (await renderChat([build('waiting', { waiting_kind: 'question' })])).container;
  assert.match(row(question)!.textContent!, /^Build waiting for your answer/u);
  assert.deepEqual(actions(row(question)), ['Open Questions', 'Open task']);
  await click(byText(row(question)!, 'button', 'Open Questions'));
  assert.equal(window.location.hash, `#/questions/${PRODUCT}`);
  await cleanup();
  const other = (await renderChat([build('waiting')])).container;
  assert.match(row(other)!.textContent!, /^Build waiting for you/u);
  assert.deepEqual(actions(row(other)), ['Open task']);
});

test('ui/Conversation（DOM）: 終わった Build は「Build done」（確かめ待ちならそう言う）、失敗は fail の Notice と Open task、取り消しは「Build stopped」。前からの失敗を開いても alert にしない', async () => {
  const done = (await renderChat([build('done', { checklist: { items: STEPS.map(s => ({ ...s, status: 'done' as const })), tainted: false } })])).container;
  assert.match(row(done)!.textContent!, /^Build done/u);
  assert.ok(listAfter(done), '終わったら Checklist は流れの中に');
  await cleanup();
  const check = (await renderChat([build('done', { check_state: 'awaiting' })])).container;
  assert.match(row(check)!.textContent!, /^Build done · waiting for your check/u);
  assert.deepEqual(actions(row(check)), ['Open task']);
  await cleanup();
  const failed = (await renderChat([build('failed')])).container;
  const fail = row(failed)!;
  assert.ok(fail.classList.contains('bt-notice--fail'), 'fail の Notice');
  assert.equal(fail.querySelector('strong')?.textContent, 'Build failed');
  assert.equal(fail.getAttribute('role'), null, '前からの失敗を開いただけでは読み上げない');
  assert.deepEqual(actions(fail), ['Open task']);
  await cleanup();
  const stopped = (await renderChat([build('cancelled')])).container;
  assert.match(row(stopped)!.textContent!, /^Build stopped/u);
});

test('ui/Conversation（DOM）: 見ているあいだに Build が失敗したら、その fail の Notice は role="alert"', async () => {
  const { container, next } = await renderChat([build('running')]);
  assert.match(row(container)!.textContent!, /^Build running/u);
  await next([build('failed')], 1);
  assert.equal(row(container)!.getAttribute('role'), 'alert');
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

function servePlan(status: () => Task['status']) {
  let built = false;
  serve((path, method) => {
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/plan`) return { plan: PLAN };
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance(built), coverage: { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 } };
    if (path === `/api/projects/${PRODUCT}/build` && method === 'POST') { built = true; return { task: task('ready'), version: 1 }; }
    if (path === '/api/tasks/b1') return { task: task(status()), events: [], runs: [] };
    if (path === `/api/projects/${PRODUCT}/deviations`) return { deviations: { rows: [], unreadable: 0, unusable: false }, flags: { checked: false, reason: 'no_git' } };
    return undefined;
  });
}

test('ui/PlanPane（DOM）: Build はその会話の id を送る。札は ready で Queued、running で Running、waiting で Waiting for you', async () => {
  let status: Task['status'] = 'ready';
  servePlan(() => status);
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

const panesState = { views: ['plan'], shown: [{ view: 'plan', width: 420 }], narrow: false, single: true, room: 1, width: 420, reveal: false, toggle: () => {}, close: () => {}, select: () => {}, split: () => {}, begin: () => {}, drag: () => {}, nudge: () => {}, openPlan: () => {}, openPane: () => {}, revealed: () => {} };

test('ui/Panes（DOM）: Plan の欄は今の会話の id を Build に渡す。新しい会話の画面（scope new）では計画が空で、Edit と Build を出さない', async () => {
  servePlan(() => 'ready');
  await render(createElement(Panes, { panes: panesState, productId: PRODUCT, scope: CHAT, revision: '0', taskRevision: '0', isGit: true, inert: false, pending: { count: 0 } as never, questions: { count: 0 } as never }));
  await settle();
  await click(byText(document.body, 'button', 'Build with this plan'));
  await settle();
  assert.deepEqual(sent, [{ path: `/api/projects/${PRODUCT}/build`, body: { planHash: 'p1', acceptanceHash: 'ah', conversationId: CHAT } }]);
  await cleanup();
  sent = [];
  servePlan(() => 'ready');
  await render(createElement(Panes, { panes: panesState, productId: PRODUCT, scope: 'new', revision: '0', taskRevision: '0', isGit: true, inert: false, pending: { count: 0 } as never, questions: { count: 0 } as never }));
  await settle();
  const buttons = [...document.body.querySelectorAll('button')].map(b => b.textContent);
  assert.ok(!buttons.includes('Build with this plan') && !buttons.includes('Edit'), buttons.join());
  assert.match(document.body.textContent ?? '', /No plan for this conversation yet/u);
  assert.equal(document.body.querySelector('.ui-plan__doc'), null, '別の会話の計画を出さない');
  assert.deepEqual(sent, []);
  await cleanup();
});

const TASK_CONV = 'bbbbbbbb-0000-4000-8000-000000000002';
const liveDraft = (extra: Partial<LiveDraft> = {}): LiveDraft => ({ runId: 'tr', conversationId: TASK_CONV, modelId: 'm', text: '', ...extra });
const buildLive = (drafts: LiveDraft[], counts: { questions?: number; pending?: number } = {}, lists: Record<string, ChecklistItem[]> = {}) => ({
  toolOf: (b: ChatBuild) => buildToolItem(drafts, b), checklistOf: (b: ChatBuild) => lists[b.id], questions: () => counts.questions ?? 0, pending: () => counts.pending ?? 0,
});
const running = (extra: Partial<ChatBuild> = {}) => build('running', { conversation_id: TASK_CONV, checklist: { items: STEPS, tainted: false }, ...extra });
const toolsAfter = (container: HTMLElement) => { const next = row(container)?.nextElementSibling; return next?.matches('.bt-tools') ? next : null; };

test('ui/Conversation（DOM・build-in-chat）: 動いている Build のタスクの会話に今の道具があれば、Build の Notice のすぐ下に running の ToolRow が 1 本（動詞と対象）、その下に Open the session（タスクの会話へ）', async () => {
  const drafts = [liveDraft({ activeTool: 'shell_run', activeInput: '{"command":"npm test"}', toolCallId: 'c1', toolStartedAt: Date.now() })];
  const { container } = await renderChat([running()], { buildLive: buildLive(drafts) });
  const tools = toolsAfter(container)!;
  assert.ok(tools, 'the tool row sits right under the Build notice');
  assert.equal(tools.querySelectorAll('.bt-tool').length, 1);
  assert.ok(tools.querySelector('.bt-tool--running'));
  assert.equal(tools.querySelector('.bt-tool__verb')?.textContent, 'Run');
  assert.match(tools.querySelector('.bt-tool__target')?.textContent ?? '', /npm test/u);
  assert.match(tools.querySelector('.bt-tool__meta')?.textContent ?? '', /^running/u);
  const link = tools.nextElementSibling!.querySelector('a')!;
  assert.equal(link.textContent, 'Open the session');
  assert.equal(link.getAttribute('href'), `#/c/${TASK_CONV}`);
  assert.equal(container.querySelectorAll('.bt-tool--running').length, 1);
});

test('ui/Conversation（DOM・build-in-chat）: 道具が終わって次がまだなら直前の道具を running でない形で 1 本。下書きが無ければ道具の行は出ない（Notice はある）', async () => {
  const settled = [liveDraft({ settled: [{ callId: 'c0', name: 'file_read', input: '{"path":"a.ts"}' }, { callId: 'c1', name: 'shell_run', input: '{"command":"npm test"}' }], settledCount: 2 })];
  const a = (await renderChat([running()], { buildLive: buildLive(settled) })).container;
  const tools = toolsAfter(a)!;
  assert.equal(tools.querySelectorAll('.bt-tool').length, 1);
  assert.equal(tools.querySelector('.bt-tool--running'), null);
  assert.match(tools.querySelector('.bt-tool__target')?.textContent ?? '', /npm test/u, 'the last settled tool');
  await cleanup();
  const b = (await renderChat([running()], { buildLive: buildLive([]) })).container;
  assert.match(row(b)!.textContent!, /^Build running/u);
  assert.equal(toolsAfter(b), null);
  assert.equal(b.querySelector('.ui-build__session'), null);
});

test('ui/Conversation（DOM・build-in-chat）: 会話自身が running の道具の行を出している間は Build の行を running でない形に（running の ToolRow は 1 本）。会話が文を流している・道具を使っていないときは running のまま', async () => {
  const drafts = [liveDraft({ activeTool: 'shell_run', activeInput: '{"command":"npm test"}', toolCallId: 'c1', toolStartedAt: Date.now() })];
  const own = liveDraft({ runId: 'own', conversationId: CHAT, activeTool: 'file_read', activeInput: '{"path":"notes.md"}', toolCallId: 'o1', toolStartedAt: Date.now() });
  const a = (await renderChat([running()], { buildLive: buildLive([...drafts, own]), draft: own })).container;
  assert.equal(a.querySelectorAll('.bt-tool--running').length, 1, 'only one running row on screen');
  assert.equal(toolsAfter(a)!.querySelector('.bt-tool--running'), null, 'the Build row is the quiet one');
  assert.match(toolsAfter(a)!.querySelector('.bt-tool__target')?.textContent ?? '', /npm test/u);
  await cleanup();
  const streaming = liveDraft({ runId: 'own', conversationId: CHAT, text: 'Thinking about it', activeTool: 'file_read', toolCallId: 'o1' });
  const b = (await renderChat([running()], { buildLive: buildLive(drafts), draft: streaming })).container;
  assert.ok(toolsAfter(b)!.querySelector('.bt-tool--running'), 'still running while the conversation streams text');
  await cleanup();
  const idle = liveDraft({ runId: 'own', conversationId: CHAT });
  const c = (await renderChat([running()], { buildLive: buildLive(drafts), draft: idle })).container;
  assert.ok(toolsAfter(c)!.querySelector('.bt-tool--running'), 'still running while the conversation uses no tool');
});

test('ui/Conversation（DOM・build-in-chat）: 判定役に聞いている間（autoChecking）は meta が checking', async () => {
  const drafts = [liveDraft({ activeTool: 'shell_run', activeInput: '{"command":"git push"}', toolCallId: 'c1', autoChecking: true })];
  const { container } = await renderChat([running()], { buildLive: buildLive(drafts) });
  assert.equal(toolsAfter(container)!.querySelector('.bt-tool__meta')?.textContent, 'judge checking');
});

test('ui/Conversation（DOM・build-in-chat）: Pending に積んだ直前の道具のリンクは #/pending（会話自身の Pending の開き方は使わない）', async () => {
  const drafts = [liveDraft({ settled: [{ callId: 'c1', name: 'shell_run', input: '{"command":"git push"}', gate: { by: 'pending', id: 12 } }], settledCount: 1 })];
  let opened = 0;
  const panes = { open: false, onToggle: () => {}, onOpenPending: () => { opened += 1; } };
  const { container } = await renderChat([running()], { buildLive: buildLive(drafts), panes });
  const link = toolsAfter(container)!.querySelector('a.ui-tool__open')!;
  assert.equal(link.getAttribute('href'), '#/pending');
  await click(link as HTMLElement);
  assert.equal(opened, 0);
});

test('ui/Conversation（DOM・build-in-chat）: 開いている質問・待っている Pending の数を Notice の 1 行に。質問があれば Open Questions、Pending だけなら Open Pending。approval / question の段は今の行き先。0 なら出さず、数が 0 になれば消える。並び待ちの理由と 1 行につながる', async () => {
  const both = (await renderChat([running()], { buildLive: buildLive([], { questions: 1, pending: 1 }) })).container;
  assert.match(row(both)!.textContent!, /^Build running · 1 question recorded · 1 action held in Pending/u);
  assert.deepEqual(actions(row(both)), ['Open Questions', 'Open task']);
  await click(byText(row(both)!, 'button', 'Open Questions'));
  assert.equal(window.location.hash, `#/questions/${PRODUCT}`);
  await cleanup();
  const held = (await renderChat([running()], { buildLive: buildLive([], { pending: 2 }) })).container;
  assert.match(row(held)!.textContent!, /^Build running · 2 actions held in Pending/u);
  assert.deepEqual(actions(row(held)), ['Open Pending', 'Open task']);
  await cleanup();
  const approval = (await renderChat([build('waiting', { waiting_kind: 'approval' })], { buildLive: buildLive([], { questions: 2 }) })).container;
  assert.match(row(approval)!.textContent!, /^Build waiting for your approval · 2 questions recorded/u);
  assert.deepEqual(actions(row(approval)), ['Open Pending', 'Open task']);
  await cleanup();
  const question = (await renderChat([build('waiting', { waiting_kind: 'question' })], { buildLive: buildLive([], { pending: 1 }) })).container;
  assert.deepEqual(actions(row(question)), ['Open Questions', 'Open task']);
  await cleanup();
  let counts = { questions: 1 };
  const answered = await renderChat([running()], { buildLive: buildLive([], counts) });
  assert.match(row(answered.container)!.textContent!, /1 question recorded/u);
  counts = { questions: 0 };
  await cleanup();
  const none = (await renderChat([running()], { buildLive: buildLive([], counts) })).container;
  assert.doesNotMatch(row(none)!.textContent!, /recorded|held/u);
  assert.deepEqual(actions(row(none)), ['Open task']);
  await cleanup();
  const queued = (await renderChat([build('ready')], { buildLive: buildLive([], { questions: 1 }), waits: { b1: { kind: 'paused' } } })).container;
  assert.match(row(queued)!.textContent!, /^Build queued · paused · 1 question recorded/u);
});

test('ui/Conversation（DOM・build-in-chat）: 終わった（確かめ待ちも）・失敗した Build のまとめは Notice の下、Checklist の上に返事の形で（Markdown。生の HTML は描かない）。外を読んだ印。外を読んだ印の札は出さない（P3）。取り消し・動いている間は出ない', async () => {
  const summary = '# Result\n\n- parser added\n- tests pass\n\n<b>raw</b>';
  const done = (await renderChat([build('done', { summary, summary_tainted: true, checklist: { items: STEPS, tainted: false } })], { buildLive: buildLive([]) })).container;
  const box = row(done)!.nextElementSibling!;
  assert.ok(box.matches('.bt-msg.ui-build__summary'), 'right under the notice');
  assert.equal(box.querySelector('h1')?.textContent, 'Result');
  assert.equal(box.querySelectorAll('li').length, 2);
  assert.equal(box.querySelector('b'), null, 'raw HTML is not rendered');
  assert.equal(box.querySelector('.bt-meta'), null, 'no outside mark (P3)');
  assert.ok(!box.textContent!.includes('elsewhere'));
  assert.ok(box.nextElementSibling?.matches('.bt-checklist'), 'the checklist follows the summary');
  await cleanup();
  const check = (await renderChat([build('done', { check_state: 'awaiting', summary: 'All good.' })])).container;
  assert.equal(row(check)!.nextElementSibling?.textContent, 'All good.', 'no taint mark when the summary is clean');
  await cleanup();
  const failed = (await renderChat([build('failed', { summary: 'Tests kept failing.' })])).container;
  assert.match(row(failed)!.nextElementSibling?.textContent ?? '', /Tests kept failing/u);
  assert.match(row(failed)!.textContent!, /It stopped before finishing/u, 'the failure notice text stays');
  await cleanup();
  const stopped = (await renderChat([build('cancelled', { summary: 'Should not show.' })])).container;
  assert.equal(stopped.querySelector('.ui-build__summary'), null);
  await cleanup();
  const live = (await renderChat([build('running', { summary: 'Should not show.' })])).container;
  assert.equal(live.querySelector('.ui-build__summary'), null);
});

test('ui/Conversation（DOM・build-in-chat・回帰の守り）: 読み直し（同じ読み出しの結果で描き直す）でも、まとめ・数・Checklist が同じに出る', async () => {
  const builds = [build('done', { summary: 'Done. 1 file changed.', checklist: { items: STEPS, tainted: false } })];
  const live = buildLive([], { questions: 1 });
  const { container, next } = await renderChat(builds, { buildLive: live });
  const before = row(container)!.parentElement!.innerHTML;
  await next(builds, 1);
  assert.equal(row(container)!.parentElement!.innerHTML, before);
  assert.match(row(container)!.textContent!, /1 question recorded/u);
  assert.equal(container.querySelector('.ui-build__summary')?.textContent, 'Done. 1 file changed.');
});

test('ui/Conversation（DOM・build-in-chat）: 失敗した Build も、開いている質問の数を失敗の文につなぎ、Open Questions と Open task を出す（Pending だけなら Open Pending）', async () => {
  const failed = (await renderChat([build('failed')], { buildLive: buildLive([], { questions: 1 }) })).container;
  const fail = row(failed)!;
  assert.ok(fail.classList.contains('bt-notice--fail'));
  assert.equal(fail.querySelector('p')?.textContent, 'It stopped before finishing. The task has the details. · 1 question recorded');
  assert.deepEqual(actions(fail), ['Open Questions', 'Open task']);
  await click(byText(fail, 'button', 'Open Questions'));
  assert.equal(window.location.hash, `#/questions/${PRODUCT}`);
  await cleanup();
  const held = (await renderChat([build('failed')], { buildLive: buildLive([], { pending: 1 }) })).container;
  assert.deepEqual(actions(row(held)), ['Open Pending', 'Open task']);
});

test('ui/Conversation（DOM・build-in-chat）: 道具の行は動いている Build だけ。待っている・終わった Build は、タスクの会話に今の道具があっても出さない', async () => {
  const drafts = [liveDraft({ activeTool: 'shell_run', activeInput: '{"command":"npm test"}', toolCallId: 'c1', toolStartedAt: Date.now() })];
  for (const b of [build('waiting', { waiting_kind: 'approval', conversation_id: TASK_CONV }), build('done', { conversation_id: TASK_CONV }), build('ready', { conversation_id: TASK_CONV })]) {
    const { container } = await renderChat([b], { buildLive: buildLive(drafts) });
    assert.ok(row(container), b.status);
    assert.equal(container.querySelector('.bt-tools .bt-tool'), null, b.status);
    assert.equal(container.querySelector('.ui-build__session'), null, b.status);
    await cleanup();
  }
});

test('ui/Conversation（DOM・build-in-chat）: 動いている Build の Checklist は、渡された表（checklistOf）で描き直す。会話は読み直さない。動いていない Build は読み出しの表のまま', async () => {
  const lists: Record<string, ChecklistItem[]> = {};
  const empty = () => running({ checklist: { items: [], tainted: false } });
  const { container, next } = await renderChat([empty()], { buildLive: buildLive([], {}, lists) });
  assert.equal(container.querySelector('.ui-pinned'), null, '読み出しの表がまだ空で、渡された表も無い');
  const base = globalThis.fetch;
  let loads = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    if (String(path) === `/api/conversations/${CHAT}/messages`) loads += 1;
    return base(path, init);
  }) as typeof fetch;
  lists['b1'] = STEPS;
  await next([empty()], 0);
  const pinned = () => container.querySelector('.bt-checklist.ui-pinned');
  assert.equal(pinned()?.querySelector('.bt-check--doing')?.textContent, 'Write the parser', '表が渡されただけで出る');
  assert.equal(pinned()?.querySelector('.bt-checklist__head .bt-meta')?.textContent, '1 / 3');
  lists['b1'] = STEPS.map(s => ({ ...s, status: 'done' as const }));
  await next([empty()], 0);
  assert.equal(pinned()?.querySelector('.bt-checklist__head .bt-meta')?.textContent, '3 / 3', '次の更新でも描き直す');
  assert.equal(loads, 0, '会話の読み直しはしない');
  await cleanup();
  const waiting = (await renderChat([build('waiting', { waiting_kind: 'approval', conversation_id: TASK_CONV, checklist: { items: STEPS, tainted: false } })], { buildLive: buildLive([], {}, { b1: [{ text: 'Other', status: 'pending' }] }) })).container;
  assert.equal(waiting.querySelector('.ui-pinned'), null);
  assert.equal(listAfter(waiting)?.querySelector('.bt-checklist__head .bt-meta')?.textContent, '1 / 3', '止まっている Build は読み出しの表（渡された表では上書きしない）');
});
