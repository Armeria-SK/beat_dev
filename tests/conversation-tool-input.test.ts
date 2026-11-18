import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reply } from './helpers.ts';
import { taskApp, toolCall } from './helpers/task-app.ts';

test('B1: GET /api/conversations/:id/messages の toolCalls[].input は、長い入力でも JSON として読める', async t => {
  const s = await taskApp(t);
  const content = 'x"\\'.repeat(4000);
  s.adapter().scripts = [toolCall('file_write', { path: 'notes/big.md', content }), reply('done')];
  await s.chat('write it');
  const body = (await s.api('/api/conversations/c1/messages')).body;
  const calls = body.messages.flatMap((m: any) => m.toolCalls ?? []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.length <= 2000);
  const input = JSON.parse(calls[0].input);
  assert.equal(input.path, 'notes/big.md');
  assert.ok(input.content.endsWith('…'));
});
