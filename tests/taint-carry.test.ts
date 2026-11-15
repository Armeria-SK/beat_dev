import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import type { AttachmentMeta, ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { settled, waitFor } from './app-setup.ts';
import { TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import { JudgeAdapter, judgeTextOf, reply, tempDir, testConfig, type Script } from './helpers.ts';

const C = 'c1';
const EVIL: AttachmentMeta = { id: 'u1', name: 'evil.txt', kind: 'text' };
const FETCH = { url: 'https://news.example.com/' };
const WRITE = { path: 'out.txt', content: 'x' };
const PROBE = { command: 'frobnicate --now' };

const network: PageNetwork = {
  resolve: async () => ['93.184.216.34'],
  get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>ページの本文</p></main></body></html>') }) as PageResponse,
};

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
// 止められるまで返事を始めない
const untilStopped: Script = async function* (req) {
  await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
};

async function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: JudgeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, webNetwork: network, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'a.txt'), 'こんにちは');
  return { app, adapter: () => adapter, paths };
}
type S = Awaited<ReturnType<typeof setup>>;

function send(s: S, text: string, attachments: AttachmentMeta[] = []): string {
  const outcome = s.app.engine.send(C, text, [], attachments);
  assert.ok(outcome.ok && !outcome.queued, JSON.stringify(outcome));
  return outcome.runId;
}
function retry(s: S): string {
  const outcome = s.app.engine.retry(C);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.runId;
}
const next = (s: S, how: 'retry' | 'send') => how === 'retry' ? retry(s) : send(s, '続けて');

// 1 回目の実行: 道具を 1 つ呼んだあと、次の返事を待っているところで止める（最後の発言は道具の結果になる）
async function stopAfterTool(s: S, tool: string, args: unknown, text = '読んで', attachments: AttachmentMeta[] = []): Promise<string> {
  s.adapter().scripts = [call(tool, args), untilStopped];
  const runId = send(s, text, attachments);
  await waitFor(() => s.adapter().calls.length >= 2, '道具のあとの 2 回目の呼び出し');
  s.app.engine.stop(runId);
  await settled(s.app, runId);
  await s.app.engine.wait(runId);
  assert.equal(s.app.conversations.messages(C).at(-1)!.role, 'tool', '前提: 最後の発言は道具の結果');
  return runId;
}

// 次の実行の最初の道具（印に頼らず判定役に回る一覧に無いコマンド）を判定役が見るとき、外から読んだ 1 行が付き、ask の答えで積まれた行に外から読んだ印が残る
async function expectAsked(s: S, runId: string, kind: 'judge' | 'judge_failed' = 'judge'): Promise<void> {
  await settled(s.app, runId);
  await s.app.engine.wait(runId);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.equal(rows.length, 1, '判定役の ask で 1 行積む');
  assert.equal(rows[0]!.kind, kind);
  assert.equal(rows[0]!.tainted, true, '外から読んだ扱いの印');
  if (kind === 'judge_failed') return;
  assert.equal(s.adapter().judged.length, 1);
  assert.ok(judgeTextOf(s.adapter().judged[0]!).includes(TAINTED_NOTE), '判定役に外から読んだ会話だと伝わる');
}
// 確かめなしで書き込みが通る（外から読んだ扱いではない）
async function expectWritten(s: S, runId: string): Promise<void> {
  await settled(s.app, runId);
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0, '確かめは出ない');
  assert.equal(existsSync(join(s.paths.workspace, 'out.txt')), true, '書き込みが通った');
}

test('やり直し: 添付を読んだ実行が、道具を使ったあとで止められても、やり直しは「外から読んだ」扱いのまま（書き込みは確かめが出る）', async t => {
  const s = await setup(t);
  const first = await stopAfterTool(s, 'file_read', { path: 'a.txt' }, '添付を見て', [EVIL]);
  assert.equal(s.app.runs.get(first)!.ok, 0);
  s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
  const runId = retry(s);
  await expectAsked(s, runId);
});

for (const how of ['retry', 'send'] as const) {
  test(`Web を読んだ実行が止められたあとの実行（${how === 'retry' ? 'やり直し' : '次の発言'}）も「外から読んだ」扱いのまま（書き込みは確かめが出る）`, async t => {
    const s = await setup(t);
    const first = await stopAfterTool(s, 'web_fetch', FETCH);
    assert.equal(s.app.runs.get(first)!.tainted, 1, 'Web を読んだ実行は、終わるとき「外から読んだ」印が残る');
    s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
    const runId = next(s, how);
    await expectAsked(s, runId);
  });
}

