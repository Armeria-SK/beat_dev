import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App, builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { startApp } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

const MIN = 60_000;
const FAKE_KEY = 'sk-ant-test-0000000000000000';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

const sent: string[] = [];
const formSend: ToolDef<{ tab?: string }> = {
  name: 'form_send',
  description: 'test: submits a form',
  input: Type.Object({ tab: Type.Optional(Type.String()) }, { additionalProperties: false }),
  effect: 'network',
  allowedIn: ['task'],
  submits: true,
  async execute(input) { sent.push(input.tab ?? ''); return { content: 'sent' }; },
};

async function setup(t: Parameters<typeof startApp>[0], tools?: ToolDef[]) {
  const clock = { now: Date.parse('2026-11-15T09:00:00Z') };
  const s = await startApp(t, { now: () => clock.now, configure: c => { c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.memory.review = false; c.worker.maxRunsPerHour = 100; }, ...(tools ? { tools } : {}) });
  const blocking = (question: string) => toolCall('question_add', { question, why: 'No safe default', options: ['A', 'B'], blocking: true });
  const lastPrompt = () => JSON.stringify(s.adapter().calls.at(-1)!.messages);
  return { ...s, clock, blocking, lastPrompt };
}

const taskCount = (s: { app: App }): number => (s.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

test('5-2b-s ask_user を呼ぶ所が 0（src・web/src・scripts の grep）', () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js|json|md)$/u.test(entry.name) && /ask_user|askUser/u.test(readFileSync(path, 'utf8'))) hits.push(path);
    }
  };
  for (const dir of ['src', join('web', 'src'), 'scripts']) walk(dir);
  assert.deepEqual(hits, []);
  assert.equal(builtinTools().some(tool => tool.name === 'ask_user'), false);
});

test('5-2b-s question_add はタスクの実行に渡る', async t => {
  const s = await setup(t);
  assert.ok(s.app.tools.forRun('task').some(tool => tool.name === 'question_add'));
  assert.ok(!s.app.tools.forRun('chat').some(tool => tool.name === 'question_add'), '会話には渡らない');
});

test('5-2b-s blocking の質問で返事待ちになり、質問票で答えると答えを読んで続く', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Pick a format', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(s.blocking('PDF or Markdown?'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
  assert.equal(s.app.tasks.get(task.id)!.waiting_kind, 'question');
  assert.equal(await s.app.worker.tick(), 'idle', '答えるまで動かない');
  const [question] = s.app.questions.list({ status: 'open', taskId: task.id });
  const answered = await s.json(`/api/questions/${question!.id}/answer`, 'POST', { choice: null, text: 'Markdown, please' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.resumedTaskId, task.id);
  assert.equal(answered.body.fixTaskId, null, '直しのタスクは作らない');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'made it' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.match(s.lastPrompt(), /Markdown, please/u, '答えは次の依頼文に入る');
  assert.equal(taskCount(s), 1, 'タスクは 1 つのまま');
});

