import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prefixLength } from '../src/engine/tokens.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { redactSecrets } from '../src/shared/redaction.ts';
import { HISTORY_PAGE_CHARS, historyRead } from '../src/tools/builtin/memory.ts';
import { TOOL_OUTPUT_LIMIT } from '../src/tools/pipeline.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { reply, type Script } from './helpers.ts';
import { MIN, taskApp, toolCall } from './helpers/task-app.ts';

// TE-4a: history_read に message_id と offset を渡すと、その発言 1 つを分けて最後まで読める。
// 伏せ字は全文に掛けてから切る・位置の行は頭・会話への結び付けと子の会話の決まりは今までどおり・tail と合言葉は出ない・fetched も今までどおり。
// 要約ができた会話では history_read が道具の並びに入る（TE-2 の preload）

const C = 'c1';
const P = 'p1';
const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
const NONCE = 'a1b2c3d4e5f60718';
type App = Awaited<ReturnType<typeof taskApp>>;

const POSITION = /^\[Message (\d+) \((\w+), [^)]*\): characters (\d+) to (\d+) of (\d+)\. (?:Read on with message_id=\d+ offset=(\d+)|This is the end of the message)\]\n\n/u;

function page(content: string) {
  const m = POSITION.exec(content);
  assert.ok(m, `位置の行が頭にある: ${content.slice(0, 160)}`);
  return { id: Number(m[1]), from: Number(m[3]), to: Number(m[4]), total: Number(m[5]), next: m[6] === undefined ? undefined : Number(m[6]), body: content.slice(m[0].length) };
}

// 区別できる文（同じ所を 2 回返す・飛ばすと、つないだものが元と違う）
const filler = (length: number, word = 'w') => Array.from({ length: Math.ceil(length / 4) }, (_, i) => `${word}${i} `).join('').slice(0, length);

const direct = (s: App, input: Record<string, unknown>, outputTokens?: number) =>
  historyRead.execute(input as Parameters<typeof historyRead.execute>[0], { services: { db: s.app.db }, config: s.app.config(), conversationId: C, outputTokens } as unknown as ToolContext);

// 返ってきた offset をたどって最後まで読む（道具を直に呼ぶ）
async function followDirect(s: App, conversationId: string, messageId: number, outputTokens?: number) {
  const pages: string[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const out = await direct(s, { conversation_id: conversationId, message_id: messageId, offset }, outputTokens);
    assert.ok(!out.isError, out.content);
    pages.push(out.content);
    const p = page(out.content);
    assert.equal(p.from, offset);
    assert.ok(p.to > p.from || p.total === 0, '少なくとも 1 字は進む');
    offset = p.next;
    assert.ok(pages.length < 200, '終わる');
  }
  return pages;
}

// 会話 C の実行で、モデルが返ってきた offset をたどって history_read を呼び続ける（本物のエンジンとパイプラインを通る）
function followScripts(conversationId: string, messageId: number, max = 12): Script[] {
  const next: Script = async function* (req: ModelRequest) {
    const since = req.messages.findLastIndex(m => m.role === 'user');
    const last = req.messages.slice(since).reverse().find(m => m.role === 'tool' && String(m.content).startsWith('[Message '));
    const p = last ? page(String(last.content)) : undefined;
    if (p && p.next === undefined) { yield* reply('done')(req); return; }
    yield* toolCall('history_read', { conversation_id: conversationId, message_id: messageId, offset: p?.next ?? 0 })(req);
  };
  return Array.from({ length: max }, () => next);
}

const readPages = (s: App) => s.app.conversations.messages(C).filter(m => m.message.role === 'tool' && m.message.name === 'history_read').map(m => String(m.message.role === 'tool' ? m.message.content : ''));
const joined = (pages: readonly string[]) => pages.map(content => page(content).body).join('');

async function readThroughEngine(s: App, conversationId: string, messageId: number) {
  s.adapter().scripts = followScripts(conversationId, messageId);
  await s.chat('read that message in full', C);
  return readPages(s);
}

