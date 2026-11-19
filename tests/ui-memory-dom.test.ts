import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { MemoryFileEvent, MemoryNote, Project } from '../web/src/api.ts';
import { t } from '../web/src/i18n/index.ts';
import type { RunNotice } from '../web/src/ui/live-state.ts';

// beat 10-4a: Memory の画面を製品の記憶のファイル（memory/<name>.md）で描く。口は src/web/routes-memory.ts（10-3）
interface MemoryProps { productId: string | undefined; projects: readonly Project[]; projectsLoaded: boolean; revision: number }

const scope = globalThis as unknown as Record<string, unknown>;
scope.addEventListener ??= window.addEventListener.bind(window);
scope.removeEventListener ??= window.removeEventListener.bind(window);

const { Memory } = await loadTsx<{ Memory: ComponentType<MemoryProps> }>('../web/src/ui/screens/Memory.tsx', import.meta.url);
const { noticeText } = await loadTsx<{ noticeText: (tr: typeof t, n: RunNotice) => string }>('../web/src/ui/Conversation.tsx', import.meta.url);
const { undoMemoryNoteEvent } = await loadTsx<{ undoMemoryNoteEvent: (projectId: string, name: string, eventId: number) => Promise<boolean> }>('../web/src/memory-undo.ts', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

const PID = 'p1aaaa';
const NOW = Date.now();
const project = (over: Partial<Project> = {}): Project => ({
  id: PID, name: 'uploader', root: 'C:/w/uploader', check_command: null, scout_mode: 'off' as Project['scout_mode'], remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { pending: 0, questions: 0, approval: 0, check: 0 } as unknown as Project['waiting'], running: 0, last_activity_at: null, ...over,
});

const hashOf = (text: string): string => {
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `h${h.toString(16)}`;
};

interface Stored { text: string | null; events: MemoryFileEvent[] }
interface Call { method: string; path: string; body: Record<string, unknown> | null; query: URLSearchParams }

// 10-3 の口と同じ形で返す、メモリの中の偽物。書き込みは baseHash を照らす
function fakeServer(seed: Record<string, { text: string; events: Array<Partial<MemoryFileEvent> & Pick<MemoryFileEvent, 'action'>>; tainted?: boolean }>, archived = false) {
  let nextId = 100;
  const notes = new Map<string, Stored>();
  const tainted = new Set<string>();
  for (const [name, s] of Object.entries(seed)) {
    notes.set(name, { text: s.text, events: s.events.map((e): MemoryFileEvent => ({ id: nextId++, actor: 'beat', summary: null, tainted: false, before: null, after: null, created_at: NOW - 3_600_000, ...e })).reverse() });
    if (s.tainted) tainted.add(name);
  }
  const calls: Call[] = [];
  const note = (name: string): MemoryNote => {
    const s = notes.get(name)!;
    const text = s.text!;
    const first = text.split('\n')[0]!;
    return { name, title: first.startsWith('# ') ? first.slice(2) : name, mtime: s.events[0]?.created_at ?? NOW, hash: hashOf(text), tainted: tainted.has(name), updatedBy: s.events[0]?.actor ?? null };
  };
  const add = (name: string, action: MemoryFileEvent['action'], before: string | null, after: string | null) => {
    const s = notes.get(name)!;
    s.events.unshift({ id: nextId++, action, actor: 'owner', summary: null, tainted: false, before, after, created_at: NOW });
    s.text = action === 'forget' ? null : after;
  };
  const fail = (status: number, code: string) => ({ status, body: { code, message: code } });
  globalThis.fetch = (async (raw: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(raw), 'http://localhost/');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, path: url.pathname, body, query: url.searchParams });
    const m = /^\/api\/projects\/([^/]+)\/memory(?:\/([^/]+))?(?:\/(history|restore|reviewed))?$/u.exec(url.pathname);
    let reply: { status: number; body: unknown } = { status: 404, body: {} };
    if (m && m[1] === PID) {
      const name = m[2] ? decodeURIComponent(m[2]) : undefined;
      const s = name ? notes.get(name) : undefined;
      const current = s?.text ?? null;
      const baseOk = (hash: unknown) => (current === null ? hash === null : hash === hashOf(current));
      if (!name && method === 'GET') reply = { status: 200, body: { notes: [...notes.keys()].filter(n => notes.get(n)!.text !== null).map(note), archived } };
      else if (!name && method === 'POST') {
        const created = String(body!.title).toLowerCase().replace(/[^a-z0-9]+/gu, '-');
        notes.set(created, { text: null, events: [] });
        add(created, 'create', null, `# ${String(body!.title)}\n\n${String(body!.content).trim()}\n`);
        reply = { status: 201, body: { note: note(created), text: notes.get(created)!.text } };
      } else if (name && !s) reply = fail(404, 'memfile.bad_name');
      else if (name && m[3] === 'history') reply = { status: 200, body: { events: s!.events } };
      else if (name && !m[3] && method === 'GET') reply = current === null ? fail(404, 'memfile.bad_name') : { status: 200, body: { note: note(name), text: current } };
      else if (name && !m[3] && method === 'PUT') {
        if (!baseOk(body!.baseHash)) reply = fail(409, 'memfile.changed');
        else { add(name, 'update', current, `# ${String(body!.title)}\n\n${String(body!.content).trim()}\n`); reply = { status: 200, body: { note: note(name), text: notes.get(name)!.text } }; }
      } else if (name && !m[3] && method === 'DELETE') {
        if (!baseOk(url.searchParams.get('baseHash'))) reply = fail(409, 'memfile.changed');
        else { add(name, 'forget', current, null); reply = { status: 200, body: { ok: true } }; }
      } else if (name && m[3] === 'restore') {
        const version = s!.events.find(e => e.id === body!.eventId);
        if (!baseOk(body!.baseHash)) reply = fail(409, 'memfile.changed');
        else if (!version) reply = fail(404, 'memfile.no_version');
        else { add(name, 'restore', current, version.after ?? version.before); reply = { status: 200, body: { note: note(name), text: notes.get(name)!.text } }; }
      } else if (name && m[3] === 'reviewed') {
        if (!baseOk(body!.baseHash)) reply = fail(409, 'memfile.changed');
        else { add(name, 'reviewed', current, current); tainted.delete(name); reply = { status: 200, body: { note: note(name), text: current } }; }
      }
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const writes = () => calls.filter(c => c.method !== 'GET');
  return { calls, writes, notes, hashOf: (name: string) => hashOf(notes.get(name)!.text!) };
}

const settle = (ms = 220) => update(() => new Promise(resolve => setTimeout(resolve, ms)));

async function screen(productId: string | undefined, projects: Project[] = [project()]) {
  const { container } = await render(createElement(Memory, { productId, projects, projectsLoaded: true, revision: 0 }));
  await settle();
  return container;
}

const V1 = '# Test commands\n\nRun npm test.\n';
const V2 = '# Test commands\n\nRun npm test.\nThen npm run check.\n';
const SEED = {
  'test-commands': { text: V2, events: [{ action: 'create' as const, after: V1, summary: 'Created' }, { action: 'update' as const, before: V1, after: V2, summary: 'Added the check step' }] },
  'note-1': { text: '# Web finding\n\nThe API pages say X.\n', events: [{ action: 'create' as const, after: '# Web finding\n\nThe API pages say X.\n' }], tainted: true },
};

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-note]')];
const historyRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ui-lib__history [data-event]')];

