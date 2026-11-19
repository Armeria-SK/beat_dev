import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { Worktrees } from '../src/projects/worktree.ts';
import { TaskPlaces } from '../src/tasks/place.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileWrite } from '../src/tools/builtin/files.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeAdapter, tempDir, testConfig, withLoad, type Script } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function gitIn(dir: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (name === '.git' && dir === root) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(abs)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const mainState = (product: string) => ({
  tree: tree(product), head: gitIn(product, 'rev-parse', 'HEAD'), branch: gitIn(product, 'symbolic-ref', 'HEAD'),
  status: gitIn(product, 'status', '--porcelain=v1', '--untracked-files=all'), stash: gitIn(product, 'stash', 'list'),
  config: readFileSync(join(product, '.git', 'config'), 'utf8'), index: createHash('sha256').update(readFileSync(join(product, '.git', 'index'))).digest('hex'),
});

function makeProduct(dir: string, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'tracked.txt'), 'keep\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  gitIn(dir, 'branch', 'feature');
  return dir;
}

// 道具の判定を、作業コピーで動くタスクの形で呼ぶ台
async function wtRig(t: { after: (fn: () => void) => void }) {
  const base = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(base, 'beat'));
  mkdirSync(paths.workspace, { recursive: true });
  const product = makeProduct(join(base, 'product'));
  const raw = testConfig();
  raw.tools.roots = [];
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const projects = new ProjectStore(db, paths.projects);
  const tasks = new TaskStore(db, Date.now);
  const row = projects.create({ name: 'P', root: product, rootKey: rootKeyOf(product), checkCommand: null });
  const task = tasks.create({ title: 'Fix the queue', origin: 'user', actor: 'user', projectId: row.id });
  const worktrees = new Worktrees({ db, paths, config: () => config, projects });
  const places = new TaskPlaces({ db, tasks, projects, worktrees, config: () => config });
  const made = await worktrees.createWorktree({ projectId: row.id, root: product, kind: 'task', taskId: task.id, title: task.title });
  assert.ok(made.ok, JSON.stringify(made));
  const wt = made.row;
  const wtPath = wt.path!;
  const registry = new ToolRegistry().register(shellRun).register(fileWrite);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const approvals = new ApprovalBroker(db);
  const judged: string[] = [];
  const policy = buildPolicy(config, paths, { root: wtPath }, [product]);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'task', signal: new AbortController().signal, config, paths, policy, workspace: wtPath,
    taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
    project: { id: row.id, root: wtPath, productRoot: product, worktree: { branch: wt.branch } },
    place: { kind: 'worktree', id: wt.id, productRoot: product, branch: wt.branch, base: wt.base, ceiling: join(wtPath, '..', '..') },
    task: { id: task.id, control: { outcome: 'none' } },
    services: { db, memory: undefined as never, emit: () => undefined, tasks, projects },
  };
  const mainCtx: ToolContext = { ...ctx, policy: buildPolicy(config, paths, { root: product }, [product]), workspace: product, project: { id: row.id, root: product }, place: undefined };
  const call = (name: string, args: unknown, c: ToolContext = ctx) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
    registry, approvals, pending, db, emit: () => undefined, conversationTainted: () => false,
    lastUserRequest: () => 'please do the work', autoClassify: async (input: unknown) => { judged.push(JSON.stringify(input)); return '{"decision":"ask","reason":"not sure"}'; },
  } as never);
  const deps = () => ({ db, store: pending, registry, config: () => config, paths, projects, conversationExists: () => true, conversationTainted: () => false, log: () => undefined, places }) as unknown as Parameters<typeof replayAction>[1];
  const approve = async (id: number) => replayAction(pending.claim(id), deps());
  return { base, paths, product, wtPath, wt, ctx, mainCtx, call, pending, judged, approve, worktrees, places, task, db, row };
}

const REFUSED_GIT = (product: string): string[] => [
  'git stash pop', 'git stash', 'git config user.name x', 'git worktree prune', 'git checkout main', 'git switch main', 'git branch -D feature',
  'git branch -f feature HEAD', 'git tag v1', 'git update-ref refs/heads/feature HEAD', 'git reflog expire --all', 'git gc', 'git remote add o https://example.invalid/x.git',
  `git -C "${product}" commit -m x`, 'git rebase main feature', 'git fetch . HEAD:refs/heads/feature',
];

