import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { backgroundSection, shellOutput, shellStop } from '../src/tools/builtin/shell-bg.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import type { BackgroundJobs } from '../src/tools/shell/background.ts';
import { fakeModel, startApp, uuid, waitFor } from './app-setup.ts';
import { removeDir, reply, tempDir, withLoad, type Script } from './helpers.ts';

// beat 6-2: shell_run の background と shell_output / shell_stop。裏の道も、事前の判定・判定役・Pending・見張りを同じに通る

const WIN = process.platform === 'win32';
const CURL = WIN ? 'curl.exe' : 'curl';
const TICK = "let n = 0; setInterval(() => console.log('tick ' + (++n)), 100);\n";
const QUICK = "console.log('quick done');\n";

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const hang: Script = async function* (req) {
  await new Promise<void>(resolve => { if (req.signal?.aborted) resolve(); else req.signal?.addEventListener('abort', () => resolve(), { once: true }); });
  yield { type: 'done', stop: 'end_turn' as StopReason };
};

type Options = NonNullable<Parameters<typeof startApp>[1]>;

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-test-')));
  let jobs: BackgroundJobs | undefined;
  t.after(async () => {
    const running = new Set(jobs?.list().filter(job => job.state === 'running').map(job => job.conversationId));
    for (const conversationId of running) await jobs!.stopWhere({ conversationId });
  });
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(), judge: '{"decision":"allow","reason":"fits"}', ...options });
  jobs = s.app.background;
  t.after(async () => { s.app.background.closeAll(); await removeDir(products); });
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tick.js'), TICK);
    writeFileSync(join(dir, 'quick.js'), QUICK);
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { ...(made.body.project as { id: string }), dir };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await waitFor(() => s.app.runs.get(sent.body.runId)?.ended_at != null, 'run ended', 30_000);
    return sent.body.runId as string;
  };
  const calls = () => s.adapter().calls.filter(c => c.tools.length > 0);
  const results = () => s.adapter().calls.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content));
  const toolRow = (runId: string, tool: string) => s.app.db.prepare('SELECT decision, decided_by, ok, output_preview FROM tool_calls WHERE run_id = ? AND tool = ? ORDER BY created_at').all(runId, tool) as Array<{ decision: string; decided_by: string; ok: number; output_preview: string }>;
  return { ...s, product, send, calls, results, toolRow };
}

test('6-2: 2 秒以内に終わるコマンドはふつうの結果（終了コードつき）で裏に残らない。動き続けるものは番号と出力が返り、次の発言の system に一覧が出る', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [call('shell_run', { command: 'node quick.js', background: true }), call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  const runId = await s.send(uuid(1), { text: 'run them', projectId: shop.id, permissionMode: 'auto' });
  const [quick, tick] = s.results();
  assert.match(quick!, /exit code: 0/u, quick);
  assert.match(quick!, /quick done/u);
  assert.doesNotMatch(quick!, /bg-\d/u);
  assert.match(tick!, /Started in the background as bg-2/u, tick);
  assert.match(tick!, /tick 1/u, tick);
  const jobs = s.app.background.list({ conversationId: uuid(1) });
  assert.deepEqual(jobs.map(j => [j.id, j.state, j.projectId]), [['bg-2', 'running', shop.id]]);
  assert.deepEqual(s.toolRow(runId, 'shell_run').map(r => r.ok), [1, 1]);
  s.adapter().scripts = [call('shell_output', { id: 'bg-2', waitSec: 1 }), reply('ok')];
  await s.send(uuid(1), { text: 'read it' });
  const first = s.calls().at(-2)!;
  assert.match(first.system.tail, /Background commands of this conversation as of now, including any you just started/u);
  assert.match(first.system.tail, /Commands started before beat last restarted have ended, and numbers start again from bg-1 after a restart/u, 'backlog: numbers restart per boot');
  assert.match(first.system.tail, /- bg-2 \[running(?:, unread output)?\] node tick\.js/u);
  assert.doesNotMatch(first.system.dynamic, /Background commands/u, 'S1: 一覧は実行のあいだ同じ部分（dynamic）には入れない');
  // TE-1: 前の実行で送った一覧は、その発言に保存した tail のまま届く（変わっていなければ送り直さない）
  const tails = first.messages.map(m => (m.role === 'assistant' ? '' : m.tail ?? '')).join('\n');
  assert.match(tails, /- bg-2 \[running/u, 'S1: 一覧は発言に付けて送る');
  const read = s.results().at(-1)!;
  assert.match(read, /^bg-2: running/u, read);
  assert.match(read, /tick \d+/u);
  assert.doesNotMatch(read, /\btick 1\n/u, 'the second read starts after the first one');
});

test('6-2: 一覧の節は 0 件なら空で、system に何も足さない', async t => {
  assert.equal(backgroundSection([], 'en'), '');
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  assert.doesNotMatch(s.calls().at(-1)!.system.dynamic, /Background commands/u);
  assert.doesNotMatch(s.calls().at(-1)!.system.tail, /Background commands/u);
});

test('6-2: 計画モードには shell_run と shell_stop が渡らず shell_output は渡る。振り返りにはどれも渡らない。製品の無い会話には shell_output / shell_stop が渡らない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok'), reply('ok')];
  await s.send(uuid(1), { text: 'plan', projectId: shop.id, permissionMode: 'plan' });
  const planned = s.calls().at(-1)!.tools.map(tool => tool.name);
  assert.ok(planned.includes('shell_output'), planned.join(','));
  assert.ok(!planned.includes('shell_run') && !planned.includes('shell_stop'), planned.join(','));
  await s.send(uuid(2), { text: 'hi' });
  const plain = s.calls().at(-1)!.tools.map(tool => tool.name);
  assert.ok(plain.includes('shell_run') && !plain.includes('shell_output') && !plain.includes('shell_stop'), plain.join(','));
  for (const tool of [shellRun, shellOutput, shellStop]) assert.ok(!tool.allowedIn.includes('review'), tool.name);
  assert.deepEqual(s.app.tools.forRun('review').filter(tool => tool.name.startsWith('shell_')), []);
});