test('Memory（DOM）: 製品の外から開くと製品を選ぶ一覧から始まり、記憶の口は呼ばない。Global は押せず「Bot mode only — not used yet」', async () => {
  const server = fakeServer(SEED);
  const container = await screen(undefined, [project(), project({ id: 'p2bbbb', name: 'field-notes', archived_at: 5 })]);
  const links = [...container.querySelectorAll<HTMLAnchorElement>('.ui-mem__picker a')];
  assert.deepEqual(links.map(a => [a.textContent, a.getAttribute('href')]), [['uploader', '#/memory/p1aaaa'], ['field-notes', '#/memory/p2bbbb']]);
  assert.match(container.querySelector('.ui-mem__picker')!.textContent!, /archived/u);
  const global = byText(container, '.bt-seg__opt', 'Global') as HTMLButtonElement;
  assert.equal(global.disabled, true);
  assert.equal(global.title, 'Bot mode only — not used yet');
  assert.equal(byText(container, 'button', 'New memory'), undefined);
  assert.equal(server.calls.length, 0);
});

test('Memory（DOM）: 0 件の製品は空の表示と New memory。範囲の切り替えは製品の名前が押された形', async () => {
  fakeServer({});
  const container = await screen(PID);
  assert.ok(byText(container, '.bt-empty *', 'No memories yet'));
  assert.equal(byText(container, '.bt-seg__opt', 'uploader')?.getAttribute('aria-pressed'), 'true');
  assert.ok(byText(container, '.bt-empty button', 'New memory'));
});

