import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp, uuid, waitFor } from './app-setup.ts';

// beat 6-4: 持ち主の Terminal の欄の口。一覧・続きを読む・止める。製品ごとに見せ、無い番号・製品の違う番号は 404

const KEY = `sk-ant-${'B'.repeat(32)}`;
const ESC = String.fromCharCode(27);

async function setup(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-test-')));
  const s = await startApp(t, { projectFolderExempt: [products] });
  t.after(async () => {
    for (const job of s.app.background.list().filter(j => j.state === 'running')) await s.app.background.stop(job.id, 'system');
    s.app.background.closeAll();
    rmSync(products, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
  });
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: (made.body.project as { id: string }).id, dir };
  };
  const start = (conversationId: string, projectId: string, cwd: string, script: string, taskId?: string) => {
    const started = s.app.background.start({
      conversationId, projectId, ...(taskId ? { taskId } : {}), command: `node -e "${script.slice(0, 40)}" (in ${cwd})`, cwd: tmpdir(),
      file: process.execPath, args: ['-e', script], env: { ...process.env } as Record<string, string>, fetched: false,
    });
    assert.ok('id' in started, JSON.stringify(started));
    return started.id;
  };
  return { ...s, product, start };
}

test('6-4: 一覧は製品ごと。始めた会話の題・ポート・状態が出て、ほかの製品のものは出ない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const blog = await s.product('blog');
  s.app.conversations.create({ id: uuid(1), title: 'Dev server', projectId: shop.id });
  s.app.conversations.create({ id: uuid(2), title: 'Other', projectId: blog.id });
  const id = s.start(uuid(1), shop.id, shop.dir, "console.log('  Local:   http://localhost:5173/'); setInterval(() => {}, 1000);");
  s.start(uuid(2), blog.id, blog.dir, 'setInterval(() => {}, 1000);');
  await waitFor(() => (s.app.background.peek(id, 0)?.text ?? '').includes('5173'), 'output');
  const res = await s.json(`/api/background?projectId=${shop.id}`, 'GET');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 1);
  const item = res.body.items[0];
  assert.equal(item.id, id);
  assert.equal(item.state, 'running');
  assert.equal(item.port, 5173);
  assert.deepEqual(item.startedBy, { kind: 'conversation', id: uuid(1), title: 'Dev server' });
  assert.equal(item.logPath, undefined, 'ログの置き場は画面に出さない');
  assert.equal(item.cwd, undefined, '作業フォルダは画面で使わない');
  assert.equal((await s.json('/api/background', 'GET')).status, 400, 'projectId が無いと 400');
  assert.equal((await s.json('/api/background?projectId=..%2Fx', 'GET')).status, 400);
});

test('6-4: 続きを読むと位置が進み、色のコードは消え、鍵らしい文字は伏せられる。無い番号・製品の違う番号は 404', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const blog = await s.product('blog');
  s.app.conversations.create({ id: uuid(1), projectId: shop.id });
  const script = `console.log('${ESC}[32mready${ESC}[0m'); console.log('key=${KEY}'); setTimeout(() => console.log('later'), 600); setInterval(() => {}, 1000);`;
  const id = s.start(uuid(1), shop.id, shop.dir, script);
  await waitFor(() => (s.app.background.peek(id, 0)?.text ?? '').includes('key='), 'first lines');
  const first = await s.json(`/api/background/${id}/output?projectId=${shop.id}`, 'GET');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.text, /^ready\n/u, '色のコードが消える');
  assert.doesNotMatch(first.body.text, new RegExp(KEY, 'u'), '鍵は伏せる');
  assert.match(first.body.text, /\[REDACTED\]/u);
  assert.equal(first.body.state, 'running');
  await waitFor(() => (s.app.background.peek(id, 0)?.text ?? '').includes('later'), 'later line', 5000);
  const next = await s.json(`/api/background/${id}/output?projectId=${shop.id}&from=${first.body.next}`, 'GET');
  assert.equal(next.body.text, 'later\n', '前に読んだ所からあとだけ');
  assert.ok(next.body.next > first.body.next);
  assert.equal((await s.json(`/api/background/${id}/output?projectId=${blog.id}`, 'GET')).status, 404, '製品の違う番号');
  assert.equal((await s.json(`/api/background/bg-999/output?projectId=${shop.id}`, 'GET')).status, 404, '無い番号');
  assert.equal((await s.json(`/api/background/x/output?projectId=${shop.id}`, 'GET')).status, 404);
});

