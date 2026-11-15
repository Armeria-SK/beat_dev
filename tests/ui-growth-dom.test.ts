import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChecklistItem, Conversation, GrowthBucket, GrowthStats, Project, WorkerStatus } from '../web/src/api.ts';
import { getTimezone } from '../web/src/i18n/index.ts';
import { emptyGrowthBucket, monthKey } from '../web/src/ui/growth.ts';
import type { LiveDraft } from '../web/src/ui/live-state.ts';

interface SectionProps { id: string; createdAt: number; revision: number; index: number }
interface HomeProps { id: string; project: Project | undefined; conversations: Conversation[]; drafts: LiveDraft[]; checklists: ReadonlyMap<string, ChecklistItem[]>; worker: WorkerStatus | null; revision: number }

const scope = globalThis as unknown as Record<string, unknown>;
scope.addEventListener ??= window.addEventListener.bind(window);
scope.removeEventListener ??= window.removeEventListener.bind(window);

const { GrowthSection } = await loadTsx<{ GrowthSection: ComponentType<SectionProps> }>('../web/src/ui/screens/GrowthSection.tsx', import.meta.url);
const { ProductHome } = await loadTsx<{ ProductHome: ComponentType<HomeProps> }>('../web/src/ui/screens/ProductHome.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

const DAY = 86_400_000;
const thisMonth = () => monthKey(Date.now(), getTimezone());
const lastMonth = () => monthKey(new Date(`${thisMonth()}-01T00:00:00Z`).getTime() - 2 * DAY, getTimezone());

function bucket(month: string, over: Partial<GrowthBucket> = {}): GrowthBucket {
  return { ...emptyGrowthBucket(month, 'p1aaaa'), ...over };
}

const busy = (month: string): GrowthBucket => bucket(month, {
  tasks: 2, judgeAsked: 3, pending: 1,
  questions: {
    asked: 8, perTask: 4, answered: 4, kept: 3, keptRate: 0.75, noAssumption: 4,
    byCategory: [{ category: 'scope', asked: 4, answered: 3, kept: 2, keptRate: 2 / 3, noAssumption: 1 }, { category: 'ui', asked: 2, answered: 0, kept: 0, keptRate: null, noAssumption: 2 }],
  },
  checks: { decisions: 4, notEnough: 1, notEnoughShare: 0.25 },
  skills: [{ name: 'release-notes', uses: 5, taskUses: 4, chatUses: 1, tasks: 4, done: 2, failed: 1, cancelled: 0, unfinished: 1 }],
});

type Reply = { status: number; body: unknown };

function serve(growth: (url: URL) => Reply | Promise<Reply>): URL[] {
  const seen: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost/');
    let reply: Reply = { status: 200, body: {} };
    if (url.pathname === '/api/growth/stats') { seen.push(url); reply = await growth(url); }
    else if (url.pathname === '/api/tasks') reply = { status: 200, body: { active: [], finished: [], awaiting: [] } };
    else if (url.pathname === '/api/tasks/finished') reply = { status: 200, body: { tasks: [], next: null, total: 0 } };
    else if (url.pathname === '/api/runs') reply = { status: 200, body: { runs: [], total: 0, judged: {} } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const stats = (month: string, buckets: GrowthBucket[], since: number | null = null): GrowthStats => ({ month, projectId: 'p1aaaa', skillsCountedSince: since, buckets });
const settle = (ms = 30) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const figure = (container: HTMLElement, id: string) => container.querySelector(`[data-growth="${id}"]`);

async function section(createdAt = Date.now()) {
  const { container } = await render(createElement(GrowthSection, { id: 'p1aaaa', createdAt, revision: 0, index: 7 }));
  await settle();
  return container;
}

test('Growth（DOM）: 数が 0 の月も欄を隠さずに出す。割合は「—」、表の代わりに短い 1 行、数え始めが無いと言う。光る色は使わない', async () => {
  const seen = serve(url => ({ status: 200, body: stats(url.searchParams.get('month')!, []) }));
  const container = await section();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.searchParams.get('project'), 'p1aaaa');
  assert.equal(seen[0]!.searchParams.get('month'), thisMonth());
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '—');
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-meta')?.textContent, '0 questions · 0 tasks run');
  assert.equal(figure(container, 'kept')?.querySelector('.bt-stat__n')?.textContent, '—');
  assert.equal(figure(container, 'kept')?.querySelector('.bt-meta')?.textContent, '0 of 0 answered · 0 asked without a provisional answer');
  assert.equal(figure(container, 'notEnough')?.querySelector('.bt-stat__n')?.textContent, '—');
  assert.equal(figure(container, 'line')?.textContent, 'the judge asked 0 times · 0 sent to Pending');
  assert.ok(byText(container, '.bt-meta', 'No questions from the AI this month'));
  assert.equal(figure(container, 'others'), null, '0 のときは出さない');
  assert.ok(byText(container, '.bt-meta', 'No skills used this month'));
  assert.equal(figure(container, 'since')?.textContent, 'No tool calls recorded yet');
  assert.equal(container.querySelector('table'), null);
  assert.equal(container.querySelector('.bt-stat--waiting, .bt-dot, .bt-pill--running'), null, '成長の数は待ちではない');
});

test('Growth（DOM）: 1 か月ぶんの数。当たり率は仮の答えのある質問だけで割ったと書く。種類とスキルの表、スキルを数え始めた日', async () => {
  const month = thisMonth();
  serve(() => ({ status: 200, body: stats(month, [busy(month)], Date.UTC(2026, 10, 1, 3, 0)) }));
  const container = await section();
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '4');
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-meta')?.textContent, '8 questions · 2 tasks run', 'タスクあたりは止まったタスクや確かめの質問も入れた数');
  assert.equal(figure(container, 'kept')?.querySelector('.bt-label')?.textContent, 'Provisional answers kept');
  assert.equal(figure(container, 'kept')?.querySelector('.bt-stat__n')?.textContent, '67%', 'AI の質問だけの当たり率（全体の 75% ではない）');
  assert.equal(figure(container, 'kept')?.querySelector('.bt-meta')?.textContent, '2 of 3 answered · 3 asked without a provisional answer');
  assert.equal(figure(container, 'notEnough')?.querySelector('.bt-stat__n')?.textContent, '25%');
  assert.equal(figure(container, 'notEnough')?.querySelector('.bt-meta')?.textContent, '1 of 4 checks');
  assert.equal(figure(container, 'line')?.textContent, 'the judge asked 3 times · 1 sent to Pending');
  const cells = (selector: string) => [...container.querySelectorAll(`${selector} th, ${selector} td`)].map(cell => cell.textContent);
  assert.deepEqual(cells('[data-category="scope"]'), ['Scope', '4', '3', '2', '67%', '1']);
  assert.deepEqual(cells('[data-category="ui"]'), ['UI', '2', '0', '0', '—', '2']);
  assert.equal(container.querySelector('[data-category="scope"] th')?.getAttribute('scope'), 'row');
  assert.equal(figure(container, 'others')?.textContent, '2 more from stuck tasks and failed checks');
  const tables = [...container.querySelectorAll('table')].map(table => container.querySelector(`[id="${table.getAttribute('aria-labelledby')}"]`)?.textContent);
  assert.deepEqual(tables, ['Questions from the AI by category', 'Skills']);
  assert.ok(byText(container, '.bt-meta', 'Answered and kept count only questions with a provisional answer'));
  assert.ok(byText(container, 'th', 'None assumed'));
  assert.deepEqual(cells('[data-skill="release-notes"]'), ['release-notes', '5', '1', '4', '2', '1', '0', '1']);
  assert.match(figure(container, 'since')?.textContent ?? '', /^Skill results counted since 2026\/11\/01 \d{2}:\d{2}$/u);
});