test('6-2: 製品の無い会話では background を事前の判定の deny で断り、何も始めない', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('shell_run', { command: 'node --version', background: true }), reply('ok')];
  const runId = await s.send(uuid(1), { text: 'x' });
  assert.match(s.results()[0]!, /Background commands can run only in a product's conversation or task/u);
  assert.deepEqual(s.toolRow(runId, 'shell_run').map(r => r.decision), ['deny']);
  assert.equal(s.app.background.list().length, 0);
});

test('6-2: 同じ判定を通る: 許可フォルダの外の cwd・秘密のパス・beat 自身のポート・断るコマンドは background でも同じ文で断られる', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const outside = tempDir(t as never);
  const cases: Array<Record<string, unknown>> = [
    { command: 'node --version', cwd: outside },
    { command: WIN ? 'Get-Content .env' : 'cat .env' },
    { command: `${CURL} -s http://127.0.0.1:${s.app.config().server.port}/api/settings` },
    { command: WIN ? 'reg query HKCU\\Software\\beat-test-none' : 'crontab -l' },
  ];
  writeFileSync(join(shop.dir, '.env'), 'X=1\n');
  for (const input of cases) {
    s.adapter().scripts = [call('shell_run', input), call('shell_run', { ...input, background: true }), reply('ok')];
    const runId = await s.send(uuid(1), { text: 'x', projectId: shop.id, permissionMode: 'auto' });
    const [plain, background] = s.results().slice(-2);
    assert.deepEqual(s.toolRow(runId, 'shell_run').map(r => r.decision), ['deny', 'deny'], `${JSON.stringify(input)}: ${plain}`);
    assert.equal(background, plain, JSON.stringify(input));
  }
  assert.equal(s.app.background.list().length, 0);
});

test('6-2: 判定役に回る形は background でも判定役に回り、判定役と Pending の札には「(background)」と時間の上限が無いことの 1 行が出る', async t => {
  const s = await setup(t, { judge: '{"decision":"ask","reason":"check it"}' });
  const shop = await s.product('shop');
  const notes = join(tempDir(t as never), 'notes.md');
  writeFileSync(notes, 'my notes\n');
  const command = WIN ? `Get-Content ${notes}` : `cat ${notes}`;
  s.adapter().scripts = [call('shell_run', { command, background: true }), reply('ok')];
  const runId = await s.send(uuid(1), { text: 'fetch it', projectId: shop.id, permissionMode: 'auto' });
  const judged = (s.adapter() as unknown as { judged: Array<{ messages: unknown[] }> }).judged;
  assert.equal(judged.length, 1);
  const prompt = JSON.stringify(judged[0]!.messages);
  assert.match(prompt, /Run a command \(background\): it runs with no time limit until stopped/u);
  const parked = s.app.pending.list({ status: 'waiting' });
  assert.equal(parked.length, 1);
  assert.equal(s.toolRow(runId, 'shell_run')[0]!.decided_by, 'pending');
  const view = s.app.pending.view(parked[0]!.id)!;
  assert.equal(view.title, 'Run a command (background): it runs with no time limit until stopped');
  assert.equal(view.parts.body, command);
  assert.equal(s.app.background.list().length, 0);
});

