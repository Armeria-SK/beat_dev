import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { ResearchSession, type PartKind } from '../src/research/evidence.ts';
import { ResearchStore } from '../src/research/store.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, tempDir } from './helpers.ts';
import { toolCall } from './helpers/task-app.ts';

// beat R (M2): 調べる実行のエンジンと Web の守り（R3.2 D1〜D7・R3.11 H1・M1・M2・L1・L2・L3）

const LONG = `https://alpha.zqnotes.net/long?q=${'a'.repeat(300)}`;
const LONG_PATH = `https://alpha.zqnotes.net/${'p'.repeat(300)}?q=1`;
const html = (body: string) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from(`<!doctype html><html><head><title>t</title></head><body><main>${body}</main></body></html>`) }) as PageResponse;
const ddg = (links: readonly string[]) => html(`<div id="links" class="results">${links.map((l, i) => `<div class="result results_links web-result"><div class="result__body"><h2 class="result__title"><a class="result__a" href="${l.replaceAll('&', '&amp;')}">Hit ${i}</a></h2><a class="result__snippet">Snippet ${i}</a></div></div>`).join('')}</div>`);

function fakeWeb() {
  const asked: string[] = [];
  const network: PageNetwork = {
    resolve: async () => ['93.184.216.34'],
    get: async (url: URL) => {
      asked.push(url.href);
      if (url.hostname === 'html.duckduckgo.com') {
        const q = url.searchParams.get('q') ?? '';
        if (q.includes('longpath')) return ddg([LONG_PATH]);
        if (q.includes('bounce')) return { status: 302, location: 'https://third.zqnotes.net/?q=bounce', contentType: 'text/html', body: Buffer.alloc(0) };
        return ddg(['https://alpha.zqnotes.net/notes', 'https://alpha.zqnotes.net/Case/Path', 'https://alpha.zqnotes.net/q?a=1', 'https://short.zqnotes.net/r', LONG]);
      }
      if (url.hostname === 'short.zqnotes.net') return { status: 302, location: 'https://alpha.zqnotes.net/landing', contentType: 'text/html', body: Buffer.alloc(0) };
      if (url.hostname === 'third.zqnotes.net') return ddg(['https://third.zqnotes.net/x']);
      return html(`<p>Page ${url.pathname} is released under the MIT License. It has live Markdown preview.</p><a href="https://alpha.zqnotes.net/docs">Docs</a>`);
    },
  };
  return { network, asked };
}

async function setup(t: Parameters<typeof startApp>[0], configure?: (config: AppConfig) => void, extra: { botMemory?: boolean; models?: ModelConfig[] } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const web = fakeWeb();
  const s = await startApp(t, { projectFolderExempt: [products], tools: builtinTools(), webNetwork: web.network, ...extra, configure: c => { c.memory.review = false; configure?.(c); } });
  const root = join(products, 'Notes');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'ZQ-INSTRUCTIONS-MARKER: always use tabs');
  const made = await s.json('/api/projects', 'POST', { root });
  const projectId = made.body.project.id as string;
  const store = new ResearchStore(s.app.db);
  let n = 100;
  const part = (options: { part?: PartKind; oneByOne?: boolean; session?: ResearchSession; tools?: ReadonlySet<string>; followUp?: string; pinned?: string | null; limits?: Partial<ResearchSession['limits']> } = {}) => {
    const record = options.session ? store.get(options.session.researchId)! : store.start({ projectId, phase: options.part === 'libraries' ? 'libraries' : 'products', mode: options.oneByOne ? 'one_by_one' : 'batch' });
    const session = options.session ?? new ResearchSession({ researchId: record.id, part: options.part ?? 'first', oneByOne: options.oneByOne ?? false, budget: { fetches: 0, searches: 0, started: Date.now() }, limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20, ...options.limits } });
    const task = s.app.tasks.create({ title: 'Research', origin: 'self', projectId, scoutRun: true, actor: 'worker' });
    const conversationId = uuid(n++);
    assert.ok(s.app.tasks.claim(task.id, 60_000, conversationId));
    s.app.conversations.create({ id: conversationId, kind: 'task', title: 'Research', projectId });
    const started = s.app.engine.runResearch(s.app.tasks.get(task.id)!, conversationId, { prompt: 'Find similar products for a Markdown notes app.', ...(options.followUp ? { followUp: options.followUp } : {}) }, { pinned: options.pinned ?? null, session, ...(options.tools ? { tools: options.tools } : {}) });
    assert.ok(started.ok, JSON.stringify(started));
    const index = store.addPart(record.id, { taskId: task.id, conversationId, kind: session.part });
    store.setPart(record.id, index, { runId: started.runId });
    return { ...started, session, record, conversationId };
  };
  const toolResults = (conversationId: string) => s.app.conversations.messages(conversationId).map(m => m.message).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
  return { ...s, ...web, root, projectId, store, part, toolResults };
}

