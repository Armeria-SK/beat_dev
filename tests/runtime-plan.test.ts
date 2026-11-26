import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatMessage } from '../src/engine/types.ts';
import { runtimePlanTools } from '../src/engine/runtime-plan-tools.ts';
import { frozenHash } from '../src/projects/acceptance.ts';
import { settled, uuid, waitFor } from './app-setup.ts';
import { rig } from './helpers/runtime-rig.ts';
import type { Script } from './helpers/scripted-runtime.ts';

// AR-9b: 計画モードの会話で、外の実行役（Claude Code・Codex）が beat の計画・受け入れの一覧を作れる。書くのは beat 自身の道具（plan_write など）で、実行役にファイル・コマンドの許可は足さない

type Rig = Awaited<ReturnType<typeof rig>>;
let n = 900;

const PLAN = '# Notes app\n\n## Goal\nKeep short notes in a local JSON file.\n\n## Scope\n- in: add, list, delete\n- out: sync\n\n## Steps\n- write src/notes.js\n- write tests/notes.test.js and run node --test\n';
const ITEMS = {
  items: [
    { result: 'A note added through the app is listed after a restart', source: 'ai_added', check: 'command', command: 'npm test' },
    { result: 'Deleting a note removes it from the list', source: 'ai_added', check: 'look' },
  ],
  notDoing: [{ text: 'Syncing notes between devices', source: 'ai_added' }],
};

const answerOf = (r: Rig, id: string) => r.runtime.approvals.find(a => a.requestId === id)?.decision;
const untilAnswer = (r: Rig, id: string) => waitFor(() => answerOf(r, id) !== undefined, `answer to ${id}`);
const count = (r: Rig, sql: string) => (r.s.app.db.prepare(sql).get() as { c: number }).c;
const toolRows = (r: Rig, conversation: string) => r.rows(conversation).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');

async function start(r: Rig, projectId: string, extra: Record<string, unknown> = {}) {
  const conversation = uuid(++n);
  const sent = await r.send(conversation, 'plan a notes app', { projectId, modelId: 'cc', permissionMode: 'plan', ...extra });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  return { conversation, runId: sent.body.runId as string };
}

// Claude Code の計画モードの会話: 実行役が MCP の道具（mcp__beat__*）を呼ぶ。承認の求めには、窓口が確かめた beatTool の印が付く
const claudeScript = (r: Rig): Script => async feed => {
  const tools = r.runtime.starts[0]!.planTools!;
  feed.push({ type: 'text', delta: 'Writing the plan. ' });
  for (const [id, name, input] of [['tu_plan', 'plan_write', { content: PLAN, language: 'en' }], ['tu_items', 'acceptance_write', ITEMS]] as const) {
    feed.push({ type: 'tool_start', id, name: `mcp__beat__${name}`, input });
    feed.push({ type: 'approval', requestId: id, tool: `mcp__beat__${name}`, input, beatTool: name });
    await untilAnswer(r, id);
    assert.equal(answerOf(r, id), 'accept', `${name} is allowed in plan mode`);
    const result = await tools.call(name, input);
    feed.push({ type: 'tool_end', id, output: result.text, isError: result.isError });
  }
  feed.push({ type: 'text', delta: 'The plan is in the Plan pane.' });
  feed.done();
};

