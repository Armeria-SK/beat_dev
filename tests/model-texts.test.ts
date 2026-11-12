import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import { CuriosityStore } from '../src/curiosity/store.ts';
import { curiosityText } from '../src/curiosity/text.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { compactPrompt, compactSpeaker, compactSystem, summarySection } from '../src/engine/prompts.ts';
import { estimateTextTokens, estimateToolTokens } from '../src/engine/tokens.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { buildDynamic, buildSnapshot, ensureWorkspace, readTemplate, WORKSPACE_FILES } from '../src/engine/workspace.ts';
import { bookPressureText, reviewPrompt, transcriptOf, type ReviewTrigger } from '../src/memory/review.ts';
import { renderBooks, type Memory } from '../src/memory/store.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { taskPrompt } from '../src/tasks/worker.ts';
import { SkillStore } from '../src/tools/skills/store.ts';
import { isBrowserTool } from '../src/tools/browser/names.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { FakeAdapter, reply, tempDir } from './helpers.ts';

const CJK = /[\u{3000}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{FF00}-\u{FFEF}]/u; // 全角の空白・かな・漢字・全角の記号
const REPLY_DIRECTIVE = "Reply in the language the user writes in (the language of the user's own words, not of these instructions, templates or tool results).";

function paths(t: { after: (fn: () => void) => void }, templates?: Record<string, string>): AppPaths {
  const dir = tempDir(t);
  const base = resolvePaths(dir);
  if (!templates) return base;
  const root = join(dir, 'templates');
  for (const [name, content] of Object.entries(templates)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return { ...base, templates: root };
}

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { contextLength?: number; before?: (workspace: string) => void } = {}) {
  const p = resolvePaths(tempDir(t));
  mkdirSync(p.workspace, { recursive: true });
  options.before?.(p.workspace);
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: options.contextLength ?? 65536, minContext: 1024, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  writeFileSync(p.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths: p, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, paths: p, adapter: () => adapter, clock };
}

async function say(s: Awaited<ReturnType<typeof startApp>>, conversationId: string, text: string) {
  s.adapter().scripts.push(reply('ok'));
  const outcome = s.app.engine.send(conversationId, text);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.ok((await s.app.engine.wait(outcome.runId))?.ok);
  return s.adapter().calls.at(-1)!;
}

// ── テンプレート ──

