import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import type { SendChoice } from '../src/engine/chat.ts';
import { contextAvailable, maxOutputFor } from '../src/engine/context-budget.ts';
import { estimateMessageTokens, IMAGE_TOKENS } from '../src/engine/tokens.ts';
import type { ChatMessage, ImageRef, RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { REVIEW_WINDOW_CHARS, reviewWindow } from '../src/memory/review.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../src/tools/types.ts';
import { CONVERSATION, fakeModel, startApp } from './app-setup.ts';
import { fail, JudgeAdapter, judgeTextOf, reply, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function textOnly(text: string): Script {
  return async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
}

async function setup(t: { after: (fn: () => void) => void }, model: Partial<ModelConfig> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false, ...model }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: JudgeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  const send = async (text: string) => {
    const outcome = app.engine.send('c1', text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return { runId: outcome.runId, done: app.engine.wait(outcome.runId)! };
  };
  return { app, adapter: () => adapter, events, send, paths };
}

test('ツールを使ってから返事を書く（結果は履歴に残り、次の呼び出しに渡る）', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', { path: 'hello.md', content: 'やあ' }), reply('書きました'));
  const { runId, done } = await s.send('hello.md を作って');
  const result = await done;
  assert.ok(result.ok);
  assert.equal(readFileSync(join(s.paths.workspace, 'hello.md'), 'utf8'), 'やあ');
  assert.deepEqual(s.app.conversations.messages('c1').map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  const second = s.adapter().calls[1]!.messages;
  assert.equal(second.at(-1)?.role, 'tool');
  assert.ok(s.adapter().calls[0]!.tools.some(t => t.name === 'shell_run'));
  const run = s.app.runs.get(runId)!;
  assert.equal(run.tool_calls, 1); assert.equal(run.iterations, 2);
  assert.deepEqual(s.events.filter(e => e.type.startsWith('tool.')).map(e => e.type), ['tool.call', 'tool.result']);
});

// security-self-api.md の V1: 報告された筋道そのもの。beat が put.js を書いて動かし、API・設定ファイルに手を出そうとする
test('V1: スクリプトを書いて node で動かす筋道は、製品の外なので判定役に回り、ask なら中身つきで Pending に積まれて何も起きない', async t => {
  const s = await setup(t);
  const configBefore = readFileSync(s.paths.config, 'utf8');
  const marker = join(s.paths.workspace, 'ran.txt');
  const attack = [
    "const fs = require('node:fs');",
    "fs.writeFileSync('ran.txt', 'ran');",
    `fs.writeFileSync(${JSON.stringify(s.paths.config)}, '{}');`,
    "fetch('http://127.0.0.1:1/api/settings', { method: 'PUT', headers: { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);",
    '',
  ].join('\n');
  s.adapter().scripts.push(toolCall('file_write', { path: 'put.js', content: attack }), toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  const { done } = await s.send('設定を直して');
  const result = await done;
  assert.ok(result.ok);
  assert.equal(s.adapter().judged.length, 1, 'put.js を書くのは作業フォルダの中なので判定役なし。判定役が見るのは動かす node だけ');
  const judged = judgeTextOf(s.adapter().judged[0]!);
  assert.match(judged, /This code contains text that touches beat itself/u, '判定役に目印の理由が渡る');
  assert.match(judged, /It runs code written in a file/u);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, 'judge');
  assert.equal(row.tool, 'shell_run');
  assert.equal(row.preview.length, 1);
  assert.match(row.preview[0]!.path, /put\.js$/u);
  assert.match(row.preview[0]!.text, /api\/settings/u, '動かすコードの中身が Pending の行に出る');
  assert.match(row.checks[0]!, /This code contains text that touches beat itself/u, '理由の先頭に目印');
  assert.match(row.checks[0]!, /config\.json/u);
  assert.equal(existsSync(marker), false, '積んだだけで動いていない');
  assert.equal(readFileSync(s.paths.config, 'utf8'), configBefore, '設定ファイルが書き換わった');

  // 同じ文字のコマンドを、中身を変えてもう一度出しても、また判定役が見る（許したあとも）
  writeFileSync(join(s.paths.workspace, 'put.js'), "require('node:fs').writeFileSync('ran.txt', 'harmless');\n");
  s.adapter().judgeAnswer = '{"decision":"allow","reason":"fits"}';
  s.adapter().scripts.push(toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  assert.ok((await (await s.send('もう一度')).done).ok);
  assert.equal(s.adapter().judged.length, 2, '2 回目も判定役が見る');
  assert.doesNotMatch(judgeTextOf(s.adapter().judged[1]!), /beat itself/u, '無害な中身には目印が付かない');
  assert.equal(readFileSync(marker, 'utf8'), 'harmless', '判定役が許せば動く（積んだだけで動かないことの対照）');
  assert.equal(readFileSync(s.paths.config, 'utf8'), configBefore);

  s.adapter().judgeAnswer = '{"decision":"ask","reason":"check"}';
  s.adapter().scripts.push(toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  assert.ok((await (await s.send('もう一度')).done).ok);
  assert.equal(s.adapter().judged.length, 3, '前に判定役が許していても、3 回目もまた判定役が見る');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 2);
});

test('道具の結果は、モデルのコンテキストに合わせて切る（小さなコンテキストで、大きな一覧 1 つが入りきらなくならない）', async t => {
  const small = await setup(t, { contextLength: 16384, maxOutputTokens: 1024 });
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  writeFileSync(join(small.paths.workspace, 'listing.txt'), lines);
  small.adapter().scripts.push(...[1, 2, 3].map(() => toolCall('file_read', { path: 'listing.txt' })), reply('読みました'));
  const run = await small.send('一覧を読んで');
  const result = await run.done;
  assert.ok(result.ok, JSON.stringify(result));
  const results = small.app.conversations.messages('c1').filter(m => m.role === 'tool').map(m => m.text);
  assert.equal(results.length, 3);
  for (const text of results) {
    assert.ok(text.length < 9100, `16k のモデルでは、1 つの結果は、道具の仕様と今のやり取りを引いた残りの一部（約 8,700 文字より小さい）: ${text.length}`);
    assert.match(text, /\n\n\[Lines 1 to \d+ of 600\. Read on with offset=\d+\]$/u, 'TE-3: file_read は行の切れ目で切り、続きの offset を必ず書く');
  }
  assert.ok(results[0]!.length > results[1]!.length && results[1]!.length > results[2]!.length, '結果が積まれるほど、次の結果に許す量は小さくなる');
  const last = small.adapter().calls.at(-1)!;
  assert.ok(last.messages.length >= 7, '3 回分の結果が入っている');
  assert.equal(small.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), false, '古い発言を削らずに収まる');

  const large = await setup(t, { contextLength: 200_000, maxOutputTokens: 4096 });
  writeFileSync(join(large.paths.workspace, 'listing.txt'), lines.repeat(2));
  large.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  assert.ok((await (await large.send('一覧を読んで')).done).ok);
  const big = large.app.conversations.messages('c1').find(m => m.role === 'tool')!.text;
  assert.match(big, /\n\n\[Lines 1 to \d+ of 1199\. Read on with offset=\d+\]$/u, '大きなコンテキストでは 16,000 文字に収まる所で行の切れ目で切り、続きの offset を書く（TE-3）');
  assert.ok(big.length > 15_000 && big.length <= 16_000 + '[file_read] '.length, `16,000 文字近くまで使う: ${big.length}`);
});

// 道具の数が 24 → 31 に増えて、固定の分（system と道具の仕様）が 16k の約 4 割になっても、結果が入りきらなくならない。
// 結果の量を「モデルの境目の 2 割」と決めていたころは、英数字の一覧で 3 つ目、日本語の本文だと 1 つ目で、入りきらなくなった
test('道具の結果: 固定の分が大きい 16k のモデルでも、結果を何度受け取っても入りきる（英数字も日本語も）', async t => {
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  const minutes = Array.from({ length: 900 }, (_, i) => `第${i}回議事録: 予算の見直しと来期の採用計画について話し合い、各部門の担当者が持ち帰って検討することになった。`).join('\n');
  for (const [name, text, count] of [['英数字', lines, 5], ['日本語', minutes, 5]] as const) {
    const s = await setup(t, { contextLength: 16384, maxOutputTokens: 1024 });
    writeFileSync(join(s.paths.workspace, 'listing.txt'), text);
    s.adapter().scripts.push(...Array.from({ length: count }, () => toolCall('file_read', { path: 'listing.txt' })), reply('読みました'));
    const result = await (await s.send('一覧を読んで')).done;
    assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
    assert.equal(s.app.conversations.messages('c1').filter(m => m.role === 'tool').length, count);
    assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), false, `${name}: 古い発言を削らずに収まる`);
    const available = contextAvailable(16384, maxOutputFor(s.app.config().models[0]!, 16384));
    const run = s.app.runs.get(result.runId)!;
    const estimate = run.est_prompt_tokens ?? 0;
    assert.ok(estimate > 0 && estimate <= available, `${name}: 最後の呼び出しの見積もり ${estimate} が使える量 ${available} に収まる`);
  }
});