test('Claude Code の計画モード: 実行役が beat の計画の道具を呼ぶと、計画と受け入れの項目が書かれ、Plan 画面に出る（Build ができる状態）', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = claudeScript(r);
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);

  const begun = r.runtime.starts[0]!;
  assert.equal(begun.permission, 'default', 'still started with the most careful permission');
  assert.deepEqual(begun.planTools!.specs.map(spec => spec.name), ['plan_write', 'acceptance_write']);
  assert.match(begun.instructions!, /mcp__beat__plan_write/u);
  assert.doesNotMatch(begun.instructions!, /beat-plan/u, 'the block format is for the runtime that has no tools');
  assert.doesNotMatch(begun.instructions!, /ask_owner/u);

  const view = r.s.app.plans.view(projectId, conversation);
  assert.equal(view.content, PLAN, 'the Plan pane has the plan');
  assert.equal(view.updated_by, 'ai');
  assert.equal(view.tainted, true, 'a plan written by a runtime that read outside carries the mark');
  const draft = r.s.app.acceptance.read(projectId, conversation)!;
  assert.deepEqual(draft.items.map(item => item.result), ITEMS.items.map(item => item.result));
  assert.equal(draft.notDoing.length, 1);

  // 画面の Plan 欄が読む API からも同じ（ストアを直に読んだ上の確かめとは別の道）
  const pane = await r.s.json(`/api/projects/${projectId}/plan?conversationId=${conversation}`, 'GET');
  assert.equal(pane.status, 200, JSON.stringify(pane.body));
  assert.equal(pane.body.plan.content, PLAN);
  const items = await r.s.json(`/api/projects/${projectId}/acceptance?conversationId=${conversation}`, 'GET');
  assert.equal(items.status, 200, JSON.stringify(items.body));
  assert.deepEqual(items.body.acceptance.items.map((item: { result: string }) => item.result), ITEMS.items.map(item => item.result));
  // 画面の Build ボタンが呼ぶ道（書いた計画と受け入れの項目のハッシュで）が、そのまま通る
  const built = await r.s.json(`/api/projects/${projectId}/build`, 'POST', { planHash: view.hash, acceptanceHash: frozenHash(draft), conversationId: conversation });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.task.title, 'Build: prod');

  // beat の道具の道を通った: 道具の記録・計画の変更の出来事・控えが beat の側に残る。画面の行は実行役の道具の行 1 つずつ（二重に出ない）
  assert.deepEqual((r.s.app.db.prepare('SELECT tool FROM tool_calls ORDER BY rowid').all() as Array<{ tool: string }>).map(row => row.tool), ['plan_write', 'acceptance_write']);
  assert.ok(r.events.some(e => e.type === 'plan.changed'), 'the Plan pane is told');
  assert.deepEqual(toolRows(r, conversation).map(m => [m.name, m.isError, m.gate]), [['claude-code:mcp__beat__plan_write', undefined, { by: 'runtime' }], ['claude-code:mcp__beat__acceptance_write', undefined, { by: 'runtime' }]]);
  assert.equal(r.events.filter(e => e.type === 'tool.call' && e.runId === runId).length, 2);
  assert.equal(r.events.filter(e => e.type === 'tool.result' && e.runId === runId).length, 2);
  assert.equal(JSON.parse(r.s.app.runs.get(runId)!.runtime!).plan, 'tools');
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
});

test('計画モードで通すのは beat の計画の道具だけ: ほかの書く・動かす・読む求めと、印の無い mcp__beat__ の名前は、計画モードだと名指しして断る', async t => {
  const r = await rig(t, { permission: 'acceptEdits' });
  const { id: projectId, root } = await r.product();
  await r.check();
  const requests = [
    { id: 'x-write', tool: 'Write', input: { file_path: join(root, 'new.txt'), content: 'hello' } },
    { id: 'x-bash', tool: 'Bash', input: { command: 'ls' } },
    { id: 'x-read', tool: 'Read', input: { file_path: join(root, 'a.txt') } },
    { id: 'x-spoof', tool: 'mcp__beat__plan_write', input: { content: PLAN } },
    { id: 'x-other-server', tool: 'mcp__github__plan_write', input: { content: PLAN }, beatTool: undefined },
    { id: 'x-not-offered', tool: 'mcp__beat__acceptance_change', input: { changes: [] }, beatTool: 'acceptance_change' },
  ];
  r.runtime.script = async feed => {
    for (const q of requests) feed.push({ type: 'approval', requestId: q.id, tool: q.tool, input: q.input, ...(q.beatTool ? { beatTool: q.beatTool } : {}) });
    for (const q of requests) await untilAnswer(r, q.id);
    feed.done();
  };
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);

  assert.deepEqual(requests.map(q => answerOf(r, q.id)), requests.map(() => 'decline_by_beat'));
  for (const q of requests) {
    const note = r.runtime.notes.get(q.id)!;
    assert.match(note, /plan mode/u, `${q.id}: the runtime is told it is plan mode`);
    assert.match(note, /switch this conversation to Normal mode/u);
    assert.match(note, /reading outside the product folder or reading protected paths/u, 'a declined read is covered by the same note');
    assert.doesNotMatch(note, /you can read files/u, 'the note does not promise reads it may be declining');
    assert.doesNotMatch(note, /You were not asked|you were not asked/u, 'the owner-facing wording is not given to the model');
  }
  assert.equal(count(r, 'SELECT COUNT(*) AS c FROM pending_actions'), 0, 'plan mode never asks the owner');
  assert.equal(count(r, 'SELECT COUNT(*) AS c FROM tool_calls'), 0, 'no beat tool ran');
  assert.equal(r.s.app.plans.view(projectId, conversation).content, null);
  assert.deepEqual(toolRows(r, conversation).map(m => m.gate), requests.map(() => ({ by: 'guard', key: 'plan_mode' })), 'the owner sees each decline as a plan mode decline');
  assert.match(toolRows(r, conversation)[0]!.content, /plan mode/u);
});

