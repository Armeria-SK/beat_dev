import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { FileContent, FileEntry } from '../web/src/api.ts';
import { t } from '../web/src/i18n/index.ts';
import { EMPTY, reduce, type RunNotice } from '../web/src/ui/live-state.ts';

// beat 8-5b: Changes の欄へのつなぎ。会話の Edit の行と Files の欄の「Open in Changes」、Undo の知らせ（Undid 1 file · Redo）が会話に入ること、Redo の押し方

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const { ToolGroup } = await loadTsx<{ ToolGroup: ComponentType<{ rows: unknown[]; isNew: (key: string) => boolean; changes?: (path: string) => void }> }>('../web/src/ui/ToolRow.tsx', import.meta.url);
const { FilesPane } = await loadTsx<{ FilesPane: ComponentType<{ productId: string; revision: string; onOpenChanges?: (path: string) => void }> }>('../web/src/ui/panes/FilesPane.tsx', import.meta.url);
const { RedoAction } = await loadTsx<{ RedoAction: ComponentType<{ projectId: string; batch: string }> }>('../web/src/ui/ChangesRedo.tsx', import.meta.url);
const { noticeText } = await loadTsx<{ noticeText: (tr: typeof t, n: RunNotice) => string }>('../web/src/ui/Conversation.tsx', import.meta.url);

test('ui/ToolRow（DOM）: 終わった Edit の行の中に「Open in Changes」。押すとそのファイルのパスで欄を開く。失敗した Edit・Run の行・欄の無い所には出さない', async () => {
  const opened: string[] = [];
  const row = (key: string, name: string, input: unknown, isError = false) => ({ key, name, input: JSON.stringify(input), result: { text: isError ? 'failed' : 'Replaced 1 occurrence', isError } });
  const rows = [
    row('a', 'file_edit', { path: 'src/upload/queue.ts', old: 'a', new: 'b' }),
    row('b', 'file_edit', { path: 'src/x.ts', old: 'a', new: 'b' }, true),
    row('c', 'shell_run', { command: 'npm test' }),
  ];
  const { container } = await render(createElement(ToolGroup, { rows, isNew: () => false, changes: path => opened.push(path) }));
  const links = [...container.querySelectorAll('.ui-tool__changes')];
  assert.equal(links.length, 1);
  assert.equal(links[0]!.textContent, 'Open in Changes');
  assert.ok(links[0]!.closest('.bt-tool__body'), '行の中（開いたときの本文）にある。行そのものにボタンは置かない');
  await click(links[0]);
  assert.deepEqual(opened, ['src/upload/queue.ts']);
  await cleanup();
  const bare = await render(createElement(ToolGroup, { rows, isNew: () => false }));
  assert.equal(bare.container.querySelectorAll('.ui-tool__changes').length, 0, '欄を開けない所（製品の外の会話）では出さない');
});

test('ui/FilesPane（DOM）: 前のコミットから変わったファイル（M / A）の頭に「Open in Changes」。押すとそのパス。変わっていないファイルと Knowledge には出さない', async () => {
  const entries: FileEntry[] = [{ name: 'queue.ts', path: 'queue.ts', kind: 'file', mark: 'M' }, { name: 'main.ts', path: 'main.ts', kind: 'file' }];
  const content = (path: string, mark: FileContent['mark']): FileContent => ({ path, size: 10, modifiedAt: Date.now(), mark, hidden: false, binary: false, truncated: false, text: 'x\n' });
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = new URL(String(path), 'http://x');
    if (url.pathname.endsWith('/files')) return reply({ dir: '', entries: url.searchParams.get('tree') === 'knowledge' ? [{ name: 'STATE.md', path: 'STATE.md', kind: 'file', mark: 'M' }] : entries, truncated: false, ignoreChecked: true });
    const p = url.searchParams.get('path')!;
    return reply(content(p, p === 'main.ts' ? null : 'M'));
  }) as typeof fetch;
  const opened: string[] = [];
  const { container } = await render(createElement(FilesPane, { productId: 'p1', revision: '0', onOpenChanges: path => opened.push(path) }));
  await settle();
  await click(container.querySelector('[data-path="queue.ts"]'));
  await settle();
  const link = container.querySelector('.ui-files__changes');
  assert.equal(link?.textContent, 'Open in Changes');
  await click(link);
  assert.deepEqual(opened, ['queue.ts']);
  await click(container.querySelector('[data-path="main.ts"]'));
  await settle();
  assert.ok(container.querySelector('.ui-files__changes') === null, '変わっていないファイルには出さない');
  await click(byText(container, '.bt-seg__opt', 'Knowledge'));
  await settle();
  await click(container.querySelector('[data-path="STATE.md"]'));
  await settle();
  assert.ok(container.querySelector('.ui-files__changes') === null, 'Knowledge の木には出さない');
});

test('ui/live-state: Undo の知らせはその会話に入り、ほかの会話には入らない。文は「Undid 1 file」、戻せなかった数・残りの数も足す', () => {
  const notice: RunNotice = { runId: 'undo:b1', kind: 'undo', projectId: 'p1', batch: 'b1', undone: 1, refused: 0, more: 0 };
  const state = reduce(EMPTY, { type: 'notice', conversationId: 'c1', notice }).state;
  assert.deepEqual(state.notices.get('c1'), [notice]);
  assert.equal(state.notices.get('c2'), undefined);
  assert.equal(noticeText(t, notice), 'Undid 1 file');
  assert.equal(noticeText(t, { ...notice, undone: 3, refused: 1, more: 2 }), 'Undid 3 files · 1 could not be undone · 2 more were not undone');
});

test('ui/ChangesRedo（DOM）: Redo を押すと組の id で口を呼び、「redone」に変わる。動いているあいだ（409）は理由を出して、もう一度押せる', async () => {
  const bodies: unknown[] = [];
  let busy = true;
  globalThis.fetch = (async (_path: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)));
    if (busy) return reply({ error: 'project', code: 'project.changes_busy', message: 'A task or conversation of this product is running. Undo or redo after it stops' }, 409);
    return reply({ redone: ['a.ts'], refused: [] });
  }) as typeof fetch;
  const { container } = await render(createElement('div', { className: 'bt-notice' }, createElement(RedoAction, { projectId: 'p1', batch: 'batch-a' })));
  await click(byText(container, 'button', 'Redo'));
  await settle();
  assert.deepEqual(bodies, [{ redo: 'batch-a' }]);
  assert.match(container.textContent!, /could not redo: A task or conversation of this product is running/u);
  busy = false;
  await click(byText(container, 'button', 'Redo'));
  await settle();
  assert.equal(container.textContent!.trim(), '· redone');
  assert.ok(container.querySelector('button') === null, 'やり直したあとは押せない');
});
