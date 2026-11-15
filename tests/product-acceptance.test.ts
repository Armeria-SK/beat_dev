import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { builtinTools } from '../src/app.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations, ownerSpeech } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { ChatMessage, RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { buildDynamic } from '../src/engine/workspace.ts';
import { resolvePaths } from '../src/paths.ts';
import {
  ACCEPTANCE_MAX_ITEMS, AcceptanceStore, FOLD_COST, frozenHash, prepareSpeech, verifySource,
  type AcceptanceDoc, type ClaimedSource,
} from '../src/projects/acceptance.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { PendingStore } from '../src/pending/store.ts';
import { acceptanceWrite } from '../src/tools/builtin/acceptance.ts';
import { planAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { ATTACHMENT_OPEN } from '../src/uploads/store.ts';
import { fakeModel, settled, startApp, uuid, planFile } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';
import { assertProjectFileGuarded } from './helpers/project-file-guard.ts';

type Options = NonNullable<Parameters<typeof startApp>[1]>;

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const CONV = 'cccccccc-0000-4000-8000-0000000000c1';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function speechFixture() {
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1;
  const conversations = new Conversations(db, () => clock++);
  const chat = (projectId: string | null = PROJECT, over: { kind?: 'chat' | 'task'; parentRunId?: string } = {}) => conversations.create({ projectId, ...over }).id;
  const say = (conversationId: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) =>
    conversations.append(conversationId, { role, content, ...extra } as unknown as ChatMessage).id;
  const check = (claimed: ClaimedSource) => verifySource(prepareSpeech(ownerSpeech(db, PROJECT)), claimed);
  return { db, conversations, chat, say, check };
}

const words = (quote: string): ClaimedSource => ({ kind: 'owner_words', quote });
const choice = (question: string, answer: string): ClaimedSource => ({ kind: 'owner_choice', question, answer });

test('3-1b 出どころ: 持ち主の発言に無い抜き書きは ai_added（not_found）。あれば owner_words と、いちばん新しいその発言の番号', () => {
  const f = speechFixture();
  const c = f.chat();
  f.say(c, 'user', 'Uploads must resume after a restart, please');
  f.say(c, 'assistant', 'Downloads must be fast and cheap. Got it');
  const second = f.say(c, 'user', 'Again: uploads must resume after a restart');
  assert.deepEqual(f.check(words('uploads must resume after a restart')), { kind: 'owner_words', quote: 'uploads must resume after a restart', messageId: second, conversationId: c, context: 'Again: uploads must resume after a restart' });
  assert.deepEqual(f.check(words('downloads must be fast and cheap')), { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'downloads must be fast and cheap' }, 'AI の発言だけにある文は持ち主の言葉ではない');
  assert.deepEqual(f.check({ kind: 'ai_added' }), { kind: 'ai_added' });
});

test('3-1b 出どころ: owner_choice は今は確かめない。持ち主がすぐ次に「A」と答えていても ai_added（choice_unverified）で、AI の質問と答えを表示用に残す', () => {
  const f = speechFixture();
  const c = f.chat();
  f.say(c, 'assistant', '1. Where should the files be stored?\nA) Local disk (recommended)\nB) S3');
  f.say(c, 'user', 'A');
  assert.deepEqual(f.check(choice('Where should the files be stored?', 'A')),
    { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: 'Where should the files be stored?', answer: 'A' });
  assert.deepEqual(f.check(choice('Which?', 'Keep them on the local disk')),
    { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: 'Which?', answer: 'Keep them on the local disk' });
});

test('3-1b 出どころ: owner_words の quote には AI の文字ではなく、一致した持ち主の文の部分をそのまま入れる（「106」と「10⁶」、「now here」と「nowhere」）', () => {
  const f = speechFixture();
  const c = f.chat();
  const power = f.say(c, 'user', 'We expect 10⁶ uploads per day at peak.');
  assert.deepEqual(f.check(words('106 uploads per day')),
    { kind: 'owner_words', quote: '10⁶ uploads per day', messageId: power, conversationId: c, context: 'We expect 10⁶ uploads per day at peak.' });
  const nowhere = f.say(c, 'user', 'The old export is nowhere to be found');
  const found = f.check(words('the old export is now here')) as { quote?: string; messageId?: number };
  assert.equal(found.messageId, nowhere);
  assert.equal(found.quote, 'The old export is nowhere');
  const caps = f.say(c, 'user', 'UPLOADS MUST RESUME AFTER A RESTART');
  const upper = f.check(words('uploads must resume after a restart')) as { quote?: string; messageId?: number };
  assert.equal(upper.quote, 'UPLOADS MUST RESUME AFTER A RESTART');
  assert.equal(upper.messageId, caps);
});

test('3-1b 出どころ: 一致と context は同じそろえ方。半角カナの濁点と、分けて書いたアクセントも context つきで確かめる', () => {
  const f = speechFixture();
  const c = f.chat();
  const kana = f.say(c, 'user', 'ﾌﾟﾛｼﾞｪｸﾄを保存する。');
  const k = f.check(words('プロジェクトを保存')) as { kind: string; messageId?: number; context?: string; quote?: string };
  assert.equal(k.kind, 'owner_words', JSON.stringify(k));
  assert.equal(k.messageId, kana);
  assert.equal(k.quote, 'ﾌﾟﾛｼﾞｪｸﾄを保存');
  assert.equal(k.context, 'ﾌﾟﾛｼﾞｪｸﾄを保存する。');
  const accent = f.say(c, 'user', `The cafe${String.fromCharCode(0x301)} menu must show prices.`);
  const a = f.check(words(`caf${String.fromCharCode(0xE9)} menu must show prices`)) as { kind: string; messageId?: number; context?: string; quote?: string };
  assert.equal(a.kind, 'owner_words');
  assert.equal(a.messageId, accent);
  assert.equal(a.quote, `cafe${String.fromCharCode(0x301)} menu must show prices`);
  assert.equal(a.context, `The cafe${String.fromCharCode(0x301)} menu must show prices.`);
});

test('3-1b 出どころ: 1 回の書き込みで持ち主の発言を読む量に上限がある。使い切ったあとの抜き書きは ai_added（scan_budget）', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, conversation_id: 'c', role: 'user' as const, text: `message ${i} says the uploader keeps part ${i} safe`, generated: 0 }));
  const speech = prepareSpeech(rows, rows[9]!.text.length * FOLD_COST * 2.5);
  const first = verifySource(speech, words('message 9 says the uploader keeps part 9 safe'));
  assert.equal(first.kind, 'owner_words', '新しい発言から読むので最初の 1 件は足りる');
  const second = verifySource(speech, words('message 0 says the uploader keeps part 0 safe'));
  assert.deepEqual(second, { kind: 'ai_added', claimed: 'owner_words', reason: 'scan_budget', quote: 'message 0 says the uploader keeps part 0 safe' });
  const third = verifySource(speech, words('message 9 says the uploader keeps part 9 safe'));
  assert.equal(third.kind === 'ai_added' && third.reason, 'scan_budget', '使い切ったら残りはすべて');
  const plenty = prepareSpeech(rows);
  assert.equal(verifySource(plenty, words('message 0 says the uploader keeps part 0 safe')).kind, 'owner_words');
});