test('計画モードでない会話には、計画の道具も計画の指示も付かない。守りで断るときは、断った守りを実行役へ名指しで返す', async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product();
  await r.check();
  const outside = join(r.products, 'elsewhere', 'x.txt');
  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'g-out', tool: 'Write', input: { file_path: outside, content: 'x' } });
    feed.push({ type: 'approval', requestId: 'g-secret', tool: 'Read', input: { file_path: join(root, '.env') } });
    await untilAnswer(r, 'g-out');
    await untilAnswer(r, 'g-secret');
    feed.done();
  };
  const { runId } = await start(r, projectId, { permissionMode: 'auto' });
  await settled(r.s.app, runId);
  assert.equal('planTools' in r.runtime.starts[0]!, false);
  assert.equal('instructions' in r.runtime.starts[0]!, false);
  assert.deepEqual([answerOf(r, 'g-out'), answerOf(r, 'g-secret')], ['decline_by_beat', 'decline_by_beat']);
  assert.match(r.runtime.notes.get('g-out')!, /\[beat guard: outside_write\]/u);
  assert.match(r.runtime.notes.get('g-out')!, /outside the product folder/u);
  assert.match(r.runtime.notes.get('g-secret')!, /\[beat guard: secret\]/u);
  assert.doesNotMatch(r.runtime.notes.get('g-out')!, /plan mode/u, 'a guard is not blamed on plan mode');
  assert.equal(JSON.parse(r.s.app.runs.get(runId)!.runtime!).plan, null);
});

// Codex の計画モードの会話: 道具を渡せないので、返事の中の決まった塊を beat が取り出して、同じ道具で書く
const CODEX_REPLY = `I read the folder. The plan is saved.\n\n<beat-plan language="en">\n${PLAN}</beat-plan>\n\n<beat-acceptance>\n${JSON.stringify(ITEMS)}\n</beat-acceptance>\n`;

test('Codex の計画モード: 返事の中の計画・受け入れの塊を beat が取り出し、beat の道具で書く。ほかの承認は計画モードだと断る', async t => {
  const r = await rig(t, { kind: 'codex' });
  const { id: projectId, root } = await r.product();
  await r.check();
  r.runtime.script = async feed => {
    feed.push({ type: 'approval', requestId: 'c-cmd', tool: 'commandExecution', input: { command: 'ls' } });
    feed.push({ type: 'approval', requestId: 'c-file', tool: 'fileChange', input: { path: join(root, 'x.txt') } });
    await untilAnswer(r, 'c-cmd');
    await untilAnswer(r, 'c-file');
    feed.push({ type: 'text', delta: CODEX_REPLY });
    feed.done();
  };
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);

  const begun = r.runtime.starts[0]!;
  assert.equal('planTools' in begun, false, 'no tools are offered to Codex');
  assert.match(begun.instructions!, /<beat-plan language="en">/u);
  assert.doesNotMatch(begun.instructions!, /mcp__beat__/u);
  assert.equal(begun.permission, 'read-only', 'Codex too is started with its most careful permission');

  assert.equal(r.s.app.plans.view(projectId, conversation).content, PLAN.trimEnd());
  assert.equal(r.s.app.plans.view(projectId, conversation).updated_by, 'ai');
  const pane = await r.s.json(`/api/projects/${projectId}/plan?conversationId=${conversation}`, 'GET');
  assert.equal(pane.body.plan.content, PLAN.trimEnd(), 'the Plan pane API shows it too');
  assert.deepEqual(r.s.app.acceptance.read(projectId, conversation)!.items.map(item => item.result), ITEMS.items.map(item => item.result));
  assert.deepEqual((r.s.app.db.prepare('SELECT tool FROM tool_calls ORDER BY rowid').all() as Array<{ tool: string }>).map(row => row.tool), ['plan_write', 'acceptance_write'], 'written through beat\'s own tools');
  assert.ok(r.events.some(e => e.type === 'plan.changed'));
  assert.deepEqual(toolRows(r, conversation).map(m => [m.name, m.isError, m.gate]), [
    ['codex:commandExecution', true, { by: 'guard', key: 'plan_mode' }], ['codex:fileChange', true, { by: 'guard', key: 'plan_mode' }],
    ['codex:plan_write', undefined, { by: 'runtime' }], ['codex:acceptance_write', undefined, { by: 'runtime' }],
  ]);
  assert.deepEqual(['c-cmd', 'c-file'].map(id => answerOf(r, id)), ['decline_by_beat', 'decline_by_beat']);
  assert.equal(count(r, 'SELECT COUNT(*) AS c FROM pending_actions'), 0);
  assert.equal(JSON.parse(r.s.app.runs.get(runId)!.runtime!).plan, 'text');
});

