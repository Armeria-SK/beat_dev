import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { RunEvent, ToolCall } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { transcriptOf } from '../src/memory/review.ts';
import { redactSecrets } from '../src/shared/redaction.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { CONVERSATION, startApp } from './app-setup.ts';
import { reply, type Script } from './helpers.ts';

// 伏せ字（redactSecrets）が、URL の中の秘密（? と & と # のあとの名前、userinfo）と、別の「名前:」のうしろに続く秘密を伏せる。
// 道具に渡した引数は、会話にはそのまま保存し（モデルに戻す中身を変えない）、見せる所・書き出す所で伏せる

// 鍵らしい形（sk- など）だと、ほかの伏せ字の処理に隠れて漏れを見逃すので、どの形にも当たらない文字列を使う
const S1 = 'Qm7xLp2Vt9a';
const S2 = 'Hd4nRw8Kc3b';
const S3 = 'Jf6zTy1Ms5c';

test('伏せ字: URL の ? と & のあとの秘密の名前（access_token・api_key など）の値を伏せ、ほかの値は残す', () => {
  assert.equal(redactSecrets(`https://x.example/p?access_token=${S1}&api_key=${S2}`), 'https://x.example/p?access_token=[REDACTED]&api_key=[REDACTED]');
  assert.equal(redactSecrets(`GET /cb?page=2&access_token=${S1}&lang=ja`), 'GET /cb?page=2&access_token=[REDACTED]&lang=ja');
  assert.equal(redactSecrets(`https://x.example/p?client_secret=${S1}&amp;refresh_token=${S2}`), 'https://x.example/p?client_secret=[REDACTED]&amp;refresh_token=[REDACTED]');
  assert.equal(redactSecrets(`{"url":"https://x.example/p?token=${S1}&page=2"}`), '{"url":"https://x.example/p?token=[REDACTED]&page=2"}');
  assert.equal(redactSecrets(`"https://x.example/p?a=1\\u0026token=${S1}"`), '"https://x.example/p?a=1\\u0026token=[REDACTED]"');
  assert.equal(redactSecrets(`{\\"url\\":\\"https://x.example/p?token=${S1}\\"}`), '{\\"url\\":\\"https://x.example/p?token=[REDACTED]\\"}');
});

test('伏せ字: URL の # のあと（#access_token=）と、URL でよく秘密を運ぶ名前（key・sig・signature・code）の値を伏せる', () => {
  assert.equal(redactSecrets(`https://x.example/cb#access_token=${S1}&state=1`), 'https://x.example/cb#access_token=[REDACTED]&state=1');
  assert.equal(redactSecrets(`https://x.example/p?key=${S1}&sig=${S2}&code=${S3}&v=3`), 'https://x.example/p?key=[REDACTED]&sig=[REDACTED]&code=[REDACTED]&v=3');
  assert.equal(redactSecrets(`https://s3.example/o?X-Amz-Signature=${S1}&X-Amz-Date=20261112`), 'https://s3.example/o?X-Amz-Signature=[REDACTED]&X-Amz-Date=20261112');
});

test('伏せ字: URL の userinfo のパスワードを、http 以外の接続先でも、名前が空でも伏せる', () => {
  assert.equal(redactSecrets(`https://user:${S1}@host.example/x`), '[REDACTED]host.example/x');
  assert.equal(redactSecrets(`postgres://svc:${S1}@db.example/app`), 'postgres://svc:[REDACTED]@db.example/app');
  assert.equal(redactSecrets(`redis://:${S1}@db.example:6379`), 'redis://:[REDACTED]@db.example:6379');
  assert.equal(redactSecrets(`https://:${S1}@host.example/x`), 'https://:[REDACTED]@host.example/x');
});

test('伏せ字: 秘密でない「名前:」「名前=」のうしろに続く秘密も伏せる（前の名前が値ごと読み飛ばさない）', () => {
  assert.equal(redactSecrets(`Error: api_key=${S1}`), 'Error: api_key=[REDACTED]');
  assert.equal(redactSecrets(`note: password=${S1} end`), 'note: password=[REDACTED] end');
  assert.equal(redactSecrets(`url=https://x.example/p?v=1 token=${S1}`), 'url=https://x.example/p?v=1 token=[REDACTED]');
  const inJson = redactSecrets(`{"command":"curl -d password=${S1} https://a.example"}`);
  assert.equal(inJson.includes(S1), false, inJson);
  assert.equal(redactSecrets(`api_key=${S1}`), 'api_key=[REDACTED]');
  assert.equal(redactSecrets(`{"password":"${S1}","n":1}`), '{"password":[REDACTED],"n":1}');
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abcdefgh"'), 'curl -H "Authorization: [REDACTED]', '前からの形は変えない（画面が、道具の結果の写しをこの形で見つける）');
});