test('6-2: push を裏で動かそうとすると、ふつうの道でも Pending に積まれる形（方針 ask）でも、積まずに事前の判定の deny で断る', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  for (const command of ['git push origin HEAD', 'git push']) {
    s.adapter().scripts = [call('shell_run', { command, background: true }), reply('ok')];
    const runId = await s.send(uuid(1), { text: 'push in the background', projectId: shop.id, permissionMode: 'auto' });
    assert.match(s.results().at(-1)!, /git push cannot run in the background/u);
    assert.deepEqual(s.toolRow(runId, 'shell_run').map(r => r.decision), ['deny']);
  }
  await s.app.applyConfig({ ...s.app.config(), tools: { ...s.app.config().tools, policies: { shell_run: 'ask' } } }, { probe: false });
  s.adapter().scripts = [call('shell_run', { command: 'git push origin HEAD' }), reply('ok')];
  const parkRun = await s.send(uuid(1), { text: 'push', permissionMode: 'auto' });
  assert.deepEqual(s.toolRow(parkRun, 'shell_run').map(r => [r.decision, r.decided_by]), [['ask', 'pending']]);
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 1, 'without background the push waits in Pending');
  for (const command of ['git push origin HEAD', 'git push']) {
    s.adapter().scripts = [call('shell_run', { command, background: true }), reply('ok')];
    const runId = await s.send(uuid(1), { text: 'push in the background', permissionMode: 'auto' });
    assert.match(s.results().at(-1)!, /git push cannot run in the background/u);
    assert.deepEqual(s.toolRow(runId, 'shell_run').map(r => r.decision), ['deny']);
  }
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 1, 'nothing more was parked');
  assert.equal(s.app.background.list().length, 0);
});

type Setup = Awaited<ReturnType<typeof setup>>;

const direct = (s: Setup, owner: { conversationId: string; projectId: string; taskId?: string }, dir: string, script = 'tick.js') =>
  s.app.background.start({ ...owner, command: `node ${script}`, cwd: dir, file: process.execPath, args: [script], env: { ...process.env } as Record<string, string>, fetched: false });

const startedId = (started: ReturnType<Setup['app']['background']['start']>): string => {
  assert.ok('id' in started, JSON.stringify(started));
  return started.id;
};

const stateOf = (s: Setup, id: string) => s.app.background.get(id)?.state;

async function stoppedSoon(s: Setup, id: string, label: string): Promise<void> {
  await waitFor(() => stateOf(s, id) !== 'running', label, 15_000);
}

const pendingSettled = (s: Setup, id: number) => waitFor(() => !['waiting', 'running'].includes(String(s.app.pending.view(id)?.status)), 'pending settled', 30_000);

