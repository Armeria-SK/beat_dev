import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import type { Project } from '../web/src/api.ts';

// B6 ui-small（backlog 295・431）: タスクの会話は一覧の API に出ないので、App は製品を見つけられず Panes のボタンが出なかった。
// 読み込んだ会話の project_id から製品を引いて、ボタンを出す。

const { App } = await loadTsx<{ App: ComponentType }>('../web/src/ui/App.tsx', import.meta.url);

const g = globalThis as Record<string, unknown>;
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
g.EventSource = class { onmessage = null; onerror = null; onopen = null; addEventListener() {} removeEventListener() {} close() {} };
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;

const PRODUCT = 'p1aaaa';
const TASK_CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LISTED_CHAT = 'aaaaaaaa-0000-4000-8000-000000000002';
const NO_PRODUCT_CHAT = 'aaaaaaaa-0000-4000-8000-000000000003';

const project: Project = {
  id: PRODUCT, name: 'Shop', root: 'C:/work/shop', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1, is_git: true, folder_missing: false,
  waiting: { pending: 0, questions: 0, answers: 0, checks: 0 } as unknown as Project['waiting'], running: 0, last_activity_at: null, has_plan: true,
};
const row = (id: string, projectId: string | null, kind: string) => ({ id, title: `chat ${id.slice(-2)}`, created_at: 1, last_message_at: 1, project_id: projectId, permission_mode: 'auto', kind });

let paths: string[] = [];
function serve(listed: ReturnType<typeof row>[]): void {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    paths.push(url);
    let out: unknown;
    let status = 200;
    const messages = /^\/api\/conversations\/([^/]+)\/messages$/u.exec(url);
    if (url === '/api/onboarding') out = { done: true, steps: { user: true, identity: true, persona: true, model: true } };
    else if (url === '/api/settings') out = { config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' };
    else if (url === '/api/models') out = { models: [], chatOrder: [] };
    else if (url === '/api/conversations') out = { conversations: listed, more: {} };
    else if (url === '/api/projects') out = { projects: [project] };
    else if (messages) {
      const id = decodeURIComponent(messages[1]!);
      const own = id === TASK_CHAT ? row(id, PRODUCT, 'task') : id === NO_PRODUCT_CHAT ? row(id, null, 'task') : listed.find(c => c.id === id);
      out = own ? { conversation: own, messages: [], pending: [], builds: [], activeRun: null } : undefined;
    } else if (/^\/api\/conversations\/[^/]+\/checklist$/u.test(url)) out = { items: [], tainted: false, updatedAt: null };
    if (out === undefined) { out = { error: 'not found' }; status = 404; }
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
async function open(hash: string): Promise<void> {
  window.history.replaceState(null, '', `/${hash}`);
  await render(createElement(App));
  for (let i = 0; i < 6; i += 1) await settle();
}
const toggle = () => document.querySelector<HTMLButtonElement>('.bt-app__bar .ui-panes__toggle');
const messageReads = (id: string) => paths.filter(p => p === `/api/conversations/${id}/messages`).length;

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  paths = [];
  try { localStorage.clear(); } catch { /* 無くてよい */ }
  window.history.replaceState(null, '', '/');
});

test('bl-ui-small/task-panes: 一覧に出ないタスクの会話でも、会話の製品に Panes のボタンが出て、押すとその製品の欄が開く', async () => {
  serve([row(LISTED_CHAT, PRODUCT, 'chat')]);
  await open(`#/c/${TASK_CHAT}`);
  const button = toggle();
  assert.ok(button, 'タスクの会話の画面に Panes のボタンがある');
  assert.equal(button.textContent, 'Panes');
  assert.equal(document.querySelector('.bt-app')?.getAttribute('data-panes'), '0', '押す前は欄が閉じている');
  await click(button);
  await settle();
  assert.notEqual(document.querySelector('.bt-app')?.getAttribute('data-panes'), '0', '押すと製品の欄が開く');
  assert.equal(toggle()?.getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('.bt-app__bar .ui-bar__product')?.textContent === 'Shop', '会話の上の製品の名前も出る');
});

test('bl-ui-small/task-panes: 製品の無い会話には出さない。一覧にある会話は今までどおり出て、会話を読む回数は増えない', async () => {
  serve([row(LISTED_CHAT, PRODUCT, 'chat')]);
  await open(`#/c/${NO_PRODUCT_CHAT}`);
  assert.equal(toggle(), null, '製品の無い会話に Panes は出ない');
  await cleanup();
  paths = [];
  await open(`#/c/${LISTED_CHAT}`);
  assert.ok(toggle(), '一覧にある会話は今までどおり');
  assert.equal(messageReads(LISTED_CHAT), 1, '一覧にある会話は、App が会話を余分に読まない（会話の画面が 1 回だけ読む）');
});
