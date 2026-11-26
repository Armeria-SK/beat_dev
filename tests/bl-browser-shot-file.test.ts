import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, withLoad, type Script } from './helpers.ts';
import { FakeBrowserDriver, TINY_PNG } from './helpers/fake-browser.ts';

// backlog L798: browser_screenshot の画面の写しは、messages.parts に base64 で入れず、添付と同じ uploads のファイルに置き、発言には id だけ残す

const PAGE = 'https://example.com/start';

const callScript = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

test('L798: 本物の App で browser_screenshot を呼ぶと、写しはファイルに置かれ、DB の parts には base64 が入らず、次の呼び出しではモデルに画像で届く。会話を消すとファイルも消える', async t => {
  const driver = new FakeBrowserDriver().site(PAGE, { title: 'Start', text: 'start page' });
  const s = await startApp(t, {
    models: [fakeModel('m1', { vision: true })], browserDriver: driver,
    configure: c => { c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; },
  });
  s.adapter().scripts = [callScript('browser_open', { url: PAGE }), callScript('browser_screenshot', {}), reply('見ました')];
  const id = uuid(98);
  s.app.conversations.create({ id, title: '会話' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '開いて写して' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId as string);

  const shot = s.app.conversations.messages(id).map(m => m.message).find((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool' && m.name === 'browser_screenshot')!;
  assert.equal(shot.isError, undefined, shot.content);
  const base64 = TINY_PNG.toString('base64');
  assert.equal(shot.images, undefined);
  assert.equal(shot.imageIds?.length, 1);
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT parts FROM messages').all()).includes(base64), false, 'messages.parts に base64 が入らない');
  const file = join(s.paths.uploads, shot.imageIds![0]!);
  assert.deepEqual(readFileSync(file), TINY_PNG, '写しは uploads のフォルダのファイルに置かれる');

  const last = s.adapter().calls.at(-1)!.messages.find(m => m.role === 'tool' && m.name === 'browser_screenshot')!;
  assert.deepEqual(last.role === 'tool' ? last.images : undefined, [{ mediaType: 'image/png', data: base64 }], 'モデルには、いままでと同じく画像で届く');

  const erased = await s.json(`/api/conversations/${id}`, 'DELETE');
  assert.equal(erased.status, 200, JSON.stringify(erased.body));
  assert.equal(existsSync(file), false, '会話を消すと写しのファイルも消える');
  assert.equal(s.app.db.prepare('SELECT 1 FROM uploads WHERE id = ?').get(shot.imageIds![0]!), undefined);
});