test('Memory（DOM）: 一覧は <name>.md・saved by beat / edited by you と時刻。印のある記憶にだけ札。右にパス・本文・History（版の題・だれ・行の増減、新しい版に Undo、古い版に Restore）', async () => {
  fakeServer(SEED);
  const container = await screen(PID);
  assert.deepEqual(rows(container).map(r => r.querySelector('code')?.textContent), ['test-commands.md', 'note-1.md']);
  assert.match(rows(container)[0]!.querySelector('.bt-row__sub')!.textContent!, /^saved by beat · /u);
  assert.equal(rows(container)[0]!.querySelector('.ui-mem__tag'), null);
  assert.equal(rows(container)[1]!.querySelector('.ui-mem__tag')?.textContent, 'read outside content');
  assert.equal(container.querySelector('.ui-mem__path')?.textContent, 'memory/test-commands.md');
  assert.match(container.querySelector('article.bt-doc')!.textContent!, /Then npm run check\./u);
  const history = historyRows(container);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.querySelector('.bt-row__title')?.textContent, 'Added the check step');
  assert.equal(history[0]!.querySelector('.ui-mem__lines')?.textContent, '+1');
  assert.ok(byText(history[0]!, 'button', 'Undo'));
  assert.ok(byText(history[1]!, 'button', 'Restore'));
  assert.equal(container.querySelector('[data-mark="outside"]'), null, '印の無い記憶に印を外すボタンは無い');
});

test('Memory（DOM）: 「読んだので印を外す」は持ち主の口（POST …/reviewed）だけを、見ている版の baseHash で呼ぶ。外したら札が消える', async () => {
  const server = fakeServer(SEED);
  const container = await screen(PID);
  await click(rows(container)[1]!.querySelector('button'));
  await settle();
  const mark = container.querySelector('[data-mark="outside"]')!;
  assert.match(mark.textContent!, /read outside content/u);
  await click(byText(mark, 'button', 'I read it · clear the mark'));
  await settle();
  assert.deepEqual(server.writes().map(c => [c.method, c.path, c.body]), [['POST', `/api/projects/${PID}/memory/note-1/reviewed`, { baseHash: server.hashOf('note-1') }]]);
  assert.equal(container.querySelector('[data-mark="outside"]'), null);
  assert.equal(rows(container)[1]!.querySelector('.ui-mem__tag'), null);
});

test('Memory（DOM）: Edit → Save は題と本文を baseHash つきで PUT し、History に版が増える', async () => {
  const server = fakeServer(SEED);
  const container = await screen(PID);
  await click(byText(container, '.bt-seg__opt', 'Edit'));
  const title = container.querySelector<HTMLInputElement>('.ui-mem__edit input')!;
  assert.equal(title.value, 'Test commands');
  const body = container.querySelector<HTMLTextAreaElement>('.ui-mem__edit textarea')!;
  assert.equal(body.value, 'Run npm test.\nThen npm run check.');
  const before = server.hashOf('test-commands');
  await input(body, 'Run npm test, then npm run check.');
  await click(byText(container, '.bt-pane__bar button', 'Save'));
  await settle();
  assert.deepEqual(server.writes().map(c => [c.method, c.body]), [['PUT', { title: 'Test commands', content: 'Run npm test, then npm run check.', baseHash: before }]]);
  assert.equal(historyRows(container).length, 3);
  assert.match(container.querySelector('article.bt-doc')!.textContent!, /Run npm test, then npm run check\./u);
});

test('Memory（DOM）: 新しい版の Undo は 1 つ前の版へ、古い版の Restore はその版へ戻す（どちらも baseHash つき）', async () => {
  const server = fakeServer(SEED);
  const container = await screen(PID);
  const [newest, older] = historyRows(container);
  const olderId = Number(older!.dataset.event);
  await click(byText(newest!, 'button', 'Undo'));
  await settle();
  assert.deepEqual(server.writes().map(c => [c.path, c.body]), [[`/api/projects/${PID}/memory/test-commands/restore`, { eventId: olderId, baseHash: hashOf(V2) }]]);
  assert.equal(server.notes.get('test-commands')!.text, V1);
  const restoreOf = historyRows(container).find(r => byText(r, 'button', 'Restore') && r.querySelector('.bt-row__title')?.textContent === 'Added the check step')!;
  await click(byText(restoreOf, 'button', 'Restore'));
  await settle();
  assert.equal(server.writes().length, 2);
  assert.equal(server.writes()[1]!.body!.baseHash, hashOf(V1));
  assert.equal(server.notes.get('test-commands')!.text, V2);
});

test('Memory（DOM）: 作っただけの記憶の Undo は消す確かめを出し、確かめたら baseHash つきで DELETE する', async () => {
  const server = fakeServer({ naming: { text: '# Naming\n\nUse kebab-case.\n', events: [{ action: 'create', after: '# Naming\n\nUse kebab-case.\n' }] } });
  const container = await screen(PID);
  await click(byText(historyRows(container)[0]!, 'button', 'Undo'));
  assert.equal(server.writes().length, 0);
  assert.ok(byText(container, '*', 'Delete this memory?'));
  await click(byText(container, '.bt-pane button', 'Delete'));
  await settle();
  assert.deepEqual(server.writes().map(c => [c.method, c.query.get('baseHash')]), [['DELETE', hashOf('# Naming\n\nUse kebab-case.\n')]]);
  assert.ok(byText(container, '.bt-empty *', 'No memories yet'));
});

