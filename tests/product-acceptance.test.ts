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
  ACCEPTANCE_MAX_ITEMS, AcceptanceStore, frozenHash, prepareSpeech, verifySource,
  type AcceptanceDoc, type ClaimedSource,
} from '../src/projects/acceptance.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { acceptanceWrite } from '../src/tools/builtin/acceptance.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { planAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { ATTACHMENT_CLOSE, ATTACHMENT_OPEN } from '../src/uploads/store.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script } from './helpers.ts';

type Options = NonNullable<Parameters<typeof startApp>[1]>;

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
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

test('3-1b 出どころ: AI の選択肢つきの質問のすぐ次に持ち主が「A」と答えたら owner_choice。間に持ち主の別の発言があると not_next_reply で ai_added', () => {
  const f = speechFixture();
  const c = f.chat();
  f.say(c, 'user', 'I want a small uploader');
  const q = f.say(c, 'assistant', '1. Where should the files be stored?\nA) Local disk (recommended)\nB) S3');
  const a = f.say(c, 'user', 'A');
  assert.deepEqual(f.check(choice('Where should the files be stored?', 'A')),
    { kind: 'owner_choice', question: 'Where should the files be stored?', questionMessageId: q, answer: 'A', answerMessageId: a, conversationId: c });

  const c2 = f.chat();
  f.say(c2, 'assistant', 'Which database should we use for this?\nA) SQLite\nB) Postgres');
  f.say(c2, 'user', 'hmm, let me think about it');
  f.say(c2, 'user', 'A');
  assert.deepEqual(f.check(choice('Which database should we use for this?', 'A')),
    { kind: 'ai_added', claimed: 'owner_choice', reason: 'not_next_reply', question: 'Which database should we use for this?', answer: 'A' });
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
  f.say(own, 'user', `please read this\n${ATTACHMENT_OPEN}: notes.txt (text)>>>\nthe attachment says resume uploads always\n${ATTACHMENT_CLOSE}`);
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

test('3-1b 出どころ: owner_choice の負の確かめ（区切られて現れない記号・選択肢に無い記号・短い質問）と、通る形', () => {
  const f = speechFixture();
  const QUESTION = 'Which storage should the uploader use?';
  const ask = `1. ${QUESTION}\nA) Local disk (recommended)\nB) S3\nC) Both`;
  const pair = (answerText: string, question = ask) => {
    const c = f.chat();
    f.say(c, 'assistant', question);
    return f.say(c, 'user', answerText);
  };
  const kindOf = (answer: string, question = QUESTION) => {
    const result = f.check(choice(question, answer));
    return result.kind === 'owner_choice' ? result.answerMessageId : result.kind;
  };
  for (const text of ['OK, go ahead', 'A bit of both', 'A few tweaks first', 'we have 3 A grade servers', '1A', 'Aでお願いします']) {
    pair(text);
    assert.equal(kindOf('A'), 'ai_added', text);
  }
  for (const text of ['A', '1. A, 2. C', 'Q1: A', 'A.', 'A, please', 'Ａ', '１．Ａ']) {
    const id = pair(text);
    assert.equal(kindOf('A'), id, text);
  }
  const b = pair('1) B');
  assert.equal(kindOf('B'), b);

  const NO_OPTIONS = 'What color do you like best for the header?';
  pair('A', NO_OPTIONS);
  assert.equal(kindOf('A', NO_OPTIONS), 'ai_added', '質問に選択肢 A が無い');
  pair('A', 'Which?\nA) x\nB) y');
  assert.deepEqual(f.check(choice('Which?', 'A')), { kind: 'ai_added', claimed: 'owner_choice', reason: 'too_short', question: 'Which?', answer: 'A' });

  const SIMPLE = 'How simple should the first version be?';
  pair('I want a simple one', `${SIMPLE}\nA) Simple\nB) Full`);
  assert.equal(kindOf('A', SIMPLE), 'ai_added', '「I want a simple one」と A');
  const USERS = 'How many users will share it at once?';
  pair('I need 2 users', `${USERS}\n1) One\n2) Two\n3) Many`);
  assert.equal(kindOf('2', USERS), 'ai_added', '「I need 2 users」と 2');
  const NODES = 'How many worker nodes should run it?';
  pair('node 1.2', `1. ${NODES}\n1) One\n2) Two`);
  assert.equal(kindOf('2', NODES), 'ai_added', '「node 1.2」の 2 は小数');
  const LONG = 'Where should we keep the uploaded files?';
  const long = pair('Keep them on the local disk for now', `${LONG}\nA) Local\nB) Cloud`);
  assert.equal(kindOf('keep them on the local disk', LONG), long, '長い答えは含まれるかで見る');
});

test('3-1b 出どころ: 答えは自分の問いの番号に結び付く。「1. A / 2. C」は Q2 = A も Q1 = C も通さない（P1 のログインとパスワード）', () => {
  const f = speechFixture();
  const Q1 = 'Do users need to log in first?';
  const Q2 = 'How strict should passwords be?';
  const c = f.chat();
  const q = f.say(c, 'assistant', `1. ${Q1}\nA) Yes\nB) No\n2. ${Q2}\nA) Strict\nB) Loose\nC) None`);
  const a = f.say(c, 'user', '1. A\n2. C');
  assert.equal(f.check(choice(Q2, 'A')).kind, 'ai_added', 'Q2 の答えは C');
  assert.equal(f.check(choice(Q1, 'C')).kind, 'ai_added', 'Q1 に C は無く、Q1 の答えは A');
  assert.deepEqual(f.check(choice(Q1, 'A')), { kind: 'owner_choice', question: Q1, questionMessageId: q, answer: 'A', answerMessageId: a, conversationId: c });
  assert.equal(f.check(choice(Q2, 'C')).kind, 'owner_choice');

  const P1A = 'Should people sign in with a password?';
  const P1B = 'Should a login page come first?';
  const c2 = f.chat();
  f.say(c2, 'assistant', `1. ${P1A}\nA) Yes\nB) No\n2. ${P1B}\nA) Yes\nB) No`);
  f.say(c2, 'user', '1. B, 2. A');
  assert.equal(f.check(choice(P1A, 'A')).kind, 'ai_added', 'P1: A は 2 の答え');
  assert.equal(f.check(choice(P1B, 'A')).kind, 'owner_choice');
  assert.equal(f.check(choice(P1A, 'B')).kind, 'owner_choice');

  const c3 = f.chat();
  f.say(c3, 'assistant', `1. ${Q1}\nA) Yes\nB) No\n2. ${Q2}\nA) Strict\nB) Loose\nC) None`);
  f.say(c3, 'user', 'C');
  assert.equal(f.check(choice(Q1, 'C')).kind, 'ai_added', 'C は Q2 の選択肢で、Q1 の区切りの中には無い');
});

test('3-1b 出どころ: yes / no / はい / いいえ は「?」か選択肢の印のある問いへの答えだけ。リンクの行き先・参照の定義・HTML のコメントは問いにならない（P2・P2b）', () => {
  const f = speechFixture();
  const pair = (question: string, answer: string) => { const c = f.chat(); f.say(c, 'assistant', question); return f.say(c, 'user', answer); };
  const answerOf = (question: string, answer: string) => {
    const result = f.check(choice(question, answer));
    return result.kind === 'owner_choice' ? result.answerMessageId : result.kind;
  };
  const yes = pair('Should uploads resume after a restart?', 'yes');
  assert.equal(answerOf('Should uploads resume after a restart?', 'yes'), yes);
  const JA = '再起動のあとも続きから再開しますか？';
  const hai = pair(JA, 'はい');
  assert.equal(answerOf(JA, 'はい'), hai);
  pair('Uploads will resume after a restart', 'yes');
  assert.equal(answerOf('Uploads will resume after a restart', 'yes'), 'ai_added', '問いでない文への yes');
  pair('See [the guide](https://example.test/Do-you-want-telemetry-enabled?) for details.', 'yes');
  assert.equal(answerOf('Do-you-want-telemetry-enabled?', 'yes'), 'ai_added', 'P2: リンクの行き先');
  pair('Read the guide [1] first.\n\n[1]: https://example.test/guide "Do you want telemetry enabled?"', 'yes');
  assert.equal(answerOf('Do you want telemetry enabled?', 'yes'), 'ai_added', 'P2b: 参照の定義');
  pair('Thanks, noted.\n<!-- Do you want analytics turned on? -->', 'yes');
  assert.equal(answerOf('Do you want analytics turned on?', 'yes'), 'ai_added', 'P2b: HTML のコメント');
  pair('Do you want the dark theme as the default?', 'no idea, you decide');
  assert.equal(answerOf('Do you want the dark theme as the default?', 'no'), 'ai_added', '「no idea」は no ではない');
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
  const acceptance = new AcceptanceStore(db, paths.projects, { archived: () => options.archived === true });
  const registry = new ToolRegistry().register(acceptanceWrite);
  const policy = buildPolicy(config, paths);
  const events: RunEvent[] = [];
  const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, project: { id: PROJECT },
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: undefined as never, emit: e => events.push(e), acceptance }, ...over,
  });
  const run = (name: string, args: unknown, ctx: ToolContext) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db, () => undefined), db, emit: () => undefined, permissionMode: () => ctx.permissionMode ?? 'normal',
    conversationTainted: () => false, conversationAutoRead: () => false,
  });
  const say = (conversationId: string, role: 'user' | 'assistant', content: string) => {
    if (!conversations.get(conversationId)) conversations.create({ id: conversationId, projectId: PROJECT });
    return conversations.append(conversationId, { role, content } as ChatMessage).id;
  };
  return { db, paths, acceptance, events, ctxOf, run, say, file: join(paths.projects, PROJECT, 'acceptance.json') };
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
  const said = h.say('c1', 'user', 'Uploads must resume after a restart. Do not add user accounts for now');
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
  assert.match(out.output.content, /2 verified/u);
  assert.match(out.output.content, /not_found: 1/u);
  const doc = JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc;
  assert.deepEqual(doc, {
    schema: 1, version: 0, language: null,
    items: [
      { id: 'A-1', result: 'Uploads resume after a restart', source: { kind: 'owner_words', quote: 'uploads must resume after a restart', messageId: said, conversationId: 'c1', context: 'Uploads must resume after a restart.' }, check: { kind: 'command', command: 'npm test' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
      { id: 'A-2', result: 'Files are listed newest first', source: { kind: 'ai_added', claimed: 'owner_words', reason: 'not_found', quote: 'files must be sorted by date' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
      { id: 'A-3', result: 'The page loads under a second', source: { kind: 'ai_added' }, check: { kind: 'read' }, state: 'open', evidence: [], changedIn: null, removedIn: null },
    ],
    notDoing: [{ id: 'N-1', text: 'User accounts', source: { kind: 'owner_words', quote: 'do not add user accounts', messageId: said, conversationId: 'c1', context: 'Do not add user accounts for now' } }],
    taintedRuns: [],
  });
  assert.deepEqual(h.events.filter(e => e.type === 'acceptance.changed'), [{ type: 'acceptance.changed', projectId: PROJECT, version: 0, draft: true }]);
  assert.deepEqual(readdirSync(join(h.paths.projects, PROJECT)), ['acceptance.json'], '一時ファイルが残らない');

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
    ['braille blank in command', { items: [item('R', undefined, { kind: 'command', command: 'npm test ⠀' })] }],
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
  freeze(h.db, h.file, draft);
  const before = readFileSync(h.file, 'utf8');
  const out = await h.run('acceptance_write', { items: [item('Second')] }, h.ctxOf());
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /fixed \(version 1\)/u);
  assert.match(out.output.content, /acceptance_change/u);
  assert.equal(readFileSync(h.file, 'utf8'), before);

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
  await h.run('acceptance_write', { items: [item('A')] }, h.ctxOf({ runId: 'r11' }));
  assert.deepEqual((JSON.parse(readFileSync(h.file, 'utf8')) as AcceptanceDoc).taintedRuns, ['r9', 'r10'], 'きれいな実行では消えない');
});

function storeFixture(t: { after: (fn: () => void) => void }, io: ConstructorParameters<typeof AcceptanceStore>[2] = {}) {
  const paths = resolvePaths(tempDir(t));
  const dir = join(paths.projects, PROJECT);
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
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

test('3-1b ファイルと DB の順: 一時ファイルの書き込みに失敗すると前のまま。DB の版よりファイルが遅れていれば、read は DB の中身にファイルの state を重ねて返し、ファイルは書かない。書き戻しは書く前と起動のとき', t => {
  let failing = false;
  const f = storeFixture(t, { writeFileSync: (path, data) => { if (failing) { writeFileSync(path, data.slice(0, 5)); throw new Error('disk full'); } writeFileSync(path, data); } });
  f.store.writeDraft(PROJECT, f.doc(['one']));
  failing = true;
  assert.throws(() => f.store.writeDraft(PROJECT, f.doc(['two'])), /disk full/u);
  failing = false;
  assert.deepEqual(f.store.read(PROJECT)?.items.map(i => i.result), ['one']);
  assert.deepEqual(readdirSync(f.dir), ['acceptance.json']);

  const draft = f.doc(['one', 'two']);
  draft.items[0]!.state = 'met';
  writeFileSync(f.file, JSON.stringify(draft));
  const v1 = { ...f.doc(['one', 'two']), version: 1 };
  f.db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, created_at) VALUES (?, 1, ?, ?, 'build', 1)").run(PROJECT, frozenHash(v1), JSON.stringify(v1));
  const read = f.store.read(PROJECT)!;
  assert.equal(read.version, 1);
  assert.deepEqual(read.items.map(i => [i.id, i.state]), [['A-1', 'met'], ['A-2', 'open']], 'ファイルの state を重ねる');
  assert.equal((JSON.parse(readFileSync(f.file, 'utf8')) as AcceptanceDoc).version, 0, '読むだけではファイルを書かない');
  assert.equal(f.store.verifyFrozen(PROJECT), 'mismatch', 'ファイルは遅れたまま');

  assert.throws(() => f.store.writeDraft(PROJECT, f.doc(['three'])), (e: Error & { code?: string }) => e.code === 'frozen');
  const repaired = JSON.parse(readFileSync(f.file, 'utf8')) as AcceptanceDoc;
  assert.equal(repaired.version, 1, '書く前に DB の中身から書き戻す');
  assert.deepEqual(repaired.items.map(i => [i.result, i.state]), [['one', 'met'], ['two', 'open']]);
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

test('3-1b 守り: ふつうのファイルの道具とシェルからは acceptance.json を読めない・書けない（判定役が許すと答えても）', async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const dir = join(paths.projects, PROJECT);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'acceptance.json');
  writeFileSync(file, '{"secret":"list"}');
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const policy = buildPolicy(config, paths);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto', project: { id: PROJECT },
  };
  const run = (name: string, args: unknown) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db, () => undefined), db, emit: () => undefined, permissionMode: () => 'auto', lastUserRequest: () => 'edit the list',
    conversationTainted: () => false, conversationAutoRead: () => false, autoClassify: async () => '{"decision":"allow","reason":"ok"}',
  });
  for (const [name, args] of [['file_read', { path: file }], ['file_write', { path: file, content: 'x' }], ['file_edit', { path: file, old: 'secret', new: 'x' }], ['shell_run', { command: `cat "${file.replaceAll('\\', '/')}"` }]] as const) {
    const result = await run(name, args);
    assert.equal(result.decision, 'deny', name);
    assert.doesNotMatch(result.output.content, /"list"/u, name);
  }
  assert.equal(readFileSync(file, 'utf8'), '{"secret":"list"}');
});

