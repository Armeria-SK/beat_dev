import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChangedFile, ChangesView, RuntimeChangeRun } from '../web/src/api.ts';

// beat AR-9: Changes の欄の「外の実行役が変えたファイル」。beat 自身が git の前後から割り出した、返事ごとのまとまり。Undo も差分の行も無い。印・状態ごとの一言・git の変化を出す

type Source = { kind: 'product'; productId: string; conversationId: string | undefined; isGit: boolean } | { kind: 'branch'; productId: string; worktreeId: string };
type Props = { source: Source; revision: string };
const { ChangesPane } = await loadTsx<{ ChangesPane: ComponentType<Props> }>('../web/src/ui/panes/ChangesPane.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const own: ChangedFile = { path: 'src/own.ts', status: 'modified', added: 1, removed: 0, hidden: false, undo: true, hash: 'a'.repeat(64), hunks: [['@@ -1,1 +1,2 @@', ' a', '+b']] };
const NOW = Date.now();
const run = (over: Partial<RuntimeChangeRun> = {}): RuntimeChangeRun => ({
  runId: 'r1', conversationId: 'c1', runtime: 'claude-code', kind: 'claude-code', at: NOW - 5 * 60_000, outcome: 'ok', state: 'ok', files: [], more: 0, unchecked: 0, git: [], alert: false, ...over,
});

function serve(files: ChangedFile[], runs: RuntimeChangeRun[] | undefined): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/projects/p1/changes') {
      const view: ChangesView = { base: { kind: 'build', ref: null, at: null }, files, more: 0, redo: null, ...(runs ? { runtime: { runs } } : {}) };
      return reply(view);
    }
    if (url.pathname === '/api/worktrees/ab12cd34/changes') return reply({ base: { kind: 'branch', ref: 'abc', at: null }, files, more: 0 });
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
  return calls;
}

const row = (el: Element | null | undefined) => [el?.querySelector('.ui-changes__path')?.textContent, ...[...(el?.querySelectorAll('.bt-tag') ?? [])].map(tag => tag.textContent)];
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/gu, ' ').trim();

async function show(files: ChangedFile[], runs: RuntimeChangeRun[] | undefined, source: Source = { kind: 'product', productId: 'p1', conversationId: 'c1', isGit: true }) {
  const calls = serve(files, runs);
  const rendered = await render(createElement(ChangesPane, { source, revision: '0' }));
  await settle();
  return { ...rendered, calls };
}

test('ui/ChangesPane（DOM）: 実行役の返事ごとのまとまりが、ふつうのファイルの欄とは別の見出しで出る。ファイルごとに 新規・消した・変更 の印、Undo も差分の行も無い', async () => {
  const { container } = await show([own], [run({ files: [{ path: 'src/a.ts', status: 'modified', marks: [] }, { path: 'src/new.ts', status: 'added', marks: [] }, { path: 'src/gone.ts', status: 'deleted', marks: [] }] })]);
  const group = container.querySelector('.ui-changes__runtime')!;
  assert.ok(group, 'the group is there');
  assert.equal(text(group.querySelector('h3')), 'Changes by the external runtime');
  assert.match(text(group)!, /worked out by beat itself from git/u);
  assert.match(text(group.querySelector('.ui-changes__runhead'))!, /^Claude Code · 5 minutes ago$/u);
  const rows = [...group.querySelectorAll('.ui-changes__runfile')].map(row);
  assert.deepEqual(rows, [['src/a.ts', 'changed'], ['src/new.ts', 'new'], ['src/gone.ts', 'deleted']]);
  assert.equal(group.querySelectorAll('button').length, 0, 'nothing to undo');
  assert.equal(group.querySelectorAll('.bt-diff, .bt-diff__line').length, 0, 'no diff lines');
  assert.equal(container.querySelectorAll('.bt-pane__stack .bt-diff').length, 1, 'the file-tool list above is its own thing');
  assert.equal(container.querySelectorAll('.bt-pane__bar button').length, 1, 'Undo all stays (for the file tools), once');
  assert.ok(!text(container.querySelector('.bt-pane__bar'))!.includes('src/a.ts'));
});

