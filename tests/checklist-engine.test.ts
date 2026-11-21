import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { toolText } from '../src/shared/messages/tools.ts';
import { checklistWrite } from '../src/tools/builtin/checklist.ts';
import { readChecklist, writeChecklist } from '../src/tools/builtin/checklist-core.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { settled } from './app-setup.ts';
import { TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import { JudgeAdapter, judgeTextOf, reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

// 段 2-11: 作業の一覧を毎回の system に入れる・外から読んだ実行が書いた一覧は、あとの実行に「外から読んだ」印を引き継ぐ

const C = 'c1';
const FETCH = { url: 'https://news.example.com/' };
const WRITE = { path: 'out.txt', content: 'x' };
const OPEN = 'りんごの値段を調べる';
const ACTIVE = '見積もりを書く';
const DONE = '済んだ手順の印';
const LIST = { items: [{ text: OPEN, status: 'pending' }, { text: ACTIVE, status: 'in_progress' }, { text: DONE, status: 'done' }] };

const network: PageNetwork = {
  resolve: async () => ['93.184.216.34'],
  get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>ページの本文</p></main></body></html>') }) as PageResponse,
};

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: JudgeAdapter;
  const tools = [...builtinTools().filter(tool => tool.name !== 'checklist_write'), checklistWrite];
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, pendingWaitMs: 0, webNetwork: network, tools, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  return { app, adapter: () => adapter, paths };
}
type S = Awaited<ReturnType<typeof setup>>;

async function run(s: S, scripts: Script[], text = '進めて'): Promise<string> {
  s.adapter().scripts = scripts;
  const outcome = s.app.engine.send(C, text);
  assert.ok(outcome.ok && !outcome.queued, JSON.stringify(outcome));
  await settled(s.app, outcome.runId);
  await s.app.engine.wait(outcome.runId);
  assert.equal(s.app.runs.get(outcome.runId)!.ok, 1, '前提: 実行は最後まで終わった');
  return outcome.runId;
}

const PROBE = { command: 'frobnicate --now' };

async function expectAsked(s: S, runId: string): Promise<void> {
  await settled(s.app, runId);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.deepEqual(rows.map(r => [r.kind, r.tainted]), [['judge', true]], '印に頼らず判定役に回る操作が、外から読んだ印つきで積まれる');
  assert.ok(judgeTextOf(s.adapter().judged.at(-1)!).includes(TAINTED_NOTE), '判定役に外から読んだ 1 行が付く');
}

async function expectWritten(s: S, runId: string): Promise<void> {
  await settled(s.app, runId);
  assert.deepEqual(s.app.pending.list({ status: 'waiting' }), [], '確かめは出ない');
  assert.equal(existsSync(join(s.paths.workspace, 'out.txt')), true, '書き込みが通った');
}

function send(s: S, text: string, scripts: Script[]): string {
  s.adapter().scripts = scripts;
  const outcome = s.app.engine.send(C, text);
  assert.ok(outcome.ok && !outcome.queued, JSON.stringify(outcome));
  return outcome.runId;
}

test('一覧は毎回の system の「毎回組み立てる部分」に入る（終わっていない項目だけ。同じ実行の次の呼び出しにも入る）。固定の system には入らず、指紋も変わらない', async t => {
  const s = await setup(t);
  await run(s, [call('checklist_write', LIST), reply('書きました')]);
  await run(s, [reply('次です')]);
  const [before, afterWrite, nextRun] = s.adapter().calls;
  assert.equal(s.adapter().calls.length, 3);
  const heading = toolText('en', 'checklist.section');
  assert.ok(!before!.system.tail.includes(heading), '書く前は見出しが無い');
  for (const request of [afterWrite!, nextRun!]) {
    assert.ok(request.system.tail.includes(`${heading}\n- [ ] ${OPEN}\n- [>] ${ACTIVE}`), '見出しと、終わっていない項目が並びの順に入る');
    assert.ok(!request.system.tail.includes(DONE), '済みの項目は入らない');
    assert.ok(!request.system.tail.includes(toolText('en', 'checklist.section_tainted')), '外から読んでいない一覧に、印の文は付かない');
  }
  assert.ok(!afterWrite!.system.dynamic.includes(heading), 'S1: 一覧は実行のあいだ同じ部分（dynamic）には入れない');
  const lastSent = afterWrite!.messages.at(-1)!;
  assert.ok(lastSent.role !== 'assistant' && lastSent.tail?.includes(`${heading}\n- [ ] ${OPEN}`), 'S1: 書いた直後の呼び出しで、最後の発言（道具の結果）に付けて送る');
  assert.equal(afterWrite!.system.frozen, before!.system.frozen, '固定の system は変わらない');
  assert.equal(nextRun!.system.frozen, before!.system.frozen);
  assert.ok(!nextRun!.system.frozen.includes(OPEN) && !nextRun!.system.frozen.includes(heading), '一覧は固定の system に入れない');
});

test('全部 済み の一覧は、system に見出しも項目も入れない', async t => {
  const s = await setup(t);
  await run(s, [call('checklist_write', { items: [{ text: DONE, status: 'done' }] }), reply('書きました')]);
  await run(s, [reply('次です')]);
  const last = s.adapter().calls.at(-1)!;
  assert.ok(!last.system.tail.includes(toolText('en', 'checklist.section')));
  assert.ok(!last.system.tail.includes(DONE));
});

test('一覧の見出しは英語で入る', async t => {
  const s = await setup(t);
  await run(s, [call('checklist_write', { items: [{ text: 'check the price', status: 'pending' }] }), reply('saved')]);
  const last = s.adapter().calls.at(-1)!;
  assert.ok(last.system.tail.includes(`${toolText('en', 'checklist.section')}\n- [ ] check the price`));
});

test('使用量の見積もり（contextUsage）にも一覧の分が入る（実行と同じ組み立てを通る）', async t => {
  const s = await setup(t);
  const empty = s.app.engine.contextUsage(C);
  assert.ok(empty.ok);
  const items = Array.from({ length: 30 }, (_, i) => ({ text: `${i}`.padStart(3, '0') + 'あ'.repeat(190), status: 'pending' as const }));
  writeChecklist(s.app.kv, C, items, false, 1);
  const filled = s.app.engine.contextUsage(C);
  assert.ok(filled.ok);
  assert.ok(filled.tokens - empty.tokens >= 5000, `一覧の分（30 × 約 190 文字）が増える: ${filled.tokens - empty.tokens}`);
});

for (const language of ['en'] as const) {
  test(`外から読んだ実行が書いた一覧のあとの実行は「外から読んだ」で始まる（判定役に外から読んだ 1 行が付く。一覧の見出しにも印の文が付く）（${language}）`, async t => {
    const s = await setup(t);
    await run(s, [call('web_fetch', FETCH), call('checklist_write', LIST), reply('written')]);
    assert.equal(readChecklist(s.app.kv, C)?.tainted, true, '前提: 外から読んだ実行が書いた一覧は印付きで保存される');
    const second = send(s, 'next', [call('shell_run', PROBE), reply('done')]);
    await expectAsked(s, second);
    assert.equal(s.app.runs.get(second)!.tainted, 1, '実行の記録にも印が残る');
    const system = s.adapter().calls[3]!.system.tail;
    assert.ok(system.includes(toolText(language, 'checklist.section_tainted')), '一覧の見出しに、外から読んだ印の文が付く');
  });
}

test('全部 済み の印付きの一覧は、あとの実行を「外から読んだ」にしない（書き込みは確かめなしで通る）', async t => {
  const s = await setup(t);
  await run(s, [call('web_fetch', FETCH), call('checklist_write', { items: [{ text: DONE, status: 'done' }] }), reply('written')]);
  assert.equal(readChecklist(s.app.kv, C)?.tainted, true, '前提: 外から読んだ実行が書いた一覧は印付きで保存される');
  const second = send(s, '書いて', [call('file_write', WRITE), reply('書きました')]);
  await expectWritten(s, second);
  assert.equal(s.app.runs.get(second)!.tainted, 0);
});

test('外から読んでいない実行が書いた一覧は、あとの実行を「外から読んだ」にしない（書き込みは確かめなしで通る）', async t => {
  const s = await setup(t);
  await run(s, [call('checklist_write', LIST), reply('書きました')]);
  assert.equal(readChecklist(s.app.kv, C)?.tainted, false, '前提: 印なしで保存された');
  const second = send(s, '書いて', [call('file_write', WRITE), reply('書きました')]);
  await expectWritten(s, second);
  assert.equal(s.app.runs.get(second)!.tainted, 0);
});

test('一覧を空にしたあとの実行は確かめなしで書ける。ただし外から読んだ一覧を載せた tail が送る範囲にあるあいだは「外から読んだ」で始まる（TE-1）', async t => {
  const s = await setup(t);
  await run(s, [call('web_fetch', FETCH), call('checklist_write', LIST), reply('書きました')]);
  assert.equal(readChecklist(s.app.kv, C)?.tainted, true, '前提');
  const clearing = await run(s, [call('checklist_write', { items: [] }), reply('消しました')]);
  assert.equal(s.app.runs.get(clearing)!.tainted, 1, '前提: 空にした実行そのものは、印付きで始まった');
  assert.equal(readChecklist(s.app.kv, C), undefined, '前提: 一覧は消えた');
  const third = send(s, '書いて', [call('file_write', WRITE), reply('書きました')]);
  await expectWritten(s, third);
  assert.equal(s.app.runs.get(third)!.tainted, 1, '前の一覧は保存した tail のまま送るので、印は残る');
});

test('TE-1: 外から読んだ一覧を載せて保存した tail が送る範囲にあるあいだは、一覧を全部済ませても次の実行は「外から読んだ」で始まる', async t => {
  const s = await setup(t);
  await run(s, [call('web_fetch', FETCH), call('checklist_write', { items: [{ text: 'EVIL', status: 'in_progress' }] }), reply('書きました')]);
  assert.equal(readChecklist(s.app.kv, C)?.tainted, true, '前提: 外から読んだ実行が書いた一覧');
  assert.ok(s.app.conversations.messages(C).some(m => m.message.role !== 'assistant' && m.message.tail?.includes('EVIL')), '前提: 一覧を載せた tail を保存した');
  writeChecklist(s.app.kv, C, [{ text: 'EVIL', status: 'done' }], false, 2);
  const second = send(s, 'next', [call('shell_run', PROBE), reply('done')]);
  await expectAsked(s, second);
  // 前の実行は返事を書いて終わったので印を持ち越さない。添付も無い。残る理由は、送り続ける tail の一覧だけ（taint.checklist）
  assert.equal(s.app.runs.get(second)!.tainted, 1, '2 回目の実行は「外から読んだ」で始まった');
});

test('やり直し（retry）も、印付きの一覧が残っていれば「外から読んだ」で始まる', async t => {
  const s = await setup(t);
  await run(s, [call('web_fetch', FETCH), call('checklist_write', LIST), reply('書きました')]);
  s.app.conversations.append(C, { role: 'user', content: 'もう一度' });
  s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
  const retried = s.app.engine.retry(C);
  assert.ok(retried.ok);
  await expectAsked(s, retried.runId);
});

test('タスクの会話も同じ: 印付きの一覧が残っていれば、次のタスクの実行は「外から読んだ」で始まる（判定役に外から読んだ 1 行が付く）。印の無い一覧なら書き込みは確かめなしで通る', async t => {
  const s = await setup(t);
  const runTask = async (listTainted: boolean) => {
    const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
    const conversation = s.app.conversations.create({ kind: 'task' });
    writeChecklist(s.app.kv, conversation.id, [{ text: OPEN, status: 'pending' }], listTainted, 1);
    s.adapter().scripts = [call(listTainted ? 'shell_run' : 'file_write', listTainted ? PROBE : WRITE), reply('おわり')];
    const started = s.app.engine.runTask(task, conversation.id, '続きをやって');
    assert.ok(started.ok);
    return started;
  };
  const tainted = await runTask(true);
  await expectAsked(s, tainted.runId);
  await tainted.done;
  assert.equal(s.app.runs.get(tainted.runId)!.tainted, 1);
  const waitingBefore = s.app.pending.list({ status: 'waiting' }).length;
  const clean = await runTask(false);
  await clean.done;
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, waitingBefore, '印の無い一覧では確かめが出ない');
  assert.equal(existsSync(join(s.paths.workspace, 'out.txt')), true);
  assert.equal(s.app.runs.get(clean.runId)!.tainted, 0);
});
