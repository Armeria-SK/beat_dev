import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { ProviderModelConfig } from '../src/config/schema.ts';
import type { ChatMessage, ThinkingBlock } from '../src/engine/types.ts';
import { anthropicBody } from '../src/providers/anthropic.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { fail, reply } from './helpers.ts';
import { AnthropicCacheSim, totals } from './helpers/cache-sim.ts';
import { MIN, taskApp, talkThenCall, toolCall } from './helpers/task-app.ts';

// TE-4: 送る量が available を超えたら、まず古い道具の結果を短い印に替え、それでも目標（available の 70%）を超えるなら古いやり取りを外して要約する。
// どちらの位置も会話に覚え（kv の cleared-upto / trim-upto）、次に削るまで動かさない

const C = 'c1';
const NOTES = 'line of the notes file\n'.repeat(120);
const NONCE = '0123456789abcdef';
const SPLIT_NONCE = `${NONCE.slice(0, 8)}\u200b${NONCE.slice(8)}`;
const MARKER = /^\[Old result of (\S+) cleared to save space\. Input: ([^\n]*)\]$/u;
type App = Awaited<ReturnType<typeof taskApp>>;
type Json = Record<string, any>;

const withTools = (s: App) => s.adapter().calls.filter(req => req.tools.length > 0);
const summaries = (s: App) => s.adapter().calls.filter(req => req.tools.length === 0);
const toolRows = (req: ModelRequest) => req.messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
const markers = (req: ModelRequest) => toolRows(req).filter(m => MARKER.test(m.content));
const positions = (s: App) => ({
  cleared: s.app.kv.getJson<number>(`cleared-upto:${C}`) ?? 0,
  trim: s.app.kv.getJson<number>(`trim-upto:${C}`) ?? 0,
  summary: s.app.conversations.get(C)?.summary_upto ?? 0,
});
const same = (a: ReturnType<typeof positions>, b: ReturnType<typeof positions>) => a.cleared === b.cleared && a.trim === b.trim && a.summary === b.summary;

async function notesApp(t: { after: (fn: () => void) => void }, contextLength: number, edit?: Parameters<typeof taskApp>[1], notes = NOTES) {
  const s = await taskApp(t, config => { config.models[0]!.contextLength = contextLength; edit?.(config); });
  mkdirSync(s.app.paths.workspace, { recursive: true });
  writeFileSync(join(s.app.paths.workspace, 'notes.txt'), notes);
  return s;
}

