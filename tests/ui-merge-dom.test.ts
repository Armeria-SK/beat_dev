import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, AcceptanceItem, Conversation, Project, RunRow, Task } from '../web/src/api.ts';
import type { ChangesTarget } from '../web/src/ui/kanban.ts';

// beat 8-3: Kanban の取り込み待ちのカード（Task · merge it）・取り込んだカード（Task · merged）・ファイルを変えた会話のカード（Session · check it）

interface KanbanProps {
  conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>; onOpenChanges?: (target: ChangesTarget) => void;
}

const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const project = { id: PRODUCT, name: 'Parser' } as Project;
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown };
const realMedia = g.matchMedia;
const BRANCH = 'beat/restore-the-queue-3fa1';
const BASE = '1234567890abcdef1234567890abcdef12345678';
const TIP = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

interface Sent { method: string; path: string; body: unknown }
let sent: Sent[] = [];

function serve(routes: (path: string, method: string) => unknown): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    const out = routes(String(path), method);
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = realMedia;
  sent = [];
});

function task(extra: Partial<Task>): Task {
  return {
    id: 't1', title: 'Restore the queue', body: '', next_action: null, done_criteria: null, status: 'done', origin: 'user', priority: 2,
    cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: 1, updated_at: 2, completed_at: 2, project_id: PRODUCT, ...extra,
  };
}

const worktree = (state: string, extra: Partial<NonNullable<Task['worktree']>> = {}) => ({ id: 'a1b2c3d4', branch: BRANCH, base: BASE, state, files: 2, added: 84, removed: 12, note: null, ...extra });

const item = (id: string): AcceptanceItem => ({ id, result: `result ${id}`, source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null });
const acceptance: Acceptance = {
  version: 3, language: 'en', items: [item('A-1')], not_doing: [], draft: false, hash: 'h3',
  frozen: { version: 3, hash: 'h3', plan_hash: 'p1', created_at: 1, source: 'build', build_task_id: 'b1' },
};

function board(tasks: () => { awaiting: Task[]; finished: Task[] }, extra: (path: string, method: string) => unknown = () => undefined, runs: RunRow[] = [], sessions: string[] = []) {
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  serve((path, method) => {
    const more = extra(path, method);
    if (more !== undefined) return more;
    const now = tasks();
    if (path === '/api/tasks') return { active: [], finished: now.finished, awaiting: now.awaiting };
    if (path === '/api/tasks/finished?limit=20') return { tasks: now.finished, next: null, total: now.finished.length };
    if (path === '/api/runs?limit=500') return { runs, total: 0, judged: {} };
    if (path === '/api/session-checks') return { sessions: sessions.map(id => ({ conversation_id: id, changed_at: 5, checked_at: null })) };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance };
    if (path === `/api/projects/${PRODUCT}/deviations`) {
      return { deviations: { rows: [
        { item: 'A-1', what: 'Kept the old retry count', why: 'the API caps it', task: 't1', date: '2026-11-19', by: 'task', external: false },
        { item: null, what: 'Another task note', why: 'x', task: 'other', date: null, by: 'task', external: false },
      ], unreadable: 0, unusable: false }, flags: { checked: false } };
    }
    return undefined;
  });
}

const props = (extra: Partial<KanbanProps> = {}): KanbanProps => ({ conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map(), ...extra });