test('5-2b-s blocking でない質問ではタスクが止まらない（同じ実行で完了まで進む）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Write it', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('question_add', { question: 'Tone?', why: 'Not stated', options: ['Formal', 'Casual'], chosen: 0 }), toolCall('task_complete', { summary: 'written formally' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  assert.equal(s.app.questions.list({ status: 'open', taskId: task.id }).length, 1, '質問は残り、あとで答えられる');
});

test('5-2b-s /api/tasks/:id/answer は待っている質問の答えの口へ回る（質問が answered になり、DECISIONS.md に 1 行、タスクは続く）', async t => {
  const s = await setup(t);
  const root = join(s.paths.data, 'work', 'shop');
  mkdirSync(root, { recursive: true });
  const shop = s.app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null });
  const task = s.app.tasks.create({ title: 'Payments', origin: 'user', actor: 'user', projectId: shop.id });
  s.adapter().scripts.push(s.blocking('Which provider?'));
  await s.app.worker.tick();
  const [question] = s.app.questions.list({ status: 'open', taskId: task.id });
  const res = await s.json(`/api/tasks/${task.id}/answer`, 'POST', { text: 'Provider B' });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.status, 'ready');
  const row = s.app.questions.get(question!.id)!;
  assert.deepEqual([row.status, row.answer, row.answer_kind], ['answered', 'Provider B', 'changed']);
  assert.equal(row.fix_task_id, null);
  const decisions = readFileSync(join(s.paths.projects, shop.id, 'DECISIONS.md'), 'utf8');
  assert.match(decisions, new RegExp(`question #${question!.id}: changed the answer\\. Owner wrote: "Provider B"\\. AI asked: "Which provider\\?"`, 'u'));
  assert.equal((await s.json(`/api/tasks/${task.id}/answer`, 'POST', { text: 'again' })).status, 409, 'もう返事待ちではない');
  assert.equal(s.app.questions.counts().answered, 1);
});

test('5-2b-s 返事待ちのタスクに質問の行が無ければ /answer は 409（タスクは変えない）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Raw', origin: 'user', actor: 'user' });
  s.app.tasks.setWaiting(task.id, 'question', 'No row');
  assert.equal((await s.json(`/api/tasks/${task.id}/answer`, 'POST', { text: 'x' })).status, 409);
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
});

test('5-2b-s 待っている質問は番号で見分ける: 前の急ぐ質問に答えてもタスクは戻らず、いま待っている質問に答えると戻る', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Two questions', origin: 'user', actor: 'user' });
  s.app.questions.add({ taskId: task.id, question: 'First?', options: ['A', 'B'], blocking: true });
  s.adapter().scripts.push(s.blocking('Second?'));
  await s.app.worker.tick();
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
  const [second, first] = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.deepEqual([first!.question, second!.question], ['First?', 'Second?']);
  assert.equal((await s.json(`/api/questions/${first!.id}/answer`, 'POST', { choice: 0 })).body.resumedTaskId, null);
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting', '前の質問の答えでは戻らない');
  assert.equal((await s.json(`/api/questions/${second!.id}/answer`, 'POST', { choice: 1 })).body.resumedTaskId, task.id);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
});

test('5-2b-s 進まない子は failed になり質問票に stuck の行（Retry / Leave it、止めない）ができ、親がまた選ばれる。Retry でもとのタスクが開き直される', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'Parent job', origin: 'user', actor: 'user' });
  const child = s.app.tasks.create({ title: 'Child job', origin: 'user', actor: 'user', spawnedBy: parent.id });
  for (const wait of [15 * MIN, 30 * MIN, 0]) {
    s.adapter().scripts.push(reply('thinking'));
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.adapter().calls.length > 0 && /Child job/u.test(s.lastPrompt()), true, '子が先に動く（親は子の終わりまで選ばれない）');
    s.clock.now += wait;
  }
  const failed = s.app.tasks.get(child.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.result_summary ?? '', /without progress/u);
  const [stuck] = s.app.questions.list({ status: 'open', taskId: child.id });
  assert.deepEqual([stuck!.kind, stuck!.blocking, stuck!.options, stuck!.chosen], ['stuck', false, ['Retry', 'Leave it'], 1]);

  s.adapter().scripts.push(toolCall('task_complete', { summary: 'parent read the failure' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(s.lastPrompt(), /Parent job/u, '親がまた選ばれる');
  assert.equal(s.app.tasks.get(parent.id)!.status, 'done');

  const retried = await s.json(`/api/questions/${stuck!.id}/answer`, 'POST', { choice: 0 });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.reopenedTaskId, child.id);
  assert.equal(retried.body.fixTaskId, null);
  assert.equal(s.app.tasks.get(child.id)!.status, 'ready', 'もとのタスクが開き直される');
  assert.equal(taskCount(s), 2, '新しいタスクは作らない');
});