test('3-1b 毎回の system: 製品の文書の言語があれば、製品の行のあとに言語の 1 行。無ければ入らない', () => {
  const at = new Date('2026-11-12T00:00:00Z');
  const line = 'Owner-facing documents of this product (plan, acceptance items, questions, deviation notes) are written in ja.';
  assert.ok(buildDynamic('UTC', 'en', at, 'normal', { name: 'Shop', root: 'C:/shop', docLanguage: 'ja' }).split('\n').includes(line));
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'normal', { name: 'Shop', root: 'C:/shop', docLanguage: null }), /Owner-facing/u);
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'normal'), /Owner-facing/u);
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

test('3-1b 道具の一覧（本物の App）: acceptance_write は製品の会話（計画・ふつう）にあり、製品のタスク・子の担当・製品に属さない会話には無い', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b'), reply('c'), reply('d'), reply('e')];
  await s.send(uuid(1), { text: 'plan it', projectId: shop.id, permissionMode: 'plan' });
  assert.ok(s.names().includes('acceptance_write'), s.names().join());
  await s.send(uuid(2), { text: 'do it', projectId: shop.id, permissionMode: 'normal' });
  assert.ok(s.names().includes('acceptance_write'));
  for (const [n, mode] of [[3, 'normal'], [4, 'plan'], [5, 'auto']] as const) {
    await s.send(uuid(n), { text: 'hi', permissionMode: mode });
    assert.ok(!s.names().includes('acceptance_write'), mode);
  }
  s.adapter().scripts = [call('agent_run', { task: 'look' }), call('acceptance_write', { items: [] }), reply('child'), reply('parent')];
  await s.send(uuid(6), { text: 'delegate', projectId: shop.id, permissionMode: 'normal' });
  const child = s.adapter().calls.at(-3)!.tools.map(tool => tool.name);
  assert.ok(child.length > 0 && !child.includes('acceptance_write'), child.join());
  assert.match(s.adapter().calls.at(-2)!.messages.filter(m => m.role === 'tool').at(-1)!.content, /cannot be used|not allowed|not available/iu, '子の担当が名前で呼んでも断られる');
  assert.equal(existsSync(join(s.paths.projects, shop.id, 'acceptance.json')), false);

  const made = await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  assert.equal(made.status, 201);
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(!s.names().includes('acceptance_write'), s.names().join());
});

