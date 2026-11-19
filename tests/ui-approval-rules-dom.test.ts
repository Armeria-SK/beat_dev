import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ApprovalRule, PendingAction } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { judgedLine } from '../web/src/ui/library.ts';

// beat J-5: the "Approve, and don't ask again in this product" choice, the Settings list of rules, the rule gate on a tool row and the Runs count

interface ListProps { projectId: string | null; waiting: readonly PendingAction[]; counts: null; projects: never[]; conversations: never[]; revision: string; onOpenPlan: (id: string) => void }

const { PendingList } = await loadTsx<{ PendingList: ComponentType<ListProps> }>('../web/src/ui/panes/PendingPane.tsx', import.meta.url);
const { RulesGroup } = await loadTsx<{ RulesGroup: ComponentType }>('../web/src/ui/settings/agent.tsx', import.meta.url);
const { SettingsContext } = await loadTsx<{ SettingsContext: import('react').Context<unknown> }>('../web/src/ui/settings/controls.tsx', import.meta.url);
// Row reads only errors and pending from the Settings context
const rulesGroup = () => createElement(SettingsContext.Provider, { value: { errors: {}, pending: null } }, createElement(RulesGroup));
const { ToolGroup } = await loadTsx<{ ToolGroup: ComponentType<{ rows: unknown[]; isNew: (key: string) => boolean }> }>('../web/src/ui/ToolRow.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

interface Sent { method: string; path: string; body: string | null }

function stubFetch(answer: (sent: Sent) => { status: number; body: unknown }): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const one = { method: init?.method ?? 'GET', path: String(path), body: typeof init?.body === 'string' ? init.body : null };
    sent.push(one);
    const { status, body } = answer(one);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

const row = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 1, tool: 'shell_run', shown: 'npm install lodash', masked: 0, kind: 'judge', reason: 'the judge wants to ask', cwd: null, preview: [], files: [], conversation_id: 'c1',
  task_id: null, project_id: 'prod01', task_title: null, project_name: 'Shop', status: 'waiting', reject_reason: null, exit_code: null, output_preview: null,
  created_at: Date.now() - 5000, decided_at: null, ran_at: null, rule: null, ...over,
});

async function showPending(waiting: PendingAction[]) {
  const sent = stubFetch(s => (s.path.startsWith('/api/pending?status=decided') ? { status: 200, body: { items: [] } } : { status: 202, body: { item: null } }));
  const { container } = await render(createElement(PendingList, { projectId: 'prod01', waiting, counts: null, projects: [], conversations: [], revision: '0', onOpenPlan: () => undefined }));
  await settle();
  return { container, sent };
}