test('調べる実行（D1）: 渡る道具は web_search・web_fetch・research_record の 3 つだけ（tool_search も無い）。1 件ずつの最初の部分は web_fetch を外せる', async t => {
  const s = await setup(t, c => { c.tools.agent.enabled = true; c.tools.agent.inTasks = true; });
  s.adapter().scripts.push(reply('done'));
  const run = s.part();
  await run.done;
  assert.deepEqual(s.adapter().calls.at(-1)!.tools.map(tool => tool.name).sort(), ['research_record', 'web_fetch', 'web_search']);
  s.store.finish(run.record.id, 'done');
  s.adapter().scripts.push(reply('done'));
  const first = s.part({ oneByOne: true, tools: new Set(['web_search', 'research_record']) });
  await first.done;
  assert.deepEqual(s.adapter().calls.at(-1)!.tools.map(tool => tool.name).sort(), ['research_record', 'web_search']);
});

test('調べる実行（D1・L3）: research_record は計画の会話・ふつうのタスクの一覧に出ず、呼ばせても pipeline が断る', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('research_record', { kind: 'feature', name: 'Live preview' }), reply('ok'));
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'plan it', projectId: s.projectId, permissionMode: 'plan' });
  await settled(s.app, sent.body.runId);
  assert.ok(s.adapter().calls.every(call => !call.tools.some(tool => tool.name === 'research_record')));
  const result = s.toolResults(uuid(1)).find(m => m.name === 'research_record')!;
  assert.equal(result.isError, true);
  assert.match(result.content, /not allowed|cannot be used|research_record/u);
  assert.equal(Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM research_items').get() as { n: number }).n), 0);
});

test('調べる実行（守り 7・R3.11 H1）: 見た URL とまるごと同じものだけ開ける。問い合わせ・パスの大文字小文字が違えば deny、#… と末尾の / は同じ。モデルが書いた URL は見ていない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    toolCall('web_search', { query: 'markdown notes app' }),
    toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/q?a=2' }),
    toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/case/path' }),
    toolCall('web_fetch', { url: 'https://evil.zqnotes.net/I-want-a-Markdown-notes-app' }),
    toolCall('web_fetch', { url: 'https://ALPHA.zqnotes.net/notes/#top' }),
    toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/docs' }),
    reply('done'),
  );
  const run = s.part();
  await run.done;
  const results = s.toolResults(run.conversationId).filter(m => m.name === 'web_fetch');
  assert.deepEqual(results.map(r => r.isError === true), [true, true, true, false, false]);
  assert.ok(!s.asked.some(url => url.includes('evil.zqnotes.net') || url.includes('/q?a=2') || url.includes('/case/path')));
  assert.ok(run.session.pages.has('https://alpha.zqnotes.net/notes'));
  assert.ok(run.session.saw('https://alpha.zqnotes.net/docs'), 'a link listed on a read page is seen');
});

