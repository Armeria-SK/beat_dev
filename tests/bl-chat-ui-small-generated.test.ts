import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Message } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { threadItems } from '../web/src/ui/thread.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply } from './helpers.ts';

// L141: beat が持ち主の代わりに入れた決まり文句（generated の発言）は、持ち主の吹き出しでなく小さな知らせの行にする。中身は開いたときだけ出す

const CANNED = 'The owner confirmed these choices and asked to continue with the plan: 1. Use a queue; 2. Keep the old API. Please go on.';
const PENDING_NOTE = '[beat] The owner approved Pending #4 (file_write src/a.ts). It has run.';

const message = (over: Partial<Message> & Pick<Message, 'id' | 'role' | 'text'>): Message => ({ runId: null, createdAt: over.id * 1000, ...over });

test('L141: thread は generated の user の発言を owner の吹き出しにせず、generated の行にする。続きの頼み（note: continue）は今までどおり出さず、ふつうの発言は owner のまま', () => {
  const items = threadItems({
    messages: [
      message({ id: 1, role: 'user', text: 'Please add a retry' }),
      message({ id: 2, role: 'assistant', text: 'Plan written' }),
      message({ id: 3, role: 'user', text: CANNED, generated: true }),
      message({ id: 4, role: 'user', text: PENDING_NOTE, generated: true, note: 'pending' }),
      message({ id: 5, role: 'user', text: 'Please continue', generated: true, note: 'continue' }),
    ],
  });
  assert.deepEqual(items.map(item => item.kind), ['owner', 'reply', 'generated', 'generated']);
  assert.deepEqual(items.filter(item => item.kind === 'generated').map(item => item.kind === 'generated' && item.text), [CANNED, PENDING_NOTE]);
  assert.equal(items.filter(item => item.kind === 'owner').length, 1, '持ち主の吹き出しは、持ち主が書いた 1 つだけ');
});

test('L141: サーバーは会話の履歴に、generated の発言の印を付けて返す（ふつうの発言には付けない）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const id = uuid(41);
  s.adapter().scripts = [reply('ok'), reply('ok again')];
  const first = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: CANNED, generated: true });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await settled(s.app, first.body.runId);
  const second = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'a normal message' });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await settled(s.app, second.body.runId);
  const listed = await s.json(`/api/conversations/${id}/messages`, 'GET');
  assert.equal(listed.status, 200);
  const users = (listed.body.messages as Message[]).filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => [m.text, m.generated]), [[CANNED, true], ['a normal message', undefined]]);
});

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000042';
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver, fetch: globalThis.fetch };
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

interface BarProps {
  id: string | null; listTitle: string | null; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}
const { Conversation: ConversationScreen } = await loadTsx<{ Conversation: ComponentType<BarProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

afterEach(async () => {
  await cleanup();
  globalThis.fetch = real.fetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
});

async function open(messages: unknown[]): Promise<HTMLElement> {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const body = url === `/api/conversations/${CHAT}/messages` ? { conversation: { id: CHAT, title: 'Plan', created_at: 0, last_message_at: 0, permission_mode: 'auto', has_summary: false }, messages, pending: [], builds: [], activeRun: null }
      : url === `/api/conversations/${CHAT}/checklist` ? { items: [], tainted: false, updatedAt: null }
        : url === '/api/models' ? { models: [], chatOrder: [] } : { error: 'not found' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { container } = await render(createElement(ConversationScreen, {
    id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {},
  }));
  await settle();
  await settle();
  return container;
}

test('L141: 画面では、generated の発言は「Automatic message · Show」の小さな知らせの行になる。中身は Show を押したときだけ出て、Hide で隠れる。持ち主の吹き出しには出ない', async () => {
  const container = await open([
    { id: 1, role: 'user', text: 'Please add a retry', runId: null, createdAt: 1000 },
    { id: 2, role: 'assistant', text: 'Plan written', runId: 'r1', createdAt: 2000 },
    { id: 3, role: 'user', text: CANNED, runId: null, createdAt: 3000, generated: true },
    { id: 4, role: 'user', text: PENDING_NOTE, runId: null, createdAt: 4000, generated: true, note: 'pending' },
  ]);
  const owners = [...container.querySelectorAll('.bt-msg--owner')].map(el => el.textContent);
  assert.equal(owners.length, 1, '持ち主の吹き出しは 1 つ');
  assert.match(owners[0]!, /Please add a retry/u);
  const rows = [...container.querySelectorAll<HTMLElement>('.ui-generated')];
  assert.equal(rows.length, 2, '決まり文句は 2 行の知らせ');
  for (const row of rows) {
    assert.match(row.querySelector('.bt-notice')!.textContent!, new RegExp(`^${en['ui.notice.generated']} · ${en['ui.notice.showGenerated']}$`, 'u'));
    assert.equal(row.querySelector('.ui-generated__text'), null, '開くまで中身は出ない');
  }
  assert.ok(!container.textContent!.includes('The owner confirmed'), '決まり文句は開くまで画面にない');
  assert.ok(!container.textContent!.includes('[beat] The owner approved'), 'Pending の承認の文も同じ');
  const show = rows[0]!.querySelector<HTMLButtonElement>('button.bt-notice__action')!;
  assert.equal(show.getAttribute('aria-expanded'), 'false');
  await click(show);
  assert.equal(rows[0]!.querySelector('.ui-generated__text')!.textContent, CANNED, '押すと中身が出る');
  assert.equal(show.getAttribute('aria-expanded'), 'true');
  assert.equal(show.textContent, en['ui.notice.hideGenerated']);
  assert.equal(rows[1]!.querySelector('.ui-generated__text'), null, 'ほかの行は開かない');
  await click(show);
  assert.equal(rows[0]!.querySelector('.ui-generated__text'), null, 'Hide で隠れる');
});