// 古いやり取りは、次の呼び出しで外せる（fit.ts）ので、結果の量を決める「削れない分」には数えない。数えると、長い会話ほど結果が小さくなってしまう
test('道具の結果の量は、削れない分だけから決まる: 古いやり取りが長くても小さくならず、入りきらない分は古い発言を外して収める', async t => {
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  const model = { contextLength: 16384, maxOutputTokens: 1024 };
  const toolText = (s: Awaited<ReturnType<typeof setup>>) => s.app.conversations.messages('c1').find(m => m.role === 'tool')!.text;

  const fresh = await setup(t, model);
  writeFileSync(join(fresh.paths.workspace, 'listing.txt'), lines);
  fresh.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  assert.ok((await (await fresh.send('一覧を読んで')).done).ok);

  const long = await setup(t, model);
  writeFileSync(join(long.paths.workspace, 'listing.txt'), lines);
  for (const question of ['一つ目', '二つ目', '三つ目']) {
    long.adapter().scripts.push(reply('あ'.repeat(2300)));
    assert.ok((await (await long.send(question)).done).ok);
  }
  long.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  const result = await (await long.send('一覧を読んで')).done;
  assert.ok(result.ok, JSON.stringify(result));
  // 新しい会話では、いまの発言が状態の節（BEAT-STATUS、約 65 トークン）を持ち、削れない分がその分だけ多い（長い会話では、その節は削れる最初の発言にある）。
  // 結果は行の切れ目で切るので、差は 1 行（約 65 字）を超えることもある。確かめるのは「古いやり取りが長くても小さくならない」こと
  // （古いやり取りを数える誤りなら、数千字小さくなる）と、大きすぎないこと（状態の節の分と行の切れ目で 2 行まで）
  const line = Math.max(...lines.split('\n').map(l => l.length + 1));
  const diff = toolText(long).length - toolText(fresh).length;
  assert.ok(diff >= -line && diff <= 2 * line, `長い会話でもほぼ同じ量: ${toolText(long).length} と ${toolText(fresh).length}`);
  // 外した発言は要約する（TE-4: 外した発言が 4 つ未満でも黙って捨てない）。要約に失敗したときは「外しました」
  assert.equal(long.events.some(e => e.type === 'compaction' || (e.type === 'warning' && e.code === 'context_trimmed')), true, '入りきらない分は、結果を小さくするのでなく古い発言を外して収める');
});

