import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { eraseConversation } from '../src/db/erase.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { isBrowserTool } from '../src/tools/browser/names.ts';
import { reply, tempDir, type Script } from './helpers.ts';

// TE-2: tool_search で読み込んだ道具は、同じ会話の次の実行でも並びに残る（kv の loaded-tools:<会話>）。
// 道具の並びが前の実行の終わりと同じなので、次の実行の最初の呼び出しが前半を読める。使えなくなった道具は並びに入らず、パイプラインも断る

type Options = NonNullable<Parameters<typeof startApp>[1]>;

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const s = await startApp(t, { models: [fakeModel('m1')], tools: builtinTools(), ...options });
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  const calls = () => s.adapter().calls.filter(c => c.tools.length > 0);
  const names = (req: ModelRequest) => req.tools.map(tool => tool.name);
  return { ...s, send, calls, names };
}

test('TE-2 読み込んだ道具は次の実行の最初の呼び出しにあり、道具の並びは前の実行の最後の呼び出しとバイト単位で同じ。別の会話には残らない', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('tool_search', { query: 'calculate' }), reply('loaded')];
  await s.send(uuid(1), { text: 'load it' });
  const end = s.calls().at(-1)!;
  assert.ok(s.names(end).includes('calculate'), '前提: 読み込んだ');
  assert.deepEqual(s.app.kv.getJson(`loaded-tools:${uuid(1)}`), ['calculate'], '読み込んだ時点で会話の記録に書く');

  s.adapter().scripts = [call('calculate', { expression: '2+3' }), reply('five')];
  await s.send(uuid(1), { text: 'use it' });
  const head = s.calls().at(-2)!;
  assert.equal(JSON.stringify(head.tools), JSON.stringify(end.tools), '次の実行の最初の呼び出しの道具の並びが同じ');
  const result = s.adapter().calls.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content)).at(-1)!;
  assert.match(result, /5/u, '読み込み直さずに使える');

  s.adapter().scripts = [reply('other')];
  await s.send(uuid(2), { text: 'hi' });
  assert.ok(!s.names(s.calls().at(-1)!).includes('calculate'), '別の会話は核の道具から');
});

test('TE-2 持ち越した道具でも、使えなくなったら並びに入らず、呼ばれてもパイプラインが断る（止めた道具・計画モード）', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('tool_search', { query: 'table_write' }), reply('loaded')];
  await s.send(uuid(1), { text: 'load it', permissionMode: 'auto' });
  assert.ok(s.names(s.calls().at(-1)!).includes('table_write'), '前提: 読み込んだ');

  s.adapter().scripts = [call('table_write', { path: 'sheet.csv', rows: [['a']] }), reply('tried')];
  await s.send(uuid(1), { text: 'plan it', permissionMode: 'plan' });
  const planned = s.calls().at(-2)!;
  assert.ok(!s.names(planned).includes('table_write'), '計画モードでは並びに入らない');
  const refused = s.adapter().calls.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content)).at(-1)!;
  assert.match(refused, /plan mode/iu, refused);

  const current = s.app.config();
  await s.app.applyConfig({ ...current, tools: { ...current.tools, policies: { table_write: 'block' } } }, { probe: false });
  s.adapter().scripts = [call('table_write', { path: 'sheet.csv', rows: [['a']] }), reply('tried')];
  await s.send(uuid(1), { text: 'write it', permissionMode: 'auto' });
  assert.ok(!s.names(s.calls().at(-2)!).includes('table_write'), '止めた道具は並びに入らない');
  const blocked = s.app.db.prepare("SELECT decision, decided_by FROM tool_calls WHERE tool = 'table_write' ORDER BY rowid DESC LIMIT 1").get() as { decision: string; decided_by: string };
  assert.deepEqual({ ...blocked }, { decision: 'deny', decided_by: 'policy' });

  await s.app.applyConfig({ ...current, tools: { ...current.tools, policies: {} } }, { probe: false });
  s.adapter().scripts = [reply('back')];
  await s.send(uuid(1), { text: 'again', permissionMode: 'auto' });
  assert.ok(s.names(s.calls().at(-1)!).includes('table_write'), '止めるのを外せば、記録が残っているので並びに戻る');
});

test('TE-2 会話を消すと、読み込んだ道具の記録も消える', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('tool_search', { query: 'calculate' }), reply('loaded')];
  await s.send(uuid(1), { text: 'load it' });
  assert.ok(s.app.kv.getJson(`loaded-tools:${uuid(1)}`), '前提: 記録がある');
  eraseConversation({ db: s.app.db, uploadsDir: s.app.paths.uploads, toolOutputsDir: join(s.app.paths.data, 'tool_outputs') }, uuid(1));
  assert.equal(s.app.kv.get(`loaded-tools:${uuid(1)}`), undefined);
});