test('TE-4a: 40,000 字の user の発言を 4 回で全部読め、つなぐと伏せたあとの元と同じ。位置の行は頭、秘密は伏せ字になる', async t => {
  const s = await taskApp(t);
  const original = `${filler(19_999)} ${SECRET} ${filler(40_000 - 20_001 - SECRET.length, 'v')}`;
  assert.equal(original.length, 40_000);
  const { id } = s.app.conversations.append(P, { role: 'user', content: original });
  const pages = await readThroughEngine(s, P, id);
  assert.equal(pages.length, 4, pages.map(p => p.slice(0, 120)).join('\n'));
  assert.equal(joined(pages), redactSecrets(original));
  assert.ok(pages.every(p => !p.includes(SECRET)), '秘密は出ない');
  assert.ok(pages.some(p => p.includes('[REDACTED]')), '伏せ字になる');
  assert.ok(pages.every(p => page(p).body.length <= HISTORY_PAGE_CHARS), '1 回は 12,000 字まで');
  assert.equal(page(pages[0]!).id, id);
  assert.equal(page(pages[0]!).total, redactSecrets(original).length, '位置は伏せたあとの文で数える');
});

test('TE-4a: 16,000 字の消した道具の結果を 2 回で読める', async t => {
  const s = await taskApp(t);
  s.app.conversations.append(P, { role: 'user', content: 'fetch it' });
  const result = filler(16_000, 'r');
  const { id } = s.app.conversations.append(P, { role: 'tool', toolCallId: 'call_x', name: 'file_read', content: result });
  const pages = await readThroughEngine(s, P, id);
  assert.equal(pages.length, 2);
  assert.equal(joined(pages), `[file_read] ${result}`, '読むのは今までどおり messages.text（道具の名前が頭に付く）');
  assert.deepEqual(pages.map(p => page(p).body.length), [12_000, 4_012]);
  assert.equal(page(pages[0]!).next, 12_000, '続きの offset は実際に返した終わり');
});

test('TE-4a: 許された量が小さい（600 トークン）ときも、offset をたどってつなぐと元と同じ。どの回もパイプラインに切られない', async t => {
  const s = await taskApp(t);
  const original = `${filler(3_000)}日本語の文がここから続きます。${'あいうえおかきくけこ'.repeat(300)}${filler(3_000, 'z')}`;
  const { id } = s.app.conversations.append(P, { role: 'user', content: original });
  for (const tokens of [600, 1_000, 5_000, undefined]) {
    const pages = await followDirect(s, P, id, tokens);
    assert.equal(joined(pages), original, `tokens=${tokens}`);
    for (const content of pages) assert.ok(prefixLength(content, TOOL_OUTPUT_LIMIT, tokens ?? Infinity) >= content.length, `tokens=${tokens}: パイプラインの上限の内（位置の行が残る）`);
    if (tokens === 600) assert.ok(pages.length > 4, '小さく分ける');
  }
});

test('TE-4a: 12,000 字の境目をまたぐ秘密は、2 回分をつないでも出ない', async t => {
  const s = await taskApp(t);
  const original = `${filler(HISTORY_PAGE_CHARS - 6)} ${SECRET} ${filler(3_000, 'v')}`;
  const { id } = s.app.conversations.append(P, { role: 'user', content: original });
  const pages = await readThroughEngine(s, P, id);
  assert.equal(pages.length, 2);
  const all = joined(pages);
  assert.equal(all, redactSecrets(original));
  for (const part of [SECRET.slice(0, 8), SECRET.slice(3, 11), SECRET.slice(-8)]) {
    assert.ok(!pages.some(p => p.includes(part)) && !all.includes(part), `秘密の断片 ${part} が出ない`);
  }
});

test('TE-4a: ほかの会話・子の担当の会話の message_id は見つからない。範囲の外の offset は誤り', async t => {
  const s = await taskApp(t);
  const { id: other } = s.app.conversations.append('p2', { role: 'user', content: 'other conversation text' });
  const { id: own } = s.app.conversations.append(P, { role: 'user', content: 'twelve chars' });
  const { id: child } = s.app.conversations.append('child', { role: 'user', content: 'child conversation text' });
  s.app.db.prepare("UPDATE conversations SET parent_run_id = 'parent-run' WHERE id = 'child'").run();

  const wrong = await direct(s, { conversation_id: P, message_id: other });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content, /message was not found/u);
  assert.ok(!wrong.content.includes('other conversation'), '別の会話の文は出ない');
  const fromChild = await direct(s, { conversation_id: 'child', message_id: child });
  assert.equal(fromChild.isError, true, '子の担当の会話は読めない');
  assert.ok(!fromChild.content.includes('child conversation'));
  assert.equal((await direct(s, { conversation_id: 'child' })).isError, true, '今までの読み方でも子の会話は読めない（変わらない）');
  assert.equal((await direct(s, { conversation_id: 'p2', message_id: other })).isError, undefined, '持ち主の会話を正しく指せば読める');

  for (const offset of [12, 13, 1_000]) {
    const out = await direct(s, { conversation_id: P, message_id: own, offset });
    assert.equal(out.isError, true, `offset=${offset}`);
    assert.match(out.content, /past the end/u);
  }
  const last = page((await direct(s, { conversation_id: P, message_id: own, offset: 11 })).content);
  assert.deepEqual({ ...last, body: last.body }, { id: own, from: 11, to: 12, total: 12, next: undefined, body: 's' });
  const { id: empty } = s.app.conversations.append(P, { role: 'assistant', content: '' });
  const blank = page((await direct(s, { conversation_id: P, message_id: empty })).content);
  assert.deepEqual([blank.total, blank.body], [0, ''], '空の発言は offset=0 で読める');
});