test('3-1b 出どころ: 全角と半角・空白・改行・大文字小文字だけ違う抜き書きが見つかる。日本語・英語・中国語で同じに働く', () => {
  const f = speechFixture();
  const c = f.chat();
  const ja = f.say(c, 'user', '再起動しても　途中のｱｯﾌﾟﾛｰﾄﾞを\n続きから再開してほしい');
  const en = f.say(c, 'user', 'Uploads   MUST\nresume after a RESTART');
  const zh = f.say(c, 'user', '重启之后，上传 可以 继续进行');
  const full = f.say(c, 'user', 'ＡＰＩキーは画面から変えられること');
  assert.equal((f.check(words('途中のアップロードを続きから 再開')) as { messageId?: number }).messageId, ja);
  assert.equal((f.check(words('uploads must resume after a restart')) as { messageId?: number }).messageId, en);
  assert.equal((f.check(words('上传可以继续进行')) as { messageId?: number }).messageId, zh);
  assert.equal((f.check(words('APIキーは画面から変えられる')) as { messageId?: number }).messageId, full);
});

test('3-1b 出どころ: 添付の中だけの文・別の製品・製品に属さない会話・タスクと子の担当の会話・generated の発言は見つからない。しまった会話は探す', () => {
  const f = speechFixture();
  const own = f.chat();
  f.say(own, 'user', `please read this\n${ATTACHMENT_OPEN}: notes.txt (text)>>>\nthe attachment says resume uploads always\n${storeText('en', 'attachment.close')}`);
  f.say(own, 'user', 'see the old file\n<<<添付ファイル: old.txt>>>\nlegacy frame says keep every version\n<<<添付ファイルここまで>>>');
  f.say(f.chat(OTHER), 'user', 'the other product wants dark mode everywhere');
  f.say(f.chat(null), 'user', 'a plain chat wants weekly reports');
  f.say(f.chat(PROJECT, { kind: 'task' }), 'user', 'task instruction: delete old logs nightly');
  f.say(f.chat(PROJECT, { parentRunId: 'run-1' }), 'user', 'child brief: compress the images');
  f.say(own, 'user', 'Yes, update the acceptance items too', { generated: true });
  for (const quote of ['the attachment says resume uploads always', 'legacy frame says keep every version', 'the other product wants dark mode', 'a plain chat wants weekly reports', 'delete old logs nightly', 'compress the images', 'update the acceptance items too']) {
    assert.deepEqual(f.check(words(quote)), { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote }, quote);
  }
  assert.equal(f.check(words('please read this')).kind, 'owner_words', '添付の前の本文は探す');
  const archived = f.chat();
  const said = f.say(archived, 'user', 'archived talk: export to CSV files');
  f.conversations.archive(archived);
  assert.equal((f.check(words('export to CSV files')) as { messageId?: number }).messageId, said);
});

test('3-1b 出どころ: 短い owner_words（日本語 5 字・英語 11 字）は too_short で ai_added。日本語 6 字・英語 12 字は確かめる', () => {
  const f = speechFixture();
  const c = f.chat();
  const m = f.say(c, 'user', '続きから再開して。the checkoutflow must work');
  assert.deepEqual(f.check(words('続きから再')), { kind: 'ai_added', claimed: 'owner_words', reason: 'too_short', quote: '続きから再' });
  assert.deepEqual(f.check(words('checkoutflo')), { kind: 'ai_added', claimed: 'owner_words', reason: 'too_short', quote: 'checkoutflo' });
  assert.equal((f.check(words('続きから再開')) as { messageId?: number }).messageId, m);
  assert.equal((f.check(words('checkoutflow')) as { messageId?: number }).messageId, m);
  assert.equal((f.check(words('check outfl o')) as { reason?: string }).reason, 'too_short', '空白は数えない');
});

test('3-1b 出どころの速さ: 持ち主の 10 万文字の発言 1 つに 120 件の抜き書きを照らしても、発言の下ごしらえ込みで短い時間で終わる', () => {
  const sentences = Array.from({ length: 2000 }, (_, i) => `Requirement number ${i} says the uploader keeps part ${i} safe`);
  let text = sentences.join('. ');
  text = text.slice(0, 100_000);
  const rows = [{ id: 1, conversation_id: 'c', role: 'user' as const, text, generated: 0 }];
  const quotes = Array.from({ length: 120 }, (_, i) => `Requirement number ${i * 10} says the uploader keeps part ${i * 10} safe`);
  const started = performance.now();
  const speech = prepareSpeech(rows);
  const results = quotes.map(quote => verifySource(speech, words(quote)));
  const took = performance.now() - started;
  assert.equal(text.length, 100_000);
  assert.ok(results.every(r => r.kind === 'owner_words' && typeof r.context === 'string' && r.context.length <= 500));
  assert.ok(took < 3000, `${took.toFixed(0)} ms`);
});

