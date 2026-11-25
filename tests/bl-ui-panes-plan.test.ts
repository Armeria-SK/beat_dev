import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

// backlog 333（Plan の欄）: Build を押してから受け入れの一覧を読み直すまでのあいだ、見出しが "Draft — locked when you build" のままにならない

interface PlanProps { productId: string; conversationId?: string; revision: string; isGit: boolean }

const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.location.hash = '';
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const item = { id: 'A1', result: 'The app starts', source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null };
const draft = { version: 0, language: 'en', items: [item], not_doing: [], draft: true, hash: 'a0', frozen: null } as unknown as Acceptance;
const frozen = {
  version: 1, language: 'en', items: [item], not_doing: [], draft: false, hash: 'a1', open_build_task_id: 't1',
  frozen: { version: 1, hash: 'a1', plan_hash: 'p1', created_at: 5, source: 'build', build_task_id: 't1' },
} as unknown as Acceptance;

interface Rig { container: HTMLElement; finishBuild: (status: number, body: unknown) => void; setAcceptance: (next: Acceptance) => void }

async function openPlan(first: Acceptance = draft): Promise<Rig> {
  let acceptance = first;
  let answer: (response: Response) => void = () => undefined;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const [route] = String(path).split('?');
    const method = init?.method ?? 'GET';
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (route === `/api/projects/${PRODUCT}/plan`) return reply(200, { plan: { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false, built_hash: null } });
    if (route === `/api/projects/${PRODUCT}/acceptance`) return reply(200, { acceptance });
    if (route === `/api/projects/${PRODUCT}/acceptance/versions`) return reply(200, { versions: [] });
    if (route === `/api/projects/${PRODUCT}/build` && method === 'POST') return new Promise<Response>(resolve => { answer = resolve; });
    return reply(404, { error: 'not found' });
  }) as typeof fetch;
  const { container } = await render(createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision: '0', isGit: true }));
  await settle();
  await settle();
  return {
    container,
    finishBuild: (status, body) => answer(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
    setAcceptance: next => { acceptance = next; },
  };
}

const header = (container: HTMLElement) => container.querySelector('section[aria-label="Acceptance"] .bt-section__head .bt-meta')?.textContent ?? null;
const buildButton = (container: HTMLElement) => [...container.querySelectorAll('button')].find(b => b.textContent === 'Build with this plan');

test('333 ui/PlanPane（DOM）: Build を押して返事を待つあいだ、見出しは "Draft — locked when you build" と言わない（もう固めに行っている）。押す前は今までどおり Draft', async () => {
  const rig = await openPlan();
  assert.equal(header(rig.container), en['ui.acc.draft'], '前提: 押す前は Draft の見出し');
  await click(buildButton(rig.container));
  await settle();
  const waiting = header(rig.container);
  assert.notEqual(waiting, en['ui.acc.draft'], 'Build の返事を待つあいだ');
  assert.equal(waiting, '', '何も言わない（版の番号はまだ無い）');
});

test('333 ui/PlanPane（DOM）: Build が通って読み直したあとは版の番号（v1）。断られて下書きのままなら Draft の見出しに戻る', async () => {
  const done = await openPlan();
  await click(buildButton(done.container));
  await settle();
  done.setAcceptance(frozen);
  done.finishBuild(201, { task: { id: 't1', status: 'ready' }, version: 1 });
  await settle();
  await settle();
  assert.equal(header(done.container), en['ui.acc.version'](1));
  await cleanup();

  const refused = await openPlan();
  await click(buildButton(refused.container));
  await settle();
  refused.finishBuild(409, { error: 'refused', code: 'build.changed' });
  await settle();
  await settle();
  assert.equal(header(refused.container), en['ui.acc.draft'], '下書きのままなので、また Draft と言う');
});

test('333 ui/PlanPane（DOM）: すでに固めた版に残りがあって 2 回目の Build を待つあいだは、版の番号（v1）のまま。消すのは下書きの見出しだけ', async () => {
  const rig = await openPlan({ ...frozen, open_build_task_id: null, unbuilt: ['A1'] } as Acceptance);
  assert.equal(header(rig.container), en['ui.acc.version'](1), '前提: 固めた版');
  await click(buildButton(rig.container));
  await settle();
  assert.equal(header(rig.container), en['ui.acc.version'](1));
});