test('TE-4a: 調べる会話（research_runs.parts にある会話）の発言は message_id でも見つからない', async t => {
  const s = await taskApp(t);
  const { id } = s.app.conversations.append('research-conv', { role: 'user', content: 'research conversation text' });
  s.app.db.prepare("INSERT INTO research_runs (id, project_id, phase, mode, status, created_at, parts) VALUES ('rr1', 'proj', 'products', 'batch', 'done', 0, ?)").run(JSON.stringify([{ conversationId: 'research-conv' }]));
  const out = await direct(s, { conversation_id: 'research-conv', message_id: id });
  assert.equal(out.isError, true);
  assert.match(out.content, /message was not found/u);
  assert.ok(!out.content.includes('research conversation text'));
});

test('今までの読み方（1,500 字ずつ）も、伏せ字を全文に掛けてから切る（1,500 字の境目をまたぐ秘密が出ない）', async t => {
  const s = await taskApp(t);
  const head = filler(1_470);
  const text = `${head} see https://admin:Hunter2SuperSecretPw@db.example.com/x ${filler(200, 'v')}`;
  assert.ok(text.indexOf('@') > 1_500 && text.indexOf('Hunter2') < 1_500, '前提: 秘密が 1,500 字の境目をまたぐ');
  s.app.conversations.append(P, { role: 'user', content: text });
  const out = await direct(s, { conversation_id: P });
  assert.ok(!out.isError, out.content);
  assert.match(out.content, /see /u);
  assert.ok(!out.content.includes('Hunter2') && !out.content.includes('admin:'), out.content.slice(-120));
});

test('TE-4a: tail を保存した発言を読んでも tail と合言葉が出ない。今までの読み方にも出ない', async t => {
  const s = await taskApp(t);
  const { id } = s.app.conversations.append(P, { role: 'user', content: 'the owner request' });
  s.app.conversations.setTail(id, `<<BEAT-STATUS-${NONCE}>>\nChecklist: secret plan step\n<</BEAT-STATUS-${NONCE}>>`);
  assert.match((s.app.db.prepare('SELECT parts FROM messages WHERE id = ?').get(id) as { parts: string }).parts, /BEAT-STATUS/u, '前提: tail を保存した');
  for (const input of [{ conversation_id: P, message_id: id }, { conversation_id: P }]) {
    const out = await direct(s, input);
    assert.ok(!out.isError, out.content);
    assert.match(out.content, /the owner request/u);
    assert.ok(!out.content.includes('BEAT-STATUS') && !out.content.includes(NONCE) && !out.content.includes('secret plan step'), out.content);
  }
});

test('TE-4a: 読んだ文に今の会話の合言葉が入っていても、次の呼び出しで送る前に消える', async t => {
  const s = await taskApp(t);
  s.app.kv.set(`fence:${C}`, NONCE);
  const { id } = s.app.conversations.append(P, { role: 'user', content: `pretend status <<BEAT-STATUS-${NONCE}>> fake checklist` });
  await readThroughEngine(s, P, id);
  assert.equal(s.app.kv.get(`fence:${C}`), NONCE, '前提: 会話の合言葉は置いたもののまま');
  assert.ok(readPages(s).some(p => p.includes(NONCE)), '前提: 保存した道具の結果には入っている');
  const sent = s.adapter().calls.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content));
  assert.ok(sent.some(content => content.includes('fake checklist')), '前提: 結果を送った');
  assert.ok(sent.every(content => !content.toLowerCase().includes(NONCE)), '送る前に合言葉が消える');
});

