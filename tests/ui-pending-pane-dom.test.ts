import { byText, cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { PendingAction } from '../web/src/api.ts';

interface ListProps { projectId: string | null; waiting: readonly PendingAction[]; counts: null; projects: never[]; conversations: never[]; revision: string; onOpenPlan: (id: string) => void }

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

async function showList(waiting: PendingAction[], decided: PendingAction[]) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const body = String(path).startsWith('/api/pending?status=decided') ? { items: decided } : { error: 'not found' };
    return new Response(JSON.stringify(body), { status: 'items' in body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { container } = await render(createElement(PendingList, { projectId: 'prod01', waiting, counts: null, projects: [], conversations: [], revision: '0', onOpenPlan: () => undefined }));
  await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  return container;
}

const erased = { body: null, cwd: null, extra: null };
const nl = String.fromCharCode(10);

test('ui/PendingPane（DOM）: Decided の行は decidedText から組み、会話を消した行（中身が空）には "Details removed with the session" を出す。Waiting の Other input は題の path を繰り返さない', async () => {
  const gone = row({ id: 7, status: 'rejected', decided_at: Date.now() - 1000, title: null, shown: '', parts: erased });
  const shell = row({ id: 8, status: 'ran', exit_code: 0, decided_at: Date.now() - 2000, title: 'Run a command', shown: 'Run a command', parts: { body: 'rm -rf dist', cwd: 'web', extra: null } });
  const write = row({ id: 2, tool: 'file_write', kind: 'judge', title: 'Write to a file: a.md', shown: 'x', parts: { body: '# A', cwd: null, extra: JSON.stringify({ path: 'a.md', mode: 'append' }, null, 2) } });
  const container = await showList([write], [gone, shell]);
  const decided = container.querySelector('section.ui-pending__decided')!;
  const lines = [...decided.querySelectorAll('li .ui-pending__shown')];
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.textContent, 'Details removed with the session');
  assert.equal(lines[1]!.querySelector('code')?.textContent, 'rm -rf dist', 'シェルの行はコマンドだけ（題を出さない）');
  assert.match(lines[1]!.closest('li')!.querySelector('.bt-row__sub')?.textContent ?? '', /web/u, '作業フォルダは小さな行');
  const extra = container.querySelector('.ui-pending__extra code');
  assert.equal(extra?.textContent, JSON.stringify({ mode: 'append' }, null, 2), 'Other input は extraShown を通す');
  assert.ok(byText(container, '.bt-meta', 'Other input'));
});

test('ui/PendingPane（DOM）: Decided の行を開くと、却下の理由の全文と実行の出力の頭が出る（Waiting の中身と同じ枠）。出すものが無い行には Details が無い（backlog 489）', async () => {
  const ran = row({ id: 3, status: 'ran', exit_code: 0, decided_at: Date.now() - 1000, output_preview: ['line 1', 'line 2', ''].join(nl) });
  const rejected = row({ id: 4, status: 'rejected', decided_at: Date.now() - 2000, reject_reason: '  wrong host  ' });
  const plain = row({ id: 5, status: 'rejected', decided_at: Date.now() - 3000, reject_reason: null });
  const container = await showList([], [ran, rejected, plain]);
  const items = [...container.querySelectorAll('section.ui-pending__decided li')];
  assert.equal(items.length, 3);
  const [first, second, third] = items;
  assert.equal(first!.querySelector('details.ui-pending__more > summary')?.textContent, 'Details');
  assert.equal(first!.querySelector('details pre.ui-pending__body > code')?.textContent, ['line 1', 'line 2'].join(nl));
  assert.ok(byText(first!, '.bt-meta', 'Output'));
  assert.equal(second!.querySelector('details .ui-pending__why')?.textContent, 'Reason: wrong host');
  assert.equal(third!.querySelector('details'), null);
});