for (const command of ['git stash pop', 'git config user.name x', 'git worktree prune', 'git checkout main', 'git -C "{P}" commit -m x']) {
  test(`8-2 D-12: 作業コピーのタスクでは「${command}」を、判定役にも Pending にも回さず断り、本体は変わらない`, { skip: !gitAvailable }, async t => {
    const r = await wtRig(t);
    writeFileSync(join(r.product, 'a.txt'), 'owner edit\n');
    gitIn(r.product, 'stash', '-q');
    const before = mainState(r.product);
    const out = await r.call('shell_run', { command: command.replace('{P}', r.product) });
    assert.equal(out.decision, 'deny', out.output.content);
    assert.match(out.output.content, /shares its branches, stash, settings/u);
    assert.equal(r.pending.list({ status: 'waiting' }).length, 0, 'Pending に積まない');
    assert.equal(r.judged.length, 0, '判定役を呼ばない');
    assert.equal((r.db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n, 0);
    assert.deepEqual(mainState(r.product), before);
    assert.match(gitIn(r.product, 'worktree', 'list', '--porcelain'), new RegExp(r.wt.id, 'u'), '作業コピーの登録も残る');
  });
}

test('8-2 D-12: 通さない git の形はどれも wt.git_shared、自分のブランチの上の add・commit・reset --hard・読むだけの git は wt の鍵が付かない', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  for (const command of REFUSED_GIT(r.product)) {
    const check = await shellPreCheck({ command }, r.ctx);
    assert.equal(check.decision, 'deny', command);
    assert.deepEqual(check.reasonKeys, ['wt.git_shared'], command);
  }
  for (const command of ['git add -A', 'git commit -m x', 'git reset --hard HEAD~1', 'git status', 'git log --oneline', 'git diff', 'git branch', 'git stash list', 'git worktree list', 'git checkout -- a.txt', 'git config --get user.name', 'git push origin HEAD']) {
    const check = await shellPreCheck({ command }, r.ctx);
    assert.ok(!(check.reasonKeys ?? []).some(k => k.startsWith('wt.')), `${command}: ${check.reasons.join(' / ')}`);
  }
  for (const command of REFUSED_GIT(r.product)) {
    const check = await shellPreCheck({ command }, r.mainCtx);
    assert.ok(!(check.reasonKeys ?? []).includes('wt.git_shared'), `本体の会話では効かない: ${command}`);
  }
});

test('8-2 D-12: 作業コピーのタスクのシェルが本体に書く文は wt.write_main で断る。作業コピーの中は断らない', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  const target = join(r.product, 'a.txt');
  const write = WINDOWS ? `Set-Content -LiteralPath '${target}' -Value x` : `echo x > '${target}'`;
  const check = await shellPreCheck({ command: write }, r.ctx);
  assert.equal(check.decision, 'deny');
  assert.deepEqual(check.reasonKeys, ['wt.write_main']);
  const out = await r.call('shell_run', { command: write });
  assert.equal(out.decision, 'deny');
  assert.equal(readFileSync(target, 'utf8'), 'one\n');
  const inside = WINDOWS ? "Set-Content -LiteralPath 'a.txt' -Value x" : 'echo x > a.txt';
  assert.ok(!((await shellPreCheck({ command: inside }, r.ctx)).reasonKeys ?? []).includes('wt.write_main'));
});

test('8-2: 作業コピーの中のファイルの削除は「消す」として数えない（本体の会話なら数える）。本体のファイルの削除は断る', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  const rm = (path: string) => (WINDOWS ? `Remove-Item -LiteralPath '${path}'` : `rm '${path}'`);
  const deleteKind = (): string | undefined => {
    const row = r.pending.list({ status: 'waiting' })[0];
    return row?.kind;
  };
  writeFileSync(join(r.product, 'own.txt'), 'owner\n');
  const mainSide = await r.call('shell_run', { command: rm(join(r.product, 'own.txt')) }, r.mainCtx);
  assert.equal(mainSide.decidedBy, 'pending', mainSide.output.content);
  assert.equal(deleteKind(), 'delete', '本体の会話では追っていないファイルの削除を数える');
  r.db.prepare("UPDATE pending_actions SET status = 'rejected'").run();
  writeFileSync(join(r.wtPath, 'own.txt'), 'made\n');
  const inside = await r.call('shell_run', { command: rm(join(r.wtPath, 'own.txt')) });
  if (inside.decidedBy === 'pending') assert.notEqual(deleteKind(), 'delete', inside.output.content);
  else assert.equal(existsSync(join(r.wtPath, 'own.txt')), false);
  r.db.prepare("UPDATE pending_actions SET status = 'rejected'").run();
  const main = await r.call('shell_run', { command: rm(join(r.product, 'tracked.txt')) });
  assert.equal(main.decision, 'deny', main.output.content);
  assert.equal(readFileSync(join(r.product, 'tracked.txt'), 'utf8'), 'keep\n');
});

