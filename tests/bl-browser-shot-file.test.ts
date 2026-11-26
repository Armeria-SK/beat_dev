import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { eraseConversation } from '../src/db/erase.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Uploads } from '../src/uploads/store.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, withLoad, type Script } from './helpers.ts';
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

test('L798: 会話を消すとき、道具の画像は「ほかの発言が使っていないか」の検索をせずに消す（画像 1 枚ごとに messages 全体を読まない）。添付は今までどおり調べる', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const dir = tempDir(t);
  const uploads = new Uploads(db, dir);
  const conversations = new Conversations(db);
  const conversation = conversations.create({ projectId: 'p1' });
  const attachment = uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の中身') });
  conversations.append(conversation.id, { role: 'user', content: '見て', attachments: [{ id: attachment.id, name: 'memo.txt', kind: 'text' }] });
  const shots = [1, 2, 3].map(n => uploads.save({ name: 'browser_screenshot', mime: 'image/png', body: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`shot ${n}`)]) }));
  for (const [n, shot] of shots.entries()) conversations.append(conversation.id, { role: 'tool', toolCallId: `c${n}`, name: 'browser_screenshot', content: '写した', imageIds: [shot.id] });

  // 文を用意した回数ではなく、文を実行した回数（.get・.all・.run）を数える。用意をループの外へ出して画像ごとに実行する形でも気づける
  const executed: string[] = [];
  const spy = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key !== 'prepare') return value.bind(target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(inner, method) {
            const member = Reflect.get(inner, method);
            if (typeof member !== 'function') return member;
            const counted = method === 'get' || method === 'all' || method === 'run';
            return (...args: unknown[]) => { if (counted) executed.push(sql); return member.apply(inner, args); };
          },
        });
      };
    },
  });
  const erased = eraseConversation({ db: spy, uploadsDir: dir, toolOutputsDir: dir }, conversation.id);

  assert.equal(erased.uploads, 4);
  assert.deepEqual(erased.files.failed, []);
  for (const id of [attachment.id, ...shots.map(s => s.id)]) {
    assert.equal(uploads.get(id), undefined, `uploads の行が消える: ${id}`);
    assert.equal(existsSync(join(dir, id)), false, `ファイルが消える: ${id}`);
  }
  const sharedUseChecks = executed.filter(sql => /role = 'user' AND instr\(parts/u.test(sql));
  assert.equal(sharedUseChecks.length, 1, '「ほかの発言が使っているか」の検索の実行は、添付 1 つ分だけ（画像の 3 枚分は無い。文の用意がループの外でも数えられる）');
});

test('L798: ファイルが無くなった画像は、モデルに渡さず、知らせは画像ごとに 1 回だけ（返事のあいだに assemble が何度動いても、実行を重ねても）', async t => {
  const driver = new FakeBrowserDriver().site(PAGE, { title: 'Start', text: 'start page' });
  const s = await startApp(t, {
    models: [fakeModel('m1', { vision: true })], browserDriver: driver,
    configure: c => { c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; },
  });
  s.adapter().scripts = [callScript('browser_open', { url: PAGE }), callScript('browser_screenshot', {}), reply('見ました'), reply('二回目'), reply('三回目')];
  const id = uuid(97);
  s.app.conversations.create({ id, title: '会話' });
  const send = async (text: string) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId as string);
  };
  await send('開いて写して');
  const shot = s.app.conversations.messages(id).map(m => m.message).find((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool' && m.name === 'browser_screenshot')!;
  const imageId = shot.imageIds![0]!;
  const lost = () => s.logs.filter(line => line.includes(`Could not read the image ${imageId}`));
  assert.equal(lost().length, 0, 'ファイルがあるあいだは知らせない');

  rmSync(join(s.paths.uploads, imageId));
  await send('もう一度');
  await send('もう一回');
  assert.equal(lost().length, 1);
  assert.match(lost()[0]!, /^\[WARN\]/u);
  const seen = s.adapter().calls.at(-1)!.messages.find(m => m.role === 'tool' && m.name === 'browser_screenshot')!;
  assert.equal(seen.role === 'tool' ? seen.images : 'x', undefined, '読めない画像はモデルに渡さない');
});