test('5-2b-s stuck の答えは DECISIONS.md に「beat asked」で書く（AI の文と書かない）', async t => {
  const s = await setup(t);
  const root = join(s.paths.data, 'work', 'app');
  mkdirSync(root, { recursive: true });
  const project = s.app.projects.create({ name: 'app', root, rootKey: rootKeyOf(root), checkCommand: null });
  const task = s.app.tasks.create({ title: 'Vague', origin: 'user', actor: 'user', projectId: project.id });
  for (const wait of [15 * MIN, 30 * MIN, 0]) { s.adapter().scripts.push(reply('hmm')); await s.app.worker.tick(); s.clock.now += wait; }
  const [stuck] = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.equal((await s.json(`/api/questions/${stuck!.id}/answer`, 'POST', { choice: 1 })).status, 200);
  const decisions = readFileSync(join(s.paths.projects, project.id, 'DECISIONS.md'), 'utf8');
  assert.match(decisions, /kept the assumed answer\. Owner picked: "Leave it"\. beat asked: /u);
  assert.doesNotMatch(decisions, /AI asked/u);
});

test('5-2b-s 取り消して戻したタスク: 急ぐ質問を待つタスクを取り消す → 違う答え → 戻す、でタスクは答えを読んで続き、直しのタスクは作らない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Cancel me', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(s.blocking('Which color?'));
  await s.app.worker.tick();
  assert.equal((await s.json(`/api/tasks/${task.id}/cancel`, 'POST')).status, 200);
  const [question] = s.app.questions.list({ status: 'open', taskId: task.id });
  const answered = await s.json(`/api/questions/${question!.id}/answer`, 'POST', { choice: null, text: 'Blue' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.fixTaskId, null, '取り消したまま待っている質問の答えでは、直しのタスクを作らない');
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
  assert.equal((await s.json(`/api/tasks/${task.id}/uncancel`, 'POST')).status, 200);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready', '戻したら、答えがあるので待たずに実行待ち');
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'blue it is' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(s.lastPrompt(), /Blue/u);
  assert.equal(taskCount(s), 1, '同じ仕事が 2 つにならない');
});

test('5-2b-s 取り消したまま答えていない急ぐ質問は、戻すと返事待ちのまま', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Still waits', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(s.blocking('Which size?'));
  await s.app.worker.tick();
  await s.json(`/api/tasks/${task.id}/cancel`, 'POST');
  await s.json(`/api/tasks/${task.id}/uncancel`, 'POST');
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
});

function prepare(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  return { paths, databasePath: join(dir, 'beat.db') };
}

function open(paths: ReturnType<typeof resolvePaths>, databasePath: string) {
  const logs: string[] = [];
  const app = new App({ paths, databasePath, log: line => { logs.push(line); }, workerTimers: false, env: {} });
  return { app, logs };
}