test('3-1b 出どころ: owner_words は一致した持ち主の文をまるごと context に残す（否定が切れた引用でも持ち主の言葉が見られる。P3）', () => {
  const f = speechFixture();
  const c = f.chat();
  const m = f.say(c, 'user', 'Keep it small. I do not want uploads to resume after a restart. Thanks');
  assert.deepEqual(f.check(words('uploads to resume after a restart')),
    { kind: 'owner_words', quote: 'uploads to resume after a restart', messageId: m, conversationId: c, context: 'I do not want uploads to resume after a restart.' });
  const ja = f.say(c, 'user', '小さく作りたい。再起動しても続きから再開しなくてよい。以上');
  const result = f.check(words('再起動しても続きから再開')) as { context?: string; messageId?: number };
  assert.equal(result.messageId, ja);
  assert.equal(result.context, '再起動しても続きから再開しなくてよい。');

  const QUOTE = 'the export must keep every column header';
  const long = `${'alpha '.repeat(150)}${QUOTE} ${'omega '.repeat(150)}`;
  f.say(c, 'user', long);
  const cut = (f.check(words(QUOTE)) as { context?: string }).context!;
  assert.ok(cut.length <= 500, String(cut.length));
  assert.ok(cut.startsWith('…') && cut.endsWith('…'), cut.slice(0, 20));
  assert.ok(cut.includes(QUOTE));
  const head = `${QUOTE} ${'omega '.repeat(150)}`;
  f.say(c, 'user', `Note: ${head}`.replace(QUOTE, 'the import must keep every row id intact'));
  const EMOJI = String.fromCodePoint(0x1F600);
  const QUOTE2 = 'the backups must run every night now';
  assert.equal(QUOTE2.length, 36, '窓の両端が絵文字の途中に来る長さ');
  f.say(c, 'user', `${EMOJI.repeat(400)}${QUOTE2}${EMOJI.repeat(400)}`);
  const emoji = (f.check(words(QUOTE2)) as { context?: string }).context!;
  assert.ok(emoji.includes(QUOTE2) && emoji.length <= 500);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u, '絵文字の途中で切らない');
  const front = (f.check(words('the import must keep every row id intact')) as { context?: string }).context!;
  assert.ok(front.length <= 500 && front.startsWith('Note: the import') && front.endsWith('…'), front.slice(0, 40));
});

test('3-1b 道具の印: acceptance_write は meta・planOk・projectOnly・会話だけ。作る役（タスク）と子の担当から名前で呼ばせても、パイプラインが断る', async t => {
  assert.equal(acceptanceWrite.effect, 'meta');
  assert.equal(acceptanceWrite.planOk, true);
  assert.equal(acceptanceWrite.projectOnly, true);
  assert.deepEqual([...acceptanceWrite.allowedIn], ['chat']);
  assert.equal(planAllows(acceptanceWrite), true);
  const h = toolHarness(t);
  const input = { items: [{ result: 'Works', source: 'ai_added', check: 'look' }] };
  for (const kind of ['task', 'agent'] as const) {
    const out = await h.run('acceptance_write', input, h.ctxOf({ kind }));
    assert.equal(out.decision, 'deny', kind);
    assert.equal(out.decidedBy, 'registry', kind);
  }
  const outside = await h.run('acceptance_write', input, h.ctxOf({ project: undefined }));
  assert.equal(outside.decision, 'deny');
  assert.equal(existsSync(h.file), false);
  const plan = await h.run('acceptance_write', input, h.ctxOf({ permissionMode: 'plan' }));
  assert.equal(plan.decision, 'allow', plan.output.content);
  assert.equal(existsSync(h.file), true);
});

function toolHarness(t: { after: (fn: () => void) => void }, options: { archived?: boolean } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  conversations.create({ id: CONV, projectId: PROJECT });
  const acceptance = new AcceptanceStore(db, paths.projects, { archived: () => options.archived === true });
  const registry = new ToolRegistry().register(acceptanceWrite);
  const policy = buildPolicy(config, paths);
  const events: RunEvent[] = [];
  const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: CONV, kind: 'chat', signal: new AbortController().signal, config, paths, policy, project: { id: PROJECT },
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: undefined as never, emit: e => events.push(e), acceptance }, ...over,
  });
  const run = (name: string, args: unknown, ctx: ToolContext) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending: new PendingStore(db, { tools: registry, dataDir: paths.data }), db, emit: () => undefined, permissionMode: () => ctx.permissionMode ?? 'auto',
    conversationTainted: () => false,
  });
  const say = (conversationId: string, role: 'user' | 'assistant', content: string) => {
    if (!conversations.get(conversationId)) conversations.create({ id: conversationId, projectId: PROJECT });
    return conversations.append(conversationId, { role, content } as ChatMessage).id;
  };
  return { db, paths, acceptance, events, ctxOf, run, say, file: join(paths.projects, PROJECT, 'conversation-plans', `${CONV}.acceptance.json`), product: join(paths.projects, PROJECT, 'acceptance.json') };
}

const flat = (source: Record<string, unknown>) => { const { kind, ...rest } = source; return { source: kind, ...rest }; };
const item = (result: string, source: Record<string, unknown> = { kind: 'ai_added' }, check: Record<string, unknown> = { kind: 'command', command: 'npm test' }) => {
  const { kind, ...rest } = check;
  return { result, ...flat(source), check: kind, ...rest };
};
const nd = (text: string, source: Record<string, unknown> = { kind: 'ai_added' }) => ({ text, ...flat(source) });