test('TE-2 先読みの口 preload: 登録にある後回しの道具だけを覚え、次の実行の最初から渡す。使用量（contextUsage）も同じ並びで数える', async t => {
  const s = await setup(t);
  s.app.engine.preload(uuid(1), ['calculate', 'file_read', 'no_such_tool', 'calculate']);
  assert.deepEqual(s.app.kv.getJson(`loaded-tools:${uuid(1)}`), ['calculate'], '核の道具・無い名前・重なりは覚えない');
  const usage = s.app.engine.contextUsage(uuid(1), 'm1');
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), { text: 'x', modelId: 'm1' });
  const first = s.calls().at(-1)!;
  assert.ok(s.names(first).includes('calculate'), '最初の呼び出しから渡す');
  assert.ok(s.names(first).includes('tool_search'));
  const without = await setup(t);
  const plain = without.app.engine.contextUsage(uuid(1), 'm1');
  assert.ok(usage.ok && plain.ok && usage.tokens > plain.tokens, `先読みした道具の分だけ使用量が多い: ${usage.ok && usage.tokens} > ${plain.ok && plain.tokens}`);
});

// browser-rethink P1（持ち主の決め Q2 = 案 A）: 製品の中の実行は、よく読み込む道具を 1 回目の呼び出しから並べ、実行の途中で並びを変えない
const BROWSER = builtinTools().filter(t => isBrowserTool(t.name)).map(t => t.name);
const USUAL = [...BROWSER, 'pending_withdraw', 'deviation_add', 'image_view'];

async function inProduct(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await setup(t, { projectFolderExempt: [products], ...options });
  const dir = join(products, 'shop');
  mkdirSync(dir, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root: dir });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const shop = made.body.project as { id: string };
  const runTask = async () => {
    const task = await s.json('/api/tasks', 'POST', { title: 'Work', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(await s.app.worker.tick(), 'ran');
  };
  const searches = () => (s.app.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool = 'tool_search'").get() as { n: number }).n;
  return { ...s, shop, runTask, searches };
}

const has = (names: string[], wanted: readonly string[], label: string) => { for (const name of wanted) assert.ok(names.includes(name), `${label}: ${name}`); };
const lacks = (names: string[], unwanted: readonly string[], label: string) => { for (const name of unwanted) assert.ok(!names.includes(name), `${label}: ${name} should not be listed`); };

test('P1 製品の中の会話: 1 回目の呼び出しからブラウザの道具・pending_withdraw・image_view（画像を読めるモデル）が並び、実行の中で並びが変わらない。deviation_add（タスクだけ）は入らない', async t => {
  const s = await inProduct(t, { models: [fakeModel('m1', { vision: true })], configure: c => { c.tools.browser.enabled = true; } });
  assert.ok(BROWSER.length >= 6, `前提: ブラウザの道具 ${BROWSER.join(',')}`);
  const from = s.calls().length;
  s.adapter().scripts = [call('file_list', {}), call('file_list', {}), reply('ok')];
  await s.send(uuid(1), { text: 'check it', projectId: s.shop.id, permissionMode: 'auto' });
  const run = s.calls().slice(from);
  assert.equal(run.length, 3, '前提: 1 つの実行で 3 回呼んだ');
  has(s.names(run[0]!), [...BROWSER, 'pending_withdraw', 'image_view'], 'first call');
  lacks(s.names(run[0]!), ['deviation_add'], 'chat');
  for (const later of run.slice(1)) assert.equal(JSON.stringify(later.tools), JSON.stringify(run[0]!.tools), '実行の中で道具の並びが変わらない');
  assert.equal(s.searches(), 0, '読み込みの tool_search は 0 回');
});

test('P1 製品の中のタスク: 1 回目からブラウザの道具・pending_withdraw・deviation_add が並ぶ。画像を読めないモデルには image_view を入れない', async t => {
  const s = await inProduct(t, { configure: c => { c.tools.browser.enabled = true; } });
  s.adapter().scripts = [reply('ok')];
  await s.runTask();
  const first = s.calls().at(-1)!;
  has(s.names(first), [...BROWSER, 'pending_withdraw', 'deviation_add'], 'task');
  lacks(s.names(first), ['image_view'], 'no vision');
});

test('P1 製品の外の会話・ブラウザが切り・計画モードでは、先に並べない（今までどおり、要るときに読み込む）', async t => {
  const s = await inProduct(t, { models: [fakeModel('m1', { vision: true })], configure: c => { c.tools.browser.enabled = true; } });
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), { text: 'x', permissionMode: 'auto' });
  lacks(s.names(s.calls().at(-1)!), USUAL, 'outside the product');
  assert.equal(s.app.kv.get(`loaded-tools:${uuid(1)}`), undefined, '製品の外は記録もしない');

  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(2), { text: 'x', projectId: s.shop.id, permissionMode: 'plan' });
  lacks(s.names(s.calls().at(-1)!), USUAL, 'plan mode');
  assert.equal(s.app.kv.get(`loaded-tools:${uuid(2)}`), undefined, '計画モードは記録もしない');

  const off = await inProduct(t, { models: [fakeModel('m1', { vision: true })] });
  off.adapter().scripts = [reply('ok')];
  await off.send(uuid(3), { text: 'x', projectId: off.shop.id, permissionMode: 'auto' });
  const names = off.names(off.calls().at(-1)!);
  lacks(names, BROWSER, 'browser off');
  has(names, ['pending_withdraw', 'image_view'], 'browser off keeps the others');
});
