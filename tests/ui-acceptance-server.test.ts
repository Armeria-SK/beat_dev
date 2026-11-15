import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { ApiError, type Acceptance, type Task } from '../web/src/api.ts';
import { buildAction, decisionFailure, editBase, editRequest, loadedAcceptance, removeOp, watchedBuild } from '../web/src/ui/acceptance.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, withLoad } from './helpers.ts';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const item = (result: string) => ({ result, source: 'ai_added', check: 'command', command: 'npm test' });

async function setup(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const dir = join(products, 'shop');
  mkdirSync(dir, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root: dir });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = (made.body.project as { id: string }).id;
  await s.json(`/api/projects/${id}/plan`, 'PUT', { content: '# Plan', baseHash: null });
  const ai = async (conversation: string, name: string, args: unknown) => {
    s.adapter().scripts = [call(name, args), reply('ok')];
    const sent = await s.json(`/api/conversations/${conversation}/messages`, 'POST', { text: 'go', projectId: id });
    if (sent.status === 202 && sent.body.runId) await settled(s.app, sent.body.runId);
  };
  const list = async () => (await s.json(`/api/projects/${id}/acceptance`, 'GET')).body as { acceptance: Acceptance };
  const build = async () => {
    const plan = (await s.json(`/api/projects/${id}/plan`, 'GET')).body.plan as { hash: string };
    return s.json(`/api/projects/${id}/build`, 'POST', { planHash: plan.hash, acceptanceHash: (await list()).acceptance.hash });
  };
  return { ...s, id, ai, list, build };
}

const ready = (state: Acceptance, task: Task | null) => buildAction({ state: 'ready', mode: 'read', acc: state, task, isGit: true });

test('ui+3-3-s: 直す欄を開いたあとに AI が下書きを書き直すと、開いたときの版とハッシュで送った直しは 409 acceptance.stale になり、画面は読み直す', async t => {
  const s = await setup(t);
  const talk = uuid(11);
  await s.ai(talk, 'acceptance_write', { items: [item('Uploads resume'), item('Files are listed')] });
  const opened = (await s.list()).acceptance;
  const base = editBase(opened);
  await s.ai(talk, 'acceptance_write', { items: [item('Rewritten by the AI'), item('Another item')] });
  const sent = await s.json(`/api/projects/${s.id}/acceptance/edit`, 'POST', editRequest(base, removeOp(opened.items[0]!)));
  assert.equal(sent.status, 409, JSON.stringify(sent.body));
  assert.deepEqual(decisionFailure(new ApiError(sent.status, sent.body)), { kind: 'stale' });
  assert.deepEqual((await s.list()).acceptance.items.map(i => i.result), ['Rewritten by the AI', 'Another item'], 'AI の項目は残る');
  const fresh = await s.json(`/api/projects/${s.id}/acceptance/edit`, 'POST', editRequest(editBase((await s.list()).acceptance), removeOp(opened.items[0]!)));
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
});

test('ui+3-3-s: unbuilt と open_build_task_id が buildAction と watchedBuild を決める。固定のあとに足した項目は、Build のタスクが無ければ Build をもう一度出す', async t => {
  const s = await setup(t);
  await s.ai(uuid(12), 'acceptance_write', { items: [item('Uploads resume')] });
  const built = await s.build();
  assert.equal(built.status, 201, JSON.stringify(built.body));
  const task = built.body.task as Task;
  const after = (await s.list()).acceptance;
  assert.equal(watchedBuild(null, after), task.id);
  assert.deepEqual(after.unbuilt, []);
  assert.deepEqual(ready(after, task), { kind: 'building' });
  assert.equal(ready(after, { ...task, status: 'done' }), null, '残りが無ければ Build は出さない');

  const cancelled = await s.json(`/api/tasks/${task.id}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const added = await s.json(`/api/projects/${s.id}/acceptance/edit`, 'POST', editRequest(editBase((await s.list()).acceptance), { op: 'add', item: { result: 'Share links expire', check: { kind: 'look' } } }));
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const v2 = (await s.list()).acceptance;
  assert.equal(v2.version, 2);
  assert.equal(v2.open_build_task_id, null);
  assert.equal(watchedBuild(null, v2), null, '版 2 の build_task_id にも v1 のタスクにも頼らない');
  assert.deepEqual(v2.unbuilt, ['A-1', 'A-2'], '取り消した Build は受け持ちに数えない（TaskStore.builds）');
  assert.deepEqual(ready(v2, null), { kind: 'build', label: 'ui.plan.build', disabled: false });

  const again = await s.build();
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const v2b = (await s.list()).acceptance;
  assert.equal(v2b.open_build_task_id, (again.body.task as Task).id);
  assert.equal(watchedBuild(null, v2b), (again.body.task as Task).id, '固定のあとの Build は版を作らないので、版の build_task_id ではなく open_build_task_id で見張る');
  assert.deepEqual(v2b.unbuilt, []);
});

test('ui+3-3-s: Approve の返事を loadedAcceptance に通すと、新しい版になり、案は消える', async t => {
  const s = await setup(t);
  const talk = uuid(13);
  await s.ai(talk, 'acceptance_write', { items: [item('Uploads resume')] });
  assert.equal((await s.build()).status, 201);
  await s.ai(talk, 'acceptance_change', { changes: [{ op: 'add', result: 'Share links expire', source: 'ai_added', check: 'look' }] });
  const before = loadedAcceptance(await s.list());
  assert.ok(before.change, 'GET の acceptance.change に案がある');
  assert.equal(before.change.base_version, 1);
  const approved = await s.json(`/api/projects/${s.id}/acceptance/changes/${before.change.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const next = loadedAcceptance(approved.body);
  assert.equal(next.acc.version, 2);
  assert.equal(next.change, null);
  assert.equal(next.coverage, null, 'Approve の返事には coverage が無い');
  assert.deepEqual(next.acc.items.filter(i => i.removedIn === null).map(i => i.result), ['Uploads resume', 'Share links expire']);
});