function freeze(db: DatabaseSync, file: string, doc: AcceptanceDoc, version = 1) {
  const frozen = { ...doc, version };
  delete frozen.taintedRuns;
  db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, plan_hash, source, build_task_id, created_at) VALUES (?, ?, ?, ?, 'p', 'build', NULL, 5)")
    .run(PROJECT, version, frozenHash(frozen), JSON.stringify(frozen));
  writeFileSync(file, JSON.stringify(frozen));
  return frozen;
}

test('3-1b acceptance_write: コードが出どころを付け替えて番号を振り、acceptance.json を丸ごと置き換え、acceptance.changed を流し、確かめた数と付け替えた数を返す', async t => {
  const h = toolHarness(t);
  const said = h.say(CONV, 'user', 'Uploads must resume after a restart. Do not add user accounts for now');
  const out = await h.run('acceptance_write', {
    items: [
      item('Uploads resume after a restart', { kind: 'owner_words', quote: 'uploads must resume after a restart' }),
      item('Files are listed newest first', { kind: 'owner_words', quote: 'files must be sorted by date' }, { kind: 'look' }),
      item('The page loads under a second', { kind: 'ai_added' }, { kind: 'read' }),
    ],
    notDoing: [nd('User accounts', { kind: 'owner_words', quote: 'do not add user accounts' })],
  }, h.ctxOf());
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /3 items/u);
  assert.match(out.output.content, /2 confirmed in the conversation/u);
  assert.match(out.output.content, /not_found: 1/u);
  const doc = JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc;
  assert.deepEqual(doc, {
    schema: 1, version: 0, language: null,
    items: [
      { id: 'A-1', result: 'Uploads resume after a restart', source: { kind: 'owner_words', quote: 'Uploads must resume after a restart', messageId: said, conversationId: CONV, context: 'Uploads must resume after a restart.' }, check: { kind: 'command', command: 'npm test' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
      { id: 'A-2', result: 'Files are listed newest first', source: { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'files must be sorted by date' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
      { id: 'A-3', result: 'The page loads under a second', source: { kind: 'ai_added' }, check: { kind: 'read' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
    ],
    notDoing: [{ id: 'N-1', text: 'User accounts', source: { kind: 'owner_words', quote: 'Do not add user accounts', messageId: said, conversationId: CONV, context: 'Do not add user accounts for now' } }],
    taintedRuns: [],
  });
  assert.deepEqual(h.events.filter(e => e.type === 'acceptance.changed'), [{ type: 'acceptance.changed', projectId: PROJECT, version: 0, draft: true }]);
  assert.deepEqual(readdirSync(join(h.paths.projects, PROJECT, 'conversation-plans')), [`${CONV}.acceptance.json`], '一時ファイルが残らない');
  assert.equal(existsSync(h.product), false, '版 0 の下書きは製品のファイルにしない');

  await h.run('acceptance_write', { items: [item('Only one now')] }, h.ctxOf());
  const again = JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc;
  assert.deepEqual(again.items.map(i => [i.id, i.result]), [['A-1', 'Only one now']], '下書きは丸ごと置き換え');
  assert.deepEqual(again.notDoing, []);
});

test('3-1b acceptance_write の決まり: 項目 60 まで・結果 300 文字まで・コマンド 1,000 文字で 1 行・owner_edit は受けない・鍵らしい文字は断る。どれもファイルを変えない', async t => {
  const h = toolHarness(t);
  await h.run('acceptance_write', { items: [item('First')] }, h.ctxOf());
  const before = readFileSync(h.file, 'utf8');
  const bad: Array<[string, unknown]> = [
    ['61 items', { items: Array.from({ length: ACCEPTANCE_MAX_ITEMS + 1 }, (_, i) => item(`R${i}`)) }],
    ['301 chars', { items: [item('x'.repeat(301))] }],
    ['1001 command', { items: [item('R', undefined, { kind: 'command', command: 'x'.repeat(1001) })] }],
    ['newline command', { items: [item('R', undefined, { kind: 'command', command: 'npm test\nrm -rf /' })] }],
    ['control command', { items: [item('R', undefined, { kind: 'command', command: 'npm\u0007 test' })] }],
    ['owner_edit', { items: [item('R', { kind: 'owner_edit' })] }],
    ['owner_words without quote', { items: [item('R', { kind: 'owner_words' })] }],
    ['owner_choice without answer', { items: [item('R', { kind: 'owner_choice', question: 'Which storage should we use?' })] }],
    ['command without command', { items: [item('R', undefined, { kind: 'command' })] }],
    ['secret', { items: [item('Use sk-abcdefghijklmnop as the key')] }],
    ['secret in command', { items: [item('R', undefined, { kind: 'command', command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop"' })] }],
    ['61 not doing', { items: [], notDoing: Array.from({ length: ACCEPTANCE_MAX_ITEMS + 1 }, (_, i) => nd(`N${i}`)) }],
    ['zero width in command', { items: [item('R', undefined, { kind: 'command', command: 'npm​ test' })] }],
    ['bidi in command', { items: [item('R', undefined, { kind: 'command', command: 'npm test ‮txt' })] }],
    ['tag chars in command', { items: [item('R', undefined, { kind: 'command', command: `npm test${String.fromCodePoint(0xE0072, 0xE006D)}` })] }],
    ['soft hyphen in command', { items: [item('R', undefined, { kind: 'command', command: 'npm te­st' })] }],
    ['invisible operator in command', { items: [item('R', undefined, { kind: 'command', command: 'npm⁡test' })] }],
    ['hangul filler in command', { items: [item('R', undefined, { kind: 'command', command: 'npm test ㅤ' })] }],
    ['isolate in command', { items: [item('R', undefined, { kind: 'command', command: `npm test ${String.fromCharCode(0x2066)}x` })] }],
    ['variation selector in command', { items: [item('R', undefined, { kind: 'command', command: `npm test${String.fromCharCode(0xFE0F)}` })] }],
    ['supplementary variation selector in command', { items: [item('R', undefined, { kind: 'command', command: `npm test${String.fromCodePoint(0xE0100)}` })] }],
    ['format character in command', { items: [item('R', undefined, { kind: 'command', command: `npm test ${String.fromCharCode(0xFFF9)}x${String.fromCharCode(0xFFFB)}` })] }],
    ['braille blank in command', { items: [item('R', undefined, { kind: 'command', command: `npm test ${String.fromCharCode(0x2800)}` })] }],
    ['five spaces in command', { items: [item('R', undefined, { kind: 'command', command: 'npm test     && rm -rf /' })] }],
    ['no-break space in command', { items: [item('R', undefined, { kind: 'command', command: `npm${String.fromCharCode(0xA0)}test` })] }],
    ['ideographic space in command', { items: [item('R', undefined, { kind: 'command', command: `npm${String.fromCharCode(0x3000)}test` })] }],
    ['thin space in command', { items: [item('R', undefined, { kind: 'command', command: `npm${String.fromCharCode(0x2009)}test` })] }],
    ['language input', { items: [item('R')], language: 'en' }],
  ];
  for (const [label, input] of bad) {
    const out = await h.run('acceptance_write', input, h.ctxOf());
    assert.ok(out.decision !== 'allow' || out.output.isError === true, `${label}: ${out.output.content}`);
    assert.equal(readFileSync(h.file, 'utf8'), before, label);
  }
  const ok = await h.run('acceptance_write', { items: Array.from({ length: ACCEPTANCE_MAX_ITEMS }, (_, i) => item(`R${i}`, undefined, { kind: 'command', command: 'x'.repeat(1000) })) }, h.ctxOf());
  assert.equal(ok.output.isError, undefined, ok.output.content);
  assert.equal((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).items.length, 60);
  const hidden = await h.run('acceptance_write', { items: [item('Re\u200Bsu\u202Elt')] }, h.ctxOf());
  assert.equal(hidden.output.isError, undefined);
  assert.equal((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).items[0]!.result, 'Result', '見えない文字は取り除く');
});

test('3-1b acceptance_write: 固定のあと（version >= 1）は断られ、ファイルが変わらない。しまった製品にも書かない', async t => {
  const h = toolHarness(t);
  await h.run('acceptance_write', { items: [item('First')] }, h.ctxOf());
  const draft = JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc;
  freeze(h.db, h.product, draft);
  const before = readFileSync(h.product, 'utf8');
  const out = await h.run('acceptance_write', { items: [item('Second')] }, h.ctxOf());
  assert.equal(out.output.isError, true);
  assert.equal(out.decidedBy, 'registry', '固定のあとはパイプラインが断る');
  assert.match(out.output.content, /cannot change the locked acceptance list/u);
  assert.match(out.output.content, /acceptance_change/u);
  const direct = await acceptanceWrite.execute({ items: [item('Second')] } as never, h.ctxOf());
  assert.equal(direct.isError, true, '道具の中でも断る（二重）');
  assert.match(direct.content, /fixed \(version 1\)/u);
  assert.equal(readFileSync(h.product, 'utf8'), before);

  const archived = toolHarness(t, { archived: true });
  const refused = await archived.run('acceptance_write', { items: [item('First')] }, archived.ctxOf());
  assert.equal(refused.output.isError, true);
  assert.equal(existsSync(archived.file), false);
});

test('3-1b acceptance_write: よそから来た文を読んだ実行の書き込みは止めず、下書きの taintedRuns にその実行を積む。あとのきれいな実行の書き込みでは消えない', async t => {
  const h = toolHarness(t);
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r9', taint: { tainted: true, sources: ['web'] } }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9']);
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r10', conversationTainted: () => true }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9', 'r10'], '会話が前に外を読んでいれば');
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r9', taint: { tainted: true, sources: ['web'] } }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9', 'r10'], '同じ実行は 1 度だけ');
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r12', conversationTainted: () => { throw new Error('db gone'); } }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9', 'r10', 'r12'], '会話の印が読めなければ外を読んだとみなす');
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r11' }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9', 'r10', 'r12'], 'きれいな実行では消えない');
});

