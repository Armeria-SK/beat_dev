import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { providerModels } from '../src/config/schema.ts';
import { candidateModelIds } from '../src/engine/chat.ts';
import { settled, startApp, uuid, waitFor } from './app-setup.ts';
import { tempDir } from './helpers.ts';
import { OK_STATUS, scriptedFactory, type ScriptedRuntime } from './helpers/scripted-runtime.ts';

// AR-10: 提供元（API・手元のモデル）が 1 つも無い設定で、実行役（Claude Code・Codex）だけを頼りに、はじめの設定を終えて会話できる。動かないものは、黙らず理由を出す

type Json = Record<string, any>;
const PAGE = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };
const MODEL = { id: 'claude-code-sonnet', runtime: 'claude-code', model: 'sonnet', vision: false };

// 提供元 0・提供元のモデル 0 の設定から始める。実行役は持ち主が画面から足すまで設定に無い
async function bare(t: Parameters<typeof startApp>[0], configure: (config: Json) => void = () => undefined) {
  const holder: { current?: ScriptedRuntime } = {};
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, {
    models: [],
    configure: config => {
      config.providers = [];
      config.routing = { chat: [], background: [], retriesPerModel: 0 };
      configure(config);
    },
    runtimeFactories: { 'claude-code': scriptedFactory(holder) },
    projectFolderExempt: [products],
    runtimeStopGraceMs: 150,
    env: {},
  });
  // 画面（はじめの設定）と同じ手順: 設定を読み、実行役の行とモデルを足して保存する
  const save = async (change: (config: Json) => void) => {
    const config = structuredClone((await s.json('/api/settings', 'GET')).body.config) as Json;
    change(config);
    const saved = await s.json('/api/settings', 'PUT', { config });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  // 画面（はじめの設定）が保存する形。orderChat を false にすると、会話の順番は空のまま（既定は実行役の先頭のモデルに任せる）
  const enable = (orderChat = true) => save(config => {
    config.runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }];
    config.models = [{ ...MODEL }];
    config.routing.chat = orderChat ? [MODEL.id] : [];
  });
  const check = async () => { const res = await s.json('/api/runtimes/claude-code/check', 'POST'); assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
  const step = async () => (await s.json('/api/onboarding', 'GET')).body.steps.model as boolean;
  const product = async (name = 'prod') => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  return { s, holder, save, enable, check, step, product };
}

test('はじめの設定の「モデルをつないだ」印: 提供元が無くても、使える実行役（入れた・モデルがある・最後の確かめが使える）があれば満たし、ログアウト・切ると「つなぐものが無い」に戻る', async t => {
  const r = await bare(t);
  assert.equal(providerModels(r.s.app.config()).length, 0);
  assert.equal(await r.step(), false, 'nothing connected at the start');
  await r.enable();
  assert.equal(await r.step(), false, 'enabled but never checked: not known to work');
  await r.check();
  assert.equal(await r.step(), true, 'checked and usable');

  r.holder.current!.status = { ...OK_STATUS, auth: 'login_required' };
  await r.check();
  assert.equal(await r.step(), false, 'logged out: nothing connected again');
  r.holder.current!.status = { ...OK_STATUS, login: 'other' };
  await r.check();
  assert.equal(await r.step(), false, 'a login that is not a subscription cannot start a conversation: nothing connected');
  r.holder.current!.status = OK_STATUS;
  await r.check();
  assert.equal(await r.step(), true);
  await r.save(config => { config.runtimes[0].enabled = false; });
  assert.equal(await r.step(), false, 'switched off: nothing connected');
});

test('はじめの設定の印: 実行役のモデルが設定に無いとき（入れただけ）は、使える実行役でも満たさない。提供元のモデルがあるときは今までどおり', async t => {
  const r = await bare(t);
  await r.save(config => { config.runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }]; });
  await r.check();
  assert.equal(await r.step(), false, 'a usable runtime without a model of it in the settings');
  const withProvider = await startApp(t, { models: [{ id: 'm1', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }] });
  assert.equal((await withProvider.json('/api/onboarding', 'GET')).body.steps.model, true);
});

test('会話の既定: 提供元のモデルが 1 つも無く、会話の順番が空のとき、入れてある実行役の先頭のモデルが既定になる（切れた実行役・提供元のモデルがあるときは今までどおり）', async t => {
  const r = await bare(t);
  await r.save(config => { config.runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }]; config.models = [{ ...MODEL }]; });
  assert.deepEqual(r.s.app.config().routing.chat, [], 'the stored order stays empty');
  assert.deepEqual(candidateModelIds(r.s.app.config(), 'chat'), [MODEL.id]);
  assert.deepEqual(candidateModelIds(r.s.app.config(), 'background'), [], 'a runtime model never runs the background');
  const models = (await r.s.json('/api/models', 'GET')).body;
  assert.deepEqual(models.routing.chat, [MODEL.id]);
  assert.equal(models.models.find((m: Json) => m.id === MODEL.id).inChat, true);

  await r.save(config => { config.runtimes[0].enabled = false; });
  assert.deepEqual(candidateModelIds(r.s.app.config(), 'chat'), [], 'switched off: nothing');
  assert.equal((await r.s.json('/api/models', 'GET')).body.models.find((m: Json) => m.id === MODEL.id).inChat, false);

  const mixed = await startApp(t, {
    models: [{ id: 'm1', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }, { ...MODEL } as never],
    configure: config => { config.runtimes = [{ id: 'claude-code', kind: 'claude-code', enabled: true }]; config.routing.chat = []; },
  });
  assert.deepEqual(candidateModelIds(mixed.app.config(), 'chat'), ['m1'], 'with a provider model the runtime is not put in front of it');
});

