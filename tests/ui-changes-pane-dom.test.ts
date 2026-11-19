import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChangedFile, ChangesView } from '../web/src/api.ts';

// beat 8-5b: Changes の欄（Design ChangesPane）。差分の形・符号・省略、Undo（確かめなし）で塊が去り Notice の知らせ、Redo、動いているあいだの 409、測る点の切り替え、hidden に Undo なし、ブランチの差分に Undo なし

type Source = { kind: 'product'; productId: string; conversationId: string | undefined; isGit: boolean } | { kind: 'branch'; productId: string; worktreeId: string };
type Props = { source: Source; revision: string; focus?: { path: string; n: number } | null; onUndone?: (notice: unknown) => void };
const { ChangesPane } = await loadTsx<{ ChangesPane: ComponentType<Props> }>('../web/src/ui/panes/ChangesPane.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const BATCH = '0f0e0d0c-1111-4222-8333-444455556666';
const queue: ChangedFile = { path: 'src/upload/queue.ts', status: 'modified', added: 2, removed: 1, hidden: false, undo: true, hunks: [['@@ -1,3 +1,4 @@', ' async function send(chunk: Chunk) {', '-  await put(chunk);', `+  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) { ${'x'.repeat(200)} }`, '+  throw new UploadFailed(chunk.id);'], ['@@ -40,1 +41,1 @@', ' }']] };
const backoff: ChangedFile = { path: 'src/upload/backoff.ts', status: 'added', added: 1, removed: 0, hidden: false, undo: true, hunks: [['@@ -0,0 +1,1 @@', '+export const MAX_ATTEMPTS = 3;']] };
const old: ChangedFile = { path: 'src/old.ts', status: 'deleted', added: 0, removed: 4, hidden: false, undo: true, hunks: [['@@ -1,4 +0,0 @@', '-a', '-b', '-c', '-d']] };
const env: ChangedFile = { path: '.env', status: 'modified', added: 0, removed: 0, hidden: true, undo: false, hunks: null };
const big: ChangedFile = { path: 'assets/logo.png', status: 'modified', added: 0, removed: 0, hidden: false, undo: true, hunks: null };

interface Server { calls: string[]; bodies: unknown[]; files: ChangedFile[]; redo: ChangesView['redo']; undo: { status: number; body: unknown } | null; redoReply: { status: number; body: unknown } | null }

function serve(server: Server) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    server.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (init?.body) server.bodies.push(JSON.parse(String(init.body)));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/projects/p1/changes') {
      const base = url.searchParams.get('base');
      if (base === 'build' && !server.files.length) return reply({ error: 'project', code: 'project.changes_no_base', message: 'There is nothing to compare with yet' }, 404);
      const kind = base ?? 'build';
      return reply({ base: { kind, ref: null, at: null }, files: server.files, more: 0, redo: server.redo });
    }
    if (url.pathname === '/api/projects/p1/changes/undo') {
      if (server.undo) return reply(server.undo.body, server.undo.status);
      const body = JSON.parse(String(init!.body)) as { paths: string[] | 'all' };
      const undone = body.paths === 'all' ? server.files.filter(f => f.undo).map(f => f.path) : body.paths;
      server.files = server.files.filter(f => !undone.includes(f.path));
      server.redo = { id: BATCH, created_at: Date.now(), paths: undone };
      return reply({ undone, refused: [], redo: BATCH, more: 0 });
    }
    if (url.pathname === '/api/projects/p1/changes/redo') {
      if (server.redoReply) return reply(server.redoReply.body, server.redoReply.status);
      server.files = [queue, backoff];
      server.redo = null;
      return reply({ redone: ['src/upload/queue.ts'], refused: [] });
    }
    if (url.pathname === '/api/worktrees/ab12cd34/changes') return reply({ base: { kind: 'branch', ref: 'abc', at: null }, files: [queue], more: 0 });
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const wait = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const block = (container: HTMLElement, path: string) => container.querySelector(`.bt-diff[data-path="${path}"]`) as HTMLElement | null;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/gu, ' ').trim();