function storeFixture(t: { after: (fn: () => void) => void }, io: ConstructorParameters<typeof AcceptanceStore>[2] = {}) {
  const paths = resolvePaths(tempDir(t));
  const dir = join(paths.projects, PROJECT);
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  db.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at, project_id) VALUES (?, 'chat', 0, 0, ?)").run(CONV, PROJECT);
  const store = new AcceptanceStore(db, paths.projects, io);
  const doc = (results: string[], version = 0): AcceptanceDoc => ({
    schema: 1, version, language: 'ja',
    items: results.map((result, i) => ({ id: `A-${i + 1}`, result, source: { kind: 'ai_added' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null })),
    notDoing: [{ id: 'N-1', text: 'No accounts', source: { kind: 'ai_added' } }],
  });
  return { db, store, dir, doc, file: join(dir, 'acceptance.json') };
}

test('3-1b frozenHash と verifyFrozen: 固定の部分だけにハッシュをかける。state と evidence を変えても合い、result を変える・ファイルを直接書き換えると合わない', t => {
  const f = storeFixture(t);
  assert.equal(f.store.verifyFrozen(PROJECT), 'not_frozen');
  const frozen = freeze(f.db, f.file, f.doc(['再開できる', 'Lists files']));
  assert.match(frozenHash(frozen), /^[0-9a-f]{64}$/u);
  assert.equal(f.store.verifyFrozen(PROJECT), 'ok');
  const moved = structuredClone(frozen);
  moved.items[0]!.state = 'met';
  moved.items[0]!.evidence = [{ ran: 'npm test' }];
  moved.taintedRuns = ['r1'];
  writeFileSync(f.file, JSON.stringify(moved, null, 2));
  assert.equal(frozenHash(moved), frozenHash(frozen));
  assert.equal(f.store.verifyFrozen(PROJECT), 'ok', '状態・証拠・空白の違いでは変わらない');
  const reordered = { ...structuredClone(frozen), items: [...frozen.items].reverse(), notDoing: frozen.notDoing };
  assert.equal(frozenHash(reordered), frozenHash(frozen), '項目の並びと鍵の順に依らない');
  const edited = structuredClone(frozen);
  edited.items[0]!.result = '再開できない';
  writeFileSync(f.file, JSON.stringify(edited));
  assert.notEqual(frozenHash(edited), frozenHash(frozen));
  assert.equal(f.store.verifyFrozen(PROJECT), 'mismatch');
  writeFileSync(f.file, 'not json');
  assert.equal(f.store.verifyFrozen(PROJECT), 'mismatch');
});