test('8-2: 作業コピーの実行の file_write は本体の絶対パスを断り、作業コピーの中の書き込みは place つきで記録する', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  const out = await r.call('file_write', { path: join(r.product, 'a.txt'), content: 'bad' });
  assert.equal(out.decision, 'deny', out.output.content);
  assert.equal(readFileSync(join(r.product, 'a.txt'), 'utf8'), 'one\n');
  const ok = await r.call('file_write', { path: 'a.txt', content: 'two\n' });
  assert.equal(ok.decision, 'allow', ok.output.content);
  assert.equal(readFileSync(join(r.wtPath, 'a.txt'), 'utf8'), 'two\n');
  const rows = r.db.prepare('SELECT place, path FROM file_changes').all() as Array<{ place: string | null; path: string }>;
  assert.deepEqual(rows.map(x => ({ ...x })), [{ place: r.wt.id, path: 'a.txt' }]);
});

test('8-1 の申し送り: beat のブランチがあるリポジトリでは --all・--mirror・--prune・ワイルドカード・matching の push を断る。名指しの push と beat のブランチの無いリポジトリは今までどおり', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  for (const command of ['git push --all origin', 'git push --mirror origin', 'git push --prune origin', 'git push origin "refs/heads/*:refs/heads/*"']) {
    for (const c of [r.mainCtx, r.ctx]) {
      const check = await shellPreCheck({ command }, c);
      assert.deepEqual(check.reasonKeys, ['wt.push_beat'], command);
    }
  }
  assert.ok(!((await shellPreCheck({ command: 'git push origin feature' }, r.mainCtx)).reasonKeys ?? []).includes('wt.push_beat'));
  gitIn(r.product, 'config', 'push.default', 'matching');
  assert.deepEqual((await shellPreCheck({ command: 'git push origin' }, r.mainCtx)).reasonKeys, ['wt.push_beat']);
  const other = makeProduct(join(r.base, 'other'));
  const plain: ToolContext = { ...r.mainCtx, policy: buildPolicy(r.ctx.config, r.paths, { root: other }, [other]), workspace: other, project: { id: 'x', root: other } };
  assert.ok(!((await shellPreCheck({ command: 'git push --all origin' }, plain)).reasonKeys ?? []).includes('wt.push_beat'));
});

test('8-1 の申し送り: 承認待ちの --all の push は、積んだあとに beat のブランチができたら動かさず、送り先に beat のブランチは届かない', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  await r.worktrees.removeWorktree(r.wt.id, { keepBranch: false, state: 'gone', discardLocal: true });
  assert.equal(gitIn(r.product, 'for-each-ref', 'refs/heads/beat/'), '');
  const remote = join(r.base, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote]);
  const command = `git push --all ${JSON.stringify(remote)}`;
  const parked = await r.call('shell_run', { command }, r.mainCtx);
  assert.equal(parked.decidedBy, 'pending', parked.output.content);
  const row = r.pending.list({ status: 'waiting' })[0]!;
  gitIn(r.product, 'branch', 'beat/made-later-1a2b');
  const outcome = await r.approve(row.id);
  assert.equal(outcome.status, 'failed', outcome.output);
  assert.equal(spawnSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' }).stdout, '', '何も送らない');
});

