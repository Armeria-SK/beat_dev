import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { MERGE_WATCH_MS } from '../src/projects/merge-watch.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, withLoad } from './helpers.ts';

// beat 8-3: 取り込み待ち（done + 作業コピーの行が branch）の見回り・Mark merged・Discard と、ファイルを変えた会話のカード

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const hasBranch = (cwd: string, branch: string): boolean => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd, env: GIT_ENV }).status === 0;

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function rig(t: Parameters<typeof startApp>[0], options: { now?: () => number } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(), ...(options.now ? { now: options.now } : {}) });
  const product = async (name: string, isGit = true) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    if (isGit) git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    if (isGit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'first'); }
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  // 作業コピーで動いて終わったタスク（8-2 のワーカーの終わりと同じ: 書きかけをコミットして branch、タスクは done）
  const branchTask = async (p: { id: string; root: string }, title = 'Restore the queue', status: 'done' | 'cancelled' = 'done') => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user', projectId: p.id, ownerRequest: true });
    const made = await s.app.worktrees.createWorktree({ projectId: p.id, root: p.root, kind: 'task', taskId: task.id, title });
    assert.ok(made.ok, JSON.stringify(made));
    writeFileSync(join(made.row.path!, `${title.replace(/\W/gu, '')}.txt`), 'fixed\n');
    const done = await s.app.worktrees.finishWorktree(made.row.id, { commitLeftovers: true, message: title });
    assert.ok(done.ok && done.committed, JSON.stringify(done));
    s.app.tasks.finish(task.id, status, 'finished', 'beat');
    return { task: s.app.tasks.get(task.id)!, row: s.app.worktrees.get(made.row.id)! };
  };
  const awaiting = async (projectId: string) => ((await s.json(`/api/tasks?project=${projectId}`, 'GET')).body.awaiting as Array<{ id: string; worktree: { state: string } | null }>);
  const events = (taskId: string) => s.app.tasks.events(taskId).filter(e => e.kind === 'worktree').map(e => `${e.actor}: ${e.content}`);
  return { ...s, products, product, branchTask, awaiting, events };
}

test('8-3: 終わった作業コピーのタスクは Awaiting check（取り込み待ち）に出て、持ち主が git merge すると製品の画面を開いたときの確かめで片づき Done になる。ブランチは -d で消える', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop');
  const { task, row } = await s.branchTask(p);
  assert.equal(row.state, 'branch');
  const waiting = await s.awaiting(p.id);
  assert.deepEqual(waiting.map(w => w.id), [task.id], '取り込み待ちのタスクが awaiting に入る');
  assert.equal(waiting[0]!.worktree?.state, 'branch');
  assert.equal((await s.json('/api/projects/' + p.id + '/branches/check', 'POST', {})).body.changed, 0, '取り込む前は何もしない');
  assert.equal(s.app.worktrees.get(row.id)!.state, 'branch');

  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  const checked = await s.json(`/api/projects/${p.id}/branches/check`, 'POST', {});
  assert.equal(checked.status, 200);
  assert.equal(checked.body.changed, 1);
  const after = s.app.worktrees.get(row.id)!;
  assert.equal(after.state, 'merged');
  assert.equal(after.path, null);
  assert.equal(existsSync(row.path!), false, '作業コピーが消える');
  assert.equal(hasBranch(p.root, row.branch), false, '取り込んだブランチは消える');
  assert.deepEqual(await s.awaiting(p.id), [], 'Awaiting check から外れる');
  const view = (await s.json(`/api/tasks/${task.id}`, 'GET')).body.task;
  assert.equal(view.status, 'done');
  assert.equal(view.worktree.state, 'merged', 'カードは Done の「Task · merged」');
  assert.deepEqual(s.events(task.id), [`beat: The branch ${row.branch} is in the product folder now, so beat removed its working copy and the branch`]);
});