test('外から読んでいない実行のあとのやり直しは、今までどおり確かめなしで書ける（印は 0）', async t => {
  const s = await setup(t);
  const first = await stopAfterTool(s, 'file_read', { path: 'a.txt' });
  assert.equal(s.app.runs.get(first)!.tainted, 0);
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, retry(s));
});

test('最後まで返事を書いて終わった実行の印は、次の実行に持ち越さない（Web を読んだ実行でも）', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('web_fetch', FETCH), reply('読みました')];
  const first = send(s, 'このページを読んで');
  await settled(s.app, first);
  await s.app.engine.wait(first);
  assert.equal(s.app.runs.get(first)!.ok, 1);
  assert.equal(s.app.runs.get(first)!.tainted, 1, '実行自体は外から読んだ');
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, send(s, 'メモを書いて'));
});

test('印は実行の頭から残る: 外から読んだ実行をやり直して、すぐ止めても、その次のやり直しも「外から読んだ」扱いのまま', async t => {
  const s = await setup(t);
  await stopAfterTool(s, 'web_fetch', FETCH);
  s.adapter().scripts = [untilStopped];
  const second = retry(s);
  await waitFor(() => s.adapter().calls.length >= 3, '2 回目の実行のモデル呼び出し');
  s.app.engine.stop(second);
  await settled(s.app, second);
  await s.app.engine.wait(second);
  assert.equal(s.app.runs.get(second)!.tainted, 1, '引き継いだ印が、この実行にも残る');
  s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
  await expectAsked(s, retry(s));
});

test('前からある実行の記録の道具の上限の印（max_iterations）を持つ実行も、最後の返事ではないので、Web を読んだ印を次の実行に持ち越す', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('web_fetch', FETCH), reply('ここまでやりました。次の一手: 書く')];
  const first = send(s, 'このページを読んで');
  await settled(s.app, first);
  await s.app.engine.wait(first);
  s.app.conversations.db.prepare("UPDATE engine_runs SET flags = '[\"max_iterations\"]' WHERE id = ?").run(first);
  assert.equal(s.app.runs.get(first)!.ok, 1);
  assert.match(s.app.runs.get(first)!.flags, /max_iterations/u);
  assert.equal(s.app.conversations.messages(C).at(-1)!.role, 'assistant', '前提: 最後は道具の呼び出しの付かない assistant の発言');
  s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
  await expectAsked(s, send(s, '続けて'));
});

test('出力の上限で切れた返事で終わった実行も、最後の返事ではないので、Web を読んだ印を次の実行に持ち越す', async t => {
  const s = await setup(t);
  const cut: Script = async function* () { yield { type: 'text', delta: '読みました。次は' }; yield { type: 'done', stop: 'max_tokens' as StopReason }; };
  s.adapter().scripts = [call('web_fetch', FETCH), cut];
  const first = send(s, 'このページを読んで');
  await settled(s.app, first);
  await s.app.engine.wait(first);
  assert.match(s.app.runs.get(first)!.flags, /output_truncated/u);
  s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
  await expectAsked(s, send(s, '続けて'));
});

const ATTACHED: ChatMessage = { role: 'user', content: '添付を見て', attachments: [EVIL] };
const toolTurn = (i: number | string): ChatMessage[] => [
  { role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'file_read', arguments: { path: 'a.txt' } }] },
  { role: 'tool', toolCallId: `t${i}`, name: 'file_read', content: 'こんにちは' },
];
const toolTurns = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => toolTurn(i)).flat();

