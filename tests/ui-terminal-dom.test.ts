import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { BackgroundItem } from '../web/src/api.ts';

// beat 6-4: Terminal の欄（Design の TerminalPane）・Overview の Running now のコマンドの行・道具の行の「Open in Terminal」

const { TerminalPane } = await loadTsx<{ TerminalPane: ComponentType<{ productId: string; revision: string; focus?: string | null }> }>('../web/src/ui/panes/TerminalPane.tsx', import.meta.url);
const { CommandItems } = await loadTsx<{ CommandItems: ComponentType<{ commands: BackgroundItem[]; now: number; busy: ReadonlySet<string>; onStop: (item: BackgroundItem) => void }> }>('../web/src/ui/screens/home-parts.tsx', import.meta.url);
const { ToolGroup } = await loadTsx<{ ToolGroup: ComponentType<{ rows: unknown[]; isNew: (key: string) => boolean; terminal?: (id: string) => void }> }>('../web/src/ui/ToolRow.tsx', import.meta.url);
const terminal = await import('../web/src/ui/terminal.ts');
const panes = await import('../web/src/ui/panes.ts');

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const nl = String.fromCharCode(10);
const job = (over: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: 'bg-1', command: 'npm run dev', state: 'running', exitCode: null, startedAt: Date.now() - 125_000, orphaned: false, tainted: false, spawnFailed: false,
  port: 5173, conversationId: 'c1', startedBy: { kind: 'conversation', id: 'c1', title: 'Add retry with backoff' }, ...over,
});

interface Server { items: BackgroundItem[]; outputs: Record<string, string[]>; calls: string[] }

function serve(server: Server) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    server.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/background') return reply({ items: server.items });
    const m = /^\/api\/background\/([^/]+)\/(output|stop)$/u.exec(url.pathname);
    const item = server.items.find(i => i.id === m?.[1]);
    if (!m || !item) return reply({ error: 'not_found' }, 404);
    if (m[2] === 'stop') {
      Object.assign(item, { state: 'stopped', stoppedBy: 'owner', endedAt: Date.now() });
      return reply({ item });
    }
    const chunks = server.outputs[item.id] ?? [];
    const from = Number(url.searchParams.get('from') ?? 0);
    const text = chunks.slice(from).join('');
    return reply({ ...item, text, next: chunks.length, skipped: 0 });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

async function show(server: Server, props: { revision?: string; focus?: string | null } = {}) {
  serve(server);
  const rendered = await render(createElement(TerminalPane, { productId: 'prod01', revision: props.revision ?? '0', focus: props.focus ?? null }));
  await settle();
  await settle();
  return rendered;
}

test('ui/TerminalPane（DOM）: 帯にコマンドの切り替え・ポートと経過時間・Running の札・Stop。出力は bt-term、コマンドの行と最後の行の caret、下に read-only と始めた会話', async () => {
  const server: Server = { items: [job(), job({ id: 'bg-2', command: 'npm test', state: 'exited', exitCode: 0, endedAt: Date.now() })], outputs: { 'bg-1': [`> vite${nl}`, `  Local:   http://localhost:5173/${nl}`] }, calls: [] };
  const { container } = await show(server);
  const seg = [...container.querySelectorAll('.bt-pane__bar .bt-seg__opt')].map(b => [b.textContent, b.getAttribute('aria-pressed')]);
  assert.deepEqual(seg, [['npm run dev', 'true'], ['npm test', 'false']]);
  assert.equal(container.querySelector('.bt-pane__bar > .bt-meta')?.textContent, 'port 5173 · 2m');
  assert.equal(container.querySelector('.bt-pane__bar .bt-pill')?.textContent, 'Running');
  const stop = byText(container, '.bt-pane__bar button', 'Stop');
  assert.ok(stop);
  assert.ok(!stop.className.includes('danger'), 'Stop は danger にしない');
  const lines = [...container.querySelectorAll('pre.bt-term > .bt-term__line')];
  assert.equal(lines[0]!.className, 'bt-term__line bt-term__line--cmd');
  assert.equal(lines[0]!.textContent, '$ npm run dev');
  assert.deepEqual(lines.slice(1).map(l => l.textContent), ['> vite', '  Local:   http://localhost:5173/']);
  assert.ok(lines.at(-1)!.querySelector('.bt-caret'), '動いているあいだ最後の行に caret');
  assert.equal(container.querySelector('.ui-term__meta > span')?.textContent, 'read-only · started by beat in “Add retry with backoff”');
  assert.equal(container.querySelector('input, textarea, [contenteditable]'), null, '入力欄は無い');
  assert.equal(byText(container, 'button', 'Run again'), undefined);
});