test('Codex の塊が読めない・beat の道具が断る（秘密の文字列など）ときは、何も保存せず、断った理由が行に残る。実行は失敗にならない', async t => {
  const r = await rig(t, { kind: 'codex' });
  const { id: projectId } = await r.product();
  await r.check();
  const broken = `<beat-plan language="en">\n   \n</beat-plan>\n<beat-acceptance>\n{not json\n</beat-acceptance>`;
  r.runtime.script = feed => { feed.push({ type: 'text', delta: broken }); feed.done(); };
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  const rows = toolRows(r, conversation);
  assert.deepEqual(rows.map(m => [m.name, m.isError]), [['codex:plan_write', true], ['codex:acceptance_write', true]]);
  assert.match(rows[0]!.content, /could not read the plan_write block/u);
  assert.equal(r.s.app.plans.view(projectId, conversation).content, null);
  assert.equal(r.s.app.acceptance.read(projectId, conversation), undefined);
  assert.equal(count(r, 'SELECT COUNT(*) AS c FROM tool_calls'), 0);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);

  r.runtime.script = feed => { feed.push({ type: 'text', delta: `<beat-plan language="en">\n# Plan\nUse the key sk-ant-api03-${'a1B2c3D4'.repeat(6)} to log in.\n</beat-plan>` }); feed.done(); };
  const second = await start(r, projectId);
  await settled(r.s.app, second.runId);
  assert.equal(r.s.app.plans.view(projectId, second.conversation).content, null, 'a secret-looking plan is refused by the same check as beat\'s own plan tool');
  assert.equal(toolRows(r, second.conversation)[0]!.isError, true);
});

const BLOCK = (plan: string) => `<beat-plan language="en">\n${plan}\n</beat-plan>`;
const textOf = (feed: { push(event: { type: 'text'; delta: string; boundary?: true }): void }, delta: string, boundary = false) => feed.push({ type: 'text', delta, ...(boundary ? { boundary: true as const } : {}) });

