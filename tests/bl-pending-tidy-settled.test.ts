import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { pendingNote } from '../src/pending/notes.ts';
import { replayAction, type ReplayDeps } from '../src/pending/replay.ts';
import { PendingStore, type ParkInput } from '../src/pending/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { fileEdit, fileRead } from '../src/tools/builtin/files.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function rig(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const ran: string[] = [];
  const send: ToolDef<{ to: string }> = {
    name: 'fake_send', description: 'Test tool.', input: Type.Object({ to: Type.String() }), effect: 'exec', allowedIn: ['chat'],
    summarize: input => ({ title: 'Send', body: input.to }),
    execute: async input => { ran.push(input.to); return { content: `sent ${input.to}`, exitCode: 0 }; },
  };
  const registry = new ToolRegistry().register(send).register(fileRead).register(fileEdit);
  const store = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const projects = new ProjectStore(db, paths.projects);
  const live = new Set(['conv-1', 'conv-2']);
  const deps: ReplayDeps = { db, store, registry, config: () => config, paths, projects, conversationExists: id => live.has(id) };
  const root = join(paths.workspace, 'prod');
  mkdirSync(root, { recursive: true });
  const product = projects.create({ name: 'Prod', root, rootKey: rootKeyOf(root), checkCommand: null });
  const file = (name: string, text: string): string => { const path = join(root, name); writeFileSync(path, text); return path; };
  const memory = new MemoryStore(db);

  const park = async (over: Partial<ParkInput>) => {
    const row = await store.park({ tool: 'fake_send', input: { to: 'x' }, cwd: root, kind: 'judge', reason: 'Judge unsure', runId: 'run-1', runKind: 'chat', conversationId: 'conv-1', projectId: product.id, ...over });
    db.prepare('UPDATE pending_actions SET created_at = ? WHERE id = ?').run(Date.now() - 5000, row.id);
    return row;
  };
  const edit = async (conversationId: string, path: string, old: string, next: string): Promise<void> => {
    const ctx: ToolContext = {
      runId: `run-${conversationId}`, conversationId, kind: 'chat', signal: new AbortController().signal, config, paths, policy: buildPolicy(config, paths), workspace: root,
      project: { id: product.id, root }, taint: { tainted: false, sources: [] }, log: () => undefined, services: { db, memory, emit: () => undefined },
    };
    const read = await fileRead.execute({ path }, ctx);
    assert.ok(!read.isError, read.content);
    const done = await fileEdit.execute({ path, old, new: next }, ctx);
    assert.ok(!done.isError, done.content);
  };
  const approve = (id: number) => replayAction(store.claim(id), deps);
  const ownerCalls = (): number => Number((db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-pending'").get() as { n: number }).n);
  return { root, db, store, product, ran, file, park, edit, approve, ownerCalls };
}

test('積んだあとに、同じ会話が送るファイルを自分で書き換えた → 承認は cancelled（動かない・理由つき）で、持ち主に「変わった」の空振りを見せない', async t => {
  const s = rig(t);
  const path = s.file('report.txt', 'one');
  const row = await s.park({ files: [path] });
  assert.ok(JSON.parse(s.store.row(row.id)!.state!).sent?.length, '前提: 送るファイルが控えに入る');
  await s.edit('conv-1', path, 'one', 'twelve');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM file_changes WHERE conversation_id = 'conv-1' AND path = 'report.txt'").get()!.n, 1, '前提: 書き換えの記録がある');

  const outcome = await s.approve(row.id);

  assert.equal(outcome.status, 'cancelled', outcome.output);
  const after = s.store.row(row.id)!;
  assert.equal(after.status, 'cancelled');
  assert.match(after.reject_reason ?? '', /settled another way/u);
  assert.match(after.output_preview ?? '', /settled another way/u);
  assert.deepEqual(s.ran, [], '動いていない');
  assert.equal(s.ownerCalls(), 0, '動いた記録（owner-pending）が無い');
  const note = pendingNote(after, s.store.view(row.id)!);
  assert.equal(note?.head, 'settled', '担当には 1 行の知らせが届く（動かさずに閉じた・まだ要るなら呼び直す）');
  assert.match(note!.text, /was closed without running/u);
  assert.match(note!.text, /call it again/u);
  assert.doesNotMatch(note!.text, /owner approved/u, '「持ち主が承認した」の知らせではない');
  assert.equal(note!.fetched, false);
});

test('別の会話が書いたなら、今までどおり stale（持ち主に見せる）', async t => {
  const s = rig(t);
  const path = s.file('report.txt', 'one');
  const row = await s.park({ files: [path] });
  await s.edit('conv-2', path, 'one', 'twelve');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', outcome.output);
  assert.match(s.store.row(row.id)!.output_preview ?? '', /files it reads or sends changed/u);
  assert.equal(pendingNote(s.store.row(row.id)!, s.store.view(row.id)!)?.head, 'stale');
  assert.deepEqual(s.ran, []);
});

test('同じ会話が書いたあとに、ほかの手でさらに変わった（今の中身が書いた中身と違う）なら stale', async t => {
  const s = rig(t);
  const path = s.file('report.txt', 'one');
  const row = await s.park({ files: [path] });
  await s.edit('conv-1', path, 'one', 'twelve');
  writeFileSync(path, 'twelve and the owner added more');
  assert.equal((await s.approve(row.id)).status, 'stale');
  assert.deepEqual(s.ran, []);
});

test('変わったファイルの 1 つでも、同じ会話の記録で説明できなければ stale（全部でないと閉じない）', async t => {
  const s = rig(t);
  const mine = s.file('mine.txt', 'one');
  const theirs = s.file('theirs.txt', 'one');
  const row = await s.park({ files: [mine, theirs] });
  await s.edit('conv-1', mine, 'one', 'twelve');
  writeFileSync(theirs, 'changed by hand');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', outcome.output);
  assert.deepEqual(s.ran, []);
});

test('積む前に同じ会話が書いた記録しか無い（積んだあとの書き込みは記録に無い）なら stale', async t => {
  const s = rig(t);
  const path = s.file('report.txt', 'one');
  await s.edit('conv-1', path, 'one', 'twelve');
  writeFileSync(path, 'one');
  const row = await s.park({ files: [path] });
  s.db.prepare('UPDATE pending_actions SET created_at = ? WHERE id = ?').run(Date.now() + 5000, row.id);
  writeFileSync(path, 'twelve');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', outcome.output);
  assert.deepEqual(s.ran, []);
});

test('記録で説明できないもの（製品の外のファイル・製品の無い行・フォルダ）は stale', async t => {
  const s = rig(t);
  const outside = join(s.root, '..', 'outside.txt');
  writeFileSync(outside, 'one');
  const away = await s.park({ files: [outside] });
  writeFileSync(outside, 'twelve');
  assert.equal((await s.approve(away.id)).status, 'stale', '製品の外');

  const path = s.file('report.txt', 'one');
  const noProduct = await s.park({ files: [path], projectId: undefined });
  await s.edit('conv-1', path, 'one', 'twelve');
  assert.equal((await s.approve(noProduct.id)).status, 'stale', '製品に属さない行は、記録があっても説明に使わない');

  const folder = join(s.root, 'docs');
  mkdirSync(folder);
  const inside = s.file(join('docs', 'a.txt'), 'one');
  const dir = await s.park({ files: [folder] });
  await s.edit('conv-1', inside, 'one', 'twelve');
  assert.equal((await s.approve(dir.id)).status, 'stale', 'フォルダは、中のファイルの記録では説明しない');
  assert.deepEqual(s.ran, []);
});

test('消す行（積んだときの中身の写し）も同じ: 同じ会話が対象を書き換えたなら cancelled、別の手なら stale', async t => {
  const s = rig(t);
  const mine = s.file('mine.txt', 'one');
  const settled = await s.park({ kind: 'delete', targets: [mine] });
  await s.edit('conv-1', mine, 'one', 'twelve');
  const outcome = await s.approve(settled.id);
  assert.equal(outcome.status, 'cancelled', outcome.output);
  assert.match(s.store.row(settled.id)!.reject_reason ?? '', /settled another way/u);

  const theirs = s.file('theirs.txt', 'one');
  const other = await s.park({ kind: 'delete', targets: [theirs] });
  writeFileSync(theirs, 'changed by hand');
  const changed = await s.approve(other.id);
  assert.equal(changed.status, 'stale', changed.output);
  assert.match(s.store.row(other.id)!.output_preview ?? '', /things changed after it was parked/u);
  assert.deepEqual(s.ran, []);
});

test('何も変わっていなければ今までどおり動く（閉じる方向だけで、通す条件は変えない）', async t => {
  const s = rig(t);
  const path = s.file('report.txt', 'one');
  const row = await s.park({ files: [path] });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran', outcome.output);
  assert.deepEqual(s.ran, ['x']);
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

test('消す行が git の製品の中: 対象を同じ会話が書き換えても、git の状態（git status）の変化は記録で説明できないので stale', { skip: !gitAvailable }, async t => {
  const s = rig(t);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: s.root, stdio: 'ignore' });
  const path = s.file('mine.txt', 'one');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const row = await s.park({ kind: 'delete', targets: [path] });
  assert.ok(JSON.parse(s.store.row(row.id)!.state!).snapshot.git, '前提: git の状態も写してある');
  await s.edit('conv-1', path, 'one', 'twelve');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', outcome.output);
  assert.match(s.store.row(row.id)!.output_preview ?? '', /git status/u);
  assert.deepEqual(s.ran, []);
});

test('git の名前（branch など）は、作業フォルダの同名のファイルの記録として数えない（相対の名前は説明に使わない）', { skip: !gitAvailable }, async t => {
  const s = rig(t);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: s.root, stdio: 'ignore' });
  writeFileSync(join(s.root, '.gitignore'), 'mine.txt\nbranch\n');
  const path = s.file('mine.txt', 'one');
  const lookalike = s.file('branch', 'one');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const before = process.cwd();
  process.chdir(s.root);
  try {
    const row = await s.park({ kind: 'delete', targets: [path] });
    await s.edit('conv-1', path, 'one', 'twelve');
    await s.edit('conv-1', lookalike, 'one', 'twelve');
    git('switch', '-q', '-c', 'other');
    const outcome = await s.approve(row.id);
    assert.equal(outcome.status, 'stale', outcome.output);
    assert.match(s.store.row(row.id)!.output_preview ?? '', /- branch: before refs\/heads\/main, now refs\/heads\/other/u);
    assert.deepEqual(s.ran, []);
  } finally { process.chdir(before); }
});
