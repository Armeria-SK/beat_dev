import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ApprovalRule } from '../web/src/api.ts';
import { setExplainLanguage } from '../web/src/i18n/index.ts';

// B6 ui-small（backlog 328）: 当たらない古い形の決まり（サーバーが inactive を付けたもの）は、Settings の一覧で「効いていない」の 1 文と Remove だけで出す

const { RulesGroup } = await loadTsx<{ RulesGroup: ComponentType }>('../web/src/ui/settings/agent.tsx', import.meta.url);
const { SettingsContext } = await loadTsx<{ SettingsContext: import('react').Context<unknown> }>('../web/src/ui/settings/controls.tsx', import.meta.url);
const rulesGroup = () => createElement(SettingsContext.Provider, { value: { errors: {}, pending: null } }, createElement(RulesGroup));

const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; setExplainLanguage('en'); });
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

const rule = (over: Partial<ApprovalRule> & { inactive?: true }): ApprovalRule => ({ id: 1, project_id: 'p1', project_name: 'Shop', archived: false, kind: 'judge', tool: 'shell_run', shown: 'Run: npm install …', created_at: 1, ...over });
const sent: Array<{ method: string; path: string }> = [];
function serve(items: () => ApprovalRule[]): void {
  sent.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const one = { method: init?.method ?? 'GET', path: String(path) };
    sent.push(one);
    return new Response(JSON.stringify(one.method === 'DELETE' ? { removed: 1 } : { items: items() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('bl-ui-small/rules-dom: inactive の決まりの行は「効いていない」の 1 文と Remove だけ。効く決まりの行には出ない', async () => {
  let items = [rule({ id: 1 }), rule({ id: 2, kind: 'policy', shown: 'Run exactly: Get-Date', inactive: true }), rule({ id: 3, kind: 'send', shown: 'curl sends data to https://a.example:443', outside: true })];
  serve(() => items);
  const { container } = await render(rulesGroup());
  await settle();
  const rows = [...container.querySelectorAll('[data-row^="rules:"]')];
  assert.deepEqual(rows.map(row => row.querySelector('code')?.textContent), ['Run: npm install …', 'Run exactly: Get-Date', 'curl sends data to https://a.example:443']);
  const descs = rows.map(row => row.querySelector('.bt-setting__desc')?.textContent ?? '');
  assert.equal(descs[0], 'judge would have checked');
  assert.match(descs[1]!, /^Not in effect\. It was made from a command on your Always ask list/u);
  assert.ok(!descs[1]!.includes('tool set to Ask'), '効かない行に、効くように見える種類の文を並べない');
  assert.match(descs[2]!, /^sends outside · also runs without asking/u);
  assert.deepEqual(rows.map(row => row.querySelectorAll('button').length), [1, 1, 1], '操作は Remove だけ');
  assert.equal(rows[1]!.querySelector('button')?.textContent, 'Remove');

  items = items.filter(r => r.id !== 2);
  await click(byText(rows[1] as HTMLElement, 'button', 'Remove'));
  await settle();
  assert.deepEqual(sent.filter(s => s.method === 'DELETE').map(s => s.path), ['/api/approval-rules/2']);
  assert.deepEqual([...container.querySelectorAll('code')].map(c => c.textContent), ['Run: npm install …', 'curl sends data to https://a.example:443'], '外すと一覧から消える');
});

test('bl-ui-small/rules-dom: 日本語の説明では、効いていない旨も日本語で出る', async () => {
  setExplainLanguage('ja');
  serve(() => [rule({ id: 2, kind: 'policy', shown: 'Run exactly: Get-Date', inactive: true })]);
  const { container } = await render(rulesGroup());
  await settle();
  assert.match(container.querySelector('.bt-setting__desc')?.textContent ?? '', /^効いていません。Always ask の一覧にあるコマンドから作った決まりで/u);
});