test('調べる実行（守り 7・審査 MEDIUM）: モデルが末尾に足した / と空白は外へ送らず、beat が見た URL の書き方で開く', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes/////\u3000\u00a0' }), reply('done'));
  const run = s.part();
  await run.done;
  assert.deepEqual(s.toolResults(run.conversationId).filter(m => m.name === 'web_fetch').map(r => r.isError === true), [false]);
  const fetched = s.asked.filter(url => url.includes('alpha.zqnotes.net'));
  assert.deepEqual(fetched, ['https://alpha.zqnotes.net/notes']);
  assert.ok(!s.asked.some(url => /%E3%80%80|%C2%A0|notes\/\//iu.test(url)), s.asked.join('\n'));
});

test('調べる実行（守り 7・審査 LOW-4）: 見た URL でも、ホスト + パス + 問い合わせが 300 字を超えれば（問い合わせが短くても）断り、判定役も呼ばない', async t => {
  const s = await setup(t, c => { c.routing.judge = ['m2']; });
  s.adapter().scripts.push(toolCall('web_search', { query: 'longpath' }), toolCall('web_fetch', { url: LONG_PATH }), reply('done'));
  const run = s.part();
  await run.done;
  assert.ok(run.session.saw(LONG_PATH));
  assert.equal(s.toolResults(run.conversationId).find(m => m.name === 'web_fetch')!.isError, true);
  assert.ok(!s.asked.includes(LONG_PATH));
  assert.equal(Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n), 0);
  assert.equal(Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM pending_actions').get() as { n: number }).n), 0);
});

test('調べる実行（D7・H1）: リダイレクトのあとの URL は見た URL に入り、開けたページの表にもその URL で入る', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes' }), toolCall('web_fetch', { url: 'https://short.zqnotes.net/r' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/landing' }), reply('done'));
  const run = s.part();
  await run.done;
  assert.deepEqual(s.toolResults(run.conversationId).filter(m => m.name === 'web_fetch').map(r => r.isError === true), [false, false]);
  assert.ok(run.session.pages.has('https://alpha.zqnotes.net/landing'));
  assert.ok(run.session.pages.quoted('https://alpha.zqnotes.net/landing', 'is released under the MIT License'));
});

test('調べる実行（D2）: 外を読んだあとの「聞く」になる呼び出しは Pending に積まずに断り、判定役も呼ばない（持ち主が web_fetch を「聞く」にしていても積まない）', async t => {
  const s = await setup(t, c => { c.routing.judge = ['m2']; c.tools.policies = { web_search: 'ask' }; });
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), toolCall('web_fetch', { url: LONG }), reply('done'));
  const run = s.part();
  await run.done;
  assert.equal(s.toolResults(run.conversationId).find(m => m.name === 'web_search')!.isError, true);
  const last = s.toolResults(run.conversationId).filter(m => m.name === 'web_fetch').at(-1)!;
  assert.equal(last.isError, true);
  assert.ok(!s.asked.includes(LONG));
  assert.equal(Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM pending_actions').get() as { n: number }).n), 0);
  assert.equal(Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n), 0);
});

test('調べる実行（R3.11 M1）: ! で始まる語の検索は deny。検索の転送は DuckDuckGo の外へたどらない。会話の検索は今のまま転送をたどる', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('web_search', { query: '!g markdown notes' }), toolCall('web_search', { query: 'bounce me' }), reply('done'));
  const run = s.part();
  await run.done;
  const results = s.toolResults(run.conversationId).filter(m => m.name === 'web_search');
  assert.deepEqual(results.map(r => r.isError === true), [true, true]);
  assert.ok(!s.asked.some(url => url.includes('third.zqnotes.net')), 'research never asks the redirect target');
  assert.ok(!s.asked.some(url => decodeURIComponent(url).includes('!g')));
  s.adapter().scripts.push(toolCall('web_search', { query: 'bounce me' }), reply('ok'));
  const sent = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: 'search', projectId: s.projectId });
  // 同じ検索先へは 4 秒空けて送るので、ふつうより長く待つ
  await waitFor(() => s.app.runs.get(sent.body.runId)?.ended_at != null, 'chat search ended', 10_000);
  assert.ok(s.asked.some(url => url.includes('third.zqnotes.net')), 'a chat search still follows the redirect');
});

test('調べる実行（R3.11 M2）: 数は記録ごと。本当の呼び出しで数え、続きの部分をまたいで上限を超える web_fetch と web_search が断られ、時間は記録の始まりから数える', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), reply('first'));
  const first = s.part({ limits: { fetches: 2, searches: 2 } });
  await first.done;
  const next = first.session.continued();
  s.adapter().scripts.push(toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), toolCall('web_search', { query: 'more' }), toolCall('web_search', { query: 'again' }), reply('second'));
  const second = s.part({ session: next });
  await second.done;
  assert.deepEqual(s.toolResults(first.conversationId).map(r => [r.name, r.isError === true]), [['web_search', false], ['web_fetch', false]]);
  assert.deepEqual(s.toolResults(second.conversationId).map(r => [r.name, r.isError === true]), [['web_fetch', false], ['web_fetch', true], ['web_search', false], ['web_search', true]]);
  assert.deepEqual([next.budget.fetches, next.budget.searches], [2, 2]);
  const late = new ResearchSession({ researchId: s.store.start({ projectId: 'other', phase: 'products', mode: 'batch' }).id, part: 'first', budget: { fetches: 0, searches: 0, started: Date.now() - 21 * 60_000 }, limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 } });
  assert.equal(late.overTime(), true);
});

