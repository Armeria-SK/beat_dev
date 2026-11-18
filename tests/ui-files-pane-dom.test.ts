import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { FileContent, FileEntry } from '../web/src/api.ts';

// beat 8-5a: Files の欄（Design FilesPane）。読むだけ・開いたフォルダごとに読み足す・M / A の印・秘密らしいものは hidden・Product / Knowledge

const { FilesPane } = await loadTsx<{ FilesPane: ComponentType<{ productId: string; revision: string }> }>('../web/src/ui/panes/FilesPane.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const dir = (path: string): FileEntry => ({ name: path.split('/').at(-1)!, path, kind: 'dir' });
const file = (path: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name: path.split('/').at(-1)!, path, kind: 'file', ...extra });

type Trees = Record<string, Record<string, FileEntry[]>>;

function serve(trees: Trees, files: Record<string, FileContent | { status: number; body: unknown }>, calls: string[], ignoreChecked = true) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${url.pathname}${url.search}`);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const tree = url.searchParams.get('tree') ?? 'product';
    if (url.pathname === '/api/projects/p1/files') {
      const entries = trees[tree]?.[url.searchParams.get('dir') ?? ''];
      return entries ? reply({ dir: url.searchParams.get('dir'), entries, truncated: false, ignoreChecked }) : reply({ error: 'not_found', message: 'The file or folder was not found' }, 404);
    }
    if (url.pathname === '/api/projects/p1/file') {
      const found = files[`${tree}:${url.searchParams.get('path')}`];
      if (!found) return reply({ error: 'not_found', message: 'The file or folder was not found' }, 404);
      return 'status' in found ? reply(found.body, found.status) : reply(found);
    }
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const content = (path: string, over: Partial<FileContent> = {}): FileContent => ({ path, size: 20, modifiedAt: Date.now() - 4 * 60_000, mark: null, hidden: false, binary: false, truncated: false, text: 'line 1\nline 2\n', ...over });

const PRODUCT: Trees = {
  product: {
    '': [dir('src'), file('.env', { hidden: true }), file('package.json')],
    src: [dir('src/upload'), file('src/main.ts')],
    'src/upload': [file('src/upload/backoff.ts', { mark: 'A' }), file('src/upload/chunk.ts'), file('src/upload/queue.ts', { mark: 'M' })],
  },
  knowledge: { '': [file('STATE.md'), file('DECISIONS.md')] },
};

async function show(trees: Trees = PRODUCT, files: Parameters<typeof serve>[1] = {}, revision = '0', ignoreChecked = true) {
  const calls: string[] = [];
  serve(trees, files, calls, ignoreChecked);
  const rendered = await render(createElement(FilesPane, { productId: 'p1', revision }));
  await settle();
  return { ...rendered, calls };
}

const rowNames = (container: HTMLElement) => [...container.querySelectorAll('.bt-tree > [role="treeitem"]')].map(li => li.querySelector('.bt-tree__name')?.textContent);
const row = (container: HTMLElement, path: string) => container.querySelector(`[data-path="${path}"]`) as HTMLElement | null;

test('ui/FilesPane（DOM）: 根の 1 段だけ読む。フォルダを開くたびにその 1 段を読み足し、深さで字下げ。閉じると隠れる', async () => {
  const { container, calls } = await show();
  assert.deepEqual(calls, ['/api/projects/p1/files?tree=product&dir='], '最初は根だけ');
  assert.deepEqual(rowNames(container), ['src', '.env', 'package.json']);
  assert.equal(row(container, 'src')!.getAttribute('aria-expanded'), 'false');
  await click(row(container, 'src'));
  await settle();
  assert.equal(calls.at(-1), '/api/projects/p1/files?tree=product&dir=src');
  await click(row(container, 'src/upload'));
  await settle();
  assert.equal(calls.at(-1), '/api/projects/p1/files?tree=product&dir=src%2Fupload');
  assert.deepEqual(rowNames(container), ['src', 'upload', 'backoff.ts', 'chunk.ts', 'queue.ts', 'main.ts', '.env', 'package.json']);
  assert.equal(row(container, 'src/upload/queue.ts')!.style.getPropertyValue('--bt-depth'), '2');
  assert.equal(row(container, 'src')!.getAttribute('aria-expanded'), 'true');
  await click(row(container, 'src'));
  assert.deepEqual(rowNames(container), ['src', '.env', 'package.json']);
});

test('ui/FilesPane（DOM）: M は Modified、A は Added の title。秘密らしい名前は行と hidden だけで、開いても中身を出さない', async () => {
  const { container, calls } = await show(PRODUCT, { 'product:.env': content('.env', { hidden: true, text: null }) });
  await click(row(container, 'src'));
  await settle();
  await click(row(container, 'src/upload'));
  await settle();
  const m = row(container, 'src/upload/queue.ts')!.querySelector('.bt-meta');
  assert.equal(m?.textContent, 'M');
  assert.equal(m?.getAttribute('title'), 'Modified');
  const a = row(container, 'src/upload/backoff.ts')!.querySelector('.bt-add');
  assert.equal(a?.textContent, 'A');
  assert.equal(a?.getAttribute('title'), 'Added');
  assert.equal(row(container, 'src/upload/chunk.ts')!.querySelector('.bt-meta, .bt-add'), null);
  assert.equal(row(container, '.env')!.querySelector('.bt-meta')?.textContent, 'hidden');
  await click(row(container, '.env'));
  await settle();
  assert.equal(calls.at(-1), '/api/projects/p1/file?tree=product&path=.env');
  assert.ok(container.querySelector('.ui-files__view .bt-pane__bar .bt-meta')!.textContent!.startsWith('.env · hidden · modified'));
  assert.equal(container.querySelector('.ui-files__view pre'), null, '中身の枠が無い');
  assert.ok(byText(container, '.ui-files__note', 'This file looks like a secret, so its contents are not shown here.'));
});

test('ui/FilesPane（DOM）: ファイルを選ぶと右に meta（パス・行数・変えた時）と中身。512KB を超えたものは頭だけの印、2 進は binary。読むだけで入力欄が無い', async () => {
  const files = {
    'product:package.json': content('package.json'),
    'product:src/main.ts': content('src/main.ts', { truncated: true, size: 600 * 1024 }),
    'product:src/logo.png': content('src/logo.png', { binary: true, text: null, size: 2048 }),
  };
  const trees: Trees = { ...PRODUCT, product: { ...PRODUCT.product, src: [file('src/logo.png'), file('src/main.ts')] } };
  const { container } = await show(trees, files);
  assert.ok(byText(container, '.bt-empty__text', 'Pick a file on the left to read it here.'), '何も選んでいないときの案内');
  await click(row(container, 'package.json'));
  await settle();
  assert.equal(row(container, 'package.json')!.className.includes('is-active'), true);
  assert.equal(container.querySelector('.ui-files__view .bt-pane__bar .bt-meta')?.textContent, 'package.json · 2 lines · modified 4 minutes ago');
  assert.equal(container.querySelector('.ui-files__view pre.bt-term')?.textContent, 'line 1\nline 2\n');
  await click(row(container, 'src'));
  await settle();
  await click(row(container, 'src/main.ts'));
  await settle();
  assert.ok(container.querySelector('.ui-files__view .bt-pane__bar .bt-meta')!.textContent!.includes('first 512 KB shown'));
  await click(row(container, 'src/logo.png'));
  await settle();
  assert.ok(container.querySelector('.ui-files__view .bt-pane__bar .bt-meta')!.textContent!.startsWith('src/logo.png · binary · 2 KB'));
  assert.equal(container.querySelector('.ui-files__view pre'), null);
  assert.equal(container.querySelector('input, textarea, [contenteditable]'), null, '入力欄は無い');
  assert.equal(byText(container, 'button', 'Save'), undefined);
});

test('ui/FilesPane（DOM）: 断られたファイルはサーバーの文を出す。Knowledge に切り替えると木を読み直し、選んでいたファイルを閉じる', async () => {
  const files = {
    'product:package.json': { status: 403, body: { error: 'refused', message: 'This path is not shown (a link)' } },
    'knowledge:STATE.md': content('STATE.md', { text: '# State\n' }),
  };
  const { container, calls } = await show(PRODUCT, files);
  await click(row(container, 'package.json'));
  await settle();
  assert.ok(container.querySelector('.ui-files__view .bt-notice')!.textContent!.includes('Could not open this file · This path is not shown (a link)'));
  const seg = [...container.querySelectorAll('.ui-files__trees .bt-seg__opt')].map(b => [b.textContent, b.getAttribute('aria-pressed')]);
  assert.deepEqual(seg, [['Product', 'true'], ['Knowledge', 'false']]);
  await click(byText(container, '.ui-files__trees .bt-seg__opt', 'Knowledge'));
  await settle();
  assert.equal(calls.at(-1), '/api/projects/p1/files?tree=knowledge&dir=');
  assert.deepEqual(rowNames(container), ['STATE.md', 'DECISIONS.md']);
  assert.equal(container.querySelector('.ui-files')!.className, 'ui-files', 'ファイルは閉じた');
  await click(row(container, 'STATE.md'));
  await settle();
  assert.equal(calls.at(-1), '/api/projects/p1/file?tree=knowledge&path=STATE.md');
  assert.equal(container.querySelector('.ui-files__view pre')?.textContent, '# State\n');
});

test('ui/FilesPane（DOM）: 狭い幅の戻るボタンでファイルを閉じる（is-open が外れる）。根が読めなければ Retry', async () => {
  const { container } = await show(PRODUCT, { 'product:package.json': content('package.json') });
  await click(row(container, 'package.json'));
  await settle();
  assert.equal(container.querySelector('.ui-files')!.classList.contains('is-open'), true);
  await click(byText(container, '.ui-files__back', 'Files'));
  assert.equal(container.querySelector('.ui-files')!.classList.contains('is-open'), false);
  await cleanup();
  const broken = await show({ product: {} });
  assert.ok(broken.container.querySelector('.ui-files__side .bt-notice')?.textContent?.includes('Could not load the files'));
  assert.ok(byText(broken.container, '.bt-notice button', 'Retry'));
});

test('ui/FilesPane（DOM）: revision が変わると開いているフォルダと選んだファイルを読み直す', async () => {
  const calls: string[] = [];
  serve(PRODUCT, { 'product:package.json': content('package.json') }, calls);
  const rendered = await render(createElement(FilesPane, { productId: 'p1', revision: '1' }));
  await settle();
  await click(row(rendered.container, 'src'));
  await settle();
  await click(row(rendered.container, 'package.json'));
  await settle();
  calls.length = 0;
  await update(() => rendered.root.render(createElement(FilesPane, { productId: 'p1', revision: '2' })));
  await settle();
  assert.deepEqual([...calls].sort(), ['/api/projects/p1/file?tree=product&path=package.json', '/api/projects/p1/files?tree=product&dir=', '/api/projects/p1/files?tree=product&dir=src']);
  assert.deepEqual(rowNames(rendered.container), ['src', 'upload', 'main.ts', '.env', 'package.json'], '読み直しても開いたまま');
});

test('ui/FilesPane（DOM）: 無視の決まりを確かめられなかった一覧なら、中身を出さないことを 1 行で知らせる。確かめられていれば出さない', async () => {
  const checked = await show();
  assert.equal(checked.container.querySelector('.ui-files__unchecked'), null);
  await cleanup();
  const { container } = await show(PRODUCT, {}, '0', false);
  const note = container.querySelector('.ui-files__unchecked');
  assert.ok(note, '知らせが出る');
  assert.equal(note.getAttribute('role'), 'status');
  assert.ok(note.textContent!.includes('Ignore rules could not be checked, so file contents are not shown.'));
  assert.deepEqual(rowNames(container), ['src', '.env', 'package.json'], '一覧は出したまま');
});