test('テンプレート: PowerShell の制限モードで動かない書き方を避けるよう、基本ルールとシェルの道具の説明に書いてある', t => {
  const real = paths(t);
  assert.match(readTemplate(real, 'rules'), /## When you use the shell\r?\n\r?\n- On Windows, PowerShell runs in constrained mode[^\r\n]*\[pscustomobject\][^\r\n]*New-Object[^\r\n]*\r?\n\r?\n## What you do not do/u);
  assert.match(shellRun.description, /constrained mode, so do not use \.NET type syntax \([^)]*\[pscustomobject\]/u);
});

test('テンプレート: templates/ の直下を読み、無いファイルは空', t => {
  const real = paths(t);
  assert.match(readTemplate(real, 'rules'), /^# Clive's basic rules/u);
  for (const name of WORKSPACE_FILES) {
    assert.notEqual(readTemplate(real, name), '', `${name} がある`);
  }

  const partial = paths(t, { 'rules.md': 'Rules', 'SOUL.md': 'Soul' });
  assert.equal(readTemplate(partial, 'rules'), 'Rules');
  assert.equal(readTemplate(partial, 'SOUL.md'), 'Soul');
  assert.equal(readTemplate(partial, 'USER.md'), '', '無ければ空');
});

test('テンプレート: 日本語が混ざらず、好奇心リストに項目を足さない', t => {
  const real = paths(t);
  const names = ['rules', ...WORKSPACE_FILES] as const;
  for (const name of names) {
    assert.doesNotMatch(readTemplate(real, name), CJK, `${name}: 日本語が混ざっていない`);
  }
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  assert.equal(new CuriosityStore(db).importMarkdown(readTemplate(real, 'CURIOSITY.md')), 0, 'CURIOSITY.md を取り込んでも項目は増えない');
});

test('初期値の写し: 無いファイルにだけ写す（既存のファイルは上書きしない）', t => {
  const p = paths(t);
  ensureWorkspace(p);
  for (const name of WORKSPACE_FILES) assert.equal(readFileSync(join(p.workspace, name), 'utf8'), readFileSync(join(p.templates, name), 'utf8'));

  const again = paths(t);
  ensureWorkspace(again);
  assert.equal(readFileSync(join(again.workspace, 'SOUL.md'), 'utf8'), readFileSync(join(again.templates, 'SOUL.md'), 'utf8'));

  const existing = paths(t);
  mkdirSync(existing.workspace, { recursive: true });
  writeFileSync(join(existing.workspace, 'SOUL.md'), '# 私の SOUL\n皮肉屋');
  writeFileSync(join(existing.workspace, 'USER.md'), '# 私の USER\n猫が好き');
  ensureWorkspace(existing);
  assert.equal(readFileSync(join(existing.workspace, 'SOUL.md'), 'utf8'), '# 私の SOUL\n皮肉屋', '書かれた SOUL.md はそのまま');
  assert.equal(readFileSync(join(existing.workspace, 'USER.md'), 'utf8'), '# 私の USER\n猫が好き', '書かれた USER.md はそのまま');
  assert.match(readFileSync(join(existing.workspace, 'CURIOSITY.md'), 'utf8'), /^# CURIOSITY\r?\n\r?\nThings that sparked curiosity/u, '無かったファイルだけ初期値が入る');
});

test('起動: 新しい作業フォルダには英語の初期値が入り、すでにある SOUL.md は変わらない', async t => {
  const fresh = await startApp(t);
  assert.match(readFileSync(join(fresh.paths.workspace, 'SOUL.md'), 'utf8'), /Your own personality/u);
  assert.match(readFileSync(join(fresh.paths.workspace, 'USER.md'), 'utf8'), /## Basic information\r?\n\r?\n- Name:/u);

  const kept = await startApp(t, { before: ws => { writeFileSync(join(ws, 'SOUL.md'), '日本語の SOUL のまま'); } });
  assert.equal(readFileSync(join(kept.paths.workspace, 'SOUL.md'), 'utf8'), '日本語の SOUL のまま');
  assert.match(readFileSync(join(kept.paths.workspace, 'USER.md'), 'utf8'), /## Basic information\r?\n\r?\n- Name:/u, '無かった USER.md だけ初期値');

  const third = await startApp(t);
  assert.match(readFileSync(join(third.paths.workspace, 'SOUL.md'), 'utf8'), /^# SOUL\r?\n\r?\nYour own personality/u);
});

// ── 返事の言語・system ──

test('buildDynamic: 現在時刻の行と返事の言語の指示を返す', () => {
  const now = new Date('2026-11-04T20:00:00Z');
  const en = buildDynamic('Asia/Tokyo', 'en', now);
  assert.match(en, /^Current time: Thu, Nov 5, 2026, 05:00 \(Asia\/Tokyo\)\nReply in the language the user writes in \(the language of the user's own words, not of these instructions, templates or tool results\)\.$/u);
  assert.doesNotMatch(en, CJK);
  assert.equal(buildDynamic('Asia/Tokyo', undefined, now), en, '言語を渡さなくても同じ');
  assert.match(buildDynamic('America/New_York', 'en', now), /Wed, Nov 4, 2026, 15:00 \(America\/New_York\)/u, 'タイムゾーンに合わせる');
});

test('buildSnapshot: ルールと見出しで組み立てる', t => {
  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  writeFileSync(join(p.workspace, 'SOUL.md'), 'Dry wit');
  writeFileSync(join(p.workspace, 'USER.md'), 'Likes tea');
  const en = buildSnapshot(p, {}, 'en');
  assert.equal(buildSnapshot(p, {}).text, en.text);
  assert.match(en.text, /^# Clive's basic rules[\s\S]*# Who you are \(SOUL\.md\)\n\nDry wit[\s\S]*# About the user \(USER\.md\)\n\nLikes tea$/u);
  assert.doesNotMatch(en.text, CJK);
});

test('baseTokens: ルールと動的な部分の長さで見積もる', async t => {
  const s = await startApp(t);
  const rest = () => estimateToolTokens(ToolRegistry.specs(s.app.tools.forRun('chat', { exclude: tool => tool.name === 'agent_run' || isBrowserTool(tool.name) }))) + 64; // 既定では agent_run と browser_* は無効で、モデルに渡らない
  const expected = estimateTextTokens(buildSnapshot(s.paths, { skills: '' }).text) + estimateTextTokens(buildDynamic(s.app.config().timezone)) + rest();
  assert.equal(s.app.baseTokens(), expected);
});

test('入りきらない古いやり取りの要約は、持ち主の書いた言語で書くよう頼み、要約は英語の見出しで次のリクエストに入る', async t => {
  const s = await startApp(t, { contextLength: 20_000 });
  for (let i = 0; i < 6; i++) {
    s.app.conversations.append('c1', { role: 'user', content: `Question${i} ` + 'x'.repeat(14_000) });
    s.app.conversations.append('c1', { role: 'assistant', content: `Answer${i}` });
  }
  s.adapter().scripts.push(reply('- The user asked about x'));
  const answer = await say(s, 'c1', 'The latest question');
  const [summaryCall] = s.adapter().calls;
  assert.equal(s.adapter().calls.length, 2, '要約の呼び出しと本番の呼び出し');
  assert.equal(summaryCall!.system.frozen, compactSystem('en'));
  const asked = (summaryCall!.messages[0] as { content: string }).content;
  assert.match(asked, /^This is the older part of a conversation\. Summarize, concisely as bullet points in the language the user writes in \(the language of the "User:" lines\), /u);
  assert.match(asked, /\nUser: Question0 /u);
  assert.match(asked, /\nClive: Answer0/u);
  assert.doesNotMatch(asked, CJK);
  assert.match(answer.system.dynamic, /# Summary of the conversation so far[\s\S]*The user asked about x/u);
  assert.doesNotMatch(answer.system.dynamic, CJK);
});

// ── 決まり文 ──

test('決まり文: モデルに渡す文に日本語が混ざらない', t => {
  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skills = new SkillStore(db, join(p.workspace, 'skills'));
  skills.write({ name: 'weekly-report', description: 'Write the weekly report', body: 'Steps' });
  const memories: Memory[] = [
    { id: 1, book: 'user', content: 'Likes tea', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 },
    { id: 2, book: 'notes', content: 'Lesson', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 },
  ];
  const task = { id: 'abcdef12-0000', title: 'Write the invoice', origin: 'curiosity', body: 'Details', next_action: 'Sum it up', done_criteria: 'Sent' } as any;
  const events = [{ kind: 'note', content: 'Started', created_at: Date.parse('2026-11-04T20:00:00Z') }];
  const stored = [
    { id: 1, role: 'user', text: 'Hello', message: { role: 'user' } },
    { id: 2, role: 'assistant', text: 'Hi', message: { role: 'assistant' } },
    { id: 3, role: 'tool', text: 'out', message: { role: 'tool', name: 'file_list' } },
  ] as any;
  const triggers: ReviewTrigger[] = ['task', 'idle', 'heavy_run', 'book_full', 'manual'];
  const pressure = { tokens: 900, budget: 500, outside: [{ id: 1, book: 'user' as const, content: 'Old fact' }, { id: 2, book: 'notes' as const, content: 'Old lesson' }] };
  const texts: Record<string, string> = {
    books: renderBooks(memories, 'en'),
    skills: skills.index('en'),
    summary: summarySection('A summary', 'en'),
    compactSystem: compactSystem('en'),
    compact: compactPrompt({ previous: 'Before', transcript: 'User: hi' }, 'en'),
    speakers: ['user', 'assistant', 'tool'].map(role => compactSpeaker({ role, name: 'file_list' }, 'en')).join(' '),
    task: taskPrompt(task, events, 'Asia/Tokyo', 'en'),
    transcript: transcriptOf(stored, 15_000, 'en'),
    pressure: bookPressureText(pressure, 'en'),
    curiosity: Object.values(curiosityText('en')).map(v => (typeof v === 'function' ? v('Topic') : v)).join('\n'),
    ...Object.fromEntries(triggers.map(trigger => [`review:${trigger}`, reviewPrompt({
      trigger, language: 'en', forgotten: ['Forgotten fact'], bookPressure: bookPressureText(pressure, 'en'),
      task: { title: 'T', status: 'done', result_summary: 'Result', body: 'Body' }, taskEvents: [{ kind: 'note', content: 'Event' }], transcript: transcriptOf(stored, 15_000, 'en'),
    })])),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.length > 0, `${name}: 空ではない`);
    assert.doesNotMatch(text, CJK, `${name}: 日本語が混ざっている`);
  }
  assert.match(texts.task!, /^\[Task run\]/u);
  assert.match(texts.task!, /Where it came from: From your curiosity/u);
  assert.match(texts['review:book_full']!, /Memory usage\nMemory totals about 900 tokens, over the guideline for what goes into a conversation \(about 500 tokens\)\. 2 memories do not fit in a conversation\. Propose merging overlapping memories and trimming old ones\nMemories that do not fit \(oldest first\):\n- \[u1\] Old fact\n- \[n2\] Old lesson/u);
});

test('決まり文: 言語を渡さない呼び出しは英語', () => {
  const memories: Memory[] = [{ id: 1, book: 'user', content: '紅茶', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 }];
  assert.equal(renderBooks(memories), renderBooks(memories, 'en'));
  assert.match(renderBooks(memories), /^# What you remember \(memory\)\n\n## Memories about the user\n- \[u1\] 紅茶$/u);
  assert.match(reviewPrompt({ trigger: 'idle', forgotten: [] }), /^\[Review\] Trigger: The conversation went quiet\./u);
});

// ── 英語の決まり文の全文（材料の日本語は訳さずにそのまま渡す。メモ・記憶は材料の言語で書かせる） ──

const EN_TASK_HEAD = [
  '[Task run] You are now working on a task from your own notepad (this is not a conversation with the user; your reply is saved to the record).',
  '',
  '# Task',
];
const EN_TASK_HOW = [
  '',
  '# How to proceed',
  '- Make progress with your tools. Do not overdo it in a single run',
  '- When you are done, call task_complete (a summary of the result). If there is nothing to tell the user, finish quietly with notify=false',
  '- To continue later or to wait for something, call task_checkpoint (what you tried, the result, the next step, and how many minutes until you resume)',
  '- Use ask_user only for what you cannot move forward on without checking with the user',
  "- Write notes, questions and the summary in the language the user writes in: the language of the user's own words in the title and details (for a curiosity task, the language of the topic), not the language of these instructions",
];
const EN_REVIEW_POLICY = [
  '',
  '# Policy',
  '- Keep only "lessons and facts that will help next time". Do not keep a log of events',
  '- Do not add what is already in memory. Merge overlapping memories into one with memory_update, and drop the one you no longer need with memory_forget',
  '- If two memories contradict, keep the newer one',
  '- Facts about the user that were missed (preferences, plans, relationships, environment): memory_save (book=user). Your own lessons: book=notes',
  '- Add at most 3 items from a single record',
  '- If you find a procedure that looks reusable, use skill_draft (it is not used until the user approves it). Prefer fixing an existing skill over creating a new one',
  '- If something caught your interest but you have not looked into it, use curiosity_add',
  '- If there is nothing to do, use no tools and reply only "No changes" (exactly these English words, whatever language you write in otherwise)',
  '- At the end, report what you did in one or two sentences',
  "- Write memories, skill drafts, curiosity items and your final reply in the language the user writes in: the language of the [User] lines in the record below (if there are none, the language of the user's own words in the task's title and notes). Only the reply \"No changes\" stays in English",
];
const EN_TIDY_POLICY = [
  '',
  '# Policy',
  '- The purpose this time is to propose how to tidy up memory. Do not learn anything new (memory_save is not available)',
  '- Of the memories listed below that do not fit in a conversation, you may merge only the clearly overlapping ones into one with memory_update. memory_forget is not available (the user decides what to delete)',
  '- Write the memories you think should be deleted or merged in your final reply, one per line, like "[n3] Delete: reason (short)" or "[u1] [u4] Merge: reason (short)". At most 10 lines',
  '- Prefer outdated memories, ones that overlap with others, and ones about temporary events. Do not list important facts about the user',
  '- If there is nothing to propose, use no tools and reply only "No changes" (exactly these English words, whatever language you write in otherwise)',
  '- Write merged memories and your final reply in the language the user writes in: the language the listed memories are written in. Only the reply "No changes" stays in English',
];
const enReviewIntro = (trigger: string) => `[Review] Trigger: ${trigger}. Read the record below and tidy up your memory (this is not a conversation with the user; your reply is only saved to the record).`;

test('英語の固定文: タスクの実行の指示の全文（日本語のタスクの中身は訳さずに入る）', () => {
  const task = { id: 'abcdef12-0000', title: '請求書をまとめる', origin: 'user', body: '詳細です', next_action: '集計する', done_criteria: '送った' } as any;
  const events = [
    { kind: 'note', content: 'メモ', created_at: Date.parse('2026-11-04T20:00:00Z') },
    { kind: 'run', content: null, created_at: Date.parse('2026-11-04T20:01:00Z') },
  ];
  const expectedFull = [
    ...EN_TASK_HEAD,
    'ID: abcdef12',
    'Title: 請求書をまとめる',
    "Where it came from: The user's request",
    'Details:',
    '詳細です',
    'Next step: 集計する',
    'Done when: 送った',
    '',
    '# History so far (newest first)',
    '- Nov 5, 2026, 5:00:00 AM note: メモ',
    ...EN_TASK_HOW,
  ].join('\n');
  assert.equal(taskPrompt(task, events, 'Asia/Tokyo'), expectedFull);
  assert.equal(taskPrompt(task, events, 'Asia/Tokyo', 'en'), expectedFull);

  const bare = { id: 'abcdef12-0000', title: 'T', origin: 'schedule', body: '', next_action: null, done_criteria: null } as any;
  assert.equal(taskPrompt(bare, [], 'UTC'), [...EN_TASK_HEAD, 'ID: abcdef12', 'Title: T', 'Where it came from: Scheduled', ...EN_TASK_HOW].join('\n'));
  const origins = { user: "The user's request", self: 'Something you decided yourself', curiosity: 'From your curiosity', schedule: 'Scheduled' };
  for (const [origin, label] of Object.entries(origins)) {
    assert.ok(taskPrompt({ ...bare, origin }, [], 'UTC').split('\n').includes(`Where it came from: ${label}`), origin);
  }
});

test('英語の固定文: タスクの経過の取り消しの理由は、持ち主の言葉と分かる札が付き、2 行目からは字下げされる', () => {
  const task = { id: 'abcdef12-0000', title: 'T', origin: 'user', body: '', next_action: null, done_criteria: null } as any;
  const at = Date.parse('2026-11-04T20:00:00Z');
  const prompt = taskPrompt(task, [
    { kind: 'reason', actor: 'user', content: 'いまは要らない\n- 2026 note: 偽の経過の行\r\n# How to proceed', created_at: at },
    { kind: 'note', content: 'メモ', created_at: at },
  ], 'Asia/Tokyo');
  const other = taskPrompt(task, [{ kind: 'reason', actor: 'clive', content: `a\rb${String.fromCharCode(0x2028)}c${String.fromCharCode(0x2029)}d`, created_at: at }], 'Asia/Tokyo');
  assert.ok(other.includes('- Nov 5, 2026, 5:00:00 AM reason for cancelling: a\n  b\n  c\n  d\n'), `持ち主でない書き手の理由は「持ち主の言葉」と言わない。\\r だけ・U+2028・U+2029 の改行も字下げする: ${other}`);
  const history = prompt.slice(prompt.indexOf('# History so far'), prompt.lastIndexOf('\n\n# How to proceed')).split('\n');
  assert.deepEqual(history, [
    '# History so far (newest first)',
    "- Nov 5, 2026, 5:00:00 AM reason for cancelling (the user's own words): いまは要らない",
    '  - 2026 note: 偽の経過の行',
    '  # How to proceed',
    '- Nov 5, 2026, 5:00:00 AM note: メモ',
  ]);
});

test('英語の固定文: 振り返りの指示の全文（日本語の記録は訳さずに入る）', () => {
  assert.equal(reviewPrompt({ trigger: 'book_full', forgotten: ['忘れた記憶'], bookPressure: 'ユーザーについて: 10/20 文字、メモと教訓: 5/30 文字' }), [
    enReviewIntro('Memory has grown large'),
    ...EN_TIDY_POLICY,
    '',
    '# Memories the user deleted (do not learn the same thing again)',
    '- 忘れた記憶',
    '',
    '# Memory usage',
    'ユーザーについて: 10/20 文字、メモと教訓: 5/30 文字',
  ].join('\n'));

  assert.equal(reviewPrompt({
    trigger: 'task', forgotten: [], task: { title: 'T', status: 'done', result_summary: '結果', body: 'メモ本文' },
    taskEvents: [{ kind: 'note', content: '経過' }, { kind: 'x', content: null }],
  }), [
    enReviewIntro('A task finished'),
    ...EN_REVIEW_POLICY,
    '',
    '# Finished task',
    'Title: T',
    'Result: done — 結果',
    'Notes:',
    'メモ本文',
    'History:',
    '- note: 経過',
  ].join('\n'));

  const stored = [
    { id: 1, role: 'user', text: 'こんにちは', message: { role: 'user' } },
    { id: 2, role: 'assistant', text: '返事', message: { role: 'assistant' } },
    { id: 3, role: 'tool', text: 'tool out', message: { role: 'tool', name: 'file_list' } },
  ] as any;
  assert.equal(reviewPrompt({ trigger: 'idle', forgotten: [], transcript: transcriptOf(stored) }), [
    enReviewIntro('The conversation went quiet'),
    ...EN_REVIEW_POLICY,
    '',
    '# Record of the conversation',
    '[User] こんにちは',
    '[Clive] 返事',
    '[Tool file_list] tool out',
  ].join('\n'));

  const triggers = { task: 'A task finished', idle: 'The conversation went quiet', heavy_run: 'Many tools were used', book_full: 'Memory has grown large', manual: 'Manual' };
  for (const [trigger, label] of Object.entries(triggers)) {
    assert.equal(reviewPrompt({ trigger: trigger as ReviewTrigger, forgotten: [] }).split('\n')[0], enReviewIntro(label), trigger);
  }
  const long = [
    { id: 1, role: 'user', text: 'あ'.repeat(3100), message: { role: 'user' } },
    { id: 2, role: 'tool', text: 'い'.repeat(310), message: { role: 'tool', name: 'file_list' } },
  ] as any;
  assert.equal(transcriptOf(long), `[User] ${'あ'.repeat(3000)}… (truncated)\n[Tool file_list] ${'い'.repeat(300)}… (truncated)`);
  assert.equal(bookPressureText({ tokens: 900, budget: 500, outside: [{ id: 1, book: 'user', content: '古い事実' }, { id: 2, book: 'notes', content: '古い教訓' }] }), [
    'Memory totals about 900 tokens, over the guideline for what goes into a conversation (about 500 tokens). 2 memories do not fit in a conversation. Propose merging overlapping memories and trimming old ones',
    'Memories that do not fit (oldest first):',
    '- [u1] 古い事実',
    '- [n2] 古い教訓',
  ].join('\n'));
});

test('英語の固定文: スキル一覧・好奇心のタスクの文の全文', t => {
  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skills = new SkillStore(db, join(p.workspace, 'skills'));
  assert.equal(skills.index(), '');
  skills.write({ name: 'weekly-report', description: '週報を書くとき', body: '手順' });
  skills.write({ name: 'deploy', description: 'デプロイするとき', body: '手順' });
  const expectedSkills = ['# Skills (procedures)', 'Before doing any of the work below, first read the procedure with skill_view and then follow it.', '- deploy: デプロイするとき', '- weekly-report: 週報を書くとき'].join('\n');
  assert.equal(skills.index(), expectedSkills);
  assert.equal(skills.index('en'), expectedSkills);

  const text = curiosityText('en');
  assert.equal(text.title('X'), 'Look into: X');
  assert.equal(text.why('Y'), 'Why this caught your interest: Y');
  assert.equal(text.summarize, 'Sum up what you find out, briefly and in a form that is useful to the user.');
  assert.equal(text.doneCriteria, 'The findings are written up in the summary of task_complete');
  assert.equal(text.doneCriteriaQuiet, 'The findings are written up in the summary of task_complete (use notify=false if they are not worth telling the user)');
});

// ── 実際の流れ ──

test('裏で動くタスクの実行の指示が英語で渡り、返事の言語の指示が付く', async t => {
  const s = await startApp(t);
  s.app.tasks.create({ title: 'Check the report', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(reply('thinking it over'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls[0]!;
  const first = request.messages[0]!;
  assert.match(first.role === 'user' ? first.content : '', /^\[Task run\] You are now working on a task/u);
  assert.match(request.system.frozen, /^# Clive's basic rules/u);
  assert.ok(request.system.dynamic.includes(REPLY_DIRECTIVE));
});

test('裏で動く振り返りの指示が英語で渡る（日本語の会話の記録は、そのまま材料として渡る）', async t => {
  const s = await startApp(t);
  await s.app.worker.tick();
  await say(s, 'c1', '今日は渋谷で打ち合わせ');
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(reply('No changes'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls.at(-1)!;
  const prompt = String(request.messages.at(-1)?.content);
  assert.match(prompt, /^\[Review\] Trigger: Manual\./u);
  assert.match(prompt, /# Policy\n- Keep only/u);
  assert.match(prompt, /\[User\] 今日は渋谷で打ち合わせ/u, '会話の記録は訳さずに渡す');
  assert.ok(request.system.dynamic.includes(REPLY_DIRECTIVE));
});