test('3-1b ファイルと DB の順: 一時ファイルの書き込みに失敗すると前のまま。DB の版よりファイルが遅れていれば、read は DB の中身を返し（item_states が NULL の版は全部 open。ファイルの state は重ねない）、ファイルは書かない。書き戻しは書く前と起動のとき', t => {
  let failing = false;
  const f = storeFixture(t, { writeFileSync: (path, data) => { if (failing) { writeFileSync(path, data.slice(0, 5)); throw new Error('disk full'); } writeFileSync(path, data); } });
  f.store.writeDraft(PROJECT, CONV, f.doc(['one']));
  failing = true;
  assert.throws(() => f.store.writeDraft(PROJECT, CONV, f.doc(['two'])), /disk full/u);
  failing = false;
  assert.deepEqual(f.store.read(PROJECT, CONV)?.items.map(i => i.result), ['one']);
  assert.deepEqual(readdirSync(join(f.dir, 'conversation-plans')), [`${CONV}.acceptance.json`]);

  const draft = f.doc(['one', 'two']);
  draft.items[0]!.state = 'met';
  writeFileSync(f.file, JSON.stringify(draft));
  const v1 = { ...f.doc(['one', 'two']), version: 1 };
  f.db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, created_at) VALUES (?, 1, ?, ?, 'build', 1)").run(PROJECT, frozenHash(v1), JSON.stringify(v1));
  const read = f.store.read(PROJECT)!;
  assert.equal(read.version, 1);
  assert.deepEqual(read.items.map(i => [i.id, i.state]), [['A-1', 'open'], ['A-2', 'open']], 'ファイルの state は重ねない');
  assert.equal((JSON.parse(readFileSync(f.file, 'utf8')) as AcceptanceDoc).version, 0, '読むだけではファイルを書かない');
  assert.equal(f.store.verifyFrozen(PROJECT), 'mismatch', 'ファイルは遅れたまま');

  assert.throws(() => f.store.writeDraft(PROJECT, CONV, f.doc(['three'])), (e: Error & { code?: string }) => e.code === 'frozen');
  const repaired = JSON.parse(readFileSync(f.file, 'utf8')) as AcceptanceDoc;
  assert.equal(repaired.version, 1, '書く前に DB の中身から書き戻す');
  assert.deepEqual(repaired.items.map(i => [i.result, i.state]), [['one', 'open'], ['two', 'open']]);
  assert.equal(f.store.verifyFrozen(PROJECT), 'ok');
});

test('3-1b 起動のとき（repairAll）: 遅れたファイルを DB の中身から書き戻し、残った一時ファイルを消す。ほかの名前には触らない', t => {
  const f = storeFixture(t);
  const v1 = { ...f.doc(['one']), version: 1 };
  f.db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, created_at) VALUES (?, 1, ?, ?, 'build', 1)").run(PROJECT, frozenHash(v1), JSON.stringify(v1));
  writeFileSync(join(f.dir, 'acceptance.json.tmp-abc123'), 'half');
  writeFileSync(join(f.dir, 'plan.md'), '# Plan');
  f.store.repairAll();
  assert.deepEqual(readdirSync(f.dir).sort(), ['acceptance.json', 'plan.md']);
  assert.equal(f.store.verifyFrozen(PROJECT), 'ok');
});

test('3-1b 守り: ふつうのファイルの道具とシェルからは acceptance.json を読めない・書けない（判定役が許すと答えても）', t =>
  assertProjectFileGuarded(t, { project: PROJECT, name: 'acceptance.json', body: '{"secret":"list"}', leak: /"list"/u, request: 'edit the list' }));

test('3-1b 毎回の system: 製品の文書の言語があれば、製品の行のあとに言語の 1 行。無ければ入らない', () => {
  const at = new Date('2026-11-12T00:00:00Z');
  const line = 'Owner-facing documents of this product (plan, acceptance items, questions, deviation notes) are written in ja.';
  assert.ok(buildDynamic('UTC', 'en', at, 'auto', { name: 'Shop', root: 'C:/shop', docLanguage: 'ja' }).split('\n').includes(line));
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'auto', { name: 'Shop', root: 'C:/shop', docLanguage: null }), /Owner-facing/u);
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'auto'), /Owner-facing/u);
});

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(), ...options });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string; name: string; doc_language: string | null; doc_language_pinned: boolean };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    if (sent.status === 202) await settled(s.app, sent.body.runId);
    return sent;
  };
  const names = (index = -1) => s.adapter().calls.at(index)!.tools.map(tool => tool.name);
  const lastTool = () => { const m = s.adapter().calls.at(-1)!.messages.filter(x => x.role === 'tool').at(-1); return m?.content ?? ''; };
  return { ...s, events, product, send, names, lastTool };
}

