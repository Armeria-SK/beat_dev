import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { withLoad, type Script } from './helpers.ts';
import { FakeBrowserDriver } from './helpers/fake-browser.ts';

// backlog L132 + L152: 本物の App では、実行が終わった瞬間に Browser の欄の「beat が動いている」の札が消える（60 秒の猶予を待たない）

const PAGE = 'https://example.com/start';

const callScript = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

test('L132/L152: 実行が動いているあいだ札は出たまま、実行が終わったら（最後の操作から 1 秒もたたなくても）すぐ消える', async t => {
  const driver = new FakeBrowserDriver().site(PAGE, { title: 'Start', text: 'start page' });
  const s = await startApp(t, {
    models: [fakeModel('m1')], browserDriver: driver,
    configure: c => { c.tools.browser.enabled = true; c.tools.browser.sites = ['example.com']; c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; },
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // 1 回目: タブを開く。2 回目: 持ち主が離すまで返事をしない（実行はまだ動いている）
  const hold: Script = async function* () { await gate; yield { type: 'text', delta: 'done' }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
  s.adapter().scripts = [callScript('browser_open', { url: PAGE }), hold];
  const root = join(s.paths.workspace, 'shop');
  mkdirSync(root, { recursive: true });
  const productId = s.app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null }).id;
  const id = uuid(91);
  s.app.conversations.create({ id, title: '会話', projectId: productId });
  const view = async (): Promise<{ driving: boolean; runId: string } | null> => (await s.json(`/api/browser/view?product=${productId}`, 'GET')).body.view;

  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '開いて' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const runId = sent.body.runId as string;
  try {
    await waitFor(() => s.adapter().calls.length === 2, 'browser_open が終わり、2 回目の返事を待っている');
    assert.ok(s.app.engine.activeRuns().some(run => run.runId === runId), '前提: 実行はまだ動いている');
    const running = await view();
    assert.equal(running?.runId, runId);
    assert.equal(running?.driving, true, '実行が動いているあいだは札が出ている');
  } finally {
    release();
  }
  await settled(s.app, runId);
  await waitFor(() => !s.app.engine.activeRuns().some(run => run.runId === runId), '実行が動いている一覧から外れる');
  const ended = await view();
  assert.equal(ended?.runId, runId);
  assert.equal(ended?.driving, false, '実行が終わった瞬間に札は消える（最後の操作から 60 秒を待たない）');
});