test('8-3: 見回りは 5 分に 1 回（due）で、片づけたあとタスクの知らせ（task.changed）を出す。直す実行の行（タスクなし・作業コピーなし）もブランチだけ片づける', { skip: !gitAvailable }, async t => {
  let clock = 1_000_000;
  const s = await rig(t, { now: () => clock });
  const p = await s.product('shop');
  const { task, row } = await s.branchTask(p);
  // 8-6b の直す実行の行の形（task_id なし・path なし）
  git(p.root, 'branch', 'beat/fix-queue-1a2b', row.base);
  git(p.root, 'checkout', '-q', 'beat/fix-queue-1a2b');
  writeFileSync(join(p.root, 'c.txt'), 'fix\n');
  git(p.root, 'add', '-A');
  git(p.root, 'commit', '-q', '-m', 'fix');
  const fixTip = git(p.root, 'rev-parse', 'HEAD');
  git(p.root, 'checkout', '-q', 'main');
  s.app.db.prepare(`INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, own_tip, state, keep_branch, created_at, updated_at)
    VALUES ('0000f1a1', ?, ?, NULL, NULL, 'fix', NULL, 'beat/fix-queue-1a2b', ?, ?, ?, 'branch', 0, 1, 1)`).run(p.id, p.root, row.base, fixTip, fixTip);
  const seen: string[] = [];
  s.app.bus.subscribe(({ event }) => { if (event.type === 'task.changed') seen.push(event.task.id); });

  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge fix', 'beat/fix-queue-1a2b');
  s.app.mergeWatch.due();
  const settledRow = (id: string) => !['branch', 'removing'].includes(s.app.worktrees.get(id)!.state) && s.app.worktrees.get(id)!.path === null;
  for (let i = 0; i < 200 && !(settledRow('0000f1a1') && settledRow(row.id)); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(s.app.worktrees.get(row.id)!.state, 'merged');
  assert.equal(s.app.worktrees.get('0000f1a1')!.state, 'merged', 'kind を問わず見る');
  assert.equal(hasBranch(p.root, 'beat/fix-queue-1a2b'), false);
  assert.ok(seen.includes(task.id), 'Kanban が読み直す知らせが出る');

  // 次の 5 分までは見ない
  const second = await s.branchTask(p, 'Second one');
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge 2', second.row.branch);
  s.app.mergeWatch.due();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(s.app.worktrees.get(second.row.id)!.state, 'branch', '5 分たつまでは見回らない');
  clock += MERGE_WATCH_MS;
  s.app.mergeWatch.due();
  for (let i = 0; i < 200 && !settledRow(second.row.id); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(s.app.worktrees.get(second.row.id)!.state, 'merged');
});

test('8-3: squash で取り込むと見回りでは残り、Mark merged で作業コピーだけ消えてブランチは残る（持ち主のコミットを消さない向き）', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop');
  const { task, row } = await s.branchTask(p);
  git(p.root, 'merge', '-q', '--squash', row.branch);
  git(p.root, 'commit', '-q', '-m', 'squashed');
  assert.equal((await s.json(`/api/projects/${p.id}/branches/check`, 'POST', {})).body.changed, 0);
  assert.equal(s.app.worktrees.get(row.id)!.state, 'branch', 'squash は祖先にならないので見回りは片づけない');
  assert.equal(existsSync(row.path!), true);

  const marked = await s.json(`/api/tasks/${task.id}/merged`, 'POST', {});
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.outcome, 'kept');
  assert.equal(marked.body.task.worktree.state, 'merged');
  assert.equal(existsSync(row.path!), false, '作業コピーは消える');
  assert.equal(hasBranch(p.root, row.branch), true, 'ブランチは残る');
  assert.deepEqual(await s.awaiting(p.id), []);
  assert.match(s.events(task.id)[0]!, /^user: Marked merged: beat removed the working copy and kept the branch /u);
  assert.equal((await s.json(`/api/tasks/${task.id}/merged`, 'POST', {})).status, 409, '2 回目は取り込み待ちのブランチが無い');
});

test('8-3: Discard は見せたコミット（GET /branch の tip）のままのときだけブランチごと捨てる。変わっていれば 409', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop');
  const { task, row } = await s.branchTask(p);
  const listed = await s.json(`/api/tasks/${task.id}/branch`, 'GET');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.branch, row.branch);
  assert.deepEqual(listed.body.commits.map((c: { subject: string }) => c.subject), ['Restore the queue'], 'base..tip のコミットを見せる');
  assert.equal(listed.body.more, 0);

  const stale = await s.json(`/api/tasks/${task.id}/discard`, 'POST', { tip: row.base });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'http.branch_moved');
  assert.equal(hasBranch(p.root, row.branch), true);

  const gone = await s.json(`/api/tasks/${task.id}/discard`, 'POST', { tip: listed.body.tip });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.outcome, 'discarded');
  assert.equal(s.app.worktrees.get(row.id)!.state, 'discarded');
  assert.equal(hasBranch(p.root, row.branch), false, 'ブランチごと消える');
  assert.equal(existsSync(row.path!), false);
  assert.deepEqual(await s.awaiting(p.id), []);
  assert.deepEqual(s.events(task.id), [`user: Discarded the branch ${row.branch} and its working copy`]);
});

test('8-3（安全）: Mark merged・Discard が触るのは、そのタスクの表の行だけ。行の無いタスク・動いているタスク・持ち主のブランチには触らない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop');
  const plain = s.app.tasks.create({ title: 'No branch', origin: 'user', actor: 'user', projectId: p.id, ownerRequest: true });
  s.app.tasks.finish(plain.id, 'done', 'x', 'beat');
  git(p.root, 'branch', 'beat/owner-made-0001');
  for (const [path, body] of [[`/api/tasks/${plain.id}/merged`, {}], [`/api/tasks/${plain.id}/discard`, { tip: 'a'.repeat(40) }]] as const) {
    const refused = await s.json(path, 'POST', body);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'http.no_branch');
  }
  assert.equal(hasBranch(p.root, 'beat/owner-made-0001'), true, '表に無い beat/ の名前のブランチは残る');

  // まだ動いているタスクの作業コピー（active）は Mark merged でも見回りでも触らない
  const live = s.app.tasks.create({ title: 'Still running', origin: 'user', actor: 'user', projectId: p.id, ownerRequest: true });
  const made = await s.app.worktrees.createWorktree({ projectId: p.id, root: p.root, kind: 'task', taskId: live.id, title: 'Still running' });
  assert.ok(made.ok);
  assert.equal((await s.json(`/api/tasks/${live.id}/merged`, 'POST', {})).status, 409);
  assert.equal(existsSync(made.row.path!), true);
  // 取り消したタスクの行が branch でも、タスクが ready に戻っていれば（開き直し）見回りは触らない
  const { task, row } = await s.branchTask(p, 'Reopened later', 'cancelled');
  s.app.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id);
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  await s.app.mergeWatch.check(p.id);
  assert.equal(s.app.worktrees.get(row.id)!.state, 'branch', '動くかもしれないタスクの行は片づけない');
});

