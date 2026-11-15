import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api } from '../web/src/api.ts';
import { noProductApi } from '../web/src/ui/products.ts';

// 画面が製品の口へ送る形（p2-product.md の「サーバー」の節: 送る本文と問いの文字は camelCase、パスは URL に載せない）。

interface Sent { url: string; method: string; body: unknown }
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(status = 200, reply: unknown = {}): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

test('web/api: 製品の 4 つの口', async () => {
  const sent = capture();
  await api.projects();
  await api.projects(true);
  await api.createProject({ root: 'C:\\work\\app', name: 'App', checkCommand: 'npm test' });
  await api.patchProject('p1aaaa', { name: 'B', checkCommand: null, archived: true, refreshRemotes: true });
  await api.listFolders();
  await api.listFolders('C:\\work');
  await api.folderPickAvailable();
  await api.pickFolder();
  await api.pickFolder('C:\\work');
  assert.deepEqual(sent, [
    { url: '/api/projects', method: 'GET', body: undefined },
    { url: '/api/projects?archived=1', method: 'GET', body: undefined },
    { url: '/api/projects', method: 'POST', body: { root: 'C:\\work\\app', name: 'App', checkCommand: 'npm test' } },
    { url: '/api/projects/p1aaaa', method: 'PATCH', body: { name: 'B', checkCommand: null, archived: true, refreshRemotes: true } },
    { url: '/api/folders/list', method: 'POST', body: {} },
    { url: '/api/folders/list', method: 'POST', body: { path: 'C:\\work' } },
    { url: '/api/folders/pick', method: 'GET', body: undefined },
    { url: '/api/folders/pick', method: 'POST', body: {} },
    { url: '/api/folders/pick', method: 'POST', body: { path: 'C:\\work' } },
  ]);
});

test('web/api: 最初の発言に projectId を載せる（渡さなければ本文は今までと同じ）', async () => {
  const sent = capture(200, { runId: 'r' });
  await api.send('c1', 'hi');
  await api.send('c1', 'hi', [], { modelId: 'm' }, { interrupt: true, projectId: 'p1aaaa' });
  assert.deepEqual(sent.map(s => s.body), [{ text: 'hi' }, { text: 'hi', modelId: 'm', interrupt: true, projectId: 'p1aaaa' }]);
  assert.deepEqual(sent.map(s => s.url), ['/api/conversations/c1/messages', '/api/conversations/c1/messages']);
});

test('web/api: 製品で絞る問いの文字（渡さなければ今までの URL のまま）', async () => {
  const sent = capture();
  await api.conversations();
  await api.conversationsOf('p1aaaa');
  await api.conversationsOf('none', 50);
  await api.tasks();
  await api.tasks('p1aaaa');
  await api.finishedTasks(null);
  await api.finishedTasks({ beforeT: 5, beforeId: 't' }, 20, 'none');
  await api.runs();
  await api.runs(50, 'p1aaaa');
  await api.toolCalls();
  await api.toolCalls('none');
  await api.reviews();
  await api.reviews('p1aaaa');
  assert.deepEqual(sent.map(s => s.url), [
    '/api/conversations',
    '/api/conversations?project=p1aaaa&limit=200',
    '/api/conversations?project=none&limit=50',
    '/api/tasks',
    '/api/tasks?project=p1aaaa',
    '/api/tasks/finished?limit=20',
    '/api/tasks/finished?limit=20&beforeT=5&beforeId=t&project=none',
    '/api/runs?limit=200',
    '/api/runs?limit=50&project=p1aaaa',
    '/api/tool-calls?limit=200',
    '/api/tool-calls?limit=200&project=none',
    '/api/reviews',
    '/api/reviews?project=p1aaaa',
  ]);
});

test('web/api: 製品の口が無いサーバーの 404 は「製品なし」と読める。ほかの失敗は読まない', async () => {
  capture(404, { message: 'Not found' });
  assert.equal(noProductApi(await api.projects().catch((error: unknown) => error)), true);
  capture(500, { message: 'boom' });
  assert.equal(noProductApi(await api.projects().catch((error: unknown) => error)), false);
});

test('web/api: 受け入れの一覧を読む口と、製品の文書の言語を変える PATCH（beat 3-1b-u）', async () => {
  const sent = capture(200, { acceptance: {} });
  await api.acceptance('p1aaaa');
  await api.patchProject('p1aaaa', { docLanguage: 'ja' });
  await api.patchProject('p1aaaa', { docLanguage: null });
  assert.deepEqual(sent, [
    { url: '/api/projects/p1aaaa/acceptance', method: 'GET', body: undefined },
    { url: '/api/projects/p1aaaa', method: 'PATCH', body: { docLanguage: 'ja' } },
    { url: '/api/projects/p1aaaa', method: 'PATCH', body: { docLanguage: null } },
  ]);
});

test('web/api: タスクの取り消しと、その取り消しを戻す口・会話のアーカイブの口', async () => {
  const sent = capture(200, { task: { id: 't1' } });
  await api.taskAction('t1', 'cancel');
  await api.taskAction('t1', 'uncancel');
  await api.archiveConversation('c1');
  assert.deepEqual(sent, [
    { url: '/api/tasks/t1/cancel', method: 'POST', body: {} },
    { url: '/api/tasks/t1/uncancel', method: 'POST', body: {} },
    { url: '/api/conversations/c1', method: 'PATCH', body: { archived: true } },
  ]);
});