test('6-2: Pending に積まれた background は、承認で裏で始まり、その会話の番号がつく', async t => {
  const s = await setup(t, { configure: c => { c.tools.policies = { shell_run: 'ask' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'start it', projectId: shop.id, permissionMode: 'auto' });
  const [parked] = s.app.pending.list({ status: 'waiting' });
  assert.ok(parked, 'parked in Pending');
  assert.equal(s.app.background.list().length, 0, 'nothing runs before the OK');
  assert.equal((await s.json(`/api/pending/${parked.id}/approve`, 'POST')).status, 202);
  await pendingSettled(s, parked.id);
  const view = s.app.pending.view(parked.id)!;
  assert.equal(view.status, 'ran', JSON.stringify(view));
  const jobs = s.app.background.list({ conversationId: uuid(1) });
  assert.deepEqual(jobs.map(j => [j.state, j.projectId]), [['running', shop.id]]);
  assert.match(JSON.stringify(view), new RegExp(`Started in the background as ${jobs[0]!.id}`, 'u'));
});

test('6-2: 閉じた会話・しまった製品・終わったタスクには始めない。Pending で待つ間に会話をしまうと、承認しても始めず失敗にする', async t => {
  const s = await setup(t, { configure: c => { c.tools.policies = { shell_run: 'ask' }; } });
  const shop = await s.product('shop');
  const spare = await s.product('spare');
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'start it', projectId: shop.id, permissionMode: 'auto' });
  const [parked] = s.app.pending.list({ status: 'waiting' });
  assert.ok(parked);
  await s.json(`/api/conversations/${uuid(1)}`, 'PATCH', { archived: true });
  assert.deepEqual(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir), { refused: 'closed' }, 'archived conversation');
  assert.equal((await s.json(`/api/pending/${parked.id}/approve`, 'POST')).status, 202);
  await pendingSettled(s, parked.id);
  assert.equal(s.app.pending.view(parked.id)!.status, 'failed');
  assert.equal(s.app.background.list().length, 0, 'never started');

  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(2), { text: 'hi', projectId: spare.id });
  const task = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: spare.id });
  s.app.tasks.finish(task.id, 'done', null, 'user');
  assert.deepEqual(direct(s, { conversationId: uuid(2), projectId: spare.id, taskId: task.id }, spare.dir), { refused: 'closed' }, 'finished task');
  assert.equal((await s.json(`/api/projects/${spare.id}`, 'PATCH', { archived: true })).status, 200);
  assert.deepEqual(direct(s, { conversationId: uuid(2), projectId: spare.id }, spare.dir), { refused: 'closed' }, 'archived product');
  assert.equal(s.app.background.list().length, 0);
});

test('6-2: よその会話の番号は読めず止められない。数の上限で断るときも、よその会話のコマンドは見せない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok'), reply('ok'), reply('ok')];
  for (const n of [1, 2, 3]) await s.send(uuid(n), { text: 'hi', projectId: shop.id });
  const mine = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  s.adapter().scripts = [call('shell_output', { id: mine }), call('shell_stop', { id: mine }), reply('ok')];
  await s.send(uuid(2), { text: 'peek', permissionMode: 'auto' });
  const [read, stop] = s.results();
  const gone = `There is no background command ${mine} in this conversation. Commands started before beat last restarted have ended, and numbers start again from bg-1 after a restart`;
  assert.equal(read, gone);
  assert.equal(stop, gone);
  assert.equal(stateOf(s, mine), 'running', 'still running');
  for (let i = 0; i < 3; i++) startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  for (let i = 0; i < 4; i++) startedId(direct(s, { conversationId: uuid(2), projectId: shop.id }, shop.dir, 'tick.js'));
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(2), { text: 'one more', permissionMode: 'auto' });
  const own = s.results().at(-1)!;
  assert.match(own, /^Not started: 4 background commands are already running in this conversation/mu, own);
  assert.equal((own.match(/^- bg-\d+: node tick\.js$/gmu) ?? []).length, 4, own);
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(3), { text: 'one more', permissionMode: 'auto' });
  const total = s.results().at(-1)!;
  assert.match(total, /^Not started: beat already runs 8 background commands in total \(8 of them in other conversations or products\)/mu, total);
  assert.doesNotMatch(total, /Running in this conversation:|bg-\d/u, total);
  assert.equal(s.app.background.list({ conversationId: uuid(3) }).length, 0);
});

test('6-2: 止まる時: shell_stop・会話をしまう・タスクが終わる（done / failed / cancelled）・製品をしまう・App を閉じる', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const other = await s.product('other');
  s.adapter().scripts = [reply('ok'), reply('ok'), reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  await s.send(uuid(2), { text: 'hi', projectId: shop.id });
  await s.send(uuid(3), { text: 'hi', projectId: other.id });

  const byTool = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  s.adapter().scripts = [call('shell_stop', { id: byTool }), reply('ok')];
  await s.send(uuid(1), { text: 'stop it', permissionMode: 'auto' });
  assert.equal(s.app.background.get(byTool)?.stoppedBy, 'model');
  assert.equal(stateOf(s, byTool), 'stopped');

  for (const status of ['done', 'failed', 'cancelled'] as const) {
    const task = s.app.tasks.create({ title: `Build ${status}`, origin: 'user', actor: 'user', projectId: shop.id });
    const id = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id, taskId: task.id }, shop.dir));
    const bystander = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
    s.app.tasks.finish(task.id, status, null, 'user');
    await stoppedSoon(s, id, `task ${status}`);
    assert.equal(stateOf(s, bystander), 'running', 'a job outside the task keeps running');
    s.app.background.stop(bystander, 'owner');
    await stoppedSoon(s, bystander, 'bystander');
  }

  const archived = startedId(direct(s, { conversationId: uuid(2), projectId: shop.id }, shop.dir));
  const otherJob = startedId(direct(s, { conversationId: uuid(3), projectId: other.id }, other.dir));
  await s.json(`/api/conversations/${uuid(2)}`, 'PATCH', { archived: true });
  await stoppedSoon(s, archived, 'conversation archived');
  assert.equal(stateOf(s, otherJob), 'running');

  const inShop = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  assert.equal((await s.json(`/api/projects/${shop.id}`, 'PATCH', { archived: true })).status, 200);
  await stoppedSoon(s, inShop, 'product archived');
  assert.equal(stateOf(s, otherJob), 'running');

  s.app.close();
  Object.assign(s.app, { close: () => undefined });
  assert.equal(stateOf(s, otherJob), 'stopped', 'App.close stops everything');
  assert.equal(s.app.background.get(otherJob)!.stoppedBy, 'system');
});