test('8-3: 確かめる項目が残るタスクは、取り込んでも Awaiting check のまま（理由が 1 つ減る）。項目が済めば Done', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop');
  const { task, row } = await s.branchTask(p);
  s.app.tasks.setCheckState(task.id, 'awaiting');
  const both = (await s.awaiting(p.id)).filter(w => w.id === task.id);
  assert.equal(both.length, 1, '項目の待ちと取り込み待ちの両方でも 1 枚');
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  await s.json(`/api/projects/${p.id}/branches/check`, 'POST', {});
  const still = await s.awaiting(p.id);
  assert.deepEqual(still.map(w => w.id), [task.id], '項目が残るので Awaiting check のまま');
  assert.equal(still[0]!.worktree?.state, 'merged', '取り込み待ちの理由は消える');
  s.app.tasks.setCheckState(task.id, 'checked');
  assert.deepEqual(await s.awaiting(p.id), []);
});

test('8-3（Q-P8-12）: 製品のファイルを変えた会話だけが Session の確かめ待ちに出る（道具の記録・git の差分）。Mark checked で外れる', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const plain = await s.product('plain', false);
  const repo = await s.product('repo');
  let n = 0;
  const run = async (projectId: string, scripts: Script[]) => {
    s.adapter().scripts = [...scripts, reply('done')];
    const id = uuid(++n);
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'work', projectId, permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    return { conversation: id, runId: sent.body.runId as string };
  };
  const wrote = await run(plain.id, [call('file_write', { path: 'a.txt', content: 'two\n' })]);
  const talked = await run(plain.id, []);
  const sessions = async (project?: string) => ((await s.json(`/api/session-checks${project ? `?project=${project}` : ''}`, 'GET')).body.sessions as Array<{ conversation_id: string }>).map(x => x.conversation_id);
  assert.deepEqual(await sessions(plain.id), [wrote.conversation], '道具で書いた会話だけ（話しただけの会話は Done のまま）');
  assert.ok(!(await sessions(plain.id)).includes(talked.conversation));

  // git の製品: 実行の時間のあいだに書き換わったファイル（シェルで変えたものと同じ形）
  const shell = await run(repo.id, []);
  // 次の会話の実行と時間が重ならないよう、この実行を 10 分前にずらす
  s.app.db.prepare('UPDATE engine_runs SET started_at = started_at - 600000, ended_at = ended_at - 600000 WHERE id = ?').run(shell.runId);
  const r = s.app.db.prepare('SELECT started_at, ended_at FROM engine_runs WHERE id = ?').get(shell.runId) as { started_at: number; ended_at: number };
  writeFileSync(join(repo.root, 'a.txt'), 'changed by a command\n');
  const inside = new Date(r.started_at + Math.max(0, Math.floor((r.ended_at - r.started_at) / 2)));
  utimesSync(join(repo.root, 'a.txt'), inside, inside);
  const quiet = await run(repo.id, []);
  assert.deepEqual(await sessions(repo.id), [shell.conversation], '実行の時間に変わったファイルがある会話だけ');
  assert.ok(!(await sessions(repo.id)).includes(quiet.conversation));
  assert.deepEqual((await sessions()).sort(), [wrote.conversation, shell.conversation].sort(), '製品を絞らなければ全部');
  assert.deepEqual(await sessions('none'), [], '製品の無い会話は対象外');

  const marked = await s.json(`/api/conversations/${wrote.conversation}/checked`, 'POST', {});
  assert.equal(marked.status, 200);
  assert.deepEqual(await sessions(plain.id), [], 'Mark checked で外れる');
  assert.equal((await s.json(`/api/conversations/${uuid(999)}/checked`, 'POST', {})).status, 404);
  // そのあと同じ会話でまた書けば、また出る
  s.adapter().scripts = [call('file_write', { path: 'a.txt', content: 'three\n' }), reply('done')];
  const again = await s.json(`/api/conversations/${wrote.conversation}/messages`, 'POST', { text: 'more', projectId: plain.id, permissionMode: 'auto' });
  await settled(s.app, again.body.runId);
  assert.deepEqual(await sessions(plain.id), [wrote.conversation]);
});
