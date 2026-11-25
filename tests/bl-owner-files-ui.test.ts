import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChangedFile } from '../web/src/api.ts';
import { shownHashes } from '../web/src/ui/changes.ts';

// L241（画面側）: Undo の頼みには、差分を出した時点の各ファイルのハッシュを付ける。断られたあと読み直せば、新しいハッシュで送る

const { ChangesPane } = await loadTsx<{ ChangesPane: ComponentType<{ source: { kind: 'product'; productId: string; conversationId: string | undefined; isGit: boolean }; revision: string }> }>('../web/src/ui/panes/ChangesPane.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: 'modified', added: 1, removed: 1, hunks: [['@@ -1,1 +1,1 @@', '-a', '+b']], hidden: false, undo: true, ...over });
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

test('ui/changes: shownHashes は、頼むファイルの分だけ、差分を出した時点のハッシュ（消えたファイルは null）を返す。ハッシュの無いファイルは入れない', () => {
  const files = [file('a.ts', { hash: H1 }), file('gone.ts', { status: 'deleted', hash: null }), file('plain.ts'), file('other.ts', { hash: H2 })];
  assert.deepEqual(shownHashes(files, ['a.ts', 'gone.ts', 'plain.ts']), { 'a.ts': H1, 'gone.ts': null });
  assert.deepEqual(shownHashes(files, []), {});
  assert.deepEqual(shownHashes(files, ['nope.ts']), {});
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const wait = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/gu, ' ').trim();

test('ui/ChangesPane（DOM）: 断られた（changed）あと読み直すと、次の Undo は読み直した新しいハッシュで送る。古いハッシュを使い回さない', async () => {
  let shown = file('src/a.ts', { hash: H1 });
  const bodies: Array<{ paths: string[]; hashes: Record<string, string | null> }> = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/projects/p1/changes') return reply({ base: { kind: 'commit', ref: null, at: null }, files: [shown], more: 0, redo: null });
    if (url.pathname === '/api/projects/p1/changes/undo') {
      const body = JSON.parse(String(init!.body)) as { paths: string[]; hashes: Record<string, string | null> };
      bodies.push(body);
      if (bodies.length === 1) {
        shown = file('src/a.ts', { hash: H3 });
        return reply({ undone: [], refused: [{ path: 'src/a.ts', reason: 'changed' }], redo: null, more: 0 });
      }
      return reply({ undone: ['src/a.ts'], refused: [], redo: null, more: 0 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const { container } = await render(createElement(ChangesPane, { source: { kind: 'product', productId: 'p1', conversationId: undefined, isGit: true }, revision: '0' }));
  await settle();
  const undo = () => byText(container.querySelector('.bt-diff[data-path="src/a.ts"]')!, 'button', 'Undo')!;
  await click(undo());
  await wait(50);
  assert.deepEqual(bodies[0], { base: 'commit', paths: ['src/a.ts'], hashes: { 'src/a.ts': H1 } });
  assert.equal(text(container.querySelector('.bt-notice--warn')), '1 file could not be undone · src/a.ts: it changed again after the undo');
  await wait(50);
  await click(undo());
  await wait(50);
  assert.deepEqual(bodies[1]!.hashes, { 'src/a.ts': H3 }, '読み直した差分のハッシュで送る');
});