test('6-2: 会話を消すと止めてから記録のファイルも消す。よその会話の記録は残す', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok'), reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  await s.send(uuid(2), { text: 'hi', projectId: shop.id });
  const gone = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  const kept = startedId(direct(s, { conversationId: uuid(2), projectId: shop.id }, shop.dir));
  const goneLog = s.app.background.get(gone)!.logPath;
  const keptLog = s.app.background.get(kept)!.logPath;
  const outputs = join(s.app.paths.data, 'tool_outputs');
  const earlierBoot = join(outputs, `bg-${uuid(1)}-7-0a1b2c3d.log`);
  const otherEarlier = join(outputs, `bg-${uuid(2)}-7-0a1b2c3d.log`);
  writeFileSync(earlierBoot, 'left by an earlier boot\n');
  writeFileSync(otherEarlier, 'left by an earlier boot\n');
  await waitFor(() => existsSync(goneLog) && existsSync(keptLog), 'logs written', 10_000);
  const deleted = await s.json(`/api/conversations/${uuid(1)}`, 'DELETE');
  assert.ok(deleted.status < 300, JSON.stringify(deleted.body));
  await waitFor(() => !existsSync(goneLog), 'log of the deleted conversation removed', 15_000);
  assert.equal(s.app.background.get(gone), undefined);
  assert.equal(stateOf(s, kept), 'running');
  assert.ok(existsSync(keptLog));
  assert.ok(readdirSync(outputs).some(name => keptLog.endsWith(name)));
  assert.equal(existsSync(earlierBoot), false, 'a log left by an earlier boot goes with its conversation');
  assert.equal(existsSync(otherEarlier), true);
});

test('6-2: 止めないもの: 実行の停止ボタン・タスクの待ち（checkpoint / 質問）。次の実行が同じ番号を読める', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), hang];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'start then think', projectId: shop.id, permissionMode: 'auto' });
  assert.equal(sent.status, 202);
  await waitFor(() => s.app.background.list({ conversationId: uuid(1) }).length === 1, 'started', 30_000);
  const [job] = s.app.background.list({ conversationId: uuid(1) });
  await waitFor(() => s.adapter().calls.length >= 2, 'model called again', 30_000);
  assert.equal((await s.json(`/api/runs/${sent.body.runId}/stop`, 'POST')).status, 200);
  await waitFor(() => s.app.runs.get(sent.body.runId)?.ended_at != null, 'run stopped', 30_000);
  assert.equal(stateOf(s, job!.id), 'running', 'the stop button stops the run, not the background command');

  const task = s.app.tasks.create({ title: 'Wait', origin: 'user', actor: 'user', projectId: shop.id });
  const inTask = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id, taskId: task.id }, shop.dir));
  s.app.tasks.setWaiting(task.id, 'question', 'which port?');
  s.app.tasks.setReady(task.id, { runAt: Date.now() + 60_000, reason: 'checkpoint' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(stateOf(s, inTask), 'running', 'waiting and checkpoint keep it running');

  s.adapter().scripts = [call('shell_output', { id: job!.id, waitSec: 1 }), reply('ok')];
  await s.send(uuid(1), { text: 'read it' });
  assert.match(s.results().at(-1)!, new RegExp(`^${job!.id}: running`, 'u'));
});

