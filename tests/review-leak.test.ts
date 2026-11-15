import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, type Script, testConfig, withLoad, notSearch } from './helpers.ts';

type Started = Awaited<ReturnType<typeof startApp>>;

const WORD = 'zzyzxsecret';
const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function setup(background: string[]) {
  return {
    models: [fakeModel('loc'), fakeModel('loc2'), fakeModel('ext1', { provider: 'ext' }), fakeModel('ext2', { provider: 'ext' })],
    configure: (c: ReturnType<typeof testConfig>) => {
      c.providers.push({ id: 'ext', kind: 'openai_compatible', baseUrl: 'https://models.example.test/v1', maxParallel: 1, timeoutMs: 10_000 });
      c.routing = { chat: ['loc', 'loc2', 'ext1', 'ext2'], background, retriesPerModel: 0 };
    },
  };
}

function chatWith(s: Started, id: string, modelId: string | null, text: string): void {
  s.app.conversations.create({ id, title: `会話 ${id.slice(-2)}` });
  if (modelId) s.app.conversations.setChoice(id, { modelId });
  s.app.conversations.append(id, { role: 'user', content: text });
}

// 実際に振り返りを走らせて、振り返りの会話を作らせる
async function reviewed(s: Started, source: string): Promise<string> {
  s.app.reviews.enqueue('manual', `manual:${source}`, { conversationId: source });
  assert.equal(await s.app.worker.tick(), 'ran');
  const job = s.app.reviews.list().find(j => j.conversation_id === source)!;
  assert.ok(job.review_conversation_id, '前提: 振り返りの会話が作られ、振り返りの記録から辿れる');
  return job.review_conversation_id;
}

const toolResult = (s: Started, conversationId: string) => (s.app.conversations.messages(conversationId).find(notSearch)?.text ?? '');
async function asRun(s: Started, conversationId: string, modelId: string | null, script: Script, adapterId: 'fake' | 'ext'): Promise<string> {
  s.app.conversations.create({ id: conversationId, title: '検索する会話' });
  if (modelId) s.app.conversations.setChoice(conversationId, { modelId });
  s.adapters.get(adapterId)!.scripts = [script, reply('おわり')];
  const sent = await s.json(`/api/conversations/${conversationId}/messages`, 'POST', { text: '前の話を探して' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  return toolResult(s, conversationId);
}

// ── 止められてやり直された振り返りと、振り返りの会話が材料の会話を自分で覚える決まり ──

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '考えています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

test('止められてやり直された振り返りは、前の回の振り返りの会話に続きを書く。その会話は、ほかの提供元のモデルの実行からも検索でき、読める（4-1）', async t => {
  const s = await startApp(t, setup(['loc2']));
  const source = uuid(1);
  chatWith(s, source, 'loc', `手元でだけ話した ${WORD} の内容`);
  s.app.reviews.enqueue('manual', `manual:${source}`, { conversationId: source });
  s.adapter().scripts = [hang()];
  const ticking = s.app.worker.tick();
  await waitFor(() => s.app.reviews.list().some(j => j.status === 'running'), '振り返りが動き出す');
  const first = s.app.reviews.list()[0]!.review_conversation_id!;
  // 会話が、同じ提供元を使う裏の実行（この振り返り）を止める
  s.app.conversations.create({ id: uuid(2), title: '割り込む会話' });
  s.adapter().scripts.push(reply('はい'));
  const sent = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: 'こんにちは' });
  assert.equal(sent.status, 202);
  assert.equal(await ticking, 'ran');
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.reviews.list()[0]!.status, 'pending', '前提: 止められて、やり直しの待ちに戻った');
  // やり直し
  s.adapter().scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  const job = s.app.reviews.list()[0]!;
  assert.equal(job.status, 'done');
  assert.equal(job.review_conversation_id, first, '前の回の会話に続きを書く');
  assert.deepEqual(s.app.db.prepare("SELECT id FROM conversations WHERE kind = 'task'").all().map(r => r.id), [first], '振り返りの会話は 1 つだけ（記録から外れた会話ができない）');
  assert.equal(s.app.conversations.messages(first).filter(m => m.role === 'user').length, 2, '同じ会話に、やり直しの指示が続く');
  assert.match(s.app.conversations.messages(first).map(m => m.text).join('\n'), new RegExp(WORD, 'u'), '前提: この会話に、手元の会話の全文が入っている');
  const external = await asRun(s, uuid(30), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.match(external, /手元でだけ話した/u);
  assert.equal(external.includes(first), true);
  const read = await asRun(s, uuid(31), 'ext1', call('history_read', { conversation_id: first }), 'ext');
  assert.match(read, new RegExp(WORD, 'u'));
});

test('再起動で「動いていた」から「待ち」に戻った振り返りも、前の回の振り返りの会話に続きを書く', async t => {
  const s = await startApp(t, setup(['loc2']));
  const source = uuid(1);
  chatWith(s, source, 'loc', `手元でだけ話した ${WORD} の内容`);
  s.adapter().scripts = [reply('変更なし')];
  const first = await reviewed(s, source);
  const job = s.app.reviews.list()[0]!;
  s.app.db.prepare("UPDATE memory_jobs SET status = 'running' WHERE id = ?").run(job.id);
  s.app.db.prepare('DELETE FROM kv WHERE key = ?').run(`review:upto:${source}`);
  assert.equal(s.app.reviews.recoverRunning(), 1);
  s.adapter().scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.reviews.get(job.id)!.review_conversation_id, first);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'task'").get() as { n: number }).n, 1);
});

test('会話を消すと、その会話を材料にした振り返りの会話は、振り返りの記録から辿れなくなっていても一緒に消える', async t => {
  const s = await startApp(t, setup([]));
  const source = uuid(1);
  chatWith(s, source, null, `消す会話 ${WORD}`);
  const orphan = s.app.conversations.create({ kind: 'task', title: '辿れない振り返り', source: { conversationId: source } });
  s.app.conversations.append(orphan.id, { role: 'user', content: `全文 ${WORD}` });
  const other = s.app.conversations.create({ kind: 'task', title: 'ほかの会話の振り返り', source: { conversationId: uuid(5) } });
  const res = await s.json(`/api/conversations/${source}`, 'DELETE');
  assert.equal(res.status, 200);
  assert.equal(s.app.conversations.get(orphan.id), undefined);
  assert.deepEqual(s.app.conversations.messages(orphan.id), []);
  assert.ok(s.app.conversations.get(other.id), 'ほかの会話の振り返りは消さない');
});
