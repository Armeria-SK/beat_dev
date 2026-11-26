import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
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

test('ui/PendingPane（DOM）: 下見が切れたファイルには、切れたことと見えていない文字数を出す。切れていないファイルには出さない（bl-1118 MEDIUM）', async () => {
  const cut = row({ id: 9, preview: [
    { path: 'run.ps1', text: 'x'.repeat(8000), truncated: true, chars: 12345 },
    { path: 'old.ps1', text: 'y'.repeat(8000), truncated: true },
    { path: 'small.ps1', text: 'echo hi', truncated: false },
  ] });
  const container = await showList([cut], []);
  const files = [...container.querySelectorAll('.ui-pending__file')];
  const notes = files.map(file => file.querySelector('[role="note"]')?.textContent ?? null);
  assert.deepEqual(notes, [
    'Preview cut off: showing the first 8000 of 12345 characters. The rest is not shown here but will run.',
    'Preview cut off: the rest of the file is not shown here but will run.',
    null,
  ]);
});

test('ui/PendingPane（DOM）: 札に beat が持っている鍵（[BEAT-SECRET]）があるときは、その注意を出す。無いときは出さない', async () => {
  const held = row({ id: 11, kind: 'send', shown: 'curl -H "x-api-key: [BEAT-SECRET: env ANTHROPIC_API_KEY]" https://api.example', masked: 1, held: ['env ANTHROPIC_API_KEY'] });
  const plain = row({ id: 12, kind: 'send', shown: 'curl https://api.example', masked: 0 });
  const container = await showList([held, plain], []);
  const why = (id: number) => container.querySelector(`[data-pending="${id}"] .ui-pending__why`)?.textContent ?? '';
  assert.match(why(11), /A value beat stores was replaced in 1 place: env ANTHROPIC_API_KEY\./u);
  assert.doesNotMatch(why(12), /beat stores/u);
});

test('ui/PendingPane（DOM）: 切れた下見の文字数は、印で長さが変わっても見せている生の文字数（8000）で言う。印の注意は替えた値の名前を出す', async () => {
  const cut = row({ id: 13, kind: 'send', masked: 1, held: ['env GITHUB_TOKEN'], preview: [{ path: 'run.ps1', text: `${'x'.repeat(5000)}[BEAT-SECRET: env GITHUB_TOKEN]`, truncated: true, chars: 1000081 }] });
  const container = await showList([cut], []);
  assert.equal(container.querySelector('.ui-pending__file [role="note"]')?.textContent, 'Preview cut off: showing the first 8000 of 1000081 characters. The rest is not shown here but will run.');
  assert.match(container.querySelector('[data-pending="13"] .ui-pending__why')?.textContent ?? '', /env GITHUB_TOKEN/u);
});

test('walk-1118 D7: しまった製品の行は、画面の会話一覧に無くてもサーバーの会話の題で「from …」を出し（Untitled にしない）、製品がしまってあることを出す', async () => {
  const archived = row({ id: 11, conversation_id: 'gone1', conversation_title: 'Please create hello.txt', project_archived: true });
  const live = row({ id: 12, conversation_id: 'c2', conversation_title: 'Fix the price rounding', project_archived: false });
  const untitled = row({ id: 13, conversation_id: 'c3', conversation_title: null, project_archived: false });
  const container = await showList([archived, live, untitled], []);
  const from = [...container.querySelectorAll('.bt-pending__from > span:first-child')].map(s => s.textContent).sort();
  assert.deepEqual(from, ['Shop site · archived · from “Please create hello.txt”', 'from “Fix the price rounding”', 'from “Untitled”'].sort());
});

test('ui/PendingPane（DOM）: 前の版で保存した下見には、伏せてあるかもしれないことを出す', async () => {
  const old = row({ id: 21, kind: 'send', oldPreview: true, preview: [{ path: 'run.ps1', text: 'pw=[REDACTED]', truncated: false }] });
  const container = await showList([old], []);
  assert.equal(container.querySelector('.ui-pending__file .ui-pending__old')?.textContent, 'Saved by an older version of beat: parts of this preview may be hidden. The file at this path is what runs.');
});