// 呼び出し k と k+1 のあいだで削りの位置が動かなければ、k+1 の道具の並び・system・発言の頭は k とバイト単位で同じ。動いた所の数を返す
function assertPrefixStable(requests: ModelRequest[], at: Array<ReturnType<typeof positions>>): number {
  let changes = 0;
  for (let k = 0; k + 1 < requests.length; k++) {
    const [a, b] = [requests[k]!, requests[k + 1]!];
    if (!same(at[k]!, at[k + 1]!)) { changes++; continue; }
    assert.equal(JSON.stringify(b.tools), JSON.stringify(a.tools), `呼び出し ${k + 2}: 道具の並びが同じ`);
    assert.equal(b.system.frozen + b.system.dynamic, a.system.frozen + a.system.dynamic, `呼び出し ${k + 2}: system が同じ`);
    assert.equal(JSON.stringify(b.messages.slice(0, a.messages.length)), JSON.stringify(a.messages), `呼び出し ${k + 2}: 前の呼び出しの発言がそのまま頭にある`);
  }
  return changes;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
function readShare(requests: ModelRequest[], from: number) {
  const sim = new AnthropicCacheSim();
  for (const req of requests) sim.call(anthropicBody(req, { provider: (req.model as ProviderModelConfig).provider, model: req.model.model }) as unknown as Json);
  const part = totals(sim.calls, from);
  return { share: part.readShare, weighted: Math.round(part.calls.reduce((n, c) => n + c.read * 0.1 + c.write * 1.25 + c.input, 0)), calls: part.calls.length };
}

test('場面 (C): 容量 20,000 で 60 往復。削った呼び出しで 1 回だけ形が変わり、次に削るまで前半はバイト単位で同じ。削り始めたあとの読みの割合は 85% 以上', async t => {
  // TE-0 の場面 (C) と同じ会話（40 行のファイル）
  const s = await notesApp(t, 20_000, undefined, 'line of the notes file\n'.repeat(40));
  const at: Array<ReturnType<typeof positions>> = [];
  s.adapter().scripts = Array.from({ length: 400 }, () => async function* (req: ModelRequest) {
    if (req.tools.length === 0) { yield* reply('SUMMARY of the earlier turns')(req); return; }
    at.push(positions(s));
    s.clock.now += MIN;
    yield* (req.messages.at(-1)?.role === 'tool' ? reply('read it') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  for (let turn = 0; turn < 60; turn++) await s.chat(`turn ${turn}: read the notes`, C);
  const requests = withTools(s);
  assert.equal(requests.length, 120, '前提: 1 往復 2 回');
  const first = at.findIndex(p => p.cleared > 0 || p.trim > 0 || p.summary > 0);
  assert.ok(first > 0, '前提: 削りが始まった');
  const changes = assertPrefixStable(requests, at);
  assert.ok(changes >= 1 && changes <= 12, `形が変わったのは削った呼び出しだけ（${changes} 回）`);
  const all = readShare(requests, 1);
  const after = readShare(requests, first);
  // TE-0 の「前」（31d84a49）: 全体 78.5%・重みつき 533,687、最初の要約から 60.6%
  t.diagnostic(`(C) all: calls ${all.calls}, read share ${pct(all.share)}, weighted ${all.weighted}; from the first reduction (call ${first + 1}): calls ${after.calls}, read share ${pct(after.share)}, weighted ${after.weighted}; shape changes ${changes}, summaries ${summaries(s).length}`);
  assert.ok(after.share >= 0.85, `削り始めたあとの読みの割合 ${pct(after.share)} が 85% 以上`);
});

// 1 つの長いやり取り（持ち主の発言 1 つに道具の結果 20 個）。消さなければ ContextOverflow になる大きさ
async function longExchange(t: { after: (fn: () => void) => void }, thinking = false) {
  const s = await notesApp(t, 20_000);
  const at: Array<ReturnType<typeof positions>> = [];
  let calls = 0;
  s.adapter().scripts = Array.from({ length: 30 }, () => async function* (req: ModelRequest) {
    if (req.tools.length === 0) { yield* reply('SUMMARY')(req); return; }
    at.push(positions(s));
    calls++;
    s.clock.now += MIN;
    if (thinking) yield { type: 'thinking' as const, block: { type: 'thinking', thinking: '', signature: `SIG-${calls}`, at: 0, lead: true } as ThinkingBlock };
    yield* (calls > 20 ? reply('done') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('read the notes twenty times', C);
  return { s, requests: withTools(s), at };
}

test('1 つの長いやり取り（結果 20 個）が ContextOverflow にならずに通り、消すだけで足りれば要約を呼ばない。消した時点の新しい 6 つは残る', async t => {
  const { s, requests, at } = await longExchange(t);
  const run = s.app.runs.latestChat(C)!;
  assert.equal(run.ok, 1, `実行が通る（${run.error_kind}: ${run.error_message}）`);
  assert.equal(requests.length, 21, '20 回読んで返事');
  assert.equal(summaries(s).length, 0, '消すだけで足りるので要約の呼び出しは 0 回');
  const firstCleared = requests.findIndex(req => markers(req).length > 0);
  assert.ok(firstCleared > 0, '前提: 古い結果を消した');
  const rows = toolRows(requests[firstCleared]!);
  assert.ok(rows.slice(-6).every(m => m.content.includes('line of the notes file') && !MARKER.test(m.content)), '消した時点の新しい 6 つは元のまま');
  assert.match(rows.at(-7)!.content, MARKER, '7 つ目から前は印');
  assert.ok(assertPrefixStable(requests, at) >= 1, '前提: 形が変わった呼び出しがある');
  const stored = s.app.conversations.messages(C).filter(m => m.message.role === 'tool');
  assert.ok(stored.every(m => m.text.includes('line of the notes file')), 'DB の元の結果は変えない');
});

test('消した会話には history_read が道具の並びに入り（消した呼び出しから）、次の実行でも同じ並び・同じ印で前半が続く', async t => {
  const { s, requests } = await longExchange(t);
  const firstCleared = requests.findIndex(req => markers(req).length > 0);
  assert.ok(firstCleared > 0, '前提: 古い結果を消した');
  const has = (req: ModelRequest) => req.tools.some(tool => tool.name === 'history_read');
  assert.ok(!has(requests[firstCleared - 1]!), '消す前の呼び出しには無い');
  assert.ok(requests.slice(firstCleared).every(has), '消した呼び出しから並びにある');
  assert.ok((s.app.kv.getJson<string[]>(`loaded-tools:${C}`) ?? []).includes('history_read'), '会話の記録に書く');
  const last = requests.at(-1)!;
  s.adapter().scripts = [reply('again')];
  await s.chat('one more thing', C);
  const next = withTools(s).at(-1)!;
  assert.equal(JSON.stringify(next.tools), JSON.stringify(last.tools), '次の実行の道具の並びは前の実行の終わりと同じ');
  assert.equal(next.system.dynamic, last.system.dynamic);
  assert.equal(JSON.stringify(next.messages.slice(0, last.messages.length)), JSON.stringify(last.messages), '次の実行の最初の呼び出しは、前の実行の最後の呼び出しの発言（印も）をそのまま頭に持つ');
});

test('消した会話では考える部分を送り返さない（要約と同じ決まり）', async t => {
  const { requests } = await longExchange(t, true);
  const firstCleared = requests.findIndex(req => markers(req).length > 0);
  assert.ok(firstCleared > 0, '前提: 古い結果を消した');
  assert.ok(requests[firstCleared - 1]!.messages.some(m => m.role === 'assistant' && m.thinking), '前提: 消す前は送り返していた');
  assert.ok(requests.slice(firstCleared).every(req => !req.messages.some(m => m.role === 'assistant' && m.thinking)), '消したあとは送り返さない');
});

test('消した印: 道具の名前・入力の要点・history_read conversation_id / message_id があり、その id で元の全文が読める。read の道具だけ「もう一度呼んで」', async t => {
  const s = await notesApp(t, 20_000);
  let calls = 0;
  let asked: { conversation: string; id: number } | undefined;
  s.adapter().scripts = Array.from({ length: 40 }, () => async function* (req: ModelRequest) {
    calls++;
    s.clock.now += MIN;
    const marker = markers(req)[0]?.content;
    if (marker && !asked) {
      const m = /history_read conversation_id=(\S+) message_id=(\d+)\./u.exec(marker)!;
      asked = { conversation: m[1]!, id: Number(m[2]) };
      yield* toolCall('history_read', { conversation_id: asked.conversation, message_id: asked.id })(req);
      return;
    }
    yield* (asked ? reply('done') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('read the notes until something is cleared', C);
  assert.ok(asked, '前提: 印が送られた');
  const marker = markers(withTools(s).at(-1)!)[0]!.content;
  assert.match(marker, /^\[Old result of file_read cleared to save space\. Input: path=notes\.txt\. Full text: history_read conversation_id=c1 message_id=\d+\. If you need it, call the tool again\.\]$/u);
  const read = s.app.conversations.messages(C).filter(m => m.message.role === 'tool' && m.message.name === 'history_read').at(-1)!;
  const original = s.app.conversations.messages(C).find(m => m.id === asked!.id)!;
  assert.equal(original.message.role, 'tool');
  assert.ok(original.text.includes('line of the notes file'), '前提: DB の元の結果');
  assert.ok(read.message.role === 'tool' && read.message.content.includes(original.text.slice(0, 2000)), 'その id で元の全文が読める');
});

// 保存した会話に、書く道具と読む道具の呼び出しと長い結果を置き、消す位置を決めてから 1 回送る（印の文だけを確かめる）
async function seeded(t: { after: (fn: () => void) => void }, args: unknown, result?: (outputs: string, path: string) => string) {
  const s = await taskApp(t);
  const nonce = NONCE;
  s.app.kv.set(`fence:${C}`, nonce);
  const outputs = join(s.app.paths.data, 'tool_outputs');
  const path = join(outputs, 'shell-abc.log');
  const long = result ? result(outputs, path) : `${'output line\n'.repeat(300)}[Full output: ${path}]`;
  const ap = (m: ChatMessage) => s.app.conversations.append(C, m);
  ap({ role: 'user', content: 'do things' });
  ap({ role: 'assistant', content: '', toolCalls: [{ id: 'w1', name: 'file_write', arguments: args }, { id: 'r1', name: 'file_read', arguments: { path: 'notes.txt' } }] });
  ap({ role: 'tool', toolCallId: 'w1', name: 'file_write', content: long, images: [{ mediaType: 'image/png', data: 'AAAA' }] });
  const last = ap({ role: 'tool', toolCallId: 'r1', name: 'file_read', content: `notes ${nonce} ${SPLIT_NONCE} ${'x'.repeat(3000)}` });
  ap({ role: 'assistant', content: 'done' });
  s.app.kv.setJson(`cleared-upto:${C}`, last.id);
  s.adapter().scripts = [reply('ok')];
  await s.chat('next', C);
  const req = withTools(s).at(-1)!;
  const [write, read] = toolRows(req);
  return { s, nonce, path, write: write!, read: read!, req };
}

test('消した印: 書く道具には「もう一度」を書かない。入力の秘密と会話の印（nonce）は出ない。全文のファイルの場所を書き、画像は外す。DB は元のまま', async t => {
  const secret = `ghp_${'A1b2C3d4'.repeat(4)}`;
  const { s, nonce, path, write, read } = await seeded(t, { path: 'a.txt', content: `${SPLIT_NONCE} token ${secret} and ${NONCE} and ${NONCE.toUpperCase()}` });
  assert.match(write.content, /^\[Old result of file_write cleared to save space\. Input: path=a\.txt, content=/u);
  assert.ok(!write.content.includes('call the tool again'), '書く道具はやり直しを勧めない');
  assert.ok(read.content.includes('call the tool again'), '読む道具は勧める');
  for (const row of [write, read]) {
    assert.ok(!row.content.includes(secret) && !row.content.includes('A1b2C3d4'), '秘密は印に出ない');
    assert.ok(!row.content.toLowerCase().includes(nonce), '会話の印（nonce）は印に出ない');
  }
  assert.ok(write.content.includes(`Full output file: ${path}.`), '全文のファイルの場所');
  assert.equal(write.images, undefined, '画像は外す');
  assert.equal(write.toolCallId, 'w1', '呼び出しとの組はそのまま');
  const stored = s.app.conversations.messages(C).find(m => m.message.role === 'tool' && m.message.toolCallId === 'w1')!;
  assert.ok(stored.message.role === 'tool' && stored.message.content.startsWith('output line') && stored.message.images?.length === 1, 'DB は元のまま');
});

test('入力の要点は JSON のまま伏せてから 1 行にして、もう一度伏せる: 鍵の名前の値・幅の無い文字で割った鍵は印に出ない', async t => {
  const token = `ghp_${'A1b2C3d4'.repeat(4)}`;
  const shapes: Array<[unknown, string]> = [
    [{ path: 'a.txt', password: 'hunter2 second-half' }, 'second-half'],
    [{ path: 'a.txt', api_key: 'abc,def-rest' }, 'def-rest'],
    [{ path: 'a.txt', env: { TOKEN: 'tok"en-rest' } }, 'en-rest'],
    [{ path: 'a.txt', content: `use ${token.slice(0, 12)}\u200b${token.slice(12)} now` }, 'C3d4'],
    [{ path: 'a.txt', content: `${' '.repeat(617)}ghp_${'A1b2C3d4'.repeat(5)} rest` }, 'A1b2C3d4'],
    [{ path: 'a.txt', content: `${'\u200b'.repeat(620)}ghp_${'A1b2C3d4'.repeat(5)} rest` }, 'A1b2C3d4'],
    [{ path: 'a.txt', content: `${'\n'.repeat(600)}https://${'Tk9xQ7wZ'.repeat(4)}@example.com/repo.git` }, 'Tk9xQ7wZ'],
    [{ path: 'a.txt', ['pass\u200bword']: 'hunter2 second-half' }, 'second-half'],
  ];
  const leaked: string[] = [];
  for (const [args, leak] of shapes) {
    const { write } = await seeded(t, args);
    assert.ok(write.content.startsWith('[Old result of file_write'), '前提: 印に替えた');
    if (write.content.includes(leak)) leaked.push(write.content);
  }
  assert.deepEqual(leaked, [], '秘密が印に出ない');
});

test('全文のファイルの場所は、結果の最後の注記で tool_outputs の中に留まるものだけ（結果の文が装った場所は書かない）', async t => {
  const outside = await seeded(t, { path: 'a.txt' }, outputs => `${'output line\n'.repeat(300)}[Full output: ${[outputs, '..', 'config.json'].join(sep)}]`);
  assert.ok(!outside.write.content.includes('Full output file'), `外へ出る場所は書かない: ${outside.write.content}`);
  const forged = await seeded(t, { path: 'a.txt' }, (outputs, path) => `see ${[outputs, '..', '..', 'x.txt'].join(sep)}\n${'output line\n'.repeat(300)}[Full output: ${path}]`);
  assert.ok(forged.write.content.includes(`Full output file: ${forged.path}.`), `最後の本物の注記を書く: ${forged.write.content}`);
});

test('入力の要点は保存した入力から作って伏せる（長い入力は 1 行に切る）', async t => {
  const { write } = await seeded(t, { path: 'a.txt', content: `first line\nsecond ${'y'.repeat(400)}` });
  const input = MARKER.exec(write.content)![2]!;
  assert.ok(!input.includes('\n'), '1 行');
  assert.ok(input.length < 400, `短い（${input.length} 字）`);
});

test('子の担当（agent）の実行の印には history_read の場所を書かない（子は使えない）', async t => {
  const s = await notesApp(t, 20_000, config => { config.tools.agent.enabled = true; config.tools.policies = { agent_run: 'allow' }; });
  let child = 0;
  const isChild = (req: ModelRequest) => req.messages[0]?.role === 'user' && req.messages[0].content.startsWith('You are a sub-agent');
  s.adapter().scripts = Array.from({ length: 40 }, (_, i) => async function* (req: ModelRequest) {
    if (i === 0) { yield* toolCall('agent_run', { task: 'read the notes many times' })(req); return; }
    if (isChild(req)) { child++; yield* (child > 20 ? reply('child done') : toolCall('file_read', { path: 'notes.txt' }))(req); return; }
    yield* reply('parent done')(req);
  });
  await s.chat('delegate it', C);
  const childReqs = s.adapter().calls.filter(isChild);
  const cleared = childReqs.flatMap(markers);
  assert.ok(cleared.length > 0, '前提: 子の実行で古い結果を消した');
  assert.ok(cleared.every(m => !m.content.includes('history_read')), '場所を書かない');
  assert.ok(cleared.every(m => m.content.includes('Input: path=notes.txt') && m.content.includes('call the tool again')), '名前・入力・やり直しは書く');
});

// 前の実行で読んだ結果（証拠の札つき）が積もったタスクの会話で、次の実行を始める（タスクは 1 つのやり取りが大きくなると区切るので、積もった会話から始める）。
// 台本は、印に元を読む口があれば、その口で元を読む
async function notesTask(t: { after: (fn: () => void) => void }) {
  const s = await notesApp(t, 20_000);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const conversation = s.app.conversations.create({ kind: 'task' });
  s.app.db.prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(conversation.id, task.id);
  const ap = (m: ChatMessage) => s.app.conversations.append(conversation.id, m);
  ap({ role: 'user', content: 'read the notes' });
  for (let i = 0; i < 20; i++) {
    ap({ role: 'assistant', content: '', toolCalls: [{ id: `n${i}`, name: 'file_read', arguments: { path: 'notes.txt' } }] });
    ap({ role: 'tool', toolCallId: `n${i}`, name: 'file_read', content: `${'line of the notes file\n'.repeat(100)}\n[E-${i + 1}]` });
  }
  ap({ role: 'assistant', content: 'read them' });
  const cleared = (req: ModelRequest) => toolRows(req).filter(m => m.content.startsWith('[Old result of '));
  let done = false;
  s.adapter().scripts = Array.from({ length: 10 }, () => async function* (req: ModelRequest) {
    s.clock.now += MIN;
    const marker = cleared(req)[0]?.content;
    const m = marker && /history_read conversation_id=(\S+) message_id=(\d+)\./u.exec(marker);
    if (m && !done) { done = true; yield* toolCall('history_read', { conversation_id: m[1], message_id: Number(m[2]) })(req); return; }
    yield* reply('done')(req);
  });
  const started = s.app.engine.runTask(task, conversation.id, 'read the notes until something is cleared');
  assert.ok(started.ok);
  await started.done;
  return { s, runId: started.runId, cleared };
}

test('タスクの実行の印には history_read の口を書かず（自分の会話を読むと「外から読んだ」が付くため）、実行は外から読んだにならない。証拠の札 [E-n] は印に残す', async t => {
  const { s, runId, cleared } = await notesTask(t);
  const rows = withTools(s).flatMap(cleared);
  assert.ok(rows.length > 0, '前提: タスクの実行で古い結果を消した');
  assert.ok(rows.every(m => !m.content.includes('history_read')), '口を書かない');
  assert.ok(rows.every(m => /^\[Old result of file_read cleared to save space\. Input: path=notes\.txt\.[^\n]*call the tool again\.\]\n\[E-\d+\]$/u.test(m.content)), `札を残す: ${rows[0]!.content}`);
  assert.equal(s.app.runs.get(runId)!.tainted, 0, '外から読んだにならない');
});

test('持ち主が history_read を止めた会話では、印に元を読む口を書かない（届かない道具を指さない）', async t => {
  const s = await notesApp(t, 20_000, config => { config.tools.policies = { history_read: 'block' }; });
  s.adapter().scripts = Array.from({ length: 40 }, () => async function* (req: ModelRequest) {
    s.clock.now += MIN;
    yield* (markers(req).length ? reply('done') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('read the notes until something is cleared', C);
  const rows = withTools(s).flatMap(markers);
  assert.ok(rows.length > 0, '前提: 古い結果を消した');
  assert.ok(rows.every(m => !m.content.includes('history_read') && m.content.includes('call the tool again')), `口を書かない: ${rows[0]!.content}`);
});

test('TE-6 の sentCalls: 印に替えた結果の呼び出しは「いま送っている結果」に入らず、残した結果は入る。消したあとに同じファイルを読み直すと全文が返る', async t => {
  const s = await notesApp(t, 20_000);
  const read = s.app.tools.get('file_read')!;
  const original = read.execute.bind(read);
  const seen: Array<{ gone: string[]; kept: string[]; sent: string[] }> = [];
  t.mock.method(read, 'execute', async (input: never, ctx: Parameters<typeof read.execute>[1], ...rest: unknown[]) => {
    const req = withTools(s).at(-1)!;
    seen.push({ gone: markers(req).map(m => m.toolCallId), kept: toolRows(req).filter(m => !MARKER.test(m.content)).map(m => m.toolCallId), sent: [...(ctx.sentCalls?.() ?? [])] });
    return (original as (...a: unknown[]) => ReturnType<typeof read.execute>)(input, ctx, ...rest);
  });
  let after = 0;
  s.adapter().scripts = Array.from({ length: 40 }, () => async function* (req: ModelRequest) {
    s.clock.now += MIN;
    if (markers(req).length) after++;
    yield* (after > 1 ? reply('done') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('read the notes until something is cleared', C);
  assert.ok(seen.some(x => x.gone.length > 0), '前提: 消したあとに読んだ');
  for (const { gone, kept, sent } of seen) {
    assert.ok(gone.every(id => !sent.includes(id)), '印に替えた結果は入らない');
    assert.ok(kept.every(id => sent.includes(id)), '残した結果は入る');
  }
  const reread = s.app.conversations.messages(C).filter(m => m.message.role === 'tool' && m.message.name === 'file_read').at(-1)!;
  assert.equal(reread.text.split('line of the notes file').length - 1, 120, '読み直しは全文');
});

// 文を書いてから道具を呼ぶ長い実行（道具の結果を消すだけでは目標に届かず、古いやり取りを外す）
async function talkingRun(t: { after: (fn: () => void) => void }, summary: (req: ModelRequest) => ReturnType<typeof reply>) {
  const s = await notesApp(t, 20_000);
  const at: Array<ReturnType<typeof positions>> = [];
  let calls = 0;
  s.adapter().scripts = Array.from({ length: 60 }, () => async function* (req: ModelRequest) {
    if (req.tools.length === 0) { yield* summary(req)(req); return; }
    at.push(positions(s));
    calls++;
    s.clock.now += MIN;
    if (calls % 4 === 0) s.app.engine.addNote(C, `note ${calls}`, false);
    yield* (calls > 24 ? reply('done') : talkThenCall('Thinking it through step by step. '.repeat(40), 'file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('work through it', C);
  return { s, requests: withTools(s), at };
}

test('消すだけで目標に届かなければ、古いやり取りを目標まで外して要約する。位置は次に削るまで動かない', async t => {
  const { s, requests, at } = await talkingRun(t, () => reply('SUMMARY'));
  assert.ok(summaries(s).length > 0, '要約を頼んだ');
  assert.ok(positions(s).trim > 0 && positions(s).summary === positions(s).trim, '外した位置まで要約した');
  assertPrefixStable(requests, at);
});

test('要約に失敗しても外した位置は覚え、次の呼び出し・次の実行で外した発言は戻らない', async t => {
  const { s, requests, at } = await talkingRun(t, () => reply(''));
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), '前提: 要約せずに外した');
  const { trim, summary } = positions(s);
  assert.ok(trim > 0 && summary === 0, '前提: 外した位置を覚えた（要約は無い）');
  assertPrefixStable(requests, at);
  const gone = s.app.conversations.messages(C).filter(m => m.id <= trim && m.message.role === 'user').map(m => m.message.content);
  s.adapter().scripts = [reply('next run')];
  await s.chat('continue', C);
  const next = withTools(s).at(-1)!;
  assert.ok(gone.length > 0 && next.messages.every(m => m.role !== 'user' || !gone.includes(m.content)), '外した発言は次の実行でも送らない');
});

test('外した発言が 4 つ未満でも、外したなら要約を頼む（黙って捨てない）', async t => {
  const s = await taskApp(t, config => { config.models[0]!.contextLength = 20_000; });
  s.adapter().scripts = [reply('x'.repeat(70_000))];
  await s.chat('write a lot', C);
  s.adapter().scripts = [reply('SUMMARY'), reply('short')];
  await s.chat('now something short', C);
  assert.equal(summaries(s).length, 1, '外した 2 つの発言を要約した');
  assert.match(s.app.conversations.get(C)!.summary!, /^## Request and goal\nSUMMARY\n/u, '見出しの無い返事は最初の節に入る（TE-5）');
  assert.ok(s.events.some(e => e.type === 'compaction'));
});

test('結果の無い呼び出し（落ちた実行の残り。送るときに closeToolCalls が閉じる）があっても、消した印は呼び出しと組のまま', async t => {
  const { s } = await longExchange(t);
  s.app.conversations.append(C, { role: 'assistant', content: '', toolCalls: [{ id: 'dangle', name: 'file_read', arguments: { path: 'notes.txt' } }] });
  s.adapter().scripts = [fail(new Error('boom')), reply('back')];
  await s.chat('this one fails', C);
  await s.chat('after the failure', C);
  const last = withTools(s).at(-1)!;
  assert.ok(markers(last).length > 0, '前提: 印を送った');
  const closed = toolRows(last).find(m => m.toolCallId === 'dangle')!;
  assert.ok(closed && closed.isError && !MARKER.test(closed.content), '結果の無い呼び出しは「動かしていない」の行で閉じる');
  for (const req of withTools(s)) {
    const open = new Set<string>();
    for (const m of req.messages) {
      if (m.role === 'assistant') for (const call of m.toolCalls ?? []) open.add(call.id);
      if (m.role === 'tool') assert.ok(open.delete(m.toolCallId), `結果 ${m.toolCallId} の前に呼び出しがある`);
    }
    assert.equal(open.size, 0, 'どの呼び出しにも結果がある');
  }
});

test('1 つの長いやり取りで、消して減る量が下限（clearFloor）未満でも、消せば入るなら消して通す（ContextOverflow で止めない）', async t => {
  const s = await taskApp(t, config => { config.models[0]!.contextLength = 20_000; });
  const results = 9;
  // 持ち主の発言 1 つと、呼び出し 9 つと 1,200 字の結果 9 つ（1 つのやり取り）。持ち主の発言の長さで、全体を available の少し上に合わせる
  const seed = (pad: number) => {
    s.app.conversations.append(C, { role: 'user', content: `read all of these ${'p'.repeat(pad)}` });
    s.app.conversations.append(C, { role: 'assistant', content: '', toolCalls: Array.from({ length: results }, (_, i) => ({ id: `r${i}`, name: 'file_read', arguments: { path: `f${i}.txt` } })) });
    for (let i = 0; i < results; i++) s.app.conversations.append(C, { role: 'tool', toolCallId: `r${i}`, name: 'file_read', content: `result ${i} ${'z'.repeat(1200)}` });
  };
  const probe = await taskApp(t, config => { config.models[0]!.contextLength = 20_000; });
  const usage = (pad: number) => {
    const conv = `probe-${pad}`;
    probe.app.conversations.append(conv, { role: 'user', content: `read all of these ${'p'.repeat(pad)}` });
    probe.app.conversations.append(conv, { role: 'assistant', content: '', toolCalls: Array.from({ length: results }, (_, i) => ({ id: `r${i}`, name: 'file_read', arguments: { path: `f${i}.txt` } })) });
    for (let i = 0; i < results; i++) probe.app.conversations.append(conv, { role: 'tool', toolCallId: `r${i}`, name: 'file_read', content: `result ${i} ${'z'.repeat(1200)}` });
    const u = probe.app.engine.contextUsage(conv);
    assert.ok(u.ok);
    return u;
  };
  const a = usage(0);
  const b = usage(20_000);
  const perChar = (b.tokens - a.tokens) / 20_000;
  const pad = Math.ceil((a.available + 250 - a.tokens) / perChar);
  seed(pad);
  s.adapter().scripts = [reply('ok')];
  // 新しい発言を足さずに続ける（やり直し）: 送るのは 1 つのやり取りだけで、古いやり取りを外す余地が無い
  const before = s.app.engine.contextUsage(C);
  assert.ok(before.ok && before.tokens > before.available, `前提: available を超える（${before.ok && before.tokens} / ${before.ok && before.available}）`);
  const outcome = s.app.engine.retry(C);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  await s.app.engine.wait(outcome.runId);
  const run = s.app.runs.get(outcome.runId)!;
  assert.equal(run.ok, 1, `通る（${run.error_kind}: ${run.error_message}）`);
  const req = withTools(s).at(-1)!;
  assert.equal(markers(req).length, results - KEEP, '古い結果を消した');
  assert.equal(summaries(s).length, 0, '要約は呼ばない');
});
const KEEP = 6;

test('削りの位置が動かなくても固まらない: 1 回の呼び出しで削りをやり直せる回数を超えたら、誤りとログの行で実行を終える', { timeout: 60_000 }, async t => {
  const s = await taskApp(t, config => { config.models[0]!.contextLength = 20_000; });
  for (let i = 0; i < 8; i++) {
    s.app.conversations.append(C, { role: 'user', content: `question ${i} ${'q'.repeat(6000)}` });
    s.app.conversations.append(C, { role: 'assistant', content: `answer ${i} ${'a'.repeat(6000)}` });
  }
  // 外した位置（trim-upto）を書いても読めない（位置が動かない）ようにする。要約は失敗させる（要約の位置も動かない）
  const kv = s.app.kv;
  const original = kv.getJson.bind(kv);
  kv.getJson = (<T>(key: string): T | undefined => (key.startsWith('trim-upto:') ? undefined : original<T>(key))) as typeof kv.getJson;
  s.adapter().scripts = Array.from({ length: 30 }, () => reply(''));
  const outcome = s.app.engine.send(C, 'next');
  assert.ok(outcome.ok, JSON.stringify(outcome));
  await s.app.engine.wait(outcome.runId);
  const run = s.app.runs.get(outcome.runId)!;
  assert.equal(run.ok, 0, '誤りで終える');
  assert.equal(run.error_kind, 'context_overflow');
  assert.match(run.error_message ?? '', /did not converge \(10 tries\)/u);
  assert.ok(s.logs.some(line => line.startsWith('[ERROR]') && line.includes('did not converge after 10 tries')), 'ログの行');
});