test('本文に書かれたツール呼び出し（<tool_call>）も拾って実行する', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    textOnly('作ります <tool_call>{"name": "file_write", "arguments": {"path": "t.md", "content": "本文から"}}</tool_call>'),
    reply('できました'),
  );
  const { runId, done } = await s.send('t.md を作って');
  assert.ok((await done).ok);
  assert.equal(readFileSync(join(s.paths.workspace, 't.md'), 'utf8'), '本文から');
  assert.match(s.app.runs.get(runId)!.flags, /text_tool_calls/u);
  assert.equal(s.app.conversations.messages('c1')[1]!.text, '作ります');
});

// 本文に "args"・"arguments"・"parameters" の欄が書かれていても（MCP の設定の例など）、道具が使える会話でも本文は止めず欠けずに流す。止めたときの途中までも丸ごと残す
const MCP_REPLY = '設定はこうです。{"mcpServers":{"fs":{"command":"npx","args":["-y","server-filesystem"],"parameters":{},"arguments":[]}}} 以上です。';
const inPieces = (text: string, size = 8): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const shownText = (events: RunEvent[]): string => events.map(e => (e.type === 'text.delta' ? e.text : '')).join('');

test('返事の本文に args・arguments・parameters の欄が書かれていても、本文は欠けずに流れ、そのまま保存される', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(async function* () { for (const part of inPieces(MCP_REPLY)) yield { type: 'text', delta: part }; yield { type: 'done', stop: 'end_turn' as StopReason }; });
  const { done } = await s.send('設定の例を教えて');
  assert.ok((await done).ok);
  assert.equal(shownText(s.events), MCP_REPLY);
  assert.equal(s.app.conversations.messages('c1').at(-1)!.text, MCP_REPLY);
});