test('伏せ字: ふつうの文・URL・コマンドは変えない', () => {
  for (const plain of [
    'https://example.com/@user/x',
    'user@example.com',
    'npm test -- upload',
    'https://example.com:8080/x@y',
    'http://localhost:3000/search?q=a@b&page=2',
    'ssh://git@github.com/owner/repo.git',
    'https://user@host.example/repo.git',
    'https://example.com/list?sort=asc&page=2#section=3',
    'https://example.com/shop?postal_code=1000001&sort_key=price',
    'title: "my file" size=3',
    '{"command":"npm test -- upload","path":"docs/a.md"}',
    'see R&D=5 and Q&A',
    'at 12:30: done',
  ]) assert.equal(redactSecrets(plain), plain);
});

const echoTool: ToolDef = {
  name: 'echo_args', description: 'echo', effect: 'read', allowedIn: ['chat', 'task', 'review'],
  input: Type.Object({ url: Type.String(), remote: Type.String(), command: Type.String() }, { additionalProperties: false }),
  async execute() { return { content: 'done' }; },
};

function callTool(args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: 'call_secret_1', name: 'echo_args', arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' };
  };
}

test('道具に渡した引数の秘密: 会話にはそのまま保存してモデルに戻し、メッセージの API・tool.call の出来事・道具の記録では伏せる。履歴の道具と振り返りには引数が出ない', async t => {
  const s = await startApp(t, { tools: [echoTool], configure: config => { config.memory.review = false; } });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const args = {
    url: `https://files.example/dl?access_token=${S1}&page=2#access_token=${S2}`,
    remote: `postgres://svc:${S3}@db.example/app`,
    command: `curl -d password=${S1}${S2} https://a.example`,
  };
  const marks = [S1, S2, S3];
  const clean = (text: string, where: string) => { for (const mark of marks) assert.equal(text.includes(mark), false, `${where}: ${text}`); };
  s.adapter().scripts.push(callTool(args), reply('終わりました'));
  const outcome = s.app.engine.send(CONVERSATION, 'ファイルを取ってきて');
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result.ok, JSON.stringify(result));

  const stored = s.app.conversations.messages(CONVERSATION);
  const saved = stored.find(m => m.message.role === 'assistant' && m.message.toolCalls?.length);
  assert.deepEqual(saved?.message.role === 'assistant' ? saved.message.toolCalls?.[0]?.arguments : undefined, args, '会話には引数をそのまま保存する');
  const replayed = JSON.stringify(s.adapter().calls[1]!.messages);
  for (const mark of marks) assert.equal(replayed.includes(mark), true, 'モデルに戻す発言は伏せない');

  const listing = await (await s.api(`/api/conversations/${CONVERSATION}/messages`)).json() as { messages: Array<{ toolCalls?: Array<{ name: string; input: string }> }> };
  const shown = listing.messages.flatMap(m => m.toolCalls ?? []);
  assert.equal(shown.length, 1);
  clean(JSON.stringify(listing), 'GET /api/conversations/:id/messages');
  assert.equal(shown[0]!.input.includes('access_token=[REDACTED]&page=2#access_token=[REDACTED]'), true, shown[0]!.input);
  assert.equal(shown[0]!.input.includes('postgres://svc:[REDACTED]@db.example/app'), true, shown[0]!.input);

  const called = events.filter(e => e.type === 'tool.call');
  assert.equal(called.length, 1);
  clean(JSON.stringify(called), 'tool.call の出来事');
  clean(await (await s.api('/api/tool-calls')).text(), 'GET /api/tool-calls');

  clean(JSON.stringify(readHistory(s.app.db, CONVERSATION)), '履歴を読む道具（readHistory）');
  for (const mark of marks) assert.deepEqual(searchHistory(s.app.db, mark), [], '履歴を探す道具（searchHistory）');
  assert.deepEqual(await (await s.api(`/api/history?q=${S3}`)).json(), { hits: [] }, 'GET /api/history');
  clean(transcriptOf(stored), '振り返りに渡す会話の写し（transcriptOf）');
});