test('ui/PendingPane（DOM）J-5: 「don\'t ask again」は rule のある行だけ。押すと形と注意を見せ、Cancel に焦点（Escape で閉じる）。確かめると {"remember":true}、ふつうの Approve は {}', async () => {
  const { container, sent } = await showPending([row({ id: 1, rule: { shown: 'Run: npm install …' } }), row({ id: 2, shown: 'npm install a; npm test' })]);
  assert.equal(container.querySelectorAll('[data-remember]').length, 1, 'only the row with a rule');
  await click(container.querySelector('[data-remember]'));
  const panel = container.querySelector('[data-remember-confirm]');
  assert.ok(panel);
  assert.equal(panel.querySelector('code')?.textContent, 'Run: npm install …');
  assert.ok(byText(panel, '.bt-meta', "You can remove it in Settings › Skills & tools › Don't ask again."));
  assert.equal(document.activeElement?.textContent, 'Cancel', 'focus on Cancel, not on the confirm button');
  await update(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(container.querySelector('[data-remember-confirm]'), null, 'Escape closes the panel');
  await click(container.querySelector('[data-remember]'));
  await click(byText(container.querySelector('[data-remember-confirm]')!, 'button', 'Approve and remember'));
  await settle();
  const approves = () => sent.filter(s => s.method === 'POST' && /\/approve$/u.test(s.path));
  assert.deepEqual(approves(), [{ method: 'POST', path: '/api/pending/1/approve', body: '{"remember":true}' }]);
  const plain = [...container.querySelectorAll('button')].find(b => b.textContent === 'Approve' && !b.disabled);
  assert.ok(plain, 'a plain Approve is left');
  await click(plain);
  await settle();
  assert.deepEqual(approves()[1], { method: 'POST', path: '/api/pending/2/approve', body: '{}' });
});

const rule = (over: Partial<ApprovalRule>): ApprovalRule => ({ id: 1, project_id: 'p1', project_name: 'Shop', archived: false, kind: 'judge', tool: 'shell_run', shown: 'Run: npm install …', created_at: 1, ...over });

test('ui/Settings（DOM）J-5: 決まりの一覧は製品ごとの見出しの下。空・読めない・Remove（DELETE してから読み直す）・Remove が届かないときは決まった文のトースト', async () => {
  let items: ApprovalRule[] = [rule({ id: 1 }), rule({ id: 2, kind: 'send', shown: 'curl sends data to https://a.example:443' }), rule({ id: 3, project_id: 'p2', project_name: 'Old', archived: true, kind: 'policy', shown: 'Use tool file_write' })];
  let failRemove = false;
  const sent = stubFetch(s => {
    if (s.method === 'DELETE') {
      if (failRemove) throw new TypeError('network down');
      items = items.filter(r => `/api/approval-rules/${r.id}` !== s.path);
      return { status: 200, body: { removed: 1 } };
    }
    return { status: 200, body: { items } };
  });
  const { container } = await render(rulesGroup());
  await settle();
  const groups = [...container.querySelectorAll('[data-rules-product]')];
  assert.deepEqual(groups.map(g => [g.getAttribute('data-rules-product'), g.querySelector('.bt-label')?.textContent, [...g.querySelectorAll('code')].map(c => c.textContent)]), [
    ['p1', 'Shop', ['Run: npm install …', 'curl sends data to https://a.example:443']],
    ['p2', 'Old (archived)', ['Use tool file_write']],
  ]);
  await click(byText(groups[0]!, 'button', 'Remove'));
  await settle();
  assert.deepEqual(sent.filter(s => s.method === 'DELETE').map(s => s.path), ['/api/approval-rules/1']);
  assert.equal(sent.filter(s => s.method === 'GET').length, 2, 'reloads after removing');
  assert.equal(container.querySelectorAll('code').length, 2);

  failRemove = true;
  const toasts: FeedbackItem[] = [];
  const off = subscribe(item => { toasts.push(item); });
  try {
    await click(byText(container, 'button', 'Remove'));
    await settle();
  } finally { off(); }
  assert.deepEqual(toasts.map(x => x.title), ['Could not remove the rule']);

  await cleanup();
  items = [];
  const empty = await render(rulesGroup());
  await settle();
  assert.ok(empty.container.querySelector('[data-rules-empty]'));
  await cleanup();
  stubFetch(() => ({ status: 500, body: {} }));
  const broken = await render(rulesGroup());
  await settle();
  assert.ok(byText(broken.container, '.bt-meta', 'Could not load the rules'));
  assert.equal(broken.container.querySelector('[data-rules-empty]'), null);
});

test('ui/ToolRow（DOM）J-5: 決まりで通した行は「Allowed (your rule: …)」で、題に形', async () => {
  const { container } = await render(createElement(ToolGroup, {
    rows: [{ key: 'a', name: 'shell_run', input: JSON.stringify({ command: 'npm install a' }), result: { text: 'ok', isError: false }, gate: { by: 'rule', id: 3, shown: 'Run: npm install …' } }], isNew: () => false,
  }));
  const why = container.querySelector('.ui-tool__why');
  assert.equal(why?.textContent, 'Allowed (your rule: Run: npm install …)');
  assert.equal(why?.getAttribute('title'), 'Run: npm install …');
});

test('ui/Runs J-5: judgedLine は決まりで通した数を足し、0 なら出さない', () => {
  assert.deepEqual(judgedLine({ allowed: 1, parked: {}, notParked: 0, ruled: { send: 2, removed: 1 } }), { allowed: 1, parked: 0, notRun: 0, ruled: 3 });
  assert.deepEqual(judgedLine({ allowed: 1, parked: {}, notParked: 0, ruled: {} }), { allowed: 1, parked: 0, notRun: 0 });
  assert.deepEqual(judgedLine({ allowed: 0, parked: {}, notParked: 0, ruled: { judge: 1 } }), { allowed: 0, parked: 0, notRun: 0, ruled: 1 }, 'a day with only rule hits still shows the line');
});

test('ui J-5: push の決まりは、確かめの欄と Settings の行に「見ていないコミットも送る」の 1 文。ほかの決まりには出さない', async () => {
  const { container } = await showPending([row({ id: 1, shown: 'git push origin main', rule: { shown: 'Run: git push …', push: true } }), row({ id: 2, rule: { shown: 'Run: npm install …' } })]);
  const button = (id: number) => container.querySelector(`[data-pending="${id}"] [data-remember]`);
  await click(button(1));
  assert.match(container.querySelector('[data-remember-confirm] [data-remember-push]')?.textContent ?? '', /including commits you have not seen/u);
  await click(byText(container.querySelector('[data-remember-confirm]')!, 'button', 'Cancel'));
  await click(button(2));
  assert.equal(container.querySelector('[data-remember-push]'), null);
  await cleanup();
  stubFetch(() => ({ status: 200, body: { items: [rule({ id: 1, shown: 'Run: git push …', push: true }), rule({ id: 2 })] } }));
  const list = await render(rulesGroup());
  await settle();
  const descs = [...list.container.querySelectorAll('.bt-setting__desc')].map(e => e.textContent);
  assert.deepEqual(descs, ['judge would have checked · pushes run without asking, including commits you have not seen', 'judge would have checked']);
});

test('ui AP-1b N10: 送る・消す・push・MCP の決まり（outside）は、確かめの欄と Settings の行に「外の文を読んだあとでも聞かずに動く」の 1 文。judge の決まりには出さない', async () => {
  const { container } = await showPending([row({ id: 1, kind: 'send', shown: 'curl -d x https://a.example/p', rule: { shown: 'curl sends data to https://a.example:443', outside: true } }), row({ id: 2, rule: { shown: 'Run: npm install …' } })]);
  const button = (id: number) => container.querySelector(`[data-pending="${id}"] [data-remember]`);
  await click(button(1));
  assert.match(container.querySelector('[data-remember-confirm] [data-remember-outside]')?.textContent ?? '', /after a run has read text from elsewhere/u);
  await click(byText(container.querySelector('[data-remember-confirm]')!, 'button', 'Cancel'));
  await click(button(2));
  assert.equal(container.querySelector('[data-remember-outside]'), null);
  await cleanup();
  stubFetch(() => ({ status: 200, body: { items: [rule({ id: 1, kind: 'send', shown: 'curl sends data to https://a.example:443', outside: true }), rule({ id: 2, shown: 'Run: git push …', push: true, outside: true }), rule({ id: 3 })] } }));
  const list = await render(rulesGroup());
  await settle();
  const descs = [...list.container.querySelectorAll('.bt-setting__desc')].map(e => e.textContent ?? '');
  assert.match(descs[0]!, / · also runs without asking after reading text from elsewhere$/u);
  assert.match(descs[1]!, /pushes run without asking, including commits you have not seen · also runs without asking after reading text from elsewhere$/u);
  assert.equal(descs[2], 'judge would have checked');
});