test('3-1b 道具の一覧（本物の App）: acceptance_write は製品の会話（計画・自動承認）にあり、製品のタスク・子の担当・製品に属さない会話には無い', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b'), reply('c'), reply('d'), reply('e')];
  await s.send(uuid(1), { text: 'plan it', projectId: shop.id, permissionMode: 'plan' });
  assert.ok(s.names().includes('acceptance_write'), s.names().join());
  await s.send(uuid(2), { text: 'do it', projectId: shop.id, permissionMode: 'auto' });
  assert.ok(s.names().includes('acceptance_write'));
  for (const [n, mode] of [[3, 'auto'], [4, 'plan']] as const) {
    await s.send(uuid(n), { text: 'hi', permissionMode: mode });
    assert.ok(!s.names().includes('acceptance_write'), mode);
  }
  s.adapter().scripts = [call('agent_run', { task: 'look' }), call('acceptance_write', { items: [] }), reply('child'), reply('parent')];
  await s.send(uuid(6), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  const child = s.adapter().calls.at(-3)!.tools.map(tool => tool.name);
  assert.ok(child.length > 0 && !child.includes('acceptance_write'), child.join());
  assert.match(s.adapter().calls.at(-2)!.messages.filter(m => m.role === 'tool').at(-1)!.content, /cannot be used|not allowed|not available/iu, '子の担当が名前で呼んでも断られる');
  assert.equal(existsSync(join(s.paths.projects, shop.id, 'acceptance.json')), false);
  assert.equal(existsSync(join(s.paths.projects, shop.id, 'conversation-plans', `${uuid(6)}.acceptance.json`)), false);

  const made = await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  assert.equal(made.status, 201);
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(!s.names().includes('acceptance_write'), s.names().join());
});

test('3-1b 一覧の口: 無い間は空の下書きの形。AI の acceptance_write のあとは中身と hash、固定のあとは frozen。無い ID は 404', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const empty = await s.json(`/api/projects/${shop.id}/acceptance`, 'GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.acceptance, { version: 0, language: null, items: [], not_doing: [], draft: true, hash: null, tainted: false, frozen: null, change: null, unbuilt: [], open_build_task_id: null });
  assert.equal((await s.json('/api/projects/aaaaaaaa-0000-4000-8000-999999999999/acceptance', 'GET')).status, 404);
  assert.equal((await s.json('/api/projects/../acceptance', 'GET')).status, 404);

  s.adapter().scripts = [call('acceptance_write', { items: [item('Uploads resume after a restart', { kind: 'owner_words', quote: 'uploads must resume after a restart' })], notDoing: [nd('Accounts')] }), reply('ok')];
  await s.send(uuid(1), { text: 'Uploads must resume after a restart', projectId: shop.id });
  assert.match(s.lastTool(), /1 confirmed in the conversation/u);
  assert.equal((await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance.items.length, 0, '会話なしでは下書きを見せない');
  const got = (await s.json(`/api/projects/${shop.id}/acceptance?conversationId=${uuid(1)}`, 'GET')).body.acceptance;
  assert.equal(got.draft, true);
  assert.equal(got.version, 0);
  assert.equal(got.items[0].source.kind, 'owner_words');
  assert.equal(got.items[0].source.conversationId, uuid(1));
  assert.deepEqual(got.not_doing.map((n: { id: string }) => n.id), ['N-1']);
  const doc = JSON.parse(readFileSync(join(s.paths.projects, shop.id, 'conversation-plans', `${uuid(1)}.acceptance.json`), 'utf8')) as AcceptanceDoc;
  const file = join(s.paths.projects, shop.id, 'acceptance.json');
  assert.equal(got.hash, frozenHash(doc));
  assert.deepEqual(s.events.filter(e => e.type === 'acceptance.changed'), [{ type: 'acceptance.changed', projectId: shop.id, version: 0, draft: true }]);

  const v1 = { ...doc, version: 1 };
  delete v1.taintedRuns;
  s.app.db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, plan_hash, source, build_task_id, created_at) VALUES (?, 1, ?, ?, 'ph', 'build', 'task-1', 77)").run(shop.id, frozenHash(v1), JSON.stringify(v1));
  writeFileSync(file, JSON.stringify(v1));
  const fixed = (await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance;
  assert.equal(fixed.draft, false);
  assert.deepEqual(fixed.frozen, { version: 1, hash: frozenHash(v1), plan_hash: 'ph', created_at: 77, source: 'build', build_task_id: 'task-1' });
});

test('3-1b 一覧の口: よそから来た文を読んだ実行が書いたら tainted: true、別の会話の下書きは別のもので、その印を引き継がない。言語は製品のものを使う', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { docLanguage: 'ja' });
  s.adapter().scripts = [reply('hello'), call('acceptance_write', { items: [item('First')] }), reply('ok'), call('acceptance_write', { items: [item('Second')] }), reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  s.app.conversations.markTainted(uuid(1));
  await s.send(uuid(1), { text: 'write it' });
  const dirty = (await s.json(`/api/projects/${shop.id}/acceptance?conversationId=${uuid(1)}`, 'GET')).body.acceptance;
  assert.equal(dirty.tainted, true);
  assert.equal(dirty.language, 'ja');
  await s.send(uuid(2), { text: 'rewrite it', projectId: shop.id });
  const other = (await s.json(`/api/projects/${shop.id}/acceptance?conversationId=${uuid(2)}`, 'GET')).body.acceptance;
  assert.deepEqual(other.items.map((i: { result: string }) => i.result), ['Second']);
  assert.equal(other.tainted, false, '別の会話の下書きは別のもの');
  const still = (await s.json(`/api/projects/${shop.id}/acceptance?conversationId=${uuid(1)}`, 'GET')).body.acceptance;
  assert.deepEqual([still.items.map((i: { result: string }) => i.result), still.tainted], [['First'], true]);
});