test('ui/TerminalPane（DOM）: 札の 4 つ（Running / Exited 0 / Exited N / Stopped）。終わったものには Stop と caret が無い', async () => {
  const server: Server = {
    items: [job(), job({ id: 'bg-2', state: 'exited', exitCode: 0, endedAt: Date.now() }), job({ id: 'bg-3', state: 'exited', exitCode: 1, endedAt: Date.now() }), job({ id: 'bg-4', state: 'stopped', stoppedBy: 'owner', endedAt: Date.now() })],
    outputs: { 'bg-2': [`done${nl}`] }, calls: [],
  };
  const { container } = await show(server);
  const pills: Array<[string | null | undefined, string]> = [];
  const buttons = [...container.querySelectorAll('.bt-pane__bar .bt-seg__opt')];
  for (const button of buttons) {
    await click(button);
    await settle();
    const pill = container.querySelector('.bt-pane__bar .bt-pill')!;
    pills.push([pill.textContent, pill.className]);
    if (pill.textContent !== 'Running') {
      assert.equal(byText(container, '.bt-pane__bar button', 'Stop'), undefined);
      assert.equal(container.querySelector('.bt-caret'), null);
    }
  }
  assert.deepEqual(pills, [
    ['Running', 'bt-pill bt-pill--running'], ['Exited 0', 'bt-pill bt-pill--ok'], ['Exited 1', 'bt-pill bt-pill--danger'], ['Stopped', 'bt-pill'],
  ]);
});

test('ui/TerminalPane（DOM）: Stop で持ち主の止めを送り、札が Stopped になる', async () => {
  const server: Server = { items: [job()], outputs: {}, calls: [] };
  const { container } = await show(server);
  await click(byText(container, '.bt-pane__bar button', 'Stop'));
  await settle();
  assert.ok(server.calls.includes('POST /api/background/bg-1/stop'), server.calls.join(nl));
  assert.equal(container.querySelector('.bt-pane__bar .bt-pill')?.textContent, 'Stopped');
  assert.equal(byText(container, '.bt-pane__bar button', 'Stop'), undefined);
});

test('ui/TerminalPane（DOM）: リンクにするのは http://localhost だけ。ほかの宛先は文のまま', async () => {
  const server: Server = { items: [job()], outputs: { 'bg-1': [`Local: http://localhost:5173/app, Network: http://192.168.1.4:5173/ docs https://example.com${nl}`] }, calls: [] };
  const { container } = await show(server);
  const links = [...container.querySelectorAll('pre.bt-term a')].map(a => a.getAttribute('href'));
  assert.deepEqual(links, ['http://localhost:5173/app']);
});

