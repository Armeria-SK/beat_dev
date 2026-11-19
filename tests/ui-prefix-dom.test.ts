import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, PreFix, Project, Proposal, Task } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import { PREFIX_DIFF_LINES, prefixDiff, prefixOf, type ChangesTarget } from '../web/src/ui/kanban.ts';
import { runTaskOp, type TaskOpDeps } from '../web/src/ui/task-ops.ts';

// beat 8-6c: the Pre-fix card (Proposed → Awaiting check "Pre-fix · merge it" → Done "Pre-fix · merged") and the thinking mode switch with "Research and pre-fix"

interface KanbanProps {
  conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>; onOpenChanges?: (target: ChangesTarget) => void;
}
interface HomeProps { id: string; project: Project | undefined; conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; worker: null; revision: number; onProject?: (p: Project) => void }

const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);
const { ProductHome } = await loadTsx<{ ProductHome: ComponentType<HomeProps> }>('../web/src/ui/screens/ProductHome.tsx', import.meta.url);
const { ProductSettings } = await loadTsx<{ ProductSettings: ComponentType<{ project: Project; onProject: (p: Project) => void }> }>('../web/src/ui/screens/ProductSettings.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const BRANCH = 'beat/queue-restore-3fa1';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown };
const realMedia = g.matchMedia;

const project = (over: Partial<Project> = {}): Project => ({
  id: PRODUCT, name: 'Uploader', root: '/w/up', check_command: 'npm test', scout_mode: 'research', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

const DIFF = ['-    for (let i = 0; i < items.length - 1; i++)', '+    for (let i = 0; i < items.length; i++)', '+<b>bold</b> **not markdown** [link](http://x)', '-a', '+b', '-c', '+seventh line', '-eighth line'];
const PREFIX: PreFix = { branch: BRANCH, base: '1234567890abcdef1234567890abcdef12345678', checks: 'passed', files: 1, added: 4, removed: 4, diff: DIFF };
const proposal = (prefix: PreFix | null): Proposal => ({
  kind: 'bug', why: 'The loop stops one short when the queue is restored from disk. A second sentence stays off the pre-fix card.', area: ['src/upload/'], size: 'S', goal: 'Reliable uploads', evidence: null, ledger: null, prefix,
});
const worktree = (state: string) => ({ id: 'f1e2d3c4', branch: BRANCH, base: PREFIX.base, state, files: 1, added: 4, removed: 4, note: null });

function task(extra: Partial<Task>): Task {
  return {
    id: 't1', title: 'Queue drops the last item on restart', body: '', next_action: null, done_criteria: null, status: 'inbox', origin: 'self', priority: 2,
    cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000, completed_at: null, project_id: PRODUCT, proposal: proposal(PREFIX), ...extra,
  };
}

interface Sent { method: string; path: string; body: unknown }
let sent: Sent[] = [];
const toasts: FeedbackItem[] = [];
const unsubscribe = subscribe(item => { toasts.push(item); });

function serve(routes: (path: string, method: string) => { status?: number; body: unknown } | undefined): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    const out = routes(String(path), method);
    return new Response(JSON.stringify(out?.body ?? { error: 'not found' }), { status: out ? out.status ?? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function board(tasks: () => { active: Task[]; finished: Task[]; awaiting: Task[] }, extra: (path: string, method: string) => { status?: number; body: unknown } | undefined = () => undefined) {
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  serve((path, method) => {
    const more = extra(path, method);
    if (more !== undefined) return more;
    const now = tasks();
    if (path.startsWith('/api/tasks/finished')) return { body: { tasks: now.finished, next: null, total: now.finished.length } };
    if (path.startsWith('/api/tasks')) return { body: { active: now.active, finished: [], awaiting: now.awaiting } };
    if (path.startsWith('/api/runs')) return { body: { runs: [], total: 0, judged: {} } };
    if (path.startsWith('/api/session-checks')) return { body: { sessions: [] } };
    if (path.includes('/deviations')) return { body: { deviations: { rows: [], unreadable: 0, unusable: false }, flags: { checked: false } } };
    if (path.startsWith('/api/background')) return { body: { items: [] } };
    return undefined;
  });
}

const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const props = (extra: Partial<KanbanProps> = {}): KanbanProps => ({ conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project()], pendingByTask: new Map(), questionsByTask: new Map(), ...extra });
const cardIn = (container: HTMLElement, column: string) => container.querySelector<HTMLElement>(`[data-col="${column}"] article.bt-card[data-task="t1"]`);

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = realMedia;
  sent = [];
  toasts.length = 0;
});
process.on('exit', unsubscribe);

test('ui/kanban (8-6c): prefixDiff keeps at most 6 lines, shows "+" and "−" as signs and keeps the rest of the line as written; prefixOf is null without a prefix', () => {
  assert.equal(PREFIX_DIFF_LINES, 6);
  const lines = prefixDiff(DIFF);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.slice(0, 3), [
    { kind: 'del', text: '−     for (let i = 0; i < items.length - 1; i++)' },
    { kind: 'add', text: '+     for (let i = 0; i < items.length; i++)' },
    { kind: 'add', text: '+ <b>bold</b> **not markdown** [link](http://x)' },
  ]);
  assert.deepEqual(prefixDiff(['context']), [{ kind: 'same', text: '  context' }]);
  assert.deepEqual(prefixDiff([]), []);
  assert.equal(prefixOf({ proposal: proposal(null) }), null);
  assert.equal(prefixOf({ proposal: { kind: 'bug', why: '', area: [], size: 'S', goal: null, evidence: null, ledger: null } }), null, 'a proposal from before 8-6b has no prefix key');
  assert.equal(prefixOf({ proposal: null }), null);
  assert.equal(prefixOf({ proposal: proposal(PREFIX) })?.branch, BRANCH);
});

test('ui/Kanban（DOM, 8-6c）: a pre-fix in Proposed reads "Pre-fix · bug" with "Checks passed", one sentence, the diff (6 lines, as plain text, not Markdown), the branch, and Approve / Open diff / Reject', async () => {
  board(() => ({ active: [task({ worktree: worktree('branch') })], finished: [], awaiting: [] }));
  const opened: ChangesTarget[] = [];
  const { container } = await render(createElement(Kanban, props({ onOpenChanges: target => { opened.push(target); } })));
  await settle();
  const card = cardIn(container, 'proposed')!;
  assert.ok(card, 'the pre-fix card is in Proposed');
  assert.equal(card.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.prefix.bug']);
  assert.equal(card.querySelector('.bt-card__head .bt-pill--ok')?.textContent, en['ui.kanban.prefix.checks']);
  assert.equal(card.querySelector('.bt-card__body')?.textContent, 'The loop stops one short when the queue is restored from disk.');
  const diff = card.querySelector('[data-prefix-diff]')!;
  assert.ok(diff.classList.contains('bt-diff'));
  assert.equal(diff.querySelector('.bt-diff__file')?.textContent, '1 file+4 −4');
  const lines = [...diff.querySelectorAll('.bt-diff__line')];
  assert.equal(lines.length, 6, 'no more than six diff lines on the card');
  assert.deepEqual(lines.map(line => line.className), [
    'bt-diff__line bt-diff__line--del', 'bt-diff__line bt-diff__line--add', 'bt-diff__line bt-diff__line--add', 'bt-diff__line bt-diff__line--del', 'bt-diff__line bt-diff__line--add', 'bt-diff__line bt-diff__line--del',
  ]);
  assert.equal(lines[2]!.textContent, '+ <b>bold</b> **not markdown** [link](http://x)');
  assert.equal(diff.querySelector('b, strong, a, em'), null, 'the diff text is never parsed as HTML or Markdown');
  assert.ok(!diff.textContent?.includes('seventh line'));
  assert.ok([...card.querySelectorAll('.bt-card__meta span')].some(span => span.textContent === BRANCH), 'the branch name is on the card');
  const actions = [...card.querySelectorAll('.bt-card__actions button')].map(b => b.textContent);
  assert.deepEqual(actions, [en['ui.kanban.approve'], en['ui.kanban.prefix.openDiff'], en['ui.kanban.reject']]);
  await click(byText(card, 'button', en['ui.kanban.prefix.openDiff']));
  assert.deepEqual(opened, [{ productId: PRODUCT, worktreeId: 'f1e2d3c4', branch: BRANCH }], 'Open diff opens the branch diff in the Changes pane');
});

test('ui/Kanban（DOM, 8-6c）: without a working-copy row the pre-fix card has no Open diff (it would show the product Changes instead); a proposal without prefix keeps the plain proposal card', async () => {
  board(() => ({ active: [task({}), task({ id: 't2', title: 'Plain', proposal: proposal(null) })], finished: [], awaiting: [] }));
  const { container } = await render(createElement(Kanban, props({ onOpenChanges: () => {} })));
  await settle();
  const card = cardIn(container, 'proposed')!;
  assert.equal(byText(card, 'button', en['ui.kanban.prefix.openDiff']), undefined);
  assert.ok(card.querySelector('[data-prefix-diff]'));
  const plain = container.querySelector<HTMLElement>('[data-col="proposed"] article[data-task="t2"]')!;
  assert.equal(plain.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.proposal.bug']);
  assert.equal(plain.querySelector('.bt-diff'), null);
  assert.equal(plain.querySelector('.bt-pill--ok'), null);
  assert.equal(plain.querySelector('.bt-card__body')?.textContent, 'The loop stops one short when the queue is restored from disk. A second sentence stays off the pre-fix card.');
  assert.deepEqual([...plain.querySelectorAll('.bt-card__actions button')].map(b => b.textContent), [en['ui.kanban.approve'], en['ui.kanban.reject']]);
});

test('ui/Kanban（DOM, 8-6c）: Approve posts approve and says the branch is ready to merge; the card moves to Awaiting check as "Pre-fix · merge it" (Mark merged, Open changes); merged, it is "Pre-fix · merged" in Done', async () => {
  let state: 'proposed' | 'branch' | 'merged' = 'proposed';
  board(() => (state === 'proposed' ? { active: [task({ worktree: worktree('branch') })], finished: [], awaiting: [] }
    : state === 'branch' ? { active: [], finished: [], awaiting: [task({ status: 'done', origin: 'user', completed_at: Date.now(), worktree: worktree('branch') })] }
    : { active: [], finished: [task({ status: 'done', origin: 'user', completed_at: Date.now(), worktree: worktree('merged') })], awaiting: [] }),
  (path, method) => {
    if (path === '/api/tasks/t1/approve' && method === 'POST') { state = 'branch'; return { body: { task: task({ status: 'done' }) } }; }
    if (path === '/api/tasks/t1/merged' && method === 'POST') { state = 'merged'; return { body: { task: task({ status: 'done' }), outcome: 'merged' } }; }
    return undefined;
  });
  const { container } = await render(createElement(Kanban, props({ onOpenChanges: () => {} })));
  await settle();
  await click(byText(cardIn(container, 'proposed')!, 'button', en['ui.kanban.approve']));
  await settle();
  assert.deepEqual(sent.map(s => s.path), ['/api/tasks/t1/approve']);
  const approved = toasts.find(item => item.title === en['ui.task.toast.prefixApproved']);
  assert.ok(approved, 'the pre-fix approve toast');
  assert.equal(approved.body, `Branch ${BRANCH} is ready to merge`);
  assert.equal(approved.action, undefined, 'no Undo: approving a pre-fix finishes the proposal');
  const check = cardIn(container, 'check')!;
  assert.ok(check, 'the approved pre-fix waits in Awaiting check');
  assert.equal(check.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.prefix.mergeIt']);
  assert.ok(byText(check, 'button', en['ui.kanban.markMerged']));
  assert.ok(byText(check, 'button', en['ui.kanban.openChanges']));
  assert.equal(check.querySelector('[data-prefix-diff]'), null);
  await click(byText(check, 'button', en['ui.kanban.markMerged']));
  await settle();
  const done = cardIn(container, 'done')!;
  assert.ok(done);
  assert.equal(done.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.prefix.merged']);
});

test('ui/Kanban（DOM, 8-6c）: Reject on a pre-fix asks for a reason, posts cancel, and its toast has no Undo (the branch is gone)', async () => {
  board(() => ({ active: [task({ worktree: worktree('branch') })], finished: [], awaiting: [] }),
    (path, method) => (path === '/api/tasks/t1/cancel' && method === 'POST' ? { body: { task: task({ status: 'cancelled' }) } } : undefined));
  const { container } = await render(createElement(Kanban, props()));
  await settle();
  const card = cardIn(container, 'proposed')!;
  await click(byText(card, 'button', en['ui.kanban.reject']));
  const form = card.querySelector('form.bt-card__reason')!;
  await click(byText(form as HTMLElement, 'button', en['ui.kanban.reject']));
  await settle();
  assert.deepEqual(sent.map(s => [s.path, s.body]), [['/api/tasks/t1/cancel', {}]]);
  const rejected = toasts.find(item => item.title === en['ui.task.toast.rejected']);
  assert.ok(rejected);
  assert.equal(rejected.action, undefined);
});

test('ui/task-ops (8-6c): a plain proposal keeps the Undo on approve and reject; a pre-fix does not', async () => {
  const run = async (prefixBranch?: string) => {
    const toastsSeen: FeedbackItem[] = [];
    const reply = async () => ({ task: { id: 't1' } }) as never;
    const deps: TaskOpDeps = { api: { taskAction: reply, unapproveTask: reply, cancelTask: reply, answerTask: reply, stop: reply }, toast: item => { toastsSeen.push(item); } };
    await runTaskOp('approve', { id: 't1', title: 'x' }, { prefixBranch }, deps);
    await runTaskOp('reject', { id: 't1', title: 'x' }, { reason: '', prefixBranch }, deps);
    return toastsSeen.map(item => [item.title, item.action !== undefined]);
  };
  assert.deepEqual(await run(), [[en['ui.task.toast.approved'], true], [en['ui.task.toast.rejected'], true]]);
  assert.deepEqual(await run(BRANCH), [[en['ui.task.toast.prefixApproved'], false], [en['ui.task.toast.rejected'], false]]);
});

test('ui/ProductHome（DOM, 8-6c）: with a check command "Research and pre-fix" is pressable and sends PATCH scoutMode fix; the mini board tags a pre-fix proposal "pre-fix"', async () => {
  let saved: Project | null = null;
  board(() => ({ active: [task({}), task({ id: 't2', title: 'Plain', proposal: proposal(null) })], finished: [], awaiting: [] }),
    (path, method) => (path === `/api/projects/${PRODUCT}` && method === 'PATCH' ? { body: { project: project({ scout_mode: 'fix' }) } } : undefined));
  const { container } = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0, onProject: p => { saved = p; } }));
  await settle();
  const fix = container.querySelector<HTMLButtonElement>('.ui-home__mode [data-mode="fix"]')!;
  assert.equal(fix.disabled, false);
  assert.ok(!fix.textContent?.includes(en['ui.scout.mode.needsCheck']));
  await click(fix);
  await settle();
  assert.deepEqual(sent.find(s => s.method === 'PATCH')?.body, { scoutMode: 'fix' });
  assert.equal((saved as Project | null)?.scout_mode, 'fix');
  const tags = [...container.querySelectorAll('.bt-mini')].map(mini => [mini.querySelector('.bt-mini__name')?.textContent, mini.querySelector('.bt-tag')?.textContent ?? null]);
  assert.ok(tags.some(([name, tag]) => name === 'Queue drops the last item on restart' && tag === en['ui.kanban.prefix.tag']), JSON.stringify(tags));
  assert.ok(tags.some(([name, tag]) => name === 'Plain' && tag === null), JSON.stringify(tags));
});

test('ui/ProductHome（DOM, 8-6c）: when the server says the product has no check command (400 scout_fix_needs_check), the toast says "Needs a check command" and links to the product settings; the mode stays', async () => {
  let saved: Project | null = null;
  board(() => ({ active: [], finished: [], awaiting: [] }),
    (path, method) => (path === `/api/projects/${PRODUCT}` && method === 'PATCH' ? { status: 400, body: { error: 'project', code: 'project.scout_fix_needs_check', message: 'Add a check command first' } } : undefined));
  const { container } = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0, onProject: p => { saved = p; } }));
  await settle();
  await click(container.querySelector<HTMLButtonElement>('.ui-home__mode [data-mode="fix"]')!);
  await settle();
  const needs = toasts.find(item => item.title === en['ui.scout.mode.needsCheck']);
  assert.ok(needs, JSON.stringify(toasts));
  assert.equal(needs.href, `#/p/${PRODUCT}/settings`);
  assert.equal(saved, null);
});

test('ui/ProductSettings（DOM, 8-6c）: the product settings have the same mode switch; without a saved check command pre-fix is not pressable', async () => {
  serve((path, method) => (path === `/api/projects/${PRODUCT}` && method === 'PATCH' ? { body: { project: project({ scout_mode: 'off' }) } } : undefined));
  const { container } = await render(createElement(ProductSettings, { project: project({ check_command: null }), onProject: () => {} }));
  const options = [...container.querySelectorAll<HTMLButtonElement>('[data-scout-mode] .bt-seg__opt')];
  assert.deepEqual(options.map(o => o.dataset.mode), ['off', 'research', 'fix']);
  assert.deepEqual(options.map(o => o.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.equal(options[2]!.disabled, true);
  assert.ok(options[2]!.textContent?.includes(en['ui.scout.mode.needsCheck']));
  await click(options[0]!);
  await settle();
  assert.deepEqual(sent.map(s => [s.method, s.body]), [['PATCH', { scoutMode: 'off' }]]);
});
