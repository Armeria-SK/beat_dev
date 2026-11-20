import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { uuid } from './app-setup.ts';
import { reply } from './helpers.ts';
import { ALPHA, researchApp } from './helpers/research-app.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M3・R3.11 H1 の続き): 調べる会話は会話の履歴の道具から見えない。普通の会話はこれまでどおり見える

test('履歴: 調べる会話の文は最初の発言のときから history_search に当たらず、history_read は空。計画の会話は見つかり、印は付かない', async t => {
  const s = await researchApp(t);
  s.adapter().scripts.push(reply('Tell me more.'), toolCall('web_search', { query: 'notes app' }), toolCall('web_fetch', { url: ALPHA }), reply('Recorded quokkafern.'));
  await s.send(1, 'I want a notes app called wombatleaf.');
  await s.settle();
  const [part] = s.app.research.store.parts(s.records()[0]!.id);
  const researchConversation = part!.conversationId;
  assert.ok(s.app.conversations.messages(researchConversation).some(m => m.message.role === 'assistant'), 'the research conversation has text');
  assert.deepEqual(searchHistory(s.app.db, 'quokkafern'), []);
  assert.deepEqual(readHistory(s.app.db, researchConversation), []);
  const owner = searchHistory(s.app.db, 'wombatleaf');
  assert.ok(owner.length > 0, 'the plan chat is still found');
  assert.ok(owner.every(hit => hit.conversationId === uuid(1)), JSON.stringify(owner));
  assert.ok(readHistory(s.app.db, uuid(1)).length > 0);
  assert.equal(s.app.conversations.everTainted(uuid(1)), false);
});