test('返事の本文に args の欄が書かれたあとで止めても、流した分が丸ごと残る', async t => {
  const s = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  s.adapter().scripts.push(async function* (req) {
    for (const part of inPieces(MCP_REPLY)) yield { type: 'text', delta: part };
    await gate;
    req.signal.throwIfAborted();
    yield { type: 'done', stop: 'end_turn' as StopReason };
  });
  const { runId, done } = await s.send('設定の例を教えて');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(shownText(s.events), MCP_REPLY);
  assert.ok(s.app.engine.stop(runId));
  release();
  await done;
  const saved = s.app.conversations.messages('c1').at(-1)!.text;
  assert.ok(saved.startsWith(MCP_REPLY), saved);
});

test('引数の形が3回続けて正しくなければ止める', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', {}), toolCall('file_write', {}), toolCall('file_write', {}), reply('届かない'));
  const result = await (await s.send('書いて')).done;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errorMessage, /could not call tools in a valid form/u);
  assert.equal(s.adapter().calls.length, 3);
});

test('会話は回数で止まらない: 20 回道具を呼んでから普通に終わる', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(...Array.from({ length: 20 }, () => toolCall('file_list', {})), reply('おわり'));
  const { runId, done } = await s.send('一覧を続けて');
  const result = await done;
  assert.ok(result.ok);
  assert.equal(s.adapter().calls.length, 21);
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), []);
  assert.deepEqual(s.events.filter(e => e.type === 'warning'), []);
  assert.equal(s.app.conversations.messages('c1').at(-1)!.text, 'おわり');
});

test('使用量: 道具の仕様と道具の往復も数に入り、次の送信の見積もり（est_prompt_tokens）と合う', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', { path: 'hello.md', content: 'やあ' }), reply('書きました'), reply('二つ目の返事'));
  assert.ok((await (await s.send('hello.md を作って')).done).ok);
  const next = s.app.engine.send('c1', '次の質問');
  assert.ok(next.ok);
  const usage = s.app.engine.contextUsage('c1');
  assert.ok(usage.ok);
  await s.app.engine.wait(next.runId);
  assert.equal(usage.tokens, s.app.runs.get(next.runId)!.est_prompt_tokens, '道具の往復（assistant の呼び出しと tool の結果）と道具の仕様まで同じ組み立て');
  const calls = s.adapter().calls;
  assert.ok(calls.at(-1)!.tools.length > 0 && calls.at(-1)!.messages.some(m => m.role === 'tool'));
});

// ── 6d: 会話は道具を使う回数で止まらない ──

