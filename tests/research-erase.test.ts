import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { eraseConversation } from '../src/db/erase.ts';
import { uuid, waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
import { ALPHA, BETA, researchApp } from './helpers/research-app.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M3・R3.11 M4・R3.13 の 2): 計画の会話を消すと、その記録の動いている部分は止まり、調べる会話も消え、写した持ち主の文は残らない

test('消す: 部分の web_search が待っている間に計画の会話を消すと、実行が止まり、あとの道具の行も部分も無く、記録は cancelled。調べる会話は消え、元の会話の id は空。ほかの製品の記録は残る', async t => {
  let release!: () => void;
  const s = await researchApp(t, { hold: { search: new Promise<void>(resolve => { release = resolve; }) } });
  t.after(() => release());
  const otherRoot = join(s.root, '..', 'Other');
  mkdirSync(otherRoot, { recursive: true });
  const other = await s.json('/api/projects', 'POST', { root: otherRoot });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const kept = s.app.research.store.start({ projectId: other.body.project.id as string, phase: 'products', mode: 'batch', sourceConversationId: uuid(9) });

  s.adapter().scripts.push(reply('ok'), toolCall('web_search', { query: 'notes' }), toolCall('web_search', { query: 'more notes' }), reply('never'));
  await s.send(1, 'I want a notes app called wombatleaf.');
  const record = () => s.records()[0]!;
  await waitFor(() => s.records().length === 1 && s.app.research.store.parts(record().id)[0]?.runId != null && s.asked.some(u => u.includes('duckduckgo')), 'search held');
  const [part] = s.app.research.store.parts(record().id);
  const deleted = await s.json(`/api/conversations/${uuid(1)}`, 'DELETE');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const deletedAt = Date.now();
  release();
  await s.app.research.waitFor(record().id);

  assert.equal(record().status, 'cancelled');
  assert.equal(record().source_conversation_id, null);
  assert.equal(s.app.research.store.parts(record().id).length, 1, 'no later part');
  assert.equal(s.app.conversations.get(part!.conversationId), undefined, 'the research conversation is erased');
  assert.equal(s.app.conversations.get(uuid(1)), undefined);
  const calls = s.app.db.prepare('SELECT input, conversation_id, created_at FROM tool_calls WHERE run_id = ?').all(part!.runId) as Array<{ input: string; conversation_id: string | null; created_at: number }>;
  assert.ok(calls.length <= 1, 'the second search never ran');
  assert.ok(calls.every(c => c.input === '' && c.conversation_id === null && c.created_at <= deletedAt), JSON.stringify(calls));
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%wombatleaf%'").get()!.n, 0, 'the copied owner text is gone');
  const still = s.app.research.store.get(kept.id)!;
  assert.deepEqual([still.status, still.source_conversation_id], ['running', uuid(9)]);
});

test('消す（R3.13 の 2）: 消す口を通らずに元の会話が消えても、調べる記録は次の部分を始めない（部分の前に毎回、記録と元の会話を確かめる）', async t => {
  const s = await researchApp(t, { contextLength: 24_000 });
  s.adapter().scripts.push(
    reply('ok'),
    toolCall('web_search', { query: 'markdown notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Alpha Notes', url: ALPHA }),
    toolCall('research_record', { kind: 'candidate', name: 'Beta App', url: BETA }),
    async function* () {
      eraseConversation({ db: s.app.db, uploadsDir: s.app.paths.uploads, toolOutputsDir: join(s.app.paths.data, 'tool_outputs'), markDeleted: ids => s.app.conversations.markDeleted(ids) }, uuid(1));
      yield { type: 'text', delta: 'two candidates' };
      yield { type: 'done', stop: 'end_turn' };
    },
    reply('never'),
  );
  await s.send(1, 'I want a Markdown notes app.');
  await s.settle();
  const record = s.records()[0]!;
  assert.equal(record.mode, 'one_by_one');
  const runId = s.app.research.store.parts(record.id)[0]!.runId;
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ? AND tool = 'research_record' AND ok = 1").get(runId) as { n: number }).n, 2, 'the candidates were recorded before the erase');
  assert.deepEqual(s.app.research.store.parts(record.id).map(p => p.kind), ['first'], 'no candidate part after the source is gone');
  assert.notEqual(record.status, 'running');
});