test('8-2: 作業コピーで積んだ行は同じ作業コピーで動き、作業コピーが片づいたあとは stale', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  const send = WINDOWS ? 'curl.exe -s -m 2 -d x=1 http://127.0.0.1:9/' : 'curl -s -m 2 -d x=1 http://127.0.0.1:9/';
  assert.equal((await r.call('shell_run', { command: send })).decidedBy, 'pending');
  const first = r.pending.list({ status: 'waiting' })[0]!;
  assert.equal(first.cwd, r.wtPath);
  const ran = await r.approve(first.id);
  assert.notEqual(ran.status, 'stale', ran.output);
  assert.match(ran.output ?? '', new RegExp(`cwd: ${r.wtPath.replaceAll('\\', '\\\\')},`, 'u'), ran.output);
  assert.equal((await r.call('shell_run', { command: send })).decidedBy, 'pending');
  const second = r.pending.list({ status: 'waiting' })[0]!;
  await r.worktrees.finishWorktree(r.wt.id, { commitLeftovers: false, message: '' });
  const outcome = await r.approve(second.id);
  assert.equal(outcome.status, 'stale', outcome.output);
  assert.match(outcome.output ?? '', /separate working copy, which is no longer in use/u);
});

test('4-2d の試験 10: linked worktree で積んだ push も、積んだあとに動いたコミットは pre-push の確かめが止める。動かなければ送れる', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  const remote = join(r.base, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote]);
  const park = async () => {
    const out = await r.call('shell_run', { command: `git push --force-with-lease ${JSON.stringify(remote)} feature` });
    assert.equal(out.decidedBy, 'pending', out.output.content);
    return r.pending.list({ status: 'waiting' })[0]!;
  };
  const moved = await park();
  const next = gitIn(r.product, 'commit-tree', 'HEAD^{tree}', '-p', 'feature', '-m', 'made after parking');
  gitIn(r.product, 'update-ref', 'refs/heads/feature', next);
  const blocked = await r.approve(moved.id);
  assert.equal(blocked.status, 'failed', blocked.output);
  assert.match(blocked.output ?? '', /Not sent: the push tried to send commits that were added after it was parked/u);
  assert.equal(spawnSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' }).stdout, '');
  const still = await park();
  const sent = await r.approve(still.id);
  assert.equal(sent.status, 'ran', sent.output);
  assert.match(spawnSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' }).stdout, new RegExp(`${next} commit\\trefs/heads/feature`, 'u'));
});

test('8-1 の申し送り: finishWorktree は取り込みの途中ならコミットせず in_progress で branch にする', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  writeFileSync(join(r.product, 'a.txt'), 'main side\n');
  gitIn(r.product, 'commit', '-q', '-am', 'main side');
  writeFileSync(join(r.wtPath, 'a.txt'), 'copy side\n');
  gitIn(r.wtPath, 'commit', '-q', '-am', 'copy side');
  spawnSync('git', ['merge', 'main'], { cwd: r.wtPath, env: GIT_ENV });
  assert.match(readFileSync(join(r.wtPath, 'a.txt'), 'utf8'), /<<<<<<</u);
  const tip = gitIn(r.wtPath, 'rev-parse', 'HEAD');
  const done = await r.worktrees.finishWorktree(r.wt.id, { commitLeftovers: true, message: 'x' });
  assert.deepEqual(done, { ok: false, reason: 'in_progress' });
  assert.equal(gitIn(r.wtPath, 'rev-parse', 'HEAD'), tip, '衝突の印ごとコミットしない');
  const row = r.worktrees.get(r.wt.id)!;
  assert.equal(row.state, 'branch');
  assert.equal(row.note, 'in_progress');
  assert.equal(await r.worktrees.isMerged(r.wt.id), false);
});

test('8-1 の申し送り: 仕上げのコミットに鍵らしい名前の新しいファイルを入れない（作業コピーには残る）', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  writeFileSync(join(r.wtPath, '.env'), 'TOKEN=x\n');
  writeFileSync(join(r.wtPath, 'id_rsa'), 'key\n');
  writeFileSync(join(r.wtPath, 'work.txt'), 'done\n');
  const done = await r.worktrees.finishWorktree(r.wt.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok && done.committed, JSON.stringify(done));
  assert.deepEqual(done.ok && done.held?.sort(), ['.env', 'id_rsa']);
  const files = gitIn(r.product, 'ls-tree', '-r', '--name-only', r.wt.branch).split('\n');
  assert.ok(files.includes('work.txt'));
  assert.ok(!files.includes('.env') && !files.includes('id_rsa'), files.join(','));
  assert.ok(existsSync(join(r.wtPath, '.env')));
});