test('5-2b-s 前からある返事待ちのタスクを、起動時に 1 回 blocking の質問に写す（件数をログに。知らせは出さない）。答えると動く。2 回走っても 1 行', async t => {
  const { paths, databasePath } = prepare(t);
  const first = open(paths, databasePath);
  const waiting = first.app.tasks.create({ title: 'Old wait', origin: 'user', actor: 'user' });
  first.app.tasks.setWaiting(waiting.id, 'question', `Use the key ${FAKE_KEY}​ now?`);
  const empty = first.app.tasks.create({ title: 'Old empty wait', origin: 'user', actor: 'user' });
  first.app.tasks.setWaiting(empty.id, 'question', '');
  const cancelled = first.app.tasks.create({ title: 'Old cancelled wait', origin: 'user', actor: 'user' });
  first.app.tasks.setWaiting(cancelled.id, 'question', 'Cancelled while waiting?');
  first.app.tasks.finish(cancelled.id, 'cancelled', null, 'user');
  const approval = first.app.tasks.create({ title: 'Approval wait', origin: 'user', actor: 'user' });
  first.app.tasks.setWaiting(approval.id, 'approval', '#1');
  first.app.kv.delete('questions:legacy-waits-copied');
  first.app.close();

  const second = open(paths, databasePath);
  try {
    assert.ok(second.logs.includes('[INFO] Copied 3 task(s) waiting for an answer into Questions (answer them there)'), second.logs.join('\n'));
    const rows = second.app.questions.list({ status: 'open' });
    assert.equal(rows.length, 3);
    for (const row of rows) assert.deepEqual([row.kind, row.blocking, row.chosen, row.options], ['ai', true, null, ['Go ahead', 'Stop here']]);
    const copied = rows.find(row => row.task_id === waiting.id)!;
    assert.equal(copied.question, 'Use the key [REDACTED] now?', '鍵らしい文字は伏せ、見えない文字は外す（タスクの文とは違ってよい）');
    assert.equal(rows.find(row => row.task_id === empty.id)!.question, 'The task is waiting for your reply.');
    assert.equal(second.app.notifications.list().filter(n => n.kind === 'question_new').length, 0, '起動のときに写した分の知らせはまとめて出さない');
    assert.equal(second.app.tasks.get(waiting.id)!.waiting_text, `Use the key ${FAKE_KEY}​ now?`, 'タスクの行は変えない');

    const result = second.app.questions.answer(copied.id, { choice: 0 });
    assert.equal(result!.resumedTaskId, waiting.id, '文が違っても番号で見分けて動く');
    assert.equal(second.app.tasks.get(waiting.id)!.status, 'ready');
    second.app.kv.delete('questions:legacy-waits-copied');
  } finally { second.app.close(); }

  const third = open(paths, databasePath);
  try {
    assert.ok(third.logs.includes('[INFO] Copied 0 task(s) waiting for an answer into Questions (answer them there)'), '印を消して 2 回目が走っても写さない');
    assert.equal(third.app.questions.list({ status: 'open' }).length, 2);
    assert.equal((third.app.db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n, 3);
  } finally { third.app.close(); }

  const fourth = open(paths, databasePath);
  try {
    assert.ok(!fourth.logs.some(line => line.startsWith('[INFO] Copied')), '印があれば見もしない');
    assert.equal(fourth.app.tasks.uncancel(cancelled.id, 'user').status, 'waiting', '答えていない写しの質問を待つタスクは、戻すと返事待ち');
  } finally { fourth.app.close(); }
});

test('5-2b-s 写した行はいつも外を読んだ印を持つ: 外を読んだ印がタスクの実行（engine_runs）にだけあり、会話にも経過の文にも無くても', async t => {
  const { paths, databasePath } = prepare(t);
  const first = open(paths, databasePath);
  const conversation = first.app.conversations.create({ kind: 'task' });
  const task = first.app.tasks.create({ title: 'Read the web', origin: 'user', actor: 'user' });
  first.app.tasks.claim(task.id, 30 * MIN, conversation.id);
  first.app.runs.start('run-web', 'task', conversation.id);
  first.app.runs.markTainted('run-web');
  first.app.tasks.setWaiting(task.id, 'question', 'Follow the page?', 'run-web');
  first.app.kv.delete('questions:legacy-waits-copied');
  first.app.close();
  const second = open(paths, databasePath);
  try {
    assert.equal(second.app.conversations.everTainted(conversation.id), false, '会話には印が無い');
    assert.equal(second.app.tasks.textTainted(task.id), false, '経過の文にも印が無い');
    const [row] = second.app.questions.list({ status: 'open', taskId: task.id });
    assert.equal(second.app.questions.get(row!.id)!.tainted, 1);
  } finally { second.app.close(); }
});

const taskRows = (app: App): string => JSON.stringify(app.db.prepare('SELECT * FROM tasks ORDER BY id').all());

for (const count of [0, 1, 4]) {
  test(`5-2b-s 古い返事待ちの写し（${count} 件）: 1 件ずつ 1 行に写し、タスクの行は 1 つも変えない。外を読んだ実行の待ちも同じ`, async t => {
    const { paths, databasePath } = prepare(t);
    const first = open(paths, databasePath);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const conversation = first.app.conversations.create({ kind: 'task' });
      const task = first.app.tasks.create({ title: `Wait ${i}`, origin: 'user', actor: 'user' });
      first.app.tasks.claim(task.id, 30 * MIN, conversation.id);
      if (i === 1) { first.app.runs.start(`run-${i}`, 'task', conversation.id); first.app.runs.markTainted(`run-${i}`); }
      first.app.tasks.setWaiting(task.id, 'question', `Question ${i}?`);
      ids.push(task.id);
    }
    first.app.tasks.create({ title: 'Not waiting', origin: 'user', actor: 'user' });
    first.app.kv.delete('questions:legacy-waits-copied');
    const before = taskRows(first.app);
    first.app.close();
    const second = open(paths, databasePath);
    try {
      assert.ok(second.logs.includes(`[INFO] Copied ${count} task(s) waiting for an answer into Questions (answer them there)`), second.logs.join('\n'));
      assert.equal(taskRows(second.app), before, 'タスクの行は変えない');
      for (const [i, id] of ids.entries()) {
        const rows = second.app.questions.list({ status: 'open', taskId: id });
        assert.deepEqual(rows.map(row => [row.question, row.blocking, second.app.questions.get(row.id)!.tainted]), [[`Question ${i}?`, true, 1]]);
      }
      assert.equal((second.app.db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n, count);
    } finally { second.app.close(); }
  });
}

test('5-2b-s 見えない字だけの古い返事待ちでも起動は止まらず、決まりの文で写す', async t => {
  const { paths, databasePath } = prepare(t);
  const first = open(paths, databasePath);
  const task = first.app.tasks.create({ title: 'Hidden wait', origin: 'user', actor: 'user' });
  first.app.tasks.setWaiting(task.id, 'question', '​​');
  first.app.kv.delete('questions:legacy-waits-copied');
  first.app.close();
  const second = open(paths, databasePath);
  try {
    assert.ok(second.logs.includes('[INFO] Copied 1 task(s) waiting for an answer into Questions (answer them there)'), second.logs.join('\n'));
    assert.deepEqual(second.app.questions.list({ status: 'open', taskId: task.id }).map(row => row.question), ['The task is waiting for your reply.']);
  } finally { second.app.close(); }
});

test('5-2b-s 写せない行があっても、ログに書いて飛ばし、ほかの行は写す', async t => {
  const s = await setup(t);
  const bad = s.app.tasks.create({ title: 'Bad wait', origin: 'user', actor: 'user' });
  s.app.tasks.setWaiting(bad.id, 'question', 'Bad?');
  const good = s.app.tasks.create({ title: 'Good wait', origin: 'user', actor: 'user' });
  s.app.tasks.setWaiting(good.id, 'question', 'Good?');
  const get = s.app.tasks.get.bind(s.app.tasks);
  s.app.tasks.get = (id: string) => { if (id === bad.id) throw new Error('broken row'); return get(id); };
  const logs: string[] = [];
  let copied: number;
  try { copied = s.app.questions.copyLegacyWaits(line => { logs.push(line); }); } finally { s.app.tasks.get = get; }
  assert.equal(copied, 1);
  assert.deepEqual(logs, [`[WARN] Could not copy the wait of task ${bad.id} into Questions: broken row`]);
  assert.deepEqual(s.app.questions.list({ status: 'open', taskId: good.id }).map(row => row.question), ['Good?']);
  assert.equal(s.app.questions.list({ status: 'open', taskId: bad.id }).length, 0);
});

test('5-2b-s 写した行で「Stop here」を選ぶと、返事待ちのタスクは取り消し、取り消し・完了のタスクは答えを残すだけ。直しのタスクは作らない（Go ahead は今までどおり）', async t => {
  const s = await setup(t);
  const make = (title: string) => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user' });
    s.app.tasks.setWaiting(task.id, 'question', `${title}?`);
    return task;
  };
  const waiting = make('Keep going');
  const held = make('Held');
  const done = make('Finished');
  const doneGo = make('Finished too');
  assert.equal(s.app.questions.copyLegacyWaits(), 4);
  s.app.tasks.finish(held.id, 'cancelled', null, 'user');
  s.app.tasks.finish(done.id, 'done', 'finished', 'user');
  s.app.tasks.finish(doneGo.id, 'done', 'finished', 'user');
  const rowOf = (id: string) => s.app.questions.list({ status: 'open', taskId: id })[0]!;
  const before = taskCount(s);

  const stopped = await s.json(`/api/questions/${rowOf(waiting.id).id}/answer`, 'POST', { choice: 1 });
  assert.equal(stopped.status, 200);
  assert.deepEqual([stopped.body.fixTaskId, stopped.body.resumedTaskId], [null, null]);
  assert.equal(s.app.tasks.get(waiting.id)!.status, 'cancelled', '返事待ちは取り消す');
  assert.ok(s.app.tasks.events(waiting.id).some(e => e.kind === 'answer' && /Stop here/u.test(e.content ?? '')));

  const heldAnswer = await s.json(`/api/questions/${rowOf(held.id).id}/answer`, 'POST', { choice: 1 });
  assert.deepEqual([heldAnswer.body.fixTaskId, heldAnswer.body.resumedTaskId], [null, null]);
  assert.equal(s.app.tasks.get(held.id)!.status, 'cancelled');

  const doneAnswer = await s.json(`/api/questions/${rowOf(done.id).id}/answer`, 'POST', { choice: 1 });
  assert.equal(doneAnswer.body.fixTaskId, null);
  assert.equal(s.app.tasks.get(done.id)!.status, 'done');
  assert.equal(taskCount(s), before, 'Stop here ではタスクを作らない');

  const go = await s.json(`/api/questions/${rowOf(doneGo.id).id}/answer`, 'POST', { choice: 0 });
  assert.notEqual(go.body.fixTaskId, null, 'Go ahead は今までどおり（終わったタスクには直しのタスク）');
});