async function show(files: ChangedFile[], over: Partial<Props> = {}, server: Partial<Server> = {}) {
  const state: Server = { calls: [], bodies: [], files, redo: null, undo: null, redoReply: null, ...server };
  serve(state);
  const notices: unknown[] = [];
  const props: Props = { source: { kind: 'product', productId: 'p1', conversationId: 'c1', isGit: true }, revision: '0', onUndone: n => notices.push(n), ...over };
  const rendered = await render(createElement(ChangesPane, props));
  await settle();
  return { ...rendered, state, notices, props };
}

test('ui/ChangesPane（DOM）: 頭に合計と測る点と Undo all。ファイルごとに見出し（パス・+n −n・Undo）と行。足した行・消した行の印と符号、前後の行は符号なし、塊のあいだに …', async () => {
  const { container, state } = await show([queue, backoff]);
  assert.deepEqual(state.calls, ['GET /api/projects/p1/changes'], '最初はサーバーの既定の元で 1 回だけ');
  assert.equal(text(container.querySelector('.bt-pane__bar .bt-meta')), '2 files · +3 −1');
  const select = container.querySelector('select.bt-select') as HTMLSelectElement;
  assert.deepEqual([...select.options].map(o => o.textContent), ['since the last Build start', 'since the last commit', 'in this conversation']);
  assert.equal(select.value, 'build');
  assert.ok(byText(container, '.bt-pane__bar button', 'Undo all'));
  const q = block(container, 'src/upload/queue.ts')!;
  assert.deepEqual([...q.querySelector('.bt-diff__file')!.children].map(text), ['src/upload/queue.ts', '+2 −1 · Undo']);
  const lines = [...q.querySelectorAll('.bt-diff__line')];
  assert.deepEqual(lines.map(l => l.className.replace('bt-diff__line', '').trim()), ['', 'bt-diff__line--del', 'bt-diff__line--add', 'bt-diff__line--add', 'ui-changes__gap', '']);
  assert.equal(lines[0]!.textContent, '  async function send(chunk: Chunk) {');
  assert.equal(lines[1]!.textContent, '−   await put(chunk);');
  assert.ok(lines[2]!.textContent!.startsWith('+   for (let attempt'));
  assert.equal(lines[2]!.getAttribute('title'), lines[2]!.textContent, '長い行は title で全文（欄では省略）');
  assert.deepEqual([...block(container, 'src/upload/backoff.ts')!.querySelector('.bt-diff__file')!.children].map(text), ['src/upload/backoff.ts · new', '+1 · Undo'], '新しいファイルは new');
  assert.ok(q.classList.contains('bt-rise'), '最初に出る塊は上がって入る');
});

test('ui/ChangesPane（DOM）: 消えたファイルは deleted で行なし。hidden は中身も Undo もなし。行の出せないファイルは一言', async () => {
  const { container } = await show([old, env, big]);
  const gone = block(container, 'src/old.ts')!;
  assert.deepEqual([...gone.querySelector('.bt-diff__file')!.children].map(text), ['src/old.ts · deleted', '−4 · Undo']);
  assert.equal(gone.querySelectorAll('.bt-diff__line').length, 0, '消えたファイルは行を出さない');
  const secret = block(container, '.env')!;
  assert.equal(text(secret.querySelector('.bt-diff__file')), '.env · hidden');
  assert.ok(secret.querySelector('button') === null, 'hidden の行に Undo は無い');
  assert.match(text(secret)!, /looks like a secret/u);
  assert.match(text(block(container, 'assets/logo.png'))!, /too large or is not text/u);
});