test('3-1b 言語: plan_write が初めて ja を渡すと製品に控えて project.changed を流す。選んでいなければ 2 回目の en にすぐ従う。持ち主が選んだ（pinned）製品では変わらない。読めない印は控えず結果に 1 行。外を読んだ実行の印は控えない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  assert.equal(shop.doc_language, null);
  assert.equal(shop.doc_language_pinned, false);
  const changes = () => s.events.filter(e => e.type === 'project.changed' && e.projectId === shop.id && e.change === 'updated').length;
  const before = changes();
  s.adapter().scripts = [call('plan_write', { content: '# 計画', language: 'ja' }), reply('a'), call('plan_write', { content: '# Plan', language: 'en' }), reply('b')];
  await s.send(uuid(1), { text: 'plan', projectId: shop.id });
  assert.equal(s.app.projects.get(shop.id)?.doc_language, 'ja');
  assert.equal(changes(), before + 1, '検出で変わったら画面へ知らせる');
  await s.send(uuid(1), { text: 'again' });
  assert.equal(s.app.projects.get(shop.id)?.doc_language, 'en', '選んでいなければ最新の印にすぐ従う');
  assert.equal(changes(), before + 2);
  s.adapter().scripts = [call('plan_write', { content: '# Plan', language: 'en' }), reply('b2')];
  await s.send(uuid(1), { text: 'same' });
  assert.equal(changes(), before + 2, '変わらなければ知らせない');
  const listed = (await s.json('/api/projects', 'GET')).body.projects[0];
  assert.deepEqual([listed.doc_language, listed.doc_language_pinned], ['en', false]);

  const cafe = await s.product('cafe');
  s.adapter().scripts = [call('plan_write', { content: '# Plan', language: 'japanese' }), reply('c')];
  await s.send(uuid(2), { text: 'plan', projectId: cafe.id });
  assert.equal(s.app.projects.get(cafe.id)?.doc_language, null);
  assert.match(s.lastTool(), /"japanese" is not a language tag/u);
  assert.equal(readFileSync(planFile(s.app, cafe.id), 'utf8'), '# Plan', '計画書は書ける');

  const pinned = await s.json(`/api/projects/${cafe.id}`, 'PATCH', { docLanguage: 'zh-Hant' });
  assert.equal(pinned.status, 200);
  assert.deepEqual([pinned.body.project.doc_language, pinned.body.project.doc_language_pinned], ['zh-Hant', true]);
  s.adapter().scripts = [call('plan_write', { content: '# Plan 2', language: 'ja' }), reply('d')];
  await s.send(uuid(2), { text: 'again' });
  assert.equal(s.app.projects.get(cafe.id)?.doc_language, 'zh-Hant');
  for (const bad of ['japanese', 'JA', 'pt_BR', 3, '']) {
    assert.equal((await s.json(`/api/projects/${cafe.id}`, 'PATCH', { docLanguage: bad })).status, 400, String(bad));
  }
  const auto = await s.json(`/api/projects/${cafe.id}`, 'PATCH', { docLanguage: null });
  assert.deepEqual([auto.body.project.doc_language, auto.body.project.doc_language_pinned], ['ja', false], 'Auto に戻すと、選んでいたあいだに渡された印でその場で決め直す');
  const fresh = await s.product('fresh');
  await s.json(`/api/projects/${fresh.id}`, 'PATCH', { docLanguage: 'en' });
  const nothing = await s.json(`/api/projects/${fresh.id}`, 'PATCH', { docLanguage: null });
  assert.deepEqual([nothing.body.project.doc_language, nothing.body.project.doc_language_pinned], [null, false], '決める材料が無ければ null');
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { docLanguage: 'fr' });
  const back = await s.json(`/api/projects/${shop.id}`, 'PATCH', { docLanguage: null });
  assert.deepEqual([back.body.project.doc_language, back.body.project.doc_language_pinned], ['en', false], '最後に渡された印に戻る');
  assert.ok(s.events.some(e => e.type === 'project.changed' && e.projectId === cafe.id && e.change === 'updated'));

  const dirty = await s.product('dirty');
  s.adapter().scripts = [reply('hello'), call('plan_write', { content: '# Plan', language: 'ja' }), reply('e')];
  await s.send(uuid(3), { text: 'hi', projectId: dirty.id });
  s.app.conversations.markTainted(uuid(3));
  await s.send(uuid(3), { text: 'plan' });
  assert.equal(readFileSync(planFile(s.app, dirty.id), 'utf8'), '# Plan');
  assert.equal(s.app.projects.get(dirty.id)?.doc_language, null, '外を読んだ実行の印では決めない');
  await s.json(`/api/projects/${dirty.id}`, 'PATCH', { docLanguage: 'en' });
  const reset = await s.json(`/api/projects/${dirty.id}`, 'PATCH', { docLanguage: null });
  assert.equal(reset.body.project.doc_language, null, '外を読んだ実行の印は控えにも残らない');
});

test('3-1b 言語（本物の App）: 製品の会話・タスク・子の担当の毎回の部分に言語の 1 行が入り、製品に属さない会話には入らない', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { docLanguage: 'ja' });
  const LINE = /Owner-facing documents of this product \(plan, acceptance items, questions, deviation notes\) are written in ja\./u;
  s.adapter().scripts = [call('agent_run', { task: 'look' }), reply('child'), reply('parent'), reply('plain')];
  await s.send(uuid(1), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  assert.match(s.adapter().calls.at(-3)!.system.dynamic, LINE, '会話');
  assert.match(s.adapter().calls.at(-2)!.system.dynamic, LINE, '子の担当');
  await s.send(uuid(2), { text: 'hi' });
  assert.doesNotMatch(s.adapter().calls.at(-1)!.system.dynamic, /Owner-facing/u, '製品に属さない会話');
  await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(s.adapter().calls.at(-1)!.system.dynamic, LINE, 'タスク');
});