test('Growth（DOM）: 月を選び替えると、その月を読み直して出す。選べる月は今月から製品を作った月まで', async () => {
  const now = thisMonth();
  const before = lastMonth();
  const seen = serve(url => {
    const month = url.searchParams.get('month')!;
    return { status: 200, body: stats(month, month === before ? [busy(month)] : []) };
  });
  const container = await section(new Date(`${before}-15T00:00:00Z`).getTime());
  const select = container.querySelector('select');
  assert.deepEqual([...(select?.options ?? [])].map(o => o.value), [now, before]);
  assert.equal(select?.getAttribute('aria-label'), 'Month');
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '—');
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, before);
    select!.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle(250);
  assert.equal(seen.at(-1)?.searchParams.get('month'), before);
  assert.equal(select?.value, before);
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '4');
});

test('Growth（DOM）: 選び替えた月の数が届くまで、前の月の数をその月の数として出さない', async () => {
  const now = thisMonth();
  const before = lastMonth();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  serve(async url => {
    const month = url.searchParams.get('month')!;
    if (month === before) await hold;
    return { status: 200, body: stats(month, month === now ? [busy(month)] : []) };
  });
  const container = await section(new Date(`${before}-15T00:00:00Z`).getTime());
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '4');
  const select = container.querySelector('select')!;
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, before);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle(250);
  assert.equal(figure(container, 'perTask'), null, '届く前は数を出さない');
  assert.equal(container.querySelector('[data-home="growth"]')?.getAttribute('aria-busy'), 'true');
  release();
  await settle();
  assert.equal(container.querySelector('[data-home="growth"]')?.getAttribute('aria-busy'), 'false');
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '—');
});

test('Growth（DOM）: 読めなかったら「Could not load」と Retry。Retry で読み直して出す', async () => {
  let fail = true;
  const month = thisMonth();
  serve(() => (fail ? { status: 500, body: { error: 'boom' } } : { status: 200, body: stats(month, [busy(month)]) }));
  const container = await section();
  assert.ok(container.querySelector('.bt-notice')?.textContent?.includes('Could not load the growth numbers'));
  assert.equal(figure(container, 'perTask'), null, '読めないときに 0 を出さない');
  fail = false;
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.equal(container.textContent?.includes('Could not load the growth numbers'), false);
  assert.equal(figure(container, 'perTask')?.querySelector('.bt-stat__n')?.textContent, '4');
});

test('Growth（DOM）: 製品のホームの終わりに Growth の欄がある（Finished の下）', async () => {
  serve(url => ({ status: 200, body: stats(url.searchParams.get('month')!, []) }));
  const project: Project = {
    id: 'p1aaaa', name: 'p1aaaa', root: 'C:\\work\\p1aaaa', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: Date.now(), updated_at: 0,
    is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
  };
  const { container } = await render(createElement(ProductHome, { id: 'p1aaaa', project, conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  const sections = [...container.querySelectorAll('[data-home]')].map(el => el.getAttribute('data-home'));
  assert.deepEqual(sections, ['running', 'finished', 'growth']);
  assert.equal(container.querySelector('[data-home="growth"] .bt-label')?.textContent, 'Growth');
});