test('調べる実行（D3・L1）: system に製品の指示ファイル・製品のフォルダの絶対パス・製品の目次・状態の行が入らない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('done'));
  const run = s.part();
  await run.done;
  const call = s.adapter().calls.at(-1)!;
  const system = `${call.system.frozen}\n${call.system.dynamic}\n${call.system.tail ?? ''}`;
  assert.ok(!system.includes('ZQ-INSTRUCTIONS-MARKER'));
  assert.ok(!system.includes(s.root));
  assert.ok(!system.includes('Notes'), 'not even the product name');
  assert.ok(!/MESH/u.test(system));
});

test('調べる実行（D4）: モデルは routing.research があればそれ、無ければ会話で選んだモデル、無ければ routing.chat', async t => {
  const s = await setup(t);
  assert.equal(s.app.engine.researchRoute(null)!.modelId, 'm1');
  assert.equal(s.app.engine.researchRoute('m2')!.modelId, 'm2');
  const config = s.app.config();
  await s.app.applyConfig({ ...config, routing: { ...config.routing, research: ['m2'] } }, { probe: false });
  assert.equal(s.app.engine.researchRoute('m1')!.modelId, 'm2');
});

test('調べる実行（D6）: 候補は 1 件ずつの最初の部分でだけ受け、見た URL だけ。ほかの部分では道具の誤り', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    toolCall('web_search', { query: 'notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Alpha Notes', url: 'https://alpha.zqnotes.net/notes' }),
    toolCall('research_record', { kind: 'candidate', name: 'Evil', url: 'https://evil.zqnotes.net/x' }),
    toolCall('research_record', { kind: 'similar', name: 'Alpha Notes', url: 'https://alpha.zqnotes.net/notes' }),
    reply('done'),
  );
  const first = s.part({ oneByOne: true, tools: new Set(['web_search', 'research_record']) });
  await first.done;
  assert.deepEqual(first.session.candidates, [{ name: 'Alpha Notes', url: 'https://alpha.zqnotes.net/notes' }]);
  assert.deepEqual(s.toolResults(first.conversationId).filter(m => m.name === 'research_record').map(r => r.isError === true), [false, true, true]);
  s.store.finish(first.record.id, 'done');
  s.adapter().scripts.push(toolCall('research_record', { kind: 'candidate', name: 'Beta', url: 'https://alpha.zqnotes.net/notes' }), reply('done'));
  const batch = s.part();
  await batch.done;
  assert.equal(s.toolResults(batch.conversationId).find(m => m.name === 'research_record')!.isError, true);
  assert.deepEqual(batch.session.candidates, []);
});

test('調べる実行（L3）: followUp は頼みのあとに generated で保存され、頼みは generated でない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('done'));
  const run = s.part({ followUp: 'Candidate: Alpha Notes https://alpha.zqnotes.net/notes' });
  await run.done;
  const users = s.app.conversations.messages(run.conversationId).map(m => m.message).filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => [m.content.slice(0, 9), (m as { generated?: true }).generated === true]), [['Find simi', false], ['Candidate', true]]);
});

test('ほかの実行は今のまま: 会話は見ていない URL も開け、Pending と判定役の扱いも変わらない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), reply('ok'));
  const sent = await s.json(`/api/conversations/${uuid(3)}/messages`, 'POST', { text: 'read it' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.toolResults(uuid(3)).find(m => m.name === 'web_fetch')!.isError, undefined, s.toolResults(uuid(3)).find(m => m.name === 'web_fetch')!.content);
});

test('調べる実行（D1）: ふつうのタスクの実行には research_record が渡らず、呼ばせても断られる（researchOnly の二重の断り）', async t => {
  const s = await setup(t, c => { c.routing.background = ['m1']; });
  const record = s.store.start({ projectId: s.projectId, phase: 'products', mode: 'batch' });
  const task = s.app.tasks.create({ title: 'Plain task', origin: 'user', projectId: s.projectId, actor: 'user' });
  const conversationId = uuid(50);
  s.app.conversations.create({ id: conversationId, kind: 'task', title: 'Plain', projectId: s.projectId });
  s.adapter().scripts.push(toolCall('research_record', { kind: 'feature', name: 'Live preview' }), reply('ok'));
  const started = s.app.engine.runTask(task, conversationId, 'do it');
  assert.ok(started.ok);
  s.store.setPart(record.id, s.store.addPart(record.id, { taskId: task.id, conversationId, kind: 'first' }), { runId: started.runId });
  await started.done;
  assert.ok(s.adapter().calls.every(call => !call.tools.some(tool => tool.name === 'research_record')));
  assert.ok(s.adapter().calls.some(call => call.tools.length > 0), 'the task run got its normal tools');
  const refused = s.toolResults(conversationId).find(m => m.name === 'research_record')!;
  assert.equal(refused.isError, true);
  assert.match(refused.content, /cannot be used in this kind of run/u);
  assert.equal(s.store.items(record.id).length, 0);
});