test('ui/TerminalPane（DOM）: いちばん下にいれば新しい行は bt-term__line--new で入る。上へ巻き戻していたら動かさず「N new lines」', async () => {
  const server: Server = { items: [job()], outputs: { 'bg-1': [`one${nl}`] }, calls: [] };
  const { container } = await show(server);
  server.outputs['bg-1']!.push(`two${nl}`);
  await update(() => new Promise(resolve => setTimeout(resolve, terminal.POLL_MS + 100)));
  await settle();
  const fresh = [...container.querySelectorAll('.bt-term__line--new')].map(l => l.textContent);
  assert.deepEqual(fresh, ['two'], '下にいるときは新しい行が上がってくる');
  const pre = container.querySelector('pre.bt-term') as HTMLElement;
  Object.defineProperty(pre, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(pre, 'clientHeight', { configurable: true, value: 200 });
  await update(() => { pre.scrollTop = 100; pre.dispatchEvent(new Event('scroll')); });
  server.outputs['bg-1']!.push(`three${nl}four${nl}`);
  await update(() => new Promise(resolve => setTimeout(resolve, terminal.POLL_MS + 100)));
  await settle();
  assert.equal(pre.scrollTop, 100, '巻き戻した位置は動かさない');
  assert.equal(container.querySelector('.ui-term__unseen')?.textContent, '2 new lines');
  assert.deepEqual([...container.querySelectorAll('.bt-term__line--new')].map(l => l.textContent), [], '巻き戻しているあいだは入る動きをしない');
  await click(container.querySelector('.ui-term__unseen'));
  assert.equal(container.querySelector('.ui-term__unseen'), null);
});

test('ui/TerminalPane（DOM）: コマンドが無ければ空の案内。外を読んだあとに始めたものは meta に印', async () => {
  const empty = await show({ items: [], outputs: {}, calls: [] });
  assert.ok(byText(empty.container, '.bt-empty__title, h2, h3, p, span', 'No background commands'), empty.container.innerHTML);
  await cleanup();
  const { container } = await show({ items: [job({ tainted: true })], outputs: {}, calls: [] });
  assert.match(container.querySelector('.ui-term__meta > span')?.textContent ?? '', /started after reading text from elsewhere/u);
});

test('ui/TerminalPane（DOM）: focus の番号を選ぶ（道具の行の Open in Terminal から開いたとき）', async () => {
  const { container } = await show({ items: [job(), job({ id: 'bg-2', command: 'npm test' })], outputs: {}, calls: [] }, { focus: 'bg-2' });
  assert.equal(container.querySelector('.bt-seg__opt[aria-pressed="true"]')?.textContent, 'npm test');
  await cleanup();
  const open = await show({ items: [job(), job({ id: 'bg-2', command: 'npm test' })], outputs: {}, calls: [] });
  assert.equal(open.container.querySelector('.bt-seg__opt[aria-pressed="true"]')?.textContent, 'npm run dev');
  await update(() => open.root.render(createElement(TerminalPane, { productId: 'prod01', revision: '0', focus: 'bg-2' })));
  await settle();
  assert.equal(open.container.querySelector('.bt-seg__opt[aria-pressed="true"]')?.textContent, 'npm test', '開いている欄でも、あとから来た focus に替わる');
});

test('ui/panes: Terminal の欄は製品があるときだけ開く。並びは Design の順', () => {
  assert.deepEqual(panes.openable({ productId: null }), []);
  assert.ok(panes.openable({ productId: 'p' }).includes('terminal'));
  assert.deepEqual(panes.tabOrder(panes.openable({ productId: 'p' }), false), ['plan', 'questions', 'pending', 'terminal']);
  assert.equal(panes.paneDef('terminal').counted, false, '札に数は出さない');
});

test('ui/terminal: 書きかけの行は次の文の頭とつなぐ。上限を超えたら古い行から捨てる', () => {
  let text = terminal.EMPTY_TEXT;
  text = terminal.addText(text, `a${nl}b`).next;
  text = terminal.addText(text, `c${nl}d${nl}`).next;
  assert.deepEqual(text.lines.map(l => l.text), ['a', 'bc', 'd']);
  const capped = terminal.addText(terminal.EMPTY_TEXT, `1${nl}2${nl}3${nl}`, 2).next;
  assert.deepEqual(capped.lines.map(l => [l.n, l.text]), [[1, '2'], [2, '3']]);
});

test('ui/home: Running now のコマンドの行は、コマンド・background・ポート・経過時間と Stop', async () => {
  const stopped: string[] = [];
  const now = Date.now();
  const { container } = await render(createElement('ul', null, createElement(CommandItems, { commands: [job({ startedAt: now - 8_040_000 })], now, busy: new Set<string>(), onStop: item => stopped.push(item.id) })));
  const row = container.querySelector('li[data-command="bg-1"]')!;
  assert.equal(row.querySelector('.bt-row__title code')?.textContent, 'npm run dev');
  assert.equal(row.querySelector('.bt-row__sub')?.textContent, 'background · port 5173 · 2h 14m');
  await click(byText(row, 'button', 'Stop'));
  assert.deepEqual(stopped, ['bg-1']);
});

test('ui/ToolRow（DOM）: 裏で始めた shell_run の行は、閉じたままでも「background · bg-N」。中に「Open in Terminal」があり、押すとその番号で欄を開く。ふつうの shell_run には無い', async () => {
  const opened: string[] = [];
  const started = 'Started in the background as bg-3 (pwsh, cwd: .). It keeps running with no time limit.';
  const rows = [
    { key: 'a', name: 'shell_run', input: JSON.stringify({ command: 'node server.js', background: true }), result: { text: `$ node server.js${nl}${started}${nl}[Output so far]${nl}listening`, isError: false } },
    { key: 'b', name: 'shell_run', input: JSON.stringify({ command: 'npm test' }), result: { text: `$ npm test${nl}${nl}(pwsh, exit code: 0, 1.2 s)${nl}ok`, isError: false } },
  ];
  const { container } = await render(createElement(ToolGroup, { rows, isNew: () => false, terminal: id => opened.push(id) }));
  const [bg, plain] = [...container.querySelectorAll('details.bt-tool')];
  assert.equal(bg!.querySelector('.bt-tool__meta')?.textContent, 'background · bg-3');
  assert.doesNotMatch(plain!.querySelector('.bt-tool__meta')?.textContent ?? '', /background/u);
  assert.match(plain!.querySelector('.bt-tool__meta')?.textContent ?? '', /1\.2/u, 'ふつうの行は終了コードと秒のまま');
  assert.equal(plain!.querySelector('.ui-tool__terminal'), null);
  const link = bg!.querySelector('.bt-tool__body .ui-tool__terminal');
  assert.equal(link?.textContent, 'Open in Terminal');
  assert.equal(bg!.querySelector('summary button'), null, '行に押しボタンは置かない');
  await click(link);
  assert.deepEqual(opened, ['bg-3']);
});