function endlessTools(onCall: (calls: number) => void): Script {
  let calls = 0;
  return async function* () {
    calls++;
    onCall(calls);
    const call: ToolCall = { id: `call_${calls}`, name: 'file_list', arguments: {} };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function runEndless(t: { after: (fn: () => void) => void }, stopAt: number) {
  const s = await setup(t);
  let runId = '';
  const script = endlessTools(calls => { if (calls === stopAt) s.app.engine.stop(runId); });
  const adapter = s.adapter();
  adapter.scripts = new Proxy([] as Script[], { get: (target, key) => (key === 'shift' ? () => script : Reflect.get(target, key)) });
  const sent = await s.send('どんどん調べて');
  runId = sent.runId;
  const result = await sent.done;
  return { s, result, calls: adapter.calls };
}

test('会話は制限なし: 100 回を超えて道具を使い続け、止めるボタン（取り消し）で止まる。まとめも上限のお知らせも出さない', async t => {
  const { s, result, calls } = await runEndless(t, 130);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorKind, 'cancelled');
  assert.ok(calls.length >= 130, `100 回で止まらない（${calls.length} 回）`);
  assert.ok(calls.every(c => c.tools.length > 0), '道具なしのまとめの呼び出しは一度も無い');
  assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'max_iterations'), false);
  const run = s.app.runs.get(result.runId)!;
  assert.deepEqual(JSON.parse(run.flags), []);
  assert.ok(run.iterations! >= 130);
});

// ── 段 4-4: 道具の結果の画像（X5 ToolOutput.images）のエンジンの側 ──

// 中身は PNG の頭の印 + 目印の文字（置き場へ置くときの見分けは頭の印だけを見る）。MARK は、その base64（messages.parts・画面の応答・出来事に出てはいけない文字列）
const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('SECRETIMAGEPIXELS')]);
const MARK = PNG_BYTES.toString('base64');
const PNG: ImageRef = { mediaType: 'image/png', data: MARK };
const BROKEN: ImageRef = { mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') };
const imageTool = (name: string, run: (ctx: ToolContext) => ToolOutput): ToolDef => ({
  name, description: name, effect: 'read', allowedIn: ['chat', 'task', 'review'],
  input: Type.Object({}, { additionalProperties: false }),
  async execute(_input, ctx) { return run(ctx); },
});
type ImageApp = Awaited<ReturnType<typeof startApp>>;

async function runImages(s: ImageApp, text: string, choice: SendChoice = {}) {
  const outcome = s.app.engine.send(CONVERSATION, text, [], [], choice);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

const storedTool = (s: ImageApp) => s.app.conversations.messages(CONVERSATION).filter(m => m.role === 'tool').map(m => m.message as Extract<ChatMessage, { role: 'tool' }>);

test('道具の結果の画像: 画像は uploads のファイルに置き、保存した発言には id だけ残る（base64 は parts に入らない）。次のモデル呼び出しの messages には画像が渡る。長くて切られた結果でも残る', async t => {
  const long = 'あ'.repeat(30_000);
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: long, images: [PNG] }))] });
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て');
  const [saved] = storedTool(s);
  assert.equal(saved!.images, undefined, '発言に base64 の画像は入らない');
  assert.equal(saved!.imageIds?.length, 1, '発言には置き場の id が 1 つ残る');
  const id = saved!.imageIds![0]!;
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT parts FROM messages').all()).includes(MARK), false, 'messages.parts に base64 が入らない');
  assert.deepEqual(readFileSync(join(s.paths.uploads, id)), PNG_BYTES, '画像は添付と同じ uploads のフォルダにファイルとして置かれる');
  assert.equal((s.app.db.prepare('SELECT kind FROM uploads WHERE id = ?').get(id) as { kind: string } | undefined)?.kind, 'image', 'uploads の行も添付と同じ形で付く');
  assert.ok(saved!.content.length < long.length, '長い結果は切られている（切る処理が images を落とさない）');
  const second = s.adapter().calls[1]!.messages.at(-1)!;
  assert.equal(second.role, 'tool');
  assert.deepEqual(second.role === 'tool' ? second.images : undefined, [PNG], '次のモデル呼び出しの messages に画像が渡る');
  assert.equal(second.role === 'tool' && 'imageIds' in second, false, 'モデルへ渡す発言に id の項目は付かない');
});