test('調べる実行（D3 (a)・M2 の残り）: 持ち主の記憶と技の目次は調べる実行の system に入らない（同じアプリの会話には入る）', async t => {
  const s = await setup(t, undefined, { botMemory: true });
  s.app.memory.save({ book: 'user', content: 'ZQ-MEMORY-MARKER likes tabs', actor: 'user' });
  s.app.skills.write({ name: 'zq-skill-marker', description: 'ZQ-SKILL-MARKER steps', body: 'Steps' });
  s.adapter().scripts.push(reply('chat ok'));
  const sent = await s.json(`/api/conversations/${uuid(3)}/messages`, 'POST', { text: 'hello' });
  await settled(s.app, sent.body.runId);
  const chat = s.adapter().calls.at(-1)!;
  const chatSystem = `${chat.system.frozen}\n${chat.system.dynamic}`;
  assert.ok(chatSystem.includes('ZQ-MEMORY-MARKER') && chatSystem.includes('zq-skill-marker'), 'the chat sees both (the markers are real)');
  s.adapter().scripts.push(reply('done'));
  const run = s.part();
  await run.done;
  const call = s.adapter().calls.at(-1)!;
  const system = `${call.system.frozen}\n${call.system.dynamic}\n${call.system.tail ?? ''}`;
  assert.ok(!system.includes('ZQ-MEMORY-MARKER'));
  assert.ok(!system.includes('zq-skill-marker') && !system.includes('ZQ-SKILL-MARKER'));
});

test('調べる実行（L2）: 調べる部分はやり取りが長くなっても context で区切られない（ふつうのタスクなら区切る長さでも）', async t => {
  const s = await setup(t, undefined, { models: [fakeModel('m1', { contextLength: 32_000 })] });
  const long = (n: number) => `https://a.zqnotes.net/${'x'.repeat(4_000)}${n}`;
  const big = (i: number) => toolCall('research_record', { kind: 'feature', name: `Feature ${i}`, url: long(i), evidence: [{ url: long(i + 100), quote: 'q' }, { url: long(i + 200), quote: 'q' }] });
  s.adapter().scripts.push(...Array.from({ length: 6 }, (_, i) => big(i)), reply('done'));
  const run = s.part();
  const ended = await run.done;
  const row = s.app.db.prepare('SELECT flags FROM engine_runs WHERE id = ?').get(run.runId) as { flags: string };
  assert.ok(!(JSON.parse(row.flags) as string[]).includes('context_split'), row.flags);
  assert.ok(s.adapter().calls.length >= 4, `the part went on past the third round (${s.adapter().calls.length} calls, ok=${ended.ok} ${JSON.stringify(s.app.db.prepare('SELECT error_kind, flags, iterations FROM engine_runs WHERE id = ?').get(run.runId))})`);
});

test('調べる実行（審査 LOW-5）: 記録の時間を過ぎた部分では web_search も web_fetch も断られ、外へ出ない', async t => {
  const s = await setup(t);
  const record = s.store.start({ projectId: s.projectId, phase: 'products', mode: 'batch' });
  const late = new ResearchSession({ researchId: record.id, part: 'first', budget: { fetches: 0, searches: 0, started: Date.now() - 21 * 60_000 }, limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 } });
  late.see('https://alpha.zqnotes.net/notes');
  s.adapter().scripts.push(toolCall('web_search', { query: 'notes' }), toolCall('web_fetch', { url: 'https://alpha.zqnotes.net/notes' }), reply('done'));
  const run = s.part({ session: late });
  await run.done;
  assert.deepEqual(s.toolResults(run.conversationId).map(r => [r.name, r.isError === true]), [['web_search', true], ['web_fetch', true]]);
  assert.deepEqual(s.asked, []);
});