test('8-1 の申し送り: 開き直しで作業コピーを使い回すのは、ブランチの先端が beat の書いた先端のときだけ', { skip: !gitAvailable }, async t => {
  const r = await wtRig(t);
  writeFileSync(join(r.wtPath, 'work.txt'), 'done\n');
  assert.ok((await r.worktrees.finishWorktree(r.wt.id, { commitLeftovers: true, message: 'x' })).ok);
  const again = await r.worktrees.reactivate(r.wt.id);
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(r.worktrees.get(r.wt.id)!.state, 'active');
  assert.ok((await r.worktrees.finishWorktree(r.wt.id, { commitLeftovers: true, message: 'x' })).ok);
  writeFileSync(join(r.wtPath, 'owner.txt'), 'owner\n');
  gitIn(r.wtPath, 'add', 'owner.txt');
  gitIn(r.wtPath, 'commit', '-q', '-m', 'owner commit');
  assert.deepEqual(await r.worktrees.reactivate(r.wt.id), { ok: false, reason: 'moved' });
  assert.equal(r.worktrees.get(r.wt.id)!.state, 'branch');
});

// ここから: ワーカーが作業コピーを選んで動かす（偽のモデル）

function toolCall(name: string, args: unknown, before?: () => void): Script {
  return async function* (req) {
    before?.();
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function gated(): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const script: Script = async function* (req) {
    yield { type: 'text', delta: '…' };
    await new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      void gate.then(resolve);
    });
    yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2)}`, name: 'task_complete', arguments: { summary: 'main done', notify: false } } };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  return { script, release };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

const CHECK_JS = "require('fs').writeFileSync('checked-in.txt', process.cwd());\n";

async function appRig(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined, options: { git?: boolean } = {}) {
  const base = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(base, 'beat'));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.worker.maxParallel = 2;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => { app.worker.stop(); app.engine.stopAll(); });
  t.after(() => app.close());
  const root = join(base, 'shop');
  if (options.git === false) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'one\n');
  } else {
    makeProduct(root, { 'check.js': CHECK_JS, 'AGENTS.md': 'Committed instructions.\n', '.gitignore': 'checked-in.txt\n' });
    writeFileSync(join(root, 'AGENTS.md'), 'MAIN FOLDER INSTRUCTIONS.\n');
  }
  const product = app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: options.git === false ? null : 'node check.js' });
  const task = (title: string) => app.tasks.create({ title, origin: 'user', actor: 'user', projectId: product.id });
  const rows = () => app.worktrees.list(product.id);
  return { app, adapter: () => adapter, root, product, task, rows };
}

// 本体で 1 本（止めておく）動かしてから、2 本目を選ばせる
async function mainBusy(s: Awaited<ReturnType<typeof appRig>>) {
  const a = s.task('A on main');
  const gate = gated();
  s.adapter().scripts.push(gate.script);
  const first = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '本体のタスクが始まる');
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  return { a, gate, first };
}

test('8-2: 本体でタスクが動いているあいだ、次のタスクは作業コピーで並んで動き、終わると書きかけがブランチにコミットされて branch になる。本体は変わらない', { skip: !gitAvailable }, async t => {
  const s = await appRig(t);
  const before = mainState(s.root);
  const busy = await mainBusy(s);
  const b = s.task('Fix the queue restore');
  s.adapter().scripts.push(toolCall('file_write', { path: 'fixed.txt', content: 'fixed\n' }), toolCall('task_complete', { summary: 'fixed', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const done = s.app.tasks.get(b.id)!;
  assert.equal(done.status, 'done', done.result_summary ?? '');
  const [row] = s.rows();
  assert.ok(row);
  assert.equal(row.task_id, b.id);
  assert.equal(row.state, 'branch');
  assert.match(row.branch, /^beat\/fix-the-queue-restore-[0-9a-f]{4}$/u);
  const files = gitIn(s.root, 'ls-tree', '-r', '--name-only', row.branch).split('\n');
  assert.ok(files.includes('fixed.txt'), files.join(','));
  assert.match(gitIn(s.root, 'log', '-1', '--format=%B', row.branch), new RegExp(`Beat-Task: ${b.id}`, 'u'));
  assert.equal(readFileSync(join(row.path!, 'checked-in.txt'), 'utf8'), row.path!, '確かめのコマンドは作業コピーで動いた');
  assert.equal(existsSync(join(s.root, 'checked-in.txt')), false);
  const bCalls = s.adapter().calls.slice(1);
  assert.match(bCalls[0]!.system.dynamic, /separate working copy on branch beat\//u);
  assert.match(bCalls[0]!.system.frozen, /MAIN FOLDER INSTRUCTIONS/u, '指示ファイルは本体から読む');
  assert.deepEqual(mainState(s.root).tree, before.tree);
  assert.equal(mainState(s.root).head, before.head);
  assert.equal(mainState(s.root).branch, before.branch);
  busy.gate.release();
  assert.equal(await busy.first, 'ran');
  assert.equal(s.rows().filter(r => r.task_id === busy.a.id).length, 0, '本体のタスクは作業コピーを作らない');
});

test('8-2: maxParallel が 1・git でない製品・worker.worktrees が false なら作業コピーを作らず今までどおり待つ', { skip: !gitAvailable }, async t => {
  for (const [label, edit, git] of [
    ['maxParallel 1', (c: AppConfig) => { c.worker.maxParallel = 1; }, true],
    ['git でない製品', () => undefined, false],
    ['設定オフ', (c: AppConfig) => { c.worker.worktrees = false; }, true],
  ] as const) {
    const s = await appRig(t, edit, { git });
    const busy = await mainBusy(s);
    const b = s.task('B');
    assert.notEqual(await s.app.worker.tick(), 'ran', label);
    assert.equal(s.app.tasks.get(b.id)!.status, 'ready', label);
    assert.equal(s.rows().length, 0, label);
    busy.gate.release();
    await busy.first;
  }
});

test('8-2 D-13: 作業コピーのタスクは yield のあと本体が空いても同じ作業コピーで続く。変更なしで終わると片づけて gone', { skip: !gitAvailable }, async t => {
  const s = await appRig(t);
  const busy = await mainBusy(s);
  const b = s.task('Look around');
  s.adapter().scripts.push(toolCall('file_write', { path: 'note.txt', content: 'x' }), toolCall('task_yield', { reason: 'later' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  const [row] = s.rows();
  assert.equal(row!.state, 'active');
  busy.gate.release();
  await busy.first;
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: false }, () => rmSync(join(row!.path!, 'note.txt'))));
  s.app.worker.requestRun(b.id);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
  const last = s.adapter().calls.at(-1)!;
  assert.match(last.system.dynamic, new RegExp(row!.branch.replace('/', '\\/'), 'u'), '2 回目も同じ作業コピー');
  const after = s.app.worktrees.get(row!.id)!;
  assert.equal(after.state, 'gone');
  assert.equal(existsSync(row!.path!), false);
});

test('8-2 D-13: 作業コピーを外で消したタスクは failed', { skip: !gitAvailable }, async t => {
  const s = await appRig(t);
  const busy = await mainBusy(s);
  const b = s.task('B');
  s.adapter().scripts.push(toolCall('task_yield', { reason: 'later' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.rows();
  for (const name of readdirSync(row!.path!)) rmSync(join(row!.path!, name), { recursive: true, force: true });
  s.app.worker.requestRun(b.id);
  await s.app.worker.tick();
  const failed = s.app.tasks.get(b.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.result_summary ?? '', /working copy is missing/u);
  busy.gate.release();
  await busy.first;
});

test('8-2: 開いた作業コピーが 5 つある製品では、次のタスクは本体が空くのを待つ', { skip: !gitAvailable }, async t => {
  const s = await appRig(t);
  for (let i = 0; i < 5; i++) {
    const made = await s.app.worktrees.createWorktree({ projectId: s.product.id, root: s.root, kind: 'task', title: `other ${i}` });
    assert.ok(made.ok);
  }
  const busy = await mainBusy(s);
  const b = s.task('B');
  assert.notEqual(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  assert.equal(s.rows().filter(r => r.task_id === b.id).length, 0);
  busy.gate.release();
  await busy.first;
});

test('8-2: 本体が埋まっているとき、まだ動いていない同じ製品のタスクの時刻で起きるのは、作業コピーで並べられる設定のときだけ', { skip: !gitAvailable }, async t => {
  const s = await appRig(t);
  const busy = await mainBusy(s);
  const b = s.task('B later');
  const at = Date.now() + 3_600_000;
  s.app.tasks.update(b.id, { runAt: at }, 'user');
  assert.equal(s.app.tasks.nextWakeAt({ mayBranch: true }), at);
  assert.equal(s.app.tasks.nextWakeAt(), undefined);
  busy.gate.release();
  await busy.first;
});