test('Memory（DOM）: New memory は題と本文を POST し、できた記憶を開く', async () => {
  const server = fakeServer({});
  const container = await screen(PID);
  await click(byText(container, '.bt-screen__tools button', 'New memory'));
  const pane = container.querySelector('[aria-label="New memory"]')!;
  const save = byText(pane, 'button', 'Save') as HTMLButtonElement;
  assert.equal(save.disabled, true);
  await input(pane.querySelector('input'), 'Deploy order');
  await input(pane.querySelector('textarea'), 'Build, then migrate, then restart.');
  await click(save);
  await settle();
  assert.deepEqual(server.writes().map(c => [c.method, c.body]), [['POST', { title: 'Deploy order', content: 'Build, then migrate, then restart.' }]]);
  assert.equal(container.querySelector('.ui-mem__path')?.textContent, 'memory/deploy-order.md');
});

test('Memory（DOM）: しまった製品は読むだけ（New memory・Edit・Delete・印を外すが無い）', async () => {
  fakeServer(SEED, true);
  const container = await screen(PID, [project({ archived_at: 5 })]);
  assert.match(container.textContent!, /This product is archived\. Its memory is read-only\./u);
  assert.equal(byText(container, 'button', 'New memory'), undefined);
  assert.equal((byText(container, '.bt-seg__opt', 'Edit') as HTMLButtonElement).disabled, true);
  assert.equal(byText(container, '.bt-pane__bar button', 'Delete'), undefined);
  await click(rows(container)[1]!.querySelector('button'));
  await settle();
  assert.ok(container.querySelector('[data-mark="outside"]'));
  assert.equal(byText(container, 'button', 'I read it · clear the mark'), undefined);
});

test('Memory（DOM）: 書きかけのまま別の記憶を選ぶと、捨てるかの確かめが出て、選びは止まる（B02・B03 の仕組み）', async () => {
  const server = fakeServer(SEED);
  const container = await screen(PID);
  await click(byText(container, '.bt-seg__opt', 'Edit'));
  await input(container.querySelector('.ui-mem__edit textarea'), 'changed');
  await click(rows(container)[1]!.querySelector('button'));
  await settle();
  assert.equal(container.querySelector('.ui-mem__path')?.textContent, 'memory/test-commands.md');
  assert.ok(byText(container, 'button', 'Discard'), 'Discard の確かめが出る');
  assert.equal(server.writes().length, 0);
});

test('Memory（DOM）: 本文の遠くの画像は出さない（img を作らない）。長い本文もそのまま出る', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `- step ${i}`).join('\n');
  fakeServer({ remote: { text: `# Remote\n\n![logo](https://example.com/x.png)\n\n${long}\n`, events: [{ action: 'create', after: 'x' }] } });
  const container = await screen(PID);
  assert.equal(container.querySelector('article.bt-doc img'), null);
  assert.match(container.querySelector('article.bt-doc')!.textContent!, /step 119/u);
});

test('Memory の Notice の Undo（undoMemoryNoteEvent）: 作った版は DELETE、書き直した版は前の版へ restore、そのあと誰かが変えていたら何も書かずに false', async () => {
  const server = fakeServer(SEED);
  const created = server.notes.get('note-1')!.events[0]!.id;
  assert.equal(await undoMemoryNoteEvent(PID, 'note-1', created), true);
  assert.deepEqual(server.writes().map(c => [c.method, c.path]), [['DELETE', `/api/projects/${PID}/memory/note-1`]]);
  const [top, prev] = server.notes.get('test-commands')!.events.map(e => e.id);
  assert.equal(await undoMemoryNoteEvent(PID, 'test-commands', prev!), false, 'いちばん新しい版でなければ戻さない');
  assert.equal(server.writes().length, 1);
  assert.equal(await undoMemoryNoteEvent(PID, 'test-commands', top!), true);
  assert.deepEqual(server.writes()[1]!.body, { eventId: prev, baseHash: hashOf(V2) });
});

test('会話の Notice: 製品の記憶のファイルの変化は「Memory saved: memory/<name>.md」などの文になる', () => {
  const notice = (action: 'create' | 'update' | 'forget'): RunNotice => ({ runId: 'r', kind: 'memoryNote', action, projectId: PID, name: 'test-order', eventId: 1 });
  assert.equal(noticeText(t, notice('create')), 'Memory saved: memory/test-order.md');
  assert.equal(noticeText(t, notice('update')), 'Memory rewritten: memory/test-order.md');
  assert.equal(noticeText(t, notice('forget')), 'Memory forgotten: memory/test-order.md');
});