test('ui/ChangesPane（DOM）: ファイルの Undo は確かめなしで口を呼び、塊が is-leaving で去って読み直す。会話への知らせ（Undid 1 file）と欄の Redo。Redo で戻る', async () => {
  const { container, state, notices } = await show([queue, backoff]);
  await click(byText(block(container, 'src/upload/queue.ts')!, 'button', 'Undo'));
  await settle();
  assert.deepEqual(state.bodies[0], { base: 'build', paths: ['src/upload/queue.ts'] }, '見ている元と、そのファイルだけ');
  assert.ok(block(container, 'src/upload/queue.ts')!.classList.contains('is-leaving'), '塊が去る');
  assert.deepEqual(notices, [{ projectId: 'p1', batch: BATCH, undone: 1, refused: 0, more: 0 }]);
  await wait(300);
  assert.ok(block(container, 'src/upload/queue.ts') === null, '読み直すと塊が無い');
  assert.equal(state.calls.filter(c => c.startsWith('GET')).length, 2);
  const redoRow = container.querySelector('.ui-changes__redo')!;
  assert.match(text(redoRow)!, /^Undid 1 file .* Redo$/u);
  assert.ok(!block(container, 'src/upload/backoff.ts')!.classList.contains('bt-rise'), '前からある塊は読み直しで上がり直さない');
  await click(byText(redoRow, 'button', 'Redo'));
  await settle();
  await settle();
  assert.deepEqual(state.bodies[1], { redo: BATCH });
  assert.ok(block(container, 'src/upload/queue.ts'), 'Redo で塊が戻る');
  assert.ok(container.querySelector('.ui-changes__redo') === null, 'Redo したら Redo の行は消える');
});

test('ui/ChangesPane（DOM）: Undo all は paths: "all"', async () => {
  const { container, state } = await show([queue, backoff, env]);
  await click(byText(container, '.bt-pane__bar button', 'Undo all'));
  await wait(300);
  assert.deepEqual(state.bodies[0], { base: 'build', paths: 'all' });
  assert.deepEqual([...container.querySelectorAll('.bt-diff')].map(b => b.getAttribute('data-path')), ['.env'], 'hidden だけ残る');
});

test('ui/ChangesPane（DOM）: タスクが動いているあいだの 409 は、塊を残したまま理由を出す。会話には知らせない', async () => {
  const busy = { status: 409, body: { error: 'project', code: 'project.changes_busy', message: 'A task or conversation of this product is running. Undo or redo after it stops' } };
  const { container, notices } = await show([queue], {}, { undo: busy });
  await click(byText(block(container, 'src/upload/queue.ts')!, 'button', 'Undo'));
  await wait(50);
  const warn = container.querySelector('.bt-notice--warn');
  assert.ok(warn, '知らせが出る');
  assert.match(text(warn)!, /^Could not undo · A task or conversation of this product is running/u);
  assert.ok(block(container, 'src/upload/queue.ts') && !block(container, 'src/upload/queue.ts')!.classList.contains('is-leaving'), '塊は残る');
  assert.deepEqual(notices, []);
  assert.ok(!(byText(block(container, 'src/upload/queue.ts')!, 'button', 'Undo') as HTMLButtonElement).disabled, 'もう一度押せる');
});

test('ui/ChangesPane（DOM）: 一部を戻せなかったときは、戻せなかったファイルと理由を出す', async () => {
  const refused = { status: 200, body: { undone: [], refused: [{ path: 'src/upload/queue.ts', reason: 'link' }], redo: null, more: 0 } };
  const { container, notices } = await show([queue], {}, { undo: refused });
  await click(byText(block(container, 'src/upload/queue.ts')!, 'button', 'Undo'));
  await wait(50);
  assert.equal(text(container.querySelector('.bt-notice--warn')), '1 file could not be undone · src/upload/queue.ts: its path goes through a link or junction');
  assert.deepEqual(notices, [{ projectId: 'p1', batch: null, undone: 0, refused: 1, more: 0 }]);
});

