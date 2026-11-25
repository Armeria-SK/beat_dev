import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, PendingAction } from '../web/src/api.ts';

// backlog 334（Pending の欄）: Other input に渡す題は画面に出している題（view.title）。子エージェントの行の from は親の題

interface ListProps { projectId: string | null; waiting: readonly PendingAction[]; counts: null; projects: never[]; conversations: readonly Conversation[]; revision: string; onOpenPlan: (id: string) => void }

const { PendingList } = await loadTsx<{ PendingList: ComponentType<ListProps> }>('../web/src/ui/panes/PendingPane.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const row = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 1, tool: 'shell_run', shown: 'rm -rf data/cache/', masked: 0, kind: 'delete', reason: 'deletes files that existed before the run',
  cwd: null, preview: [], files: [], conversation_id: 'c1', task_id: null, project_id: 'prod01', task_title: null, project_name: 'Shop site',
  status: 'waiting', reject_reason: null, exit_code: null, output_preview: null, created_at: Date.now() - 5000, decided_at: null, ran_at: null, ...over,
});

async function showList(waiting: PendingAction[], conversations: Conversation[] = []) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const body = String(path).startsWith('/api/pending?status=decided') ? { items: [] } : { error: 'not found' };
    return new Response(JSON.stringify(body), { status: 'items' in body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { container } = await render(createElement(PendingList, { projectId: 'prod01', waiting, counts: null, projects: [], conversations, revision: '0', onOpenPlan: () => undefined }));
  await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  return container;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const extraOf = (container: HTMLElement, id: number) => container.querySelector(`[data-pending="${id}"] .ui-pending__extra code`)?.textContent ?? null;

test('334 ui/PendingPane: 題が画面に出ていない行（シェルは題を隠してコマンドだけ出す）では、生の題の終わりと同じ path でも Other input から消さない', async () => {
  const shell = row({ id: 31, tool: 'shell_run', title: 'Write to a file: a.md', shown: 'echo hi', parts: { body: 'echo hi', cwd: null, extra: json({ path: 'a.md' }) } });
  const container = await showList([shell]);
  assert.ok(!container.querySelector('[data-pending="31"] .bt-pending__what')?.textContent?.includes('a.md'), '前提: 題は画面に出ていない');
  assert.equal(extraOf(container, 31), json({ path: 'a.md' }), '題に出ていない path は、Other input にだけ残る');
});

test('334 ui/PendingPane: 題が画面に出ているファイルの行は、これまでどおり題の終わりの path を Other input で繰り返さない', async () => {
  const write = row({ id: 32, tool: 'file_write', kind: 'judge', title: 'Write to a file: a.md', shown: 'x', parts: { body: '# A', cwd: null, extra: json({ path: 'a.md', mode: 'append' }) } });
  const pathOnly = row({ id: 33, tool: 'file_write', kind: 'judge', title: 'Write to a file: b.md', shown: 'x', parts: { body: '# B', cwd: null, extra: json({ path: 'b.md' }) } });
  const container = await showList([write, pathOnly]);
  assert.ok(container.querySelector('[data-pending="32"] .bt-pending__what')?.textContent?.includes('Write to a file: a.md'), '前提: 題は画面に出ている');
  assert.equal(extraOf(container, 32), json({ mode: 'append' }));
  assert.equal(extraOf(container, 33), null, 'path だけなら欄ごと出さない');
});

test('334 ui/PendingPane: 子エージェントの行の from は、サーバーが返した親の題（子の会話は kind が task で、画面の会話の一覧には入らない）。ふつうの行は一覧の題（すでに直っている行の見張り）', async () => {
  const child = row({ id: 41, conversation_id: 'child-conv', conversation_title: 'Parent: fix the price rounding' });
  const own = row({ id: 42, conversation_id: 'c1', conversation_title: 'Clean up' });
  const conversations = [{ id: 'c1', title: 'Clean up', created_at: 1, last_message_at: 1 }, { id: 'parent-conv', title: 'Parent: fix the price rounding', created_at: 1, last_message_at: 1 }] as Conversation[];
  const container = await showList([child, own], conversations);
  const from = (id: number) => container.querySelector(`[data-pending="${id}"] .bt-pending__from > span:first-child`)?.textContent;
  assert.equal(from(41), 'from “Parent: fix the price rounding”');
  assert.equal(from(42), 'from “Clean up”');
});