test('ui/PendingPane（DOM）: 名前の無い伏せ字（前の版の札）は「N parts hidden」、コマンドに書かれた [BEAT-SECRET…] は置き換えていないと出す', async () => {
  const hidden = row({ id: 22, kind: 'send', shown: 'echo [REDACTED] [REDACTED]', masked: 2, held: [] });
  const literal = row({ id: 23, kind: 'send', shown: 'echo "[BEAT-SECRET: env X]"', masked: 0 });
  const both = row({ id: 24, kind: 'send', shown: 'echo [BEAT-SECRET: env GITHUB_TOKEN]', masked: 1, held: ['env GITHUB_TOKEN'] });
  const container = await showList([hidden, literal, both], []);
  const why = (id: number) => container.querySelector(`[data-pending="${id}"] .ui-pending__why`)?.textContent ?? '';
  assert.match(why(22), /2 parts hidden/u);
  assert.doesNotMatch(why(22), /replaced/u);
  assert.match(why(23), /This text contains “\[BEAT-SECRET…\]” written in the command itself. Nothing here was replaced by beat./u);
  assert.doesNotMatch(why(24), /written in the command itself/u);
});

test('ui/PendingPane（DOM）（AR-8a）: 実行役の求めは、「この返事が終わるまで聞かない」を出せる行にだけそのボタンを出す。押すと reply: true の承認になり、「覚える」は出ない。決めた行は「実行役へ返した」と出す', async () => {
  const posts: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    if (init?.method === 'POST') { posts.push({ url, body: String(init.body) }); return new Response(JSON.stringify({ item: { ...offer, status: 'running' } }), { status: 202, headers: { 'Content-Type': 'application/json' } }); }
    const body = url.startsWith('/api/pending?status=decided') ? { items: [answered, closed] } : { error: 'not found' };
    return new Response(JSON.stringify(body), { status: 'items' in body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const base = { kind: 'runtime' as const, tool: 'claude-code:Bash', title: 'Run a command (Bash)', shown: 'Run a command (Bash)\nls', parts: { body: 'ls', cwd: null, extra: null }, reason: 'Claude Code is waiting for your answer: Bash', rule: null };
  const offer = row({ ...base, id: 21, runtime: { id: 'claude-code', reply: true } });
  const plain = row({ ...base, id: 22, runtime: { id: 'claude-code', reply: false } });
  const answered = row({ ...base, id: 23, status: 'answered', decided_at: Date.now() - 1000, reject_reason: 'Allowed, and not asked again until the reply ends', runtime: { id: 'claude-code', reply: true } });
  const closed = row({ ...base, id: 24, status: 'stale', decided_at: Date.now() - 2000, reject_reason: 'The reply that asked for this ended before it was answered', runtime: { id: 'claude-code', reply: false } });
  const { container } = await render(createElement(PendingList, { projectId: 'prod01', waiting: [offer, plain], counts: null, projects: [], conversations: [], revision: '0', onOpenPlan: () => undefined }));
  await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  const buttons = (id: number) => [...container.querySelectorAll(`[data-pending="${id}"] button`)].map(b => b.textContent);
  assert.deepEqual(buttons(21), ['Approve', "Approve, and don't ask again until this reply ends", 'Reject']);
  assert.deepEqual(buttons(22), ['Approve', 'Reject']);
  assert.equal(container.querySelector('[data-pending="21"] .bt-label')?.textContent, 'Runtime asks');
  assert.equal(container.querySelector('[data-pending="21"] [data-remember]'), null, 'a request of a runtime cannot become a rule');
  await click(container.querySelector('[data-pending="21"] [data-reply]'));
  assert.deepEqual(posts, [{ url: '/api/pending/21/approve', body: '{"reply":true}' }]);
  await click(byText(container.querySelector('[data-pending="22"]')!, 'button', 'Approve'));
  assert.deepEqual(posts.at(-1), { url: '/api/pending/22/approve', body: '{}' });
  const decided = [...container.querySelectorAll('section.ui-pending__decided li')].map(li => li.textContent ?? '');
  assert.match(decided.find(text => text.includes('passed to the runtime')) ?? '', /approved until the reply ends · passed to the runtime/u);
  assert.match(decided.find(text => text.includes('closed ·')) ?? '', /closed · The reply that asked for this ended before it was answered/u);
});