test('3-1b 登録の順（maxTools: 12）: 製品の計画モードの会話に plan_write と acceptance_write が残る', async t => {
  const s = await setup(t, { models: [fakeModel('m1', { maxTools: 12 })] });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a')];
  await s.send(uuid(1), { text: 'plan', projectId: shop.id, permissionMode: 'plan' });
  for (const name of ['plan_write', 'acceptance_write']) assert.ok(s.names().includes(name), `${name}: ${s.names().join()}`);
  const order = builtinTools().map(tool => tool.name);
  assert.ok(order.indexOf('acceptance_write') > order.indexOf('shell_run'));
});

test('3-1b 一覧の口: 無い間は空の下書きの形。AI の acceptance_write のあとは中身と hash、固定のあとは frozen。無い ID は 404', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const empty = await s.json(`/api/projects/${shop.id}/acceptance`, 'GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { acceptance: { version: 0, language: null, items: [], not_doing: [], draft: true, hash: null, tainted: false, frozen: null } });
  assert.equal((await s.json('/api/projects/aaaaaaaa-0000-4000-8000-999999999999/acceptance', 'GET')).status, 404);
  assert.equal((await s.json('/api/projects/../acceptance', 'GET')).status, 404);

  s.adapter().scripts = [call('acceptance_write', { items: [item('Uploads resume after a restart', { kind: 'owner_words', quote: 'uploads must resume after a restart' })], notDoing: [nd('Accounts')] }), reply('ok')];
  await s.send(uuid(1), { text: 'Uploads must resume after a restart', projectId: shop.id });
  assert.match(s.lastTool(), /1 verified/u);
  const got = (await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance;
  assert.equal(got.draft, true);
  assert.equal(got.version, 0);
  assert.equal(got.items[0].source.kind, 'owner_words');
  assert.equal(got.items[0].source.conversationId, uuid(1));
  assert.deepEqual(got.not_doing.map((n: { id: string }) => n.id), ['N-1']);
  const file = join(s.paths.projects, shop.id, 'acceptance.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as AcceptanceDoc;
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

test('3-1b 一覧の口: よそから来た文を読んだ実行が書いたら tainted: true、あとできれいな会話が書き直しても true のまま。言語は製品のものを使う', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { docLanguage: 'ja' });
  s.adapter().scripts = [reply('hello'), call('acceptance_write', { items: [item('First')] }), reply('ok'), call('acceptance_write', { items: [item('Second')] }), reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  s.app.conversations.markTainted(uuid(1));
  await s.send(uuid(1), { text: 'write it' });
  const dirty = (await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance;
  assert.equal(dirty.tainted, true);
  assert.equal(dirty.language, 'ja');
  await s.send(uuid(2), { text: 'rewrite it', projectId: shop.id });
  const after = (await s.json(`/api/projects/${shop.id}/acceptance`, 'GET')).body.acceptance;
  assert.deepEqual(after.items.map((i: { result: string }) => i.result), ['Second']);
  assert.equal(after.tainted, true, 'きれいな書き直しでは消えない');
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
  assert.equal(readFileSync(join(s.paths.projects, cafe.id, 'plan.md'), 'utf8'), '# Plan', '計画書は書ける');

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
  assert.equal(readFileSync(join(s.paths.projects, dirty.id, 'plan.md'), 'utf8'), '# Plan');
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
  await s.send(uuid(1), { text: 'delegate', projectId: shop.id, permissionMode: 'normal' });
  assert.match(s.adapter().calls.at(-3)!.system.dynamic, LINE, '会話');
  assert.match(s.adapter().calls.at(-2)!.system.dynamic, LINE, '子の担当');
  await s.send(uuid(2), { text: 'hi' });
  assert.doesNotMatch(s.adapter().calls.at(-1)!.system.dynamic, /Owner-facing/u, '製品に属さない会話');
  await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(s.adapter().calls.at(-1)!.system.dynamic, LINE, 'タスク');
});