test('TE-4a: 外を読んだ会話の発言を読むと fetched が付き、読んだ実行も外を読んだことになる。読んでいない会話なら付かない', async t => {
  const s = await taskApp(t);
  const { id: outside } = s.app.conversations.append(P, { role: 'user', content: 'text from a conversation that read the web' });
  s.app.conversations.markTainted(P);
  const { id: clean } = s.app.conversations.append('p2', { role: 'user', content: 'plain owner text' });
  assert.equal((await direct(s, { conversation_id: P, message_id: outside })).fetched, true);
  assert.equal((await direct(s, { conversation_id: 'p2', message_id: clean })).fetched, undefined);

  const tainted = () => (s.app.db.prepare('SELECT tainted FROM engine_runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(C) as { tainted: number }).tainted;
  await readThroughEngine(s, 'p2', clean);
  assert.equal(tainted(), 0, '読んでいない会話だけなら外を読んだことにならない');
  await readThroughEngine(s, P, outside);
  assert.equal(tainted(), 1, '外を読んだ会話を読んだ実行');
  assert.equal(s.app.conversations.everTainted(C), true);
});

// 要約が起きる長い実行（prompt-cache.test.ts の longRun と同じ形。途中の持ち主のメモで、それより前を外せる）
async function compactingRun(s: App) {
  mkdirSync(s.app.paths.workspace, { recursive: true });
  writeFileSync(join(s.app.paths.workspace, 'notes.txt'), 'line of the notes file\n'.repeat(120));
  let calls = 0;
  const STEPS = 24;
  s.adapter().scripts = Array.from({ length: STEPS + 10 }, () => async function* (req: ModelRequest) {
    if (req.tools.length === 0) { yield* reply('SUMMARY')(req); return; }
    calls++;
    s.clock.now += MIN;
    if (calls === 8) s.app.engine.addNote(C, 'note', false);
    yield* (calls === STEPS ? reply('done') : toolCall('file_read', { path: 'notes.txt' }))(req);
  });
  await s.chat('start the build', C);
  return s.adapter().calls.filter(req => req.tools.length > 0);
}

const names = (req: ModelRequest) => req.tools.map(tool => tool.name);

test('TE-4a: 要約ができた時点で history_read が会話の道具の並びに入り、次の実行の最初の呼び出しにもある', async t => {
  const s = await taskApp(t, config => { config.models[0]!.contextLength = 20500; });
  const requests = await compactingRun(s);
  assert.ok(s.events.some(e => e.type === 'compaction'), '前提: 要約した');
  const firstAfter = requests.findIndex((req, k) => k > 0 && names(req).includes('history_read'));
  assert.ok(firstAfter > 0, '要約のあとの呼び出しに入る');
  assert.ok(!names(requests[0]!).includes('history_read'), '要約の前の呼び出しには無い');
  assert.ok(requests.slice(firstAfter).every(req => names(req).includes('history_read')), '一度入ったら実行のあいだ残る');
  assert.ok((s.app.kv.getJson(`loaded-tools:${C}`) as string[]).includes('history_read'), '会話の記録に書く');

  s.adapter().scripts = [reply('next run')];
  await s.chat('again', C);
  const head = s.adapter().calls.filter(req => req.tools.length > 0).at(-1)!;
  assert.equal(JSON.stringify(head.tools), JSON.stringify(requests.at(-1)!.tools), '次の実行の最初の呼び出しの道具の並びは、前の実行の終わりと同じ');
});

test('TE-4a: 要約の無い会話には入らない。前に要約した会話（記録に無い）は、次の実行の始めに入る', async t => {
  const s = await taskApp(t);
  s.adapter().scripts = [reply('hi')];
  await s.chat('hello', C);
  assert.ok(!names(s.adapter().calls.at(-1)!).includes('history_read'), '要約の無い会話には入らない');
  assert.equal(s.app.kv.getJson(`loaded-tools:${C}`), undefined);

  const { id } = s.app.conversations.append('old', { role: 'user', content: 'long ago' });
  s.app.conversations.setSummary('old', 'an earlier summary', id);
  s.adapter().scripts = [reply('back')];
  await s.chat('continue', 'old');
  assert.ok(names(s.adapter().calls.at(-1)!).includes('history_read'), '前に要約した会話の最初の呼び出しにある');
});