test('6-2: 取得したものを流すコマンドを裏で動かすと、読んだ実行・止めた実行にも外を読んだ印がつく。取得しないものはつかない', async t => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => res.write('chunk from outside\n'), 100);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const s = await setup(t);
  const shop = await s.product('shop');
  const fetch = `${CURL} -sN http://127.0.0.1:${port}/`;
  s.adapter().scripts = [call('shell_run', { command: fetch, background: true }), call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  const first = await s.send(uuid(1), { text: 'stream it', projectId: shop.id, permissionMode: 'auto' });
  assert.match(s.results().at(-2)!, /Started in the background as bg-1/u, s.results().at(-2));
  assert.equal(s.app.runs.get(first)!.tainted, 1);
  assert.equal(s.app.background.get('bg-1')!.fetched, true);
  const section = s.calls().at(-1)!.system.tail;
  assert.match(section, /not the owner's instructions/u);
  assert.match(section, /- bg-1 \[running[^\]]*\] curl[^\n]*\(cwd: [^)\n]*\)\n/u, 'started before anything was read: no mark');
  assert.match(section, /- bg-2 \[running[^\]]*\] node tick\.js \(cwd: [^)\n]*\) \(started after reading text that came from elsewhere\)/u);
  s.app.background.stop('bg-2', 'owner');

  s.adapter().scripts = [call('shell_output', { id: 'bg-1', waitSec: 1 }), reply('ok')];
  const second = await s.send(uuid(2), { text: 'hi', projectId: shop.id });
  assert.equal(s.app.runs.get(second)!.tainted, 0, 'another conversation cannot read it, so it stays clean');

  s.adapter().scripts = [call('shell_output', { id: 'bg-1', waitSec: 1 }), reply('ok')];
  const read = await s.send(uuid(1), { text: 'read it' });
  assert.match(s.results().at(-1)!, /chunk from outside/u);
  assert.equal(s.app.runs.get(read)!.tainted, 1, 'reading fetched output marks the run');

  s.adapter().scripts = [call('shell_stop', { id: 'bg-1' }), reply('ok')];
  const stopped = await s.send(uuid(1), { text: 'stop it' });
  assert.equal(s.app.runs.get(stopped)!.tainted, 1, 'the stop result carries the last output too');

  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(3), { text: 'tick', projectId: shop.id, permissionMode: 'auto' });
  const [tick] = s.app.background.list({ conversationId: uuid(3) });
  s.adapter().scripts = [call('shell_output', { id: tick!.id, waitSec: 1 }), reply('ok')];
  const clean = await s.send(uuid(3), { text: 'read it' });
  assert.equal(s.app.runs.get(clean)!.tainted, 0);
});