test('ui/ChangesPane（DOM）: 測る点を切り替えると、その元で読み直す。「この会話」は records と会話の id で、道具の変更だけと書く', async () => {
  const { container, state } = await show([queue]);
  const select = () => container.querySelector('select.bt-select') as HTMLSelectElement;
  await update(() => { select().value = 'conversation'; select().dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
  assert.equal(state.calls.at(-1), 'GET /api/projects/p1/changes?base=records&conversation=c1');
  assert.equal(select().value, 'conversation');
  assert.match(text(container.querySelector('.ui-changes__note'))!, /^Only changes made with the file tools/u);
  await update(() => { select().value = 'commit'; select().dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
  assert.equal(state.calls.at(-1), 'GET /api/projects/p1/changes?base=commit');
  await click(byText(block(container, 'src/upload/queue.ts')!, 'button', 'Undo'));
  await settle();
  assert.deepEqual(state.bodies[0], { base: 'commit', paths: ['src/upload/queue.ts'] }, 'Undo も見ている元で');
});

test('ui/ChangesPane（DOM）: 空のときは No changes と測る点。Build の控えが無い git の製品では build を出さない。会話が無ければ「この会話」も無い', async () => {
  const empty: ChangesView = { base: { kind: 'commit', ref: null, at: null }, files: [], more: 0, redo: null };
  globalThis.fetch = (async () => new Response(JSON.stringify(empty), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const { container } = await render(createElement(ChangesPane, { source: { kind: 'product', productId: 'p1', conversationId: undefined, isGit: true }, revision: '0' }));
  await settle();
  assert.equal(text(container.querySelector('.bt-empty__title')), 'No changes');
  assert.equal(text(container.querySelector('.bt-empty__text')), 'since the last commit');
  assert.ok(container.querySelector('select') === null, '選べる元が 1 つなら選ぶ箱は出さない');
  assert.equal(byText(container, 'button', 'Undo all'), undefined);
});

test('ui/ChangesPane（DOM）: Edit の行や Files から来たら、そのファイルの塊へ動いて印を付ける。無ければ一言', async () => {
  const { container, root, props } = await show([queue, backoff], { focus: { path: 'D:\\work\\uploader\\src\\upload\\backoff.ts', n: 1 } });
  await settle();
  assert.ok(block(container, 'src/upload/backoff.ts')!.classList.contains('is-focus'));
  assert.ok(document.activeElement === block(container, 'src/upload/backoff.ts'), 'その塊に focus');
  await update(() => root.render(createElement(ChangesPane, { ...props, focus: { path: 'src/nothing.ts', n: 2 } })));
  await settle();
  assert.equal(text(container.querySelector('.ui-changes__note[role="status"]')), 'src/nothing.ts has no changes here.');
  assert.ok(container.querySelector('.is-focus') === null);
});

test('ui/ChangesPane（DOM）: タスクのブランチの差分（あとで worktree のカードから開く形）は、同じ欄で Undo を出さない', async () => {
  const state: Server = { calls: [], bodies: [], files: [], redo: null, undo: null, redoReply: null };
  serve(state);
  const { container } = await render(createElement(ChangesPane, { source: { kind: 'branch', productId: 'p1', worktreeId: 'ab12cd34' }, revision: '0' }));
  await settle();
  assert.deepEqual(state.calls, ['GET /api/worktrees/ab12cd34/changes']);
  assert.equal(text(container.querySelector('.bt-pane__bar .bt-meta')), '1 file · +2 −1 · on the task branch');
  assert.equal(container.querySelectorAll('.bt-diff__line').length, 6);
  assert.ok(container.querySelector('button') === null, 'Undo も Undo all も無い');
});

test('ui/ChangesPane（DOM）: 読めなければ理由と Retry', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'project', code: 'project.changes_git_unusable', message: 'git could not be run safely in this product folder, so the changes cannot be shown' }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const { container } = await render(createElement(ChangesPane, { source: { kind: 'product', productId: 'p1', conversationId: 'c1', isGit: true }, revision: '0' }));
  await settle();
  assert.match(text(container.querySelector('.bt-notice--warn'))!, /^Could not load the changes · git could not be run safely/u);
  assert.ok(byText(container, 'button', 'Retry'));
});