test('ui/Kanban（DOM）: 取り込み待ちのタスクは Awaiting check に「Task · merge it」（ブランチ名・+n −n・元のコミット・Mark merged・Open changes・Discard）。ずれの記録はそのタスクの分だけ出る。Mark merged で /merged を送り Done の「Task · merged」へ', async () => {
  let merged = false;
  board(() => (merged ? { awaiting: [], finished: [task({ worktree: worktree('merged') })] } : { awaiting: [task({ worktree: worktree('branch') })], finished: [] }),
    (path, method) => (path === '/api/tasks/t1/merged' && method === 'POST' ? (merged = true, { task: task({ worktree: worktree('merged') }), outcome: 'merged' }) : undefined));
  const opened: ChangesTarget[] = [];
  const { container } = await render(createElement(Kanban, props({ onOpenChanges: target => opened.push(target) })));
  await settle();
  const card = container.querySelector('[data-col="check"] .bt-card')!;
  assert.ok(card, '取り込み待ちのカードが Awaiting check にある');
  assert.ok(byText(card, '.bt-label', 'Task · merge it'));
  assert.ok(card.querySelector('.bt-dot'), '持ち主を待つカードは点が打つ');
  assert.equal(card.querySelector('[data-reasons]')?.textContent, 'Branch ready to merge');
  const line = card.querySelector(`[data-branch="${BRANCH}"]`)!;
  assert.equal(line.querySelector('.bt-tag')?.textContent, BRANCH);
  assert.equal(line.querySelector('.bt-add')?.textContent, '+84');
  assert.equal(line.querySelector('.bt-del')?.textContent, '−12');
  assert.ok(byText(line, 'span', 'from 1234567'));
  assert.deepEqual([...card.querySelectorAll('[data-deviations] .ui-check__text')].map(li => li.firstChild?.textContent), ['Kept the old retry count'], 'このタスクのずれだけ');
  assert.deepEqual([...card.querySelectorAll('.bt-card__actions .bt-btn')].map(b => b.textContent), ['Mark merged', 'Open changes', 'Discard']);
  await click(byText(card, 'button', 'Open changes'));
  assert.deepEqual(opened, [{ productId: PRODUCT, worktreeId: 'a1b2c3d4', branch: BRANCH }], 'ブランチの差分の欄を開く');
  await click(byText(card, 'button', 'Mark merged'));
  await settle();
  assert.deepEqual(sent.filter(s => s.path.startsWith('/api/tasks/')), [{ method: 'POST', path: '/api/tasks/t1/merged', body: {} }]);
  assert.equal(container.querySelector('[data-col="check"] .bt-card'), null);
  const done = container.querySelector('[data-col="done"] .bt-card')!;
  assert.ok(byText(done, '.bt-label', 'Task · merged'), 'Done の Task · merged');
});

test('ui/Kanban（DOM）: 項目も残る取り込み待ちは理由を 2 つとも出し、Mark checked も出す。作業コピーの印（not_on_branch）を 1 行で知らせる', async () => {
  board(() => ({ awaiting: [task({ check_state: 'awaiting', items: { owned: 1, met: 0, remaining: ['A-1'] }, worktree: worktree('branch', { note: 'not_on_branch', added: null, removed: null }) })], finished: [] }));
  const { container } = await render(createElement(Kanban, props({ onOpenChanges: () => undefined })));
  await settle();
  const card = container.querySelector('[data-col="check"] .bt-card')!;
  assert.equal(card.querySelector('[data-reasons]')?.textContent, 'Items to check · Branch ready to merge');
  assert.deepEqual([...card.querySelectorAll('[data-item]')].map(li => li.getAttribute('data-item')), ['A-1']);
  assert.deepEqual([...card.querySelectorAll('.bt-card__actions .bt-btn')].map(b => b.textContent), ['Mark merged', 'Mark checked', 'Open changes', 'Discard']);
  assert.match(card.querySelector('[data-branch-note]')!.textContent!, /moved off its branch/u);
  assert.equal(card.querySelector('.bt-add'), null, '数え終わる前は +n −n を出さない');
});