test('6-4: 最初の読みは新しい 64KB まで（それより前は skipped に数える）', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.app.conversations.create({ id: uuid(1), projectId: shop.id });
  const id = s.start(uuid(1), shop.id, shop.dir, "for (let i = 0; i < 3000; i++) console.log('line ' + i + ' ' + 'x'.repeat(40)); setInterval(() => {}, 1000);");
  await waitFor(() => (s.app.background.peek(id, 0)?.text ?? '').includes('line 2999 '), 'all lines', 10_000);
  const read = await s.json(`/api/background/${id}/output?projectId=${shop.id}`, 'GET');
  assert.ok(Buffer.byteLength(read.body.text) <= 64 * 1024, String(Buffer.byteLength(read.body.text)));
  assert.ok(read.body.skipped > 0);
  assert.match(read.body.text, /line 2999 x+\n$/u);
  assert.match(read.body.text, /^line \d+ /u, '行の途中からは始めない');
});

test('6-4: 持ち主の Stop で止まり、状態は stopped（owner）。出来事 background.changed が流れる。ほかの製品の番号は止められない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const blog = await s.product('blog');
  s.app.conversations.create({ id: uuid(1), projectId: shop.id });
  const id = s.start(uuid(1), shop.id, shop.dir, 'setInterval(() => {}, 1000);');
  const events: string[] = [];
  s.app.bus.subscribe(({ event }) => { if (event.type === 'background.changed') events.push(`${event.id}:${event.state}`); });
  const wrong = await s.json(`/api/background/${id}/stop`, 'POST', { projectId: blog.id });
  assert.equal(wrong.status, 404);
  assert.equal(s.app.background.get(id)?.state, 'running');
  const stopped = await s.json(`/api/background/${id}/stop`, 'POST', { projectId: shop.id });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.item.state, 'stopped');
  assert.equal(stopped.body.item.stoppedBy, 'owner');
  assert.equal(s.app.background.get(id)?.stoppedBy, 'owner');
  assert.ok(events.includes(`${id}:stopped`), events.join(','));
  const missing = await s.json('/api/background/bg-999/stop', 'POST', { projectId: shop.id });
  assert.equal(missing.status, 404);
});

test('6-4: 持ち主の Stop の口は、ほかのサイトからの要求（Origin が違う）を断る', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.app.conversations.create({ id: uuid(1), projectId: shop.id });
  const id = s.start(uuid(1), shop.id, shop.dir, 'setInterval(() => {}, 1000);');
  const res = await s.api(`/api/background/${id}/stop`, { method: 'POST', body: JSON.stringify({ projectId: shop.id }), headers: { Origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(s.app.background.get(id)?.state, 'running');
});

test('6-4: タスクが始めたものは、タスクの題を「始めたもの」に出す', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const task = s.app.tasks.create({ title: 'Add retry with backoff', origin: 'user', actor: 'user', projectId: shop.id });
  s.app.conversations.create({ id: uuid(3), projectId: shop.id, kind: 'task' });
  s.start(uuid(3), shop.id, shop.dir, 'setInterval(() => {}, 1000);', task.id);
  const res = await s.json(`/api/background?projectId=${shop.id}`, 'GET');
  assert.deepEqual(res.body.items[0].startedBy, { kind: 'task', id: task.id, title: 'Add retry with backoff' });
});