for (const orderChat of [true, false]) test(`提供元なしの通し（会話の順番${orderChat ? 'に実行役のモデルを入れた' : 'は空のまま'}）: 実行役を入れて確かめ、製品の中で新しい会話を送ると実行役が動き、承認を 1 回答えて返事が終わる（beat のモデルも判定役も呼ばれない）`, async t => {
  const r = await bare(t);
  await r.enable(orderChat);
  await r.check();
  const { id: projectId } = await r.product();
  const runtime = r.holder.current!;
  runtime.script = async feed => {
    feed.push({ type: 'text', delta: 'Working. ' });
    feed.push({ type: 'tool_start', id: 'req-1', name: 'Bash', input: { command: 'npm test' } });
    feed.push({ type: 'approval', requestId: 'req-1', tool: 'Bash', input: { command: 'npm test' } });
    await waitFor(() => runtime.approvals.length > 0, 'the answer');
    feed.push({ type: 'tool_end', id: 'req-1', output: 'ok', isError: false });
    feed.push({ type: 'text', delta: 'Finished.' });
    feed.done();
  };
  const conversation = uuid(9001);
  const sent = await r.s.json(`/api/conversations/${conversation}/messages`, 'POST', { text: 'run the tests', projectId, permissionMode: 'auto' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await waitFor(() => (r.s.app.db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind = 'runtime' AND status = 'waiting'").get() as { n: number }).n === 1, 'the request reached Pending');
  const listed = (await r.s.json('/api/pending', 'GET')).body.items;
  const item = listed.find((i: Json) => i.kind === 'runtime');
  const approved = await r.s.api(`/api/pending/${item.id}/approve`, { method: 'POST', headers: PAGE, body: '{}' });
  assert.equal(approved.status, 202, await approved.text());
  await settled(r.s.app, sent.body.runId);

  assert.equal(r.s.app.runs.get(sent.body.runId)!.ok, 1);
  assert.deepEqual(runtime.approvals, [{ requestId: 'req-1', decision: 'accept' }]);
  assert.equal(runtime.starts.length, 1, 'the runtime was started once, by the default route');
  assert.equal(r.s.app.conversations.runtimeOf(conversation).runtimeId, 'claude-code');
  assert.equal(r.s.adapters.size, 0, 'no provider was ever built, so beat called no model');
  const texts = r.s.app.conversations.messages(conversation, 20).map(row => row.message).filter(m => m.role === 'assistant').map(m => (m as { content: string }).content).join('');
  assert.match(texts, /Finished\./u);
});

test('動かないもの: ワーカーの状態が noProvider を返し、待っているタスクには「提供元が要る」という待ちの理由が付く（黙って待たない）。提供元のモデルが入れば消える', async t => {
  const r = await bare(t);
  await r.enable();
  await r.check();
  const task = r.s.app.tasks.create({ title: 'Nightly tidy', origin: 'user', actor: 'user' });
  const worker = (await r.s.json('/api/worker', 'GET')).body;
  assert.equal(worker.noProvider, true);
  assert.deepEqual(worker.waiting[task.id], { kind: 'no_provider' });
  assert.equal(await r.s.app.worker.tick(), 'no_model', 'the worker still rests, now with the reason shown');
  assert.equal(r.s.app.tasks.get(task.id)!.status, 'ready');

  await r.save(config => {
    config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
    config.models.push({ id: 'm1', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false });
  });
  const after = (await r.s.json('/api/worker', 'GET')).body;
  assert.equal(after.noProvider, false);
  assert.equal(after.waiting[task.id]?.kind === 'no_provider', false, 'with a provider model the reason is gone');
});

test('考える役（Think now）と調べもの: 提供元が無いときは、それを理由にした断りの文で返す（モデルを選ぶ案内を出さない）', async t => {
  const r = await bare(t);
  await r.enable();
  const { id: projectId } = await r.product();
  r.s.app.projects.update(projectId, { scoutMode: 'research' });
  const think = await r.s.json(`/api/projects/${projectId}/scout/run`, 'POST');
  assert.deepEqual([think.status, think.body.code], [409, 'project.scout_no_provider'], JSON.stringify(think.body));
  assert.doesNotMatch(String(think.body.error ?? think.body.message ?? ''), /Choose one in Settings/u);

  const chat = r.s.app.conversations.create({ projectId });
  const research = await r.s.json(`/api/projects/${projectId}/research`, 'POST', { conversationId: chat.id });
  assert.deepEqual([research.status, research.body.code], [409, 'research.no_provider'], JSON.stringify(research.body));
});