test('6-2: 子のエージェントが裏で始めたコマンドは、子の実行が終わると止まり、子の会話にはもう始められない', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  const loaded = (name: string, args: unknown): Script => async function* (req) {
    for (const c of withLoad({ id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  s.adapter().scripts = [loaded('agent_run', { task: 'start the ticker' }), call('shell_run', { command: 'node tick.js', background: true }), reply('child done'), reply('parent done')];
  await s.send(uuid(1), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  const jobs = s.app.background.list().filter(job => job.conversationId !== uuid(1));
  assert.equal(jobs.length, 1, JSON.stringify(s.app.background.list()));
  const child = jobs[0]!;
  assert.equal(s.app.conversations.get(child.conversationId)!.parent_run_id !== null, true, 'started by the child');
  await stoppedSoon(s, child.id, 'child run ended');
  assert.equal(s.app.background.get(child.id)!.stoppedBy, 'system');
  assert.deepEqual(direct(s, { conversationId: child.conversationId, projectId: shop.id }, shop.dir), { refused: 'closed' });
});

test('6-2: 2 秒以内に終わっても出力が輪からあふれたら、終わりの方を返し、番号と全文のログを残す（上限が輪より大きい設定でも）', async t => {
  const s = await setup(t, { configure: c => { c.tools.shell.outputCapBytes = 1024 * 1024; } });
  const shop = await s.product('shop');
  writeFileSync(join(shop.dir, 'big.js'), "for (let i = 1; i <= 6000; i++) console.log('line ' + i + ' ' + 'x'.repeat(60));\n");
  s.adapter().scripts = [call('shell_run', { command: 'node big.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'run it', projectId: shop.id, permissionMode: 'auto' });
  const result = s.results().at(-1)!;
  assert.match(result, /exit code: 0/u);
  assert.match(result, /\[[\d,]+ bytes of output before this point were not returned\]/u, result.slice(0, 400));
  assert.match(result, /line 6000 x+\n/u);
  assert.doesNotMatch(result, /\bline 1 x/u, 'the start that the ring dropped is not shown as the start');
  const [job] = s.app.background.list({ conversationId: uuid(1) });
  assert.ok(job, 'the job is kept so the log stays');
  assert.equal(job.state, 'exited');
  assert.ok(result.includes(`[Full output: ${job.logPath}]`), result.slice(-300));
  await waitFor(() => existsSync(job.logPath), 'log', 5_000);
  const log = readFileSync(job.logPath, 'utf8');
  assert.match(log, /^line 1 x/u);
  assert.match(log, /line 6000 x/u);
});

test('6-2: 2 秒待つあいだに止められたら、終了コードでなく止められたと返す', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const off = s.app.background.onChange(view => { if (view.state === 'running') void s.app.background.stop(view.id, 'owner'); });
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'run it', projectId: shop.id, permissionMode: 'auto' });
  off();
  const result = s.results().at(-1)!;
  assert.match(result, /, stopped by the user after [\d.]+ s\)/u, result);
  assert.doesNotMatch(result, /exit code/u);
});

test('6-2: 会話を消すとき、裏のコマンドが止まらなければ 409 で断り、番号もログも残す', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  const id = startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  const log = s.app.background.get(id)!.logPath;
  await waitFor(() => existsSync(log), 'log written', 10_000);
  let tries = 0;
  Object.assign(s.app.background, { stopWhere: async () => { tries++; return 0; } });
  const refused = await s.json(`/api/conversations/${uuid(1)}`, 'DELETE');
  Reflect.deleteProperty(s.app.background, 'stopWhere');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(tries, 10, 'gives up after MAX_REVIEW_STOP_ROUNDS tries');
  assert.ok(s.app.conversations.get(uuid(1)), 'the conversation stays');
  assert.equal(stateOf(s, id), 'running');
  assert.ok(existsSync(log));
  s.app.background.stop(id, 'owner');
  await stoppedSoon(s, id, 'stopped');
  let calls = 0;
  Object.assign(s.app.engine, { activeRuns: () => (calls++ === 0 ? [] : [{ conversationId: uuid(1), runId: 'x', kind: 'chat' }]) });
  const late = await s.json(`/api/conversations/${uuid(1)}`, 'DELETE');
  Reflect.deleteProperty(s.app.engine, 'activeRuns');
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.ok(calls >= 2, 'refused by the last check, after the stop loop');
  assert.ok(s.app.background.get(id), 'a refused delete keeps the ended job');
  assert.ok(existsSync(log), 'and its log');
});

test('6-2: 子のエージェントの裏のコマンドが Pending で待つあいだに子の実行が終わると、承認しても始めず失敗にする', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow', shell_run: 'ask' }; } });
  const shop = await s.product('shop');
  const loaded = (name: string, args: unknown): Script => async function* (req) {
    for (const c of withLoad({ id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  s.adapter().scripts = [loaded('agent_run', { task: 'start the ticker' }), call('shell_run', { command: 'node tick.js', background: true }), reply('child done'), reply('parent done')];
  await s.send(uuid(1), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  const parked = s.app.pending.list({ status: 'waiting' })[0]!;
  assert.ok(parked, 'the child parked it');
  assert.notEqual(parked.conversation_id, uuid(1));
  assert.equal(s.app.engine.activeRuns().length, 0, 'the child run has ended');
  assert.equal((await s.json(`/api/pending/${parked.id}/approve`, 'POST')).status, 202);
  await pendingSettled(s, parked.id);
  assert.equal(s.app.pending.view(parked.id)!.status, 'failed');
  assert.equal(s.app.background.list().length, 0, 'never started');
});

test('6-2: Pending で承認して裏で始めた取得のコマンドも、あとで読んだ実行に外を読んだ印がつく', async t => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => res.write('chunk from outside\n'), 100);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const s = await setup(t, { configure: c => { c.tools.policies = { shell_run: 'ask' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [call('shell_run', { command: `${CURL} -sN http://127.0.0.1:${port}/`, background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'stream it', projectId: shop.id, permissionMode: 'auto' });
  const [parked] = s.app.pending.list({ status: 'waiting' });
  assert.ok(parked);
  assert.equal((await s.json(`/api/pending/${parked.id}/approve`, 'POST')).status, 202);
  await pendingSettled(s, parked.id);
  assert.equal(s.app.pending.view(parked.id)!.status, 'ran', JSON.stringify(s.app.pending.view(parked.id)));
  const [job] = s.app.background.list({ conversationId: uuid(1) });
  assert.equal(job!.fetched, true);
  await waitFor(() => !s.app.engine.activeRuns().some(run => run.conversationId === uuid(1)), 'no run in the conversation', 30_000);
  s.adapter().scripts = [call('shell_output', { id: job!.id, waitSec: 1 }), reply('ok')];
  const read = await s.send(uuid(1), { text: 'read it', permissionMode: 'auto' });
  assert.match(s.results().at(-1)!, /chunk from outside/u);
  assert.equal(s.app.runs.get(read)!.tainted, 1);
});

test('6-2: 外を読んだあとに始めた裏のコマンドが一覧にある会話は、次の実行（チャット・タスク）が外を読んだ扱いで始まる。印の無いものだけなら始まらない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok'), reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  await s.send(uuid(2), { text: 'hi', projectId: shop.id });
  const marked = startedId(s.app.background.start({ conversationId: uuid(1), projectId: shop.id, command: 'node tick.js', cwd: shop.dir, file: process.execPath, args: ['tick.js'], env: { ...process.env } as Record<string, string>, fetched: false, tainted: true }));
  startedId(direct(s, { conversationId: uuid(2), projectId: shop.id }, shop.dir));
  s.adapter().scripts = [reply('ok')];
  const chat = await s.send(uuid(1), { text: 'again' });
  assert.equal(s.app.runs.get(chat)!.tainted, 1, 'a marked job in the list carries the mark');
  s.adapter().scripts = [reply('ok')];
  const clean = await s.send(uuid(2), { text: 'again' });
  assert.equal(s.app.runs.get(clean)!.tainted, 0, 'an unmarked job does not');

  const taskConversation = s.app.conversations.create({ kind: 'task', projectId: shop.id });
  const task = s.app.tasks.create({ title: 'Watch', origin: 'user', actor: 'user', projectId: shop.id });
  startedId(s.app.background.start({ conversationId: taskConversation.id, projectId: shop.id, command: 'node tick.js', cwd: shop.dir, file: process.execPath, args: ['tick.js'], env: { ...process.env } as Record<string, string>, fetched: false, tainted: true }));
  s.adapter().scripts = [reply('ok')];
  const started = s.app.engine.runTask(task, taskConversation.id, 'go on');
  assert.ok(started.ok);
  await started.done;
  assert.equal(s.app.runs.get(started.runId)!.tainted, 1, 'the task run starts marked too');
  s.app.background.stop(marked, 'owner');
});

test('6-2: 輪からあふれた出力は、上限（outputCapBytes）が 12,000 より小さければ、その上限までの終わりの方を返す', async t => {
  const s = await setup(t, { configure: c => { c.tools.shell.outputCapBytes = 2048; } });
  const shop = await s.product('shop');
  writeFileSync(join(shop.dir, 'big.js'), "for (let i = 1; i <= 6000; i++) console.log('line ' + i + ' ' + 'x'.repeat(60));\n");
  s.adapter().scripts = [call('shell_run', { command: 'node big.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'run it', projectId: shop.id, permissionMode: 'auto' });
  const result = s.results().at(-1)!;
  assert.match(result, /line 6000 x+/u);
  const shown = result.split('\n').filter(line => /^line \d+ x+$/u.test(line));
  assert.ok(shown.join('\n').length <= 2048, `shown ${shown.join('\n').length} chars`);
  assert.ok(shown.length > 10, 'still shows the end');
});

test('6-2: 数の上限で断られた start も、git の切り離しの片付けを呼ぶ（実行ごとのフォルダを残さない）', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), { text: 'hi', projectId: shop.id });
  for (let i = 0; i < 4; i++) startedId(direct(s, { conversationId: uuid(1), projectId: shop.id }, shop.dir));
  const gitRuns = join(s.app.paths.data, 'git-run');
  const before = existsSync(gitRuns) ? readdirSync(gitRuns).length : 0;
  s.adapter().scripts = [call('shell_run', { command: 'node tick.js', background: true }), reply('ok')];
  await s.send(uuid(1), { text: 'one more', permissionMode: 'auto' });
  assert.match(s.results().at(-1)!, /^Not started: 4 background commands are already running/mu);
  const after = existsSync(gitRuns) ? readdirSync(gitRuns).length : 0;
  assert.equal(after, before, 'the folder made for the refused start is removed');
});