test('道具の結果の画像: 置き場へ置けない画像は、失わないよう base64 のまま発言に残り、モデルにも渡る', async t => {
  const s = await startApp(t, { tools: [imageTool('img_odd', () => ({ content: '画像を見せます', images: [BROKEN] }))] });
  s.adapter().scripts.push(toolCall('img_odd', {}), reply('見ました'));
  await runImages(s, '画像を見て');
  const [saved] = storedTool(s);
  assert.deepEqual(saved!.images, [BROKEN]);
  assert.equal(saved!.imageIds, undefined);
  const second = s.adapter().calls[1]!.messages.at(-1)!;
  assert.deepEqual(second.role === 'tool' ? second.images : undefined, [BROKEN]);
  assert.match(s.logs.join('\n'), /Could not put an image of img_odd/u);
});

test('道具の結果の画像: 以前の保存（images に base64）の発言も、今までどおりモデルに渡る。置き場のファイルが無くなった画像は渡さず、続けられる', async t => {
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))] });
  const conversations = s.app.conversations;
  conversations.append(CONVERSATION, { role: 'user', content: '前の質問' });
  conversations.append(CONVERSATION, { role: 'assistant', content: '', toolCalls: [{ id: 'old1', name: 'img_ok', arguments: {} }] });
  conversations.append(CONVERSATION, { role: 'tool', toolCallId: 'old1', name: 'img_ok', content: '前の画像', images: [PNG] });
  conversations.append(CONVERSATION, { role: 'assistant', content: '見ました' });
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('二枚目も見ました'), reply('ファイルが無くても続く'));
  await runImages(s, '画像を見て');
  const tools = (call: number) => s.adapter().calls[call]!.messages.filter(m => m.role === 'tool').map(m => (m.role === 'tool' ? m.images : undefined));
  assert.deepEqual(tools(1), [[PNG], [PNG]], '以前の base64 の画像と、置き場から戻した画像の両方が渡る');
  const [, saved] = storedTool(s);
  rmSync(join(s.paths.uploads, saved!.imageIds![0]!));
  await runImages(s, 'もう一度');
  assert.deepEqual(tools(2), [[PNG], undefined], 'ファイルの無い画像だけ渡らない（実行は止まらない）');
});

test('道具の結果の画像: 会話を消すと、その会話の道具の画像のファイルと uploads の行も消える。ほかの会話の画像は残る', async t => {
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))] });
  const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
  for (const conversation of [CONVERSATION, OTHER]) {
    s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
    const outcome = s.app.engine.send(conversation, '画像を見て');
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.ok((await s.app.engine.wait(outcome.runId)!).ok);
  }
  const idOf = (conversation: string) => (s.app.conversations.messages(conversation).find(m => m.message.role === 'tool')!.message as Extract<ChatMessage, { role: 'tool' }>).imageIds![0]!;
  const [mine, other] = [idOf(CONVERSATION), idOf(OTHER)];
  assert.ok(existsSync(join(s.paths.uploads, mine)) && existsSync(join(s.paths.uploads, other)));
  const erased = await s.json(`/api/conversations/${CONVERSATION}`, 'DELETE');
  assert.equal(erased.status, 200);
  assert.equal(erased.body.uploads, 1);
  assert.equal(existsSync(join(s.paths.uploads, mine)), false, '消した会話の画像のファイルが無い');
  assert.equal(s.app.db.prepare('SELECT 1 FROM uploads WHERE id = ?').get(mine), undefined, 'uploads の行も無い');
  assert.ok(existsSync(join(s.paths.uploads, other)), 'ほかの会話の画像は残る');
  assert.ok(s.app.db.prepare('SELECT 1 FROM uploads WHERE id = ?').get(other));
});

