import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { NotificationItem, Project, Task } from '../web/src/api.ts';

// beat 5-u2: Pending 待ちのタスクの画面（Answer を出さず、Pending への行き先を出す）と、知らせの一覧の行き先のボタン。

interface TaskProps { id: string; revision: string; worker: null; projects: readonly Project[]; pending: number }
interface NotificationsProps { unread: number; epoch: number; onUnread: (count: number) => void; projects: readonly Project[] }

const { TaskScreen } = await loadTsx<{ TaskScreen: ComponentType<TaskProps> }>('../web/src/ui/screens/Task.tsx', import.meta.url);
const { Notifications } = await loadTsx<{ Notifications: ComponentType<NotificationsProps> }>('../web/src/ui/screens/Notifications.tsx', import.meta.url);

const realFetch = globalThis.fetch;

function serve(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const body = routes[String(path)];
    return new Response(JSON.stringify(body ?? { error: 'not found' }), { status: body === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.location.hash = '';
});

const PRODUCT = 'prod-abc123';

function task(extra: Partial<Task>): Task {
  return {
    id: 't1', title: 'Ship the parser', body: '', next_action: null, done_criteria: null, status: 'waiting', origin: 'user', priority: 2,
    cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: 1, updated_at: 2, completed_at: null, project_id: PRODUCT, ...extra,
  };
}

const project = { id: PRODUCT, name: 'Parser' } as Project;

async function renderTask(t: Task, pending = 0) {
  serve({ '/api/tasks/t1': { task: t, events: [], runs: [] } });
  const rendered = await render(createElement(TaskScreen, { id: 't1', revision: '0', worker: null, projects: [project], pending }));
  await settle();
  return rendered.container;
}

test('ui/Task（DOM）: Pending の承認を待つタスクには Answer の欄を出さず、「Waiting on Pending #12, #13」と Pending への行き先を出す', async () => {
  const container = await renderTask(task({ waiting_kind: 'approval', waiting_text: '#12, #13' }));
  assert.ok(byText(container, 'h1', 'Ship the parser'), '画面が描けている');
  assert.equal(container.querySelector('textarea'), null, 'Answer の欄が無い');
  assert.equal(byText(container, 'button', 'Send answer'), undefined);
  assert.ok(byText(container, '.bt-label', 'Waiting on Pending #12, #13'));
  assert.equal(byText(container, 'a', 'Open Pending')?.getAttribute('href'), `#/pending/${PRODUCT}`);
});

test('ui/Task（DOM）: 質問の返事待ちのタスクには、今までどおり Answer の欄を出す', async () => {
  const container = await renderTask(task({ waiting_kind: 'question', waiting_text: 'Which name?' }));
  assert.ok(container.querySelector('textarea'), 'Answer の欄がある');
  assert.equal(byText(container, '.bt-label', 'Waiting on Pending'), undefined);
});

const note = (id: number, extra: Partial<NotificationItem>): NotificationItem =>
  ({ id, kind: 'info', title: `n${id}`, body: null, link: null, read_at: null, created_at: Date.now() - id, ...extra });

test('ui/Notifications（DOM）: 行のボタンは行き先の名前（Open Pending / Open Questions / Retry）。押すとその場所へ行き、Approve・Answer は置かない', async () => {
  serve({
    '/api/notifications': {
      unread: 3,
      notifications: [
        note(1, { kind: 'approval_needed', title: 'Parked', link: '#/pending', project_id: PRODUCT }),
        note(2, { kind: 'question_new', title: 'New question', project_id: PRODUCT, action: 'questions' }),
        note(3, { kind: 'task_failed', title: 'Failed', link: '#/tasks/t9', action: 'retry' }),
      ],
    },
    '/api/notifications/read': { unread: 2 },
  });
  const { container } = await render(createElement(Notifications, { unread: 3, epoch: 0, onUnread: () => {}, projects: [project] }));
  await settle();
  const labels = [...container.querySelectorAll('.ui-notif button')].map(b => b.textContent);
  assert.deepEqual(labels, ['Open Pending', 'Open Questions', 'Retry']);
  for (const word of ['Approve', 'Answer', 'Reject']) assert.equal(byText(container, 'button', word), undefined, word);
  await click(byText(container, 'button', 'Open Pending'));
  assert.equal(window.location.hash, `#/pending/${PRODUCT}`);
  await click(byText(container, 'button', 'Retry'));
  assert.equal(window.location.hash, '#/tasks/t9');
});

interface KanbanProps {
  conversations: never[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>;
}
const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);

test('ui/Kanban（DOM）: Pending 待ちのカードは「Waiting on Pending #12」を Pending へのリンクで出し、Approve も「Pending · N」の重ねたリンクも置かない', async () => {
  const g = globalThis as { matchMedia?: unknown };
  const before = g.matchMedia;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  try {
    const parked = task({ id: 't1', waiting_kind: 'approval', waiting_text: '#12' });
    const asking = task({ id: 't2', title: 'Pick a name', waiting_kind: 'question', waiting_text: 'Which name?' });
    serve({
      '/api/tasks': { active: [parked, asking], finished: [] },
      '/api/tasks/finished?limit=20': { tasks: [], next: null, total: 0 },
      '/api/runs?limit=500': { runs: [], total: 0, judged: {} },
    });
    const { container } = await render(createElement(Kanban, {
      conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project], pendingByTask: new Map([['t1', 1], ['t2', 1]]), questionsByTask: new Map(),
    }));
    await settle();
    const link = container.querySelector('[data-pending-wait="t1"]');
    assert.equal(link?.textContent, 'Waiting on Pending #12');
    assert.equal(link?.getAttribute('href'), `#/pending/${PRODUCT}`);
    const card = link?.closest('.bt-card');
    assert.equal(byText(card!, 'a', 'Pending · 1'), undefined, '同じ行き先のリンクを 2 つ置かない');
    assert.equal(byText(card!, 'button', 'Approve'), undefined);
    assert.equal(container.querySelector('[data-pending-wait="t2"]'), null, '質問の返事待ちは Pending 待ちではない');
    assert.ok(byText(container, '.bt-card__body', 'Which name?'));
  } finally {
    g.matchMedia = before;
  }
});
