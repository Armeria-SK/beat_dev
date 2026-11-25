import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Project, Task, WaitReason } from '../web/src/api.ts';
import { buildBoard, columnOf, exhausted, type Board, type ColumnId } from '../web/src/ui/kanban.ts';
import { cleanup, loadTsx, render, update } from './helpers/dom.ts';

// BL-judge-tasks 320（と 210 の画面の側）: やり直しを使い切った ready のタスクは、ワーカーが選ばない（pickNext は attempts < max_attempts だけ、Run now は予定を戻して動かし直す）。
// なのに Approved の「next in queue」の札が付く。使い切ったものは Approved に置かず Failed に置く（札は Approved の先頭のカードだけに付く）

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});
const ids = (board: Board, column: ColumnId): string[] => board.columns.find(c => c.id === column)!.cards.map(card => (card.kind === 'task' ? card.task.id : `s:${card.conversationId}`));
const board = (active: Task[]): Board => buildBoard({ active, finished: [], hasMore: false, finishedTotal: 0, sessions: [] });

test('ui/kanban（320）: ready でやり直しを使い切ったタスク（attempts が max_attempts 以上）は Approved でなく Failed の列に入る。残りがあるものは今までどおり Approved', () => {
  assert.equal(exhausted(task('a', 'ready', { attempts: 3 })), true);
  assert.equal(exhausted(task('a', 'ready', { attempts: 4 })), true);
  assert.equal(exhausted(task('a', 'ready', { attempts: 2 })), false);
  assert.equal(exhausted(task('a', 'running', { attempts: 3 })), false, 'ready 以外は数えない');
  assert.equal(columnOf(task('a', 'ready', { attempts: 3 })), 'failed');
  assert.equal(columnOf(task('a', 'ready', { attempts: 2 })), 'approved');
  assert.equal(columnOf(task('a', 'ready', { attempts: 0, max_attempts: 1 })), 'approved');
  assert.equal(columnOf(task('a', 'ready', { attempts: 1, max_attempts: 1 })), 'failed');
  const b = board([task('spent', 'ready', { attempts: 3 }), task('live', 'ready', { attempts: 1 }), task('timed', 'ready', { attempts: 3, run_at: Date.now() + 3_600_000 })]);
  assert.deepEqual(ids(b, 'approved'), ['live']);
  assert.deepEqual(ids(b, 'failed').sort(), ['spent', 'timed']);
});

test('ui/kanban（320）: 繰り返しのひな形・取り消し・失敗のタスクの列は変わらない', () => {
  assert.equal(columnOf(task('t', 'scheduled', { cron: '0 9 * * *', attempts: 3 })), null);
  assert.equal(columnOf(task('t', 'ready', { cron: '0 9 * * *', attempts: 3 })), null, 'ひな形はどの列にも出ない');
  assert.equal(columnOf(task('f', 'failed', { attempts: 3 })), 'failed');
  assert.equal(columnOf(task('c', 'cancelled', { attempts: 3 })), 'failed');
  assert.equal(columnOf(task('i', 'inbox', { attempts: 3 })), 'proposed');
});

interface KanbanProps {
  conversations: never[]; drafts: never[]; checklists: Map<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: Map<string, number>; questionsByTask: Map<string, number>; waits?: Record<string, WaitReason>;
}

const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);

const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown };
const realMatchMedia = g.matchMedia;

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = realMatchMedia;
  window.location.hash = '';
});

test('ui/Kanban（DOM）: 使い切ったタスクのカードに「next in queue」は付かない。付くのは、ワーカーが次に選ぶ Approved の先頭のカード', async () => {
  const PRODUCT = 'prod-abc123';
  const tasks = [
    task('spent', 'ready', { title: 'Spent task', attempts: 3, priority: 1, project_id: PRODUCT }),
    task('live', 'ready', { title: 'Live task', attempts: 1, priority: 2, project_id: PRODUCT }),
  ];
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const out = url === '/api/tasks' ? { active: tasks, finished: [] } : url === '/api/tasks/finished?limit=20' ? { tasks: [], next: null, total: 0 } : url === '/api/runs?limit=500' ? { runs: [], total: 0, judged: {} } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const props: KanbanProps = { conversations: [], drafts: [], checklists: new Map<string, never[]>(), revision: 0, projects: [{ id: PRODUCT, name: 'Parser' } as Project], pendingByTask: new Map(), questionsByTask: new Map() };
  const { container } = await render(createElement(Kanban, props));
  await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  const card = (title: string): Element => [...container.querySelectorAll('.bt-card')].find(c => c.textContent?.includes(title))!;
  assert.ok(!card('Spent task').textContent!.includes('next in queue'), card('Spent task').textContent!);
  assert.ok(card('Live task').textContent!.includes('next in queue'), card('Live task').textContent!);
  assert.equal(card('Spent task').closest('[data-col]')?.getAttribute('data-col'), 'failed');
  assert.equal(card('Live task').closest('[data-col]')?.getAttribute('data-col'), 'approved');
});