test('道具の結果の画像: 画像の無い道具の結果の発言は今までと同じ形（images の項目が無い）', async t => {
  const s = await startApp(t, { tools: [imageTool('plain', () => ({ content: 'ok' })), imageTool('empty', () => ({ content: 'ok', images: [] }))] });
  s.adapter().scripts.push(toolCall('plain', {}), toolCall('empty', {}), reply('おわり'));
  await runImages(s, '呼んで');
  for (const message of storedTool(s)) assert.deepEqual(Object.keys(message).sort(), ['content', 'name', 'role', 'toolCallId'], message.name);
});

test('道具の結果の画像: 失敗（isError）の結果の画像は保存せず、モデルにも渡さない', async t => {
  const s = await startApp(t, { tools: [imageTool('img_fail', () => ({ content: '読めませんでした', isError: true, images: [PNG] }))] });
  s.adapter().scripts.push(toolCall('img_fail', {}), reply('失敗でした'));
  await runImages(s, '画像を見て');
  const [saved] = storedTool(s);
  assert.equal(saved!.isError, true);
  assert.equal('images' in saved!, false);
  assert.equal(JSON.stringify(s.adapter().calls[1]!.messages).includes(MARK), false);
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT parts FROM messages').all()).includes(MARK), false);
});

test('道具の結果の画像: 出来事・道具の記録・画面の API には画像が出ない。検索・要約・振り返りが読む文字（text）にも入らない', async t => {
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))] });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て');
  assert.ok(storedTool(s)[0]!.imageIds?.length, '画像は保存されている（これが無いと下の確かめは空振り）');
  assert.ok(events.some(e => e.type === 'tool.result'));
  assert.equal(JSON.stringify(events).includes(MARK), false, '出来事（SSE）に画像が出ない');
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT * FROM tool_calls').all()).includes(MARK), false, 'tool_calls の行（output_preview など）に画像が出ない');
  const listing = await (await s.api(`/api/conversations/${CONVERSATION}/messages`)).text();
  assert.match(listing, /img_ok/u, '道具の結果の発言は一覧に出ている');
  assert.equal(listing.includes(MARK), false, 'GET /api/conversations/:id/messages の応答に画像（base64）が無い');
  assert.equal(listing.includes('imageIds'), false, '置き場の id も画面の応答に出ない');
  const stored = s.app.conversations.messages(CONVERSATION);
  assert.equal(JSON.stringify(stored.map(m => m.text)).includes(MARK), false, 'text の列（検索の索引・要約・振り返りの材料）に画像が入らない');
  assert.equal(reviewWindow(stored, { maxChars: REVIEW_WINDOW_CHARS }).transcript.includes(MARK), false, '振り返りの記録に画像が入らない');
});

test('道具の結果の画像: 古い画像つきのやり取りを要約に回しても、要約の依頼に画像は入らない（原文は DB に残る）', async t => {
  const small = fakeModel('m1', { contextLength: 20_000, maxOutputTokens: 1024 });
  const s = await startApp(t, { models: [small], tools: [] });
  const conversations = s.app.conversations;
  conversations.append(CONVERSATION, { role: 'user', content: `質問0${'い'.repeat(3000)}` });
  conversations.append(CONVERSATION, { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'img_ok', arguments: {} }] });
  conversations.append(CONVERSATION, { role: 'tool', toolCallId: 't0', name: 'img_ok', content: '画像を見せます', images: [PNG] });
  conversations.append(CONVERSATION, { role: 'assistant', content: '答え0' });
  for (let i = 1; i < 6; i++) {
    conversations.append(CONVERSATION, { role: 'user', content: `質問${i}${'い'.repeat(3000)}` });
    conversations.append(CONVERSATION, { role: 'assistant', content: `答え${i}` });
  }
  s.adapter().scripts.push(reply('- 画像を見せてもらった'), reply('ok'));
  await runImages(s, '最新の質問');
  assert.ok(s.adapter().calls.length >= 2);
  const summaryCall = s.adapter().calls[0]!;
  assert.match(JSON.stringify(summaryCall.messages), /Older part of the conversation/u, '1 回目の呼び出しは要約の依頼');
  assert.match(JSON.stringify(summaryCall.messages), /img_ok/u, '要約に回った古い部分に、画像つきの道具の結果が入っている');
  assert.equal(JSON.stringify(s.adapter().calls).includes(MARK), false, '要約の依頼にも、そのあとの呼び出しにも画像は入らない');
  assert.ok(storedTool(s)[0]!.images, '原文の画像は DB に残る');
});