test('ui/Kanban（DOM）: Discard はブランチのコミットを見せてから確かめ、見せた先端（tip）を送る。Cancel では何も送らない', async () => {
  let gone = false;
  board(() => (gone ? { awaiting: [], finished: [task({ worktree: worktree('discarded') })] } : { awaiting: [task({ worktree: worktree('branch') })], finished: [] }), (path, method) => {
    if (path === '/api/tasks/t1/branch') return { branch: BRANCH, base: BASE, tip: TIP, commits: [{ sha: TIP, subject: 'Restore the queue' }, { sha: BASE.replace('1', '9'), subject: 'wip' }], more: 3 };
    if (path === '/api/tasks/t1/discard' && method === 'POST') { gone = true; return { task: task({ worktree: worktree('discarded') }), outcome: 'discarded' }; }
    return undefined;
  });
  const { container } = await render(createElement(Kanban, props()));
  await settle();
  const card = () => container.querySelector('[data-col="check"] .bt-card')!;
  assert.deepEqual([...card().querySelectorAll('.bt-card__actions .bt-btn')].map(b => b.textContent), ['Mark merged', 'Discard'], 'Open changes は開く先が無ければ出さない');
  await click(byText(card(), 'button', 'Discard'));
  await settle();
  assert.ok(card().classList.contains('is-rejecting'), '確かめの欄を開く（操作のボタンは隠れる）');
  const panel = card().querySelector('[data-discard="t1"]')!;
  assert.match(panel.textContent!, new RegExp(`Delete ${BRANCH} and its working copy\\? These 5 commits are only on that branch`, 'u'));
  assert.deepEqual([...panel.querySelectorAll('.ui-card__commits li')].map(li => li.textContent), ['abcdefa Restore the queue', '9234567 wip', '3 more']);
  await click(byText(panel, 'button', 'Cancel'));
  assert.equal(card().querySelector('[data-discard]'), null);
  assert.deepEqual(sent, []);
  await click(byText(card(), 'button', 'Discard'));
  await settle();
  await click(byText(card(), 'button', 'Discard branch'));
  await settle();
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/tasks/t1/discard', body: { tip: TIP } }]);
  assert.equal(container.querySelector('[data-col="check"] .bt-card'), null);
});

test('ui/Kanban（DOM）: 製品のファイルを変えた会話は Awaiting check の「Session · check it」（Mark checked・Open changes）。ほかの終わった会話は Done のまま', async () => {
  const conversations = [
    { id: 'c-changed', title: 'Fix the parser', project_id: PRODUCT } as Conversation,
    { id: 'c-talk', title: 'Just asked', project_id: PRODUCT } as Conversation,
  ];
  const run = (id: string, conversation: string): RunRow => ({ id, kind: 'chat', conversation_id: conversation, started_at: 10, duration_ms: 5, ok: 1, error_kind: null } as RunRow);
  let checked = false;
  board(() => ({ awaiting: [], finished: [] }), (path, method) => {
    if (path === '/api/conversations/c-changed/checked' && method === 'POST') { checked = true; return { conversation_id: 'c-changed', checked_at: 9 }; }
    if (path === '/api/session-checks') return { sessions: checked ? [] : [{ conversation_id: 'c-changed', changed_at: 15, checked_at: null }] };
    return undefined;
  }, [run('r1', 'c-changed'), run('r2', 'c-talk')]);
  const opened: ChangesTarget[] = [];
  const { container } = await render(createElement(Kanban, props({ conversations, onOpenChanges: target => opened.push(target) })));
  await settle();
  const card = container.querySelector('[data-col="check"] [data-session="c-changed"]')!;
  assert.ok(card, 'ファイルを変えた会話は Awaiting check');
  assert.ok(byText(card, '.bt-label', 'Session · check it'));
  assert.equal(card.querySelector('[data-reasons]')?.textContent, 'Changed product files');
  assert.ok(container.querySelector('[data-col="done"] [data-session="c-talk"]'), '話しただけの会話は Done');
  await click(byText(card, 'button', 'Open changes'));
  assert.deepEqual(opened, [{ productId: PRODUCT, conversationId: 'c-changed' }]);
  await click(byText(card, 'button', 'Mark checked'));
  await settle();
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/conversations/c-changed/checked', body: {} }]);
  assert.ok(container.querySelector('[data-col="done"] [data-session="c-changed"]'), '確かめたら Done へ移る');
});