const HISTORY_ROWS: Array<{ name: string; history: ChatMessage[]; longerThan?: number; then: 'asked' | 'judge_failed' | 'written' }> = [
  { name: '履歴の見方: 道具を呼んだ assistant の発言をまたいで、返事の付いていない添付を数える（実行の記録が無くても）', history: [ATTACHED, ...toolTurn(1)], then: 'asked' },
  { name: '履歴の見方: 返事の付いた添付は数えない。道具を呼んだだけの assistant の発言は返事ではない', history: [ATTACHED, { role: 'assistant', content: '読みました' }, { role: 'user', content: '次はこれ' }, ...toolTurn(1)], then: 'written' },
  { name: '履歴の見方: 読み出せる行数（500）のなかに最後の返事が見つからなければ、添付の有無を確かめきれないので「外から読んだ」扱いにする', history: [ATTACHED, ...toolTurns(260)], longerThan: 500, then: 'judge_failed' },
  {
    name: '履歴の見方: 500 行より長くても、そのなかに最後の返事が見つかれば、その後ろだけを見る（確かめきれない扱いにしない）',
    history: [ATTACHED, { role: 'assistant', content: '読みました' }, ...toolTurns(260), { role: 'assistant', content: 'まとめです' }, { role: 'user', content: 'ありがとう' }], then: 'written',
  },
];

for (const row of HISTORY_ROWS) {
  test(row.name, async t => {
    const s = await setup(t);
    const { conversations } = s.app;
    for (const message of row.history) conversations.append(C, message);
    if (row.longerThan) assert.ok(conversations.messages(C, 1000).length > row.longerThan, `前提: ${row.longerThan} 行より長い`);
    if (row.then === 'written') {
      s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
      await expectWritten(s, retry(s));
    } else {
      s.adapter().scripts = [call('shell_run', PROBE), reply('おわり')];
      await expectAsked(s, retry(s), row.then === 'judge_failed' ? 'judge_failed' : 'judge');
    }
  });
}

test('実行の記録の印は、実行が終わらなくても残る（Runs.markTainted。落ちたあとの起動時の closeDangling で消えない）', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const runs = new Runs(db);
  runs.start('r1', 'chat', 'c1');
  runs.start('r2', 'chat', 'c1');
  assert.equal(runs.get('r1')!.tainted, 0, '既定は 0');
  runs.markTainted('r1');
  assert.equal(runs.closeDangling(), 2);
  assert.equal(runs.get('r1')!.tainted, 1);
  assert.equal(runs.get('r2')!.tainted, 0);
  assert.equal(runs.latestChat('c1')!.id, 'r2', '会話の最後のチャットの実行');
  assert.equal(runs.latestChat('none'), undefined);
  db.close();
});

test('実行の途中で落ちて、起動し直したあとのやり直しも「外から読んだ」扱いのまま（同じデータベースを新しい App で開く）', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const databasePath = join(dir, 'beat.db');
  let adapter!: JudgeAdapter;
  const open = () => new App({ paths, databasePath, log: () => undefined, workerTimers: false, webNetwork: network, adapterOverride: p => (adapter = new JudgeAdapter(p)) });
  const first = open();
  await first.status.probeAll(first.config());
  adapter.scripts = [call('web_fetch', FETCH), untilStopped];
  const sent = first.engine.send(C, 'このページを読んで');
  assert.ok(sent.ok);
  await waitFor(() => adapter.calls.length >= 2, '道具のあとの 2 回目の呼び出し');
  assert.equal((first.db.prepare('SELECT ok, tainted FROM engine_runs').get() as { ok: number | null; tainted: number }).tainted, 1, '終わる前から印が書いてある');
  first.engine.wait(sent.runId)?.catch(() => undefined);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  // 一時フォルダを消す前に DB を閉じる（Windows では開いたままだと消せない）
  const second = open();
  try {
    await second.status.probeAll(second.config());
    assert.deepEqual({ ...(second.db.prepare('SELECT ok, error_kind AS kind, tainted FROM engine_runs').get() as object) }, { ok: 0, kind: 'cancelled', tainted: 1 }, '落ちた実行は中断扱いになっても、印は残る');
    adapter.scripts = [call('shell_run', PROBE), reply('おわり')];
    const retried = second.engine.retry(C);
    assert.ok(retried.ok);
    await settled(second, retried.runId);
    await second.engine.wait(retried.runId);
    const rows = second.pending.list({ status: 'waiting' });
    assert.deepEqual(rows.map(r => [r.kind, r.tainted]), [['judge', true]], '再起動後のやり直しも外から読んだ扱いで積まれる');
    assert.ok(judgeTextOf(adapter.judged[0]!).includes(TAINTED_NOTE));
  } finally { second.close(); await new Promise(resolve => setTimeout(resolve, 50)); }
});