test('5-2b-s stuck の行は、外を読んだタスクの実行の印を引き継ぐ', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Web job', origin: 'user', actor: 'user' });
  for (const wait of [15 * MIN, 30 * MIN, 0]) {
    s.adapter().scripts.push(reply('thinking'));
    await s.app.worker.tick();
    if (wait === 15 * MIN) s.app.db.prepare("UPDATE engine_runs SET tainted = 1 WHERE conversation_id = ? AND kind = 'task'").run(s.app.tasks.get(task.id)!.conversation_id);
    s.clock.now += wait;
  }
  const [row] = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.equal(row!.kind, 'stuck');
  assert.equal(s.app.questions.get(row!.id)!.tainted, 1);
});

test('5-2b-s 取り消したタスクの開いた急ぐ質問の知らせは、読むまで上に残る', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Cancel me', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(s.blocking('Which colour?'));
  await s.app.worker.tick();
  const pinned = () => s.app.notifications.list(0).filter(n => n.kind === 'question_new');
  assert.equal(pinned().length, 1);
  await s.json(`/api/tasks/${task.id}/cancel`, 'POST');
  s.app.settleStaleNotifications();
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
  assert.deepEqual(pinned().map(n => n.read_at), [null]);
});

test('5-2b-s 人のいない実行のフォームの送信は断り、質問票に 1 行（仮の選択 = 送らない）。同じ URL で 2 行にならず、違う URL なら別の行', async t => {
  sent.length = 0;
  const s = await setup(t, [...builtinTools(), formSend]);
  const task = s.app.tasks.create({ title: 'Book a table', origin: 'user', actor: 'user' });
  let url: string | undefined = 'https://example.com/book';
  s.app.browser.tabUrl = () => url;
  s.adapter().scripts.push(toolCall('form_send', { tab: 't1' }), toolCall('form_send', { tab: 't1' }), toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c', resume_after_minutes: 1 }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(sent, [], '送らない');
  const refused = s.app.db.prepare("SELECT output_preview, decision FROM tool_calls WHERE tool = 'form_send'").all() as Array<{ output_preview: string; decision: string }>;
  assert.equal(refused.length, 2);
  assert.ok(refused.every(r => r.decision === 'deny' && r.output_preview.startsWith('Not run: form_send submits in the browser')));
  let rows = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.equal(rows.length, 1, '同じ URL で 2 行にならない');
  assert.deepEqual([rows[0]!.kind, rows[0]!.question, rows[0]!.options, rows[0]!.chosen, rows[0]!.blocking], ['submit_refused', 'Send the form at https://example.com/book?', ['Send it', 'Do not send'], 1, false]);

  url = 'https://example.com/other';
  s.clock.now += 2 * MIN;
  s.adapter().scripts.push(toolCall('form_send', {}), toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c', resume_after_minutes: 1 }));
  await s.app.worker.tick();
  rows = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.deepEqual(rows.map(r => r.question), ['Send the form at https://example.com/other?', 'Send the form at https://example.com/book?']);
});

test('5-2b-s 送信を断った行は、ページが分からないときも 1 行（道具の名前で書く）。「Send it」を選んでも直しのタスクは作らず、会話から自分で送るよう経過に書く', async t => {
  sent.length = 0;
  const s = await setup(t, [...builtinTools(), formSend]);
  const task = s.app.tasks.create({ title: 'Send it', origin: 'user', actor: 'user' });
  s.app.tasks.markUntrusted(task.id, 'question', 'test: text from elsewhere');
  s.adapter().scripts.push(toolCall('form_send', {}), toolCall('form_send', {}), toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c', resume_after_minutes: 1 }));
  await s.app.worker.tick();
  const rows = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.deepEqual(rows.map(r => r.question), ['Send the form in the browser (form_send; the page is not known)?']);
  assert.equal(s.app.questions.get(rows[0]!.id)!.tainted, 1);
  const before = taskCount(s);
  const answered = await s.json(`/api/questions/${rows[0]!.id}/answer`, 'POST', { choice: 0 });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.fixTaskId, null);
  assert.equal(taskCount(s), before, '直しのタスクを作らない');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'answer' && /opens a conversation and sends it there/u.test(e.content ?? '')));
  assert.match(s.app.questions.get(rows[0]!.id)!.why ?? '', /send it there yourself/u);
});

test('5-2b-s 送信を断った行の URL は送り先とパスだけ（問い合わせ・#・利用者名を外す）。同じページなら 1 行で、外を読んだ印は足す。1 タスク 10 行まで', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Many forms', origin: 'user', actor: 'user' });
  const add = (url: string, tainted: boolean) => s.app.questions.addSubmitRefused({ taskId: task.id, projectId: null, conversationId: null, tool: 'form_send', url, tainted });
  const first = add('https://someone:hunter2@example.com/book?token=abc123#step', false);
  assert.equal(first.row.question, 'Send the form at https://example.com/book?');
  assert.equal(first.row.tainted, 0);
  const again = add('https://example.com/book?token=other', true);
  assert.deepEqual([again.added, again.row.id, again.row.tainted], [false, first.row.id, 1]);
  for (let i = 0; i < 15; i += 1) add(`https://example.com/page${i}`, false);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND kind = 'submit_refused'").get(task.id) as { n: number }).n, 10);
});
