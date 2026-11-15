import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { builtinTools } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { planAllows } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { placePath } from '../src/tools/hooks/scope.ts';
import { BROWSER_TOOLS } from '../src/tools/builtin/browser.ts';
import { isBrowserTool } from '../src/tools/browser/names.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, type Script, testConfig, withLoad, notSearch, offered } from './helpers.ts';
import { FakeBrowserDriver } from './helpers/fake-browser.ts';

// T-09 / T-12: ブラウザの道具が渡る場面（既定は無効、モデルを選んだ会話でも渡る、計画モードでは submits の道具は外す）と、プロファイルの置き場所

type Started = Awaited<ReturnType<typeof startApp>>;

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function chat(s: Started, id: string, text: string, model?: string): Promise<string> {
  s.app.conversations.create({ id, title: '会話' });
  if (model) s.app.conversations.setChoice(id, { modelId: model });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  return sent.body.runId as string;
}

const names = (s: Started, n: number) => offered(s.adapter().calls[n]!);
const browserNames = (s: Started, n: number) => names(s, n).filter(isBrowserTool).sort();
const ALL = ['browser_click', 'browser_close', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_type'];
const enable = (c: ReturnType<typeof testConfig>) => { c.tools.browser.enabled = true; };

test('T-09 組み込みの道具に browser_open / read / screenshot / close / click / type がある。既定（無効）ではモデルに渡らない', async t => {
  assert.deepEqual(builtinTools().map(tool => tool.name).filter(isBrowserTool).sort(), ALL);
  assert.deepEqual(BROWSER_TOOLS.map(tool => tool.name).sort(), ALL);
  const s = await startApp(t, { models: [fakeModel('m1')] });
  s.adapter().scripts = [reply('こんにちは')];
  await chat(s, uuid(1), 'やあ');
  assert.deepEqual(browserNames(s, 0), []);
  assert.ok(names(s, 0).includes('file_read'), '前提: ほかの道具は渡っている');
});

test('T-09 有効にするとチャットの実行に 6 つとも渡る。モデルを選んだ会話でも渡る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], configure: enable });
  s.adapter().scripts = [reply('こんにちは'), reply('こんにちは')];
  await chat(s, uuid(1), 'やあ');
  assert.deepEqual(browserNames(s, 0), ALL);
  await chat(s, uuid(2), 'やあ', 'm1');
  assert.deepEqual(browserNames(s, 1), ALL, 'モデルを選んだ会話でも渡る');
});

test('T-09 計画モードには、読むだけの browser_* は渡り、送信になりうる道具（submits）は渡らない', async t => {
  const submit = { ...BROWSER_TOOLS[0], name: 'browser_click_stub', submits: true } as const;
  assert.equal(planAllows(BROWSER_TOOLS[0]), true);
  assert.equal(planAllows(submit as never), false);
  const s = await startApp(t, { models: [fakeModel('m1')], configure: enable, tools: [...builtinTools(), { ...BROWSER_TOOLS[0], name: 'browser_submit_stub', submits: true } as never] });
  s.adapter().scripts = [reply('計画です')];
  const id = uuid(3);
  s.app.conversations.create({ id, title: '計画' });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '計画して', permissionMode: 'plan' });
  await settled(s.app, sent.body.runId);
  // browser_close は効果が meta、click / type は submits なので、計画モードには渡らない（読む open / read / screenshot だけ）
  assert.deepEqual(browserNames(s, 0), ['browser_open', 'browser_read', 'browser_screenshot']);
});

test('T-09 無効のあいだにモデルが browser_open を呼んでも、パイプラインが断る（ブラウザは起動しない）', async t => {
  const driver = new FakeBrowserDriver().site('https://example.com/', { title: 'Example', text: 'hello' });
  const s = await startApp(t, { models: [fakeModel('m1')], browserDriver: driver });
  s.adapter().scripts = [call('browser_open', { url: 'https://example.com/' }), reply('断られた')];
  const id = uuid(4);
  await chat(s, id, '開いて');
  const tool = s.app.conversations.messages(id).find(notSearch);
  assert.ok(tool, '道具の結果がある');
  assert.match(tool.text, /tools\.browser\.enabled/u);
  assert.equal(driver.launches, 0);
});

test('有効にして browser_open を呼ぶと、ページの内容が返り、会話に外から読んだ印（taint）が付く。会話を消すとタブが閉じる', async t => {
  const driver = new FakeBrowserDriver().site('https://example.com/', { title: 'Example', text: 'hello world', snapshot: '- link "Docs":\n  - /url: /docs' });
  const s = await startApp(t, { models: [fakeModel('m1')], configure: c => { enable(c); c.tools.policies = { browser_open: 'allow' }; }, browserDriver: driver });
  s.adapter().scripts = [call('browser_open', { url: 'https://example.com/' }), reply('読んだ')];
  const id = uuid(5);
  await chat(s, id, '開いて');
  const tool = s.app.conversations.messages(id).find(notSearch);
  assert.ok(tool?.text.includes('hello world'), tool?.text);
  assert.equal(driver.launches, 1);
  assert.equal(s.app.conversations.get(id)?.ever_tainted, 1);
  assert.equal(s.app.browser.tabCount(id), 1);
  const gone = await s.json(`/api/conversations/${id}`, 'DELETE');
  assert.ok(gone.status < 300, String(gone.status));
  await waitFor(() => s.app.browser.tabCount(id) === 0, 'タブが閉じる');
});

test('T-12 ブラウザのプロファイル（ログイン状態）は禁止パス。beat のファイルの道具からは読み書きできない', () => {
  const paths = resolvePaths('C:\\beat-data');
  assert.equal(paths.browserProfile.endsWith('browser-profile'), true);
  const policy = buildPolicy(testConfig(), paths);
  for (const sub of ['', 'Default\\Cookies', 'Default\\Login Data']) {
    const target = sub ? `${paths.browserProfile}\\${sub}` : paths.browserProfile;
    assert.equal(placePath(target, policy).kind, 'deny', target);
  }
  // バックアップの置き場所（データベースの控え）には入っていない
  assert.equal(paths.browserProfile.startsWith(paths.backups), false);
});