test('道具の結果の画像: ctx.model は、道具を呼ぶ直前のモデルの id と vision を映す（鎖の途中で替わったら替わる）', async t => {
  const seen: Array<ToolContext['model']> = [];
  const s = await startApp(t, {
    models: [fakeModel('m1', { vision: false }), fakeModel('m2', { vision: true })],
    tools: [imageTool('probe', ctx => { seen.push(ctx.model === undefined ? undefined : { ...ctx.model }); return { content: 'ok' }; })],
  });
  s.adapter().scripts.push(
    toolCall('probe', {}),
    fail(new ProviderError('provider_error', 'down', { retryable: false })),
    toolCall('probe', {}),
    reply('おわり'),
  );
  await runImages(s, '二回呼んで');
  assert.deepEqual(seen, [{ id: 'm1', vision: false }, { id: 'm2', vision: true }]);
});

test('道具の結果の画像: 手元のモデルを選んだ会話の道具の画像は、その会話のモデル（手元）にだけ届き、外のモデルには届かない', async t => {
  const s = await startApp(t, {
    models: [fakeModel('local', { vision: true }), fakeModel('remote', { vision: true, provider: 'remote' })],
    configure: config => { config.providers.push({ id: 'remote', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', maxParallel: 1, timeoutMs: 10_000 }); },
    tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))],
  });
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て', { modelId: 'local' });
  assert.deepEqual(s.adapter().calls.length, 2);
  const second = s.adapter().calls[1]!.messages.at(-1)!;
  assert.deepEqual(second.role === 'tool' ? second.images : undefined, [PNG], '手元のモデルには届く');
  assert.equal(s.adapters.get('remote')?.calls.length ?? 0, 0, '外の提供元は一度も呼ばれない（画像はどこへも新しくは出ない）');
});

test('見積もり: 道具の結果の画像は 1 枚ごとに IMAGE_TOKENS 増える（利用者の発言の画像と同じ数え方）。画像が無ければ今までどおり', () => {
  const plain: ChatMessage = { role: 'tool', toolCallId: 't', name: 'image_view', content: '画像を見せます' };
  assert.equal(estimateMessageTokens({ ...plain, images: [PNG] }) - estimateMessageTokens(plain), IMAGE_TOKENS);
  assert.equal(estimateMessageTokens({ ...plain, images: [PNG, PNG, PNG] }) - estimateMessageTokens(plain), 3 * IMAGE_TOKENS);
  assert.equal(estimateMessageTokens({ ...plain, images: [] }), estimateMessageTokens(plain));
  const user: ChatMessage = { role: 'user', content: '見て' };
  assert.equal(estimateMessageTokens({ ...user, images: [PNG] }) - estimateMessageTokens(user), IMAGE_TOKENS, '比べる基準: 利用者の発言の画像と同じ');
});

test('会話の taint: 道具の ToolContext に conversationTainted が渡り、会話の印（ever_tainted）を読む', async t => {
  const seen: Array<boolean | undefined> = [];
  const s = await startApp(t, { tools: [imageTool('cap', ctx => { seen.push(ctx.conversationTainted?.()); return { content: 'ok' }; })] });
  s.app.db.prepare('UPDATE conversations SET ever_tainted = 0 WHERE id = ?').run(CONVERSATION);
  s.adapter().scripts.push(toolCall('cap', {}), reply('おわり'));
  await runImages(s, '呼んで');
  s.app.conversations.markTainted(CONVERSATION);
  s.adapter().scripts.push(toolCall('cap', {}), reply('おわり'));
  await runImages(s, 'もう一度');
  assert.deepEqual(seen, [false, true]);
});