test('ui/ChangesPane（DOM）: 守りの印（protected・asks first・link・outside・unsafe）と、実行の終わり方（エラー・止めた）、変わった git、比べられなかった数、知らせの一言', async () => {
  const marks = ['protected', 'guarded', 'link', 'outside', 'unsafe'] as const;
  const { container } = await show([], [run({
    kind: 'codex', runtime: 'codex', outcome: 'failed', alert: true, unchecked: 2, more: 3, git: ['hooks', 'config', 'weird'],
    files: marks.map(mark => ({ path: `f-${mark}`, status: 'modified' as const, marks: [mark] })),
  })]);
  const group = container.querySelector('.ui-changes__runtime')!;
  const byPath = (path: string) => group.querySelector(`.ui-changes__runfile[data-path="${path}"]`)!;
  assert.deepEqual(row(byPath('f-protected')), ['f-protected', 'changed', 'protected']);
  assert.deepEqual(row(byPath('f-guarded')), ['f-guarded', 'changed', 'asks first']);
  assert.deepEqual(row(byPath('f-link')), ['f-link', 'changed', 'link']);
  assert.deepEqual(row(byPath('f-outside')), ['f-outside', 'changed', 'outside the folder']);
  assert.deepEqual(row(byPath('f-unsafe')), ['f-unsafe', 'changed', 'unsafe path']);
  assert.deepEqual([...byPath('f-link').querySelectorAll('.ui-changes__mark')].map(el => el.getAttribute('data-mark')), ['link']);
  assert.match(text(group.querySelector('.ui-changes__runhead .bt-meta'))!, /^Codex · 5 minutes ago$/u);
  assert.equal(text(group.querySelector('.ui-changes__runhead .bt-tag')), 'ended with an error');
  const notes = [...group.querySelectorAll('.ui-changes__note')].map(text);
  assert.ok(notes.includes('3 more files are not shown.'), JSON.stringify(notes));
  assert.ok(notes.includes('2 files could not be compared (a link or an unsafe path), so they may have changed.'), JSON.stringify(notes));
  assert.ok(notes.includes('git changed during this reply: git hooks, git settings, weird'), JSON.stringify(notes));
  assert.ok(notes.some(note => note?.startsWith('Files that beat protects or cannot follow safely changed.')), JSON.stringify(notes));
  assert.equal(group.querySelector('.ui-changes__run')!.getAttribute('data-alert'), 'true');
});

test('ui/ChangesPane（DOM）: 割り出せなかった返事は、分かったふりをせず理由を一言。何も変わらなかった返事は「見つかりませんでした」。止めた返事の印', async () => {
  const runs = [
    run({ runId: 'a', state: 'no_git' }),
    run({ runId: 'b', state: 'git_unusable' }),
    run({ runId: 'c', state: 'too_many' }),
    run({ runId: 'd', state: 'timeout' }),
    run({ runId: 'e', state: 'failed' }),
    run({ runId: 'f' }),
    run({ runId: 'g', outcome: 'stopped' }),
  ];
  const { container } = await show([], runs);
  const note = (id: string) => text(container.querySelector(`.ui-changes__run[data-run="${id}"] .ui-changes__note`));
  assert.equal(note('a'), 'This product is not a git repository, so beat cannot tell which files this reply changed.');
  assert.match(note('b')!, /could not run git safely here/u);
  assert.match(note('c')!, /Too many files had already changed/u);
  assert.match(note('d')!, /took too long/u);
  assert.match(note('e')!, /could not read git/u);
  assert.equal(note('f'), 'No file changes found.');
  assert.equal(text(container.querySelector('.ui-changes__run[data-run="g"] .ui-changes__runhead .bt-tag')), 'stopped');
  assert.equal(container.querySelector('.ui-changes__run[data-run="f"] .ui-changes__runhead .bt-tag'), null, 'a reply that ended normally has no outcome tag');
  assert.equal(container.querySelectorAll('.ui-changes__run[data-run="a"] .ui-changes__runfile').length, 0);
});

test('ui/ChangesPane（DOM）: ふつうのファイルが無くても、実行役のまとまりがあれば「No changes」は出さない。どちらも無ければ出る。ブランチの差分の欄・実行役が無い応答には出ない', async () => {
  const withRuns = await show([], [run({ files: [{ path: 'x.ts', status: 'added', marks: [] }] })]);
  assert.equal(withRuns.container.querySelector('.bt-empty'), null, 'not told "No changes" above a list of changes');
  assert.ok(withRuns.container.querySelector('.ui-changes__runtime'));
  await cleanup();
  const none = await show([], []);
  assert.ok(none.container.querySelector('.bt-empty'), 'nothing at all: the empty state');
  assert.equal(none.container.querySelector('.ui-changes__runtime'), null);
  await cleanup();
  const old = await show([own], undefined);
  assert.equal(old.container.querySelector('.ui-changes__runtime'), null, 'an answer without the field draws nothing');
  await cleanup();
  const branch = await show([own], [run()], { kind: 'branch', productId: 'p1', worktreeId: 'ab12cd34' });
  assert.equal(branch.container.querySelector('.ui-changes__runtime'), null, 'the task branch view never has it');
});