test('Codex の塊は、その返事の最後の発言からだけ取り出す。前の発言（切れ目の前・道具の前）に書いた塊は、保存しない', async t => {
  const r = await rig(t, { kind: 'codex' });
  const { id: projectId } = await r.product();
  await r.check();

  r.runtime.script = feed => { textOf(feed, `Earlier draft:\n${BLOCK('# Draft')}`); textOf(feed, '\n\n', true); textOf(feed, 'I will think about it more first.'); feed.done(); };
  const split = await start(r, projectId);
  await settled(r.s.app, split.runId);
  assert.equal(r.s.app.plans.view(projectId, split.conversation).content, null, 'a block in an earlier message of the same turn is not saved');
  assert.equal(toolRows(r, split.conversation).length, 0);

  r.runtime.script = feed => {
    textOf(feed, `Earlier draft:\n${BLOCK('# Draft')}`);
    feed.push({ type: 'tool_start', id: 'ls', name: 'commandExecution', input: { command: 'ls' } });
    feed.push({ type: 'tool_end', id: 'ls', output: 'a.txt', isError: false });
    textOf(feed, 'Nothing else to add.');
    feed.done();
  };
  const tooled = await start(r, projectId);
  await settled(r.s.app, tooled.runId);
  assert.equal(r.s.app.plans.view(projectId, tooled.conversation).content, null, 'a block before a tool call is not saved either');

  r.runtime.script = feed => { textOf(feed, `Draft:\n${BLOCK('# Draft')}`); feed.push({ type: 'tool_start', id: 'open', name: 'commandExecution', input: { command: 'ls' } }); textOf(feed, 'Waiting for it.'); feed.done(); };
  const started = await start(r, projectId);
  await settled(r.s.app, started.runId);
  assert.equal(r.s.app.plans.view(projectId, started.conversation).content, null, 'a tool that has started but not ended already closes the message before it');

  r.runtime.script = feed => { textOf(feed, `Draft:\n${BLOCK('# Draft')}`); feed.push({ type: 'tool_end', id: 'late', output: 'a.txt', isError: false }); textOf(feed, 'Nothing else.'); feed.done(); };
  const ended = await start(r, projectId);
  await settled(r.s.app, ended.runId);
  assert.equal(r.s.app.plans.view(projectId, ended.conversation).content, null, 'a tool result that arrives without a start closes the message before it too');

  r.runtime.script = feed => { textOf(feed, `First try:\n${BLOCK('# Draft')}`); textOf(feed, '\n\n', true); textOf(feed, `The final plan:\n${BLOCK(PLAN.trimEnd())}`); feed.done(); };
  const last = await start(r, projectId);
  await settled(r.s.app, last.runId);
  assert.equal(r.s.app.plans.view(projectId, last.conversation).content, PLAN.trimEnd(), 'the block of the last message is the one saved');
  assert.deepEqual(toolRows(r, last.conversation).map(m => m.name), ['codex:plan_write']);
});

test('Codex の返事がテンプレートの例をコードの囲いで引用していても、それは保存しない。本物の塊だけを保存する', async t => {
  const r = await rig(t, { kind: 'codex' });
  const { id: projectId } = await r.product();
  await r.check();
  const quote = `The format is:\n\`\`\`\n<beat-plan language="en">\n(the whole plan, Markdown)\n</beat-plan>\n<beat-acceptance>\n${JSON.stringify(ITEMS)}\n</beat-acceptance>\n\`\`\``;
  r.runtime.script = feed => { textOf(feed, quote); feed.done(); };
  const quoted = await start(r, projectId);
  await settled(r.s.app, quoted.runId);
  assert.equal(r.s.app.plans.view(projectId, quoted.conversation).content, null);
  assert.equal(r.s.app.acceptance.read(projectId, quoted.conversation), undefined, 'the acceptance list is not replaced by a quoted example');
  assert.equal(toolRows(r, quoted.conversation).length, 0);

  r.runtime.script = feed => { textOf(feed, `${quote}\n\nMy plan:\n${BLOCK(PLAN.trimEnd())}`); feed.done(); };
  const both = await start(r, projectId);
  await settled(r.s.app, both.runId);
  assert.equal(r.s.app.plans.view(projectId, both.conversation).content, PLAN.trimEnd());
  assert.equal(r.s.app.acceptance.read(projectId, both.conversation), undefined);
});

test('計画の道具は、会話の「外を読んだ」の印とは別に、実行役の実行そのものを「外を読んだ」として書く（会話の印が無くても計画に印が付く）', async t => {
  const r = await rig(t);
  const { id: projectId } = await r.product();
  await r.check();
  r.runtime.script = feed => feed.done();
  const { conversation, runId } = await start(r, projectId);
  await settled(r.s.app, runId);
  const app = r.s.app;
  const conversations = new Proxy(app.conversations, {
    get(target, prop) {
      if (prop === 'everTainted') return () => false;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const tools = runtimePlanTools({
    tools: { registry: app.tools, approvals: app.approvals, pending: app.pending }, config: () => app.config(), paths: app.paths, conversations, projects: app.projects,
    acceptance: app.acceptance, bus: app.bus, services: () => app.engine.toolServices(), modeOf: id => app.conversations.modeOf(id),
  }, { runId, conversationId: conversation, projectId, signal: new AbortController().signal })!;
  assert.equal(app.conversations.everTainted(conversation), true, 'the real conversation is marked, so the stub is what hides it');
  assert.equal((await tools.call('plan_write', { content: PLAN })).isError, false);
  const view = app.plans.view(projectId, conversation);
  assert.equal(view.content, PLAN);
  assert.equal(view.tainted, true, 'the plan carries the mark from the run itself');
});
