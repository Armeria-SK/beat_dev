import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { hiddenPath, hunksOf, lineEndingsLike, readCurrent } from '../src/changes/diff.ts';
import { changesDir, insertChange, keepContent, KEEP_MAX_BYTES, productRel, relParts, type FileChangeRow } from '../src/changes/record.ts';
import { undoEntries, writeBack } from '../src/changes/restore.ts';
import { pruneChanges } from '../src/changes/retention.ts';
import { SNAPSHOT_EVENT, snapshotBeforeBuild, snapshotLine } from '../src/projects/snapshot-before.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { readThen, reply, tempDir, type Script, withLoad } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const link = (target: string, path: string): void => symlinkSync(target, path, WINDOWS ? 'junction' : 'dir');

async function rig(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  let n = 0;
  const product = async (name: string, files: Record<string, string | Buffer>, options: { git?: boolean; attributes?: string } = {}) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    if (options.git) {
      git(root, 'init', '-q', '-b', 'main');
      if (options.attributes) writeFileSync(join(root, '.gitattributes'), options.attributes);
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    if (options.git) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'first'); }
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const run = async (projectId: string, scripts: Script[]) => {
    s.adapter().scripts = [...scripts, reply('done')];
    const id = uuid(++n);
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'work', projectId, permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    return { conversation: id, runId: sent.body.runId as string };
  };
  const rows = (projectId: string) => s.app.db.prepare('SELECT * FROM file_changes WHERE project_id = ? ORDER BY id').all(projectId) as unknown as FileChangeRow[];
  const changes = (projectId: string, query = '') => s.json(`/api/projects/${projectId}/changes${query}`, 'GET');
  const undo = (projectId: string, body: Record<string, unknown>) => s.json(`/api/projects/${projectId}/changes/undo`, 'POST', body);
  const redo = (projectId: string, id: string) => s.json(`/api/projects/${projectId}/changes/redo`, 'POST', { redo: id });
  return { ...s, products, product, run, rows, changes, undo, redo };
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

test('8-4 記録: file_write・file_edit・table_write は書く前に元の中身を控えに置き、表に 1 行（実行・会話・相対パス・作る/変える・前後のハッシュ・大きさ）', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  const made = await s.run(p.id, [
    readThen('file_write', { path: 'a.txt', content: 'v2\n' }),
    call('file_edit', { path: 'a.txt', old: 'v2', new: 'v3' }),
    call('file_write', { path: 'sub/new.txt', content: 'fresh\n' }),
    call('table_write', { path: 't.csv', rows: [['x', 1]] }),
  ]);
  assert.equal(read(p.root, 'a.txt'), 'v3\n');
  const rows = s.rows(p.id);
  assert.deepEqual(rows.map(r => [r.path, r.action, r.before_hash, r.kept, r.size, r.place]), [
    ['a.txt', 'modify', sha('v1\n'), 1, 3, null],
    ['a.txt', 'modify', sha('v2\n'), 1, 3, null],
    ['sub/new.txt', 'create', null, 1, 0, null],
    ['t.csv', 'create', null, 1, 0, null],
  ]);
  assert.equal(rows[0]!.after_hash, sha('v2\n'));
  assert.equal(rows[1]!.after_hash, sha('v3\n'));
  for (const row of rows) assert.deepEqual([row.run_id, row.conversation_id], [made.runId, made.conversation]);
  const kept = join(changesDir(s.paths), p.id);
  assert.equal(readFileSync(join(kept, sha('v1\n')), 'utf8'), 'v1\n');
  assert.equal(readFileSync(join(kept, sha('v2\n')), 'utf8'), 'v2\n');
});

test('8-4 Undo / Redo（記録の元・git でない製品）: 元に戻り、新しく作ったファイルは消え、Redo で戻る。Redo は 1 回だけ', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n', 'keep.txt': 'same\n' });
  await s.run(p.id, [
    readThen('file_write', { path: 'a.txt', content: 'v2\n' }),
    call('file_edit', { path: 'a.txt', old: 'v2', new: 'v3' }),
    call('file_write', { path: 'sub/new.txt', content: 'fresh\n' }),
    call('table_write', { path: 't.csv', rows: [['x', 1]] }),
  ]);
  const listed = await s.changes(p.id);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.base.kind, 'records');
  assert.equal(listed.body.redo, null, 'Undo の前は Redo できるものが無い');
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.status, f.added, f.removed, f.hidden, f.undo]), [
    ['a.txt', 'modified', 1, 1, false, true],
    ['sub/new.txt', 'added', 1, 0, false, true],
    ['t.csv', 'added', 1, 0, false, true],
  ]);
  assert.deepEqual(listed.body.files[0].hunks, [['@@ -1,1 +1,1 @@', '-v1', '+v3']]);

  const undone = await s.undo(p.id, { base: 'records', paths: 'all' });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual([undone.body.undone, undone.body.refused], [['a.txt', 'sub/new.txt', 't.csv'], []]);
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
  assert.equal(existsSync(join(p.root, 'sub', 'new.txt')), false, '新しく作ったファイルは消える');
  assert.equal(existsSync(join(p.root, 'sub')), false, '空になったフォルダも消える');
  assert.equal(existsSync(join(p.root, 't.csv')), false);
  assert.equal(read(p.root, 'keep.txt'), 'same\n');
  const after = await s.changes(p.id);
  assert.deepEqual(after.body.files, []);
  assert.deepEqual(after.body.redo, { id: undone.body.redo, created_at: after.body.redo?.created_at, paths: ['a.txt', 'sub/new.txt', 't.csv'] }, '差分の答えに、まだ Redo していない最後の Undo が載る');
  assert.equal(typeof after.body.redo.created_at, 'number');

  const redone = await s.redo(p.id, undone.body.redo);
  assert.equal(redone.status, 200, JSON.stringify(redone.body));
  assert.deepEqual(redone.body.refused, []);
  assert.equal(read(p.root, 'a.txt'), 'v3\n');
  assert.equal(read(p.root, 'sub/new.txt'), 'fresh\n');
  assert.equal((await s.redo(p.id, undone.body.redo)).status, 409, '同じ Redo は 2 回しない');
  assert.equal((await s.changes(p.id)).body.redo, null, 'Redo したあとは載らない');
  assert.equal((await s.redo(p.id, '00000000-0000-4000-8000-000000000000')).status, 404);
});

test('8-4 シェルで変えたファイル: git の製品では「前のコミット」の差分に出て Undo できる。git でない製品の記録には出ない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'one\n' }, { git: true });
  writeFileSync(join(g.root, 'a.txt'), 'one\nshell\n');
  writeFileSync(join(g.root, 'made.txt'), 'by shell\n');
  const listed = await s.changes(g.id, '?base=commit');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.base.kind, 'commit');
  assert.equal(listed.body.base.ref, git(g.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.status, f.undo]), [['a.txt', 'modified', true], ['made.txt', 'added', true]]);
  const undone = await s.undo(g.id, { base: 'commit', paths: ['a.txt', 'made.txt'] });
  assert.deepEqual([undone.body.undone, undone.body.refused], [['a.txt', 'made.txt'], []]);
  assert.equal(read(g.root, 'a.txt'), 'one\n');
  assert.equal(existsSync(join(g.root, 'made.txt')), false);
  assert.equal(git(g.root, 'status', '--porcelain'), '', '作業の木がコミットと同じに戻る');

  const plain = await s.product('plain', { 'a.txt': 'one\n' });
  writeFileSync(join(plain.root, 'a.txt'), 'shell\n');
  const none = await s.changes(plain.id);
  assert.deepEqual([none.body.base.kind, none.body.files], ['records', []]);
  assert.equal((await s.changes(plain.id, '?base=commit')).status, 400, 'git でない製品に git の元は無い');
});

test('8-4 持ち主がコミットせずに書き足したファイル: 「前のコミット」から Undo → Redo で書き足しが戻る（控えてから戻す）', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'notes.md': '# notes\n' }, { git: true });
  writeFileSync(join(g.root, 'notes.md'), '# notes\nowner line\n');
  const undone = await s.undo(g.id, { base: 'commit', paths: ['notes.md'] });
  assert.deepEqual(undone.body.undone, ['notes.md']);
  assert.equal(read(g.root, 'notes.md'), '# notes\n');
  const row = s.rows(g.id).find(r => r.action === 'undo')!;
  assert.deepEqual([row.before_hash, row.kept], [sha('# notes\nowner line\n'), 1]);
  const redone = await s.redo(g.id, undone.body.redo);
  assert.deepEqual([redone.body.redone, redone.body.refused], [['notes.md'], []]);
  assert.equal(read(g.root, 'notes.md'), '# notes\nowner line\n');
});

test('8-4 Redo: Undo のあとに中身が変わったファイルは書かない（changed）', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  const undone = await s.undo(p.id, { paths: ['a.txt'] });
  writeFileSync(join(p.root, 'a.txt'), 'owner edit\n');
  const redone = await s.redo(p.id, undone.body.redo);
  assert.deepEqual(redone.body.refused, [{ path: 'a.txt', reason: 'changed' }]);
  assert.equal(read(p.root, 'a.txt'), 'owner edit\n');
});

test('8-4 ジャンクション: 途中にリンクのあるパスの Undo は断られ、外の見張りのファイルは変わらない（Q-60-1 の再現の形）', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const outside = join(s.products, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'x.txt'), 'SENTINEL\n');

  const p = await s.product('plain', {});
  await s.run(p.id, [call('file_write', { path: 'sub/x.txt', content: 'ai\n' })]);
  rmSync(join(p.root, 'sub'), { recursive: true });
  link(outside, join(p.root, 'sub'));
  const listed = await s.changes(p.id);
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.undo]), [['sub/x.txt', false]]);
  const refused = await s.undo(p.id, { paths: ['sub/x.txt'] });
  assert.deepEqual([refused.body.undone, refused.body.refused], [[], [{ path: 'sub/x.txt', reason: 'link' }]]);
  assert.equal(readFileSync(join(outside, 'x.txt'), 'utf8'), 'SENTINEL\n', '消す Undo がジャンクションの先を消さない');

  const g = await s.product('repo', { 'lib/x.txt': 'committed\n' }, { git: true });
  rmSync(join(g.root, 'lib'), { recursive: true });
  link(outside, join(g.root, 'lib'));
  const all = await s.undo(g.id, { base: 'commit', paths: 'all' });
  assert.ok(!all.body.undone.includes('lib/x.txt'), JSON.stringify(all.body));
  const named = await s.undo(g.id, { base: 'commit', paths: ['lib/x.txt'] });
  assert.deepEqual(named.body.undone, []);
  assert.equal(readFileSync(join(outside, 'x.txt'), 'utf8'), 'SENTINEL\n', '書き戻しがジャンクションの先を上書きしない');
});

test('8-4 書き戻しの関数: 途中のジャンクション・最後のリンク・製品の外・.git・秘密・守る場所を断り、外の見張りのファイルは変わらない', t => {
  const base = realpathSync.native(tempDir(t));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'x.txt'), 'SENTINEL\n');
  link(outside, join(root, 'via'));
  const bytes = Buffer.from('new\n');
  const deny = [join(root, 'blocked')];
  assert.deepEqual(writeBack(root, 'via/x.txt', bytes, deny), { ok: false, reason: 'link' }, '途中のジャンクション');
  assert.deepEqual(writeBack(root, 'via/x.txt', null, deny), { ok: false, reason: 'link' }, '消す形も途中のジャンクションで断る');
  assert.deepEqual(writeBack(root, 'via', null, deny), { ok: false, reason: 'link' }, 'リンクそのものも消さない');
  assert.equal(readFileSync(join(outside, 'x.txt'), 'utf8'), 'SENTINEL\n');
  for (const rel of ['../outside/x.txt', 'a/../../outside/x.txt', '/etc/x', 'C:/x.txt', '.git/config', 'sub/.git/HEAD', 'a\\b.txt', '', 'x.txt:stream']) {
    assert.deepEqual(writeBack(root, rel, bytes, deny), { ok: false, reason: 'unsafe_path' }, rel);
  }
  assert.deepEqual(writeBack(root, '.env', bytes, deny), { ok: false, reason: 'hidden' });
  assert.deepEqual(writeBack(root, 'blocked/a.txt', bytes, deny), { ok: false, reason: 'hidden' });
  assert.equal(existsSync(join(root, 'blocked')), false);
  assert.deepEqual(writeBack(root, 'deep/er/a.txt', bytes, deny), { ok: true });
  assert.equal(readFileSync(join(root, 'deep', 'er', 'a.txt'), 'utf8'), 'new\n');
  writeFileSync(join(root, 'deep', 'other.txt'), 'x');
  assert.deepEqual(writeBack(root, 'deep/er/a.txt', null, deny), { ok: true });
  assert.deepEqual([existsSync(join(root, 'deep', 'er')), existsSync(join(root, 'deep', 'other.txt'))], [false, true], '空のフォルダだけ消える');
});

test('8-4 秘密らしいファイル: .env は hidden で中身を返さず、Undo できない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'x\n' }, { git: true });
  writeFileSync(join(g.root, '.env'), 'API_KEY=TOPSECRET123\n');
  const listed = await s.changes(g.id, '?base=commit');
  assert.deepEqual(listed.body.files, [{ path: '.env', status: 'added', added: 0, removed: 0, hunks: null, hidden: true, undo: false }]);
  assert.ok(!JSON.stringify(listed.body).includes('TOPSECRET'));
  const refused = await s.undo(g.id, { base: 'commit', paths: ['.env'] });
  assert.deepEqual(refused.body.refused, [{ path: '.env', reason: 'hidden' }]);
  const all = await s.undo(g.id, { base: 'commit', paths: 'all' });
  assert.deepEqual([all.body.undone, all.body.refused], [[], []]);
  assert.equal(read(g.root, '.env'), 'API_KEY=TOPSECRET123\n');
});

test('8-4 動いているあいだ: 製品のタスクが動いていれば Undo・Redo は 409、差分は読める', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  const undone = await s.undo(p.id, { paths: ['a.txt'] });
  const task = s.app.tasks.create({ title: 'busy', origin: 'user', actor: 'user', projectId: p.id });
  s.app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  const blocked = await s.undo(p.id, { paths: 'all' });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'project.changes_busy']);
  assert.equal((await s.redo(p.id, undone.body.redo)).status, 409);
  assert.equal((await s.changes(p.id)).status, 200);
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('8-4 大きさ: 5MB を超えるファイルは控えず（kept 0）、その記録からの Undo は not_kept', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'big.txt': Buffer.alloc(KEEP_MAX_BYTES + 1, 0x61) });
  await s.run(p.id, [readThen('file_write', { path: 'big.txt', content: 'small\n' }, { limit: 1 })]);
  assert.deepEqual(s.rows(p.id).map(r => [r.action, r.kept, r.before_hash, r.size]), [['modify', 0, null, KEEP_MAX_BYTES + 1]]);
  assert.equal(existsSync(join(changesDir(s.paths), p.id)), false, '控えのファイルは作らない');
  const listed = await s.changes(p.id);
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.undo]), [['big.txt', false]]);
  const refused = await s.undo(p.id, { paths: ['big.txt'] });
  assert.deepEqual(refused.body.refused, [{ path: 'big.txt', reason: 'not_kept' }]);
  assert.equal(read(p.root, 'big.txt'), 'small\n');
});

test('8-4 大きさ: 今の中身が 5MB を超えるファイルの Undo は cannot_keep で断られ、中身は変わらない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'data.txt': 'small\n' }, { git: true });
  const big = Buffer.alloc(KEEP_MAX_BYTES + 10, 0x62);
  writeFileSync(join(g.root, 'data.txt'), big);
  const refused = await s.undo(g.id, { base: 'commit', paths: ['data.txt'] });
  assert.deepEqual([refused.body.undone, refused.body.refused], [[], [{ path: 'data.txt', reason: 'cannot_keep' }]]);
  assert.ok(readFileSync(join(g.root, 'data.txt')).equals(big));
});

test('8-4 CRLF の製品: 改行の変換だけの違いは差分に出ず、Undo は作業の木の改行のまま書き戻す', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const original = Buffer.from('one\r\ntwo\r\n');
  const g = await s.product('crlf', { 'a.txt': original, 'b.txt': 'lf one\nlf two\n' }, { git: true, attributes: '* text eol=crlf\n' });
  assert.deepEqual((await s.changes(g.id, '?base=commit')).body.files, [], '改行だけでは差分にならない');
  await s.run(g.id, [readThen('file_write', { path: 'a.txt', content: 'one\r\nTWO\r\n' }), readThen('file_write', { path: 'b.txt', content: 'lf one\nLF TWO\n' })]);
  const listed = await s.changes(g.id, '?base=commit');
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.added, f.removed]), [['a.txt', 1, 1], ['b.txt', 1, 1]]);
  const undone = await s.undo(g.id, { base: 'commit', paths: ['a.txt', 'b.txt'] });
  assert.deepEqual(undone.body.undone, ['a.txt', 'b.txt']);
  assert.ok(readFileSync(join(g.root, 'a.txt')).equals(original), readFileSync(join(g.root, 'a.txt')).toString('hex'));
  assert.equal(read(g.root, 'b.txt'), 'lf one\nlf two\n', 'eol=crlf の製品でも、LF のままのファイルは LF で戻す');
});

test('8-4 前の Build の始まり: 6-0 の控えのコミットから差分を出し、Undo でそこへ戻す。既定の元は build', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('built', { 'a.txt': 'committed\n' }, { git: true });
  writeFileSync(join(g.root, 'a.txt'), 'before build\n');
  writeFileSync(join(g.root, 'wip.txt'), 'owner wip\n');
  const task = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: g.id });
  const snap = await snapshotBeforeBuild(g.root, task.id, s.paths.data);
  assert.equal(snap.kind, 'taken');
  s.app.tasks.event(task.id, SNAPSHOT_EVENT, 'beat', snapshotLine(snap));
  writeFileSync(join(g.root, 'a.txt'), 'after build\n');
  writeFileSync(join(g.root, 'built.txt'), 'new\n');
  const listed = await s.changes(g.id);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.base.kind, 'build');
  assert.equal(listed.body.base.ref, (snap as { hash: string }).hash);
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.status]), [['a.txt', 'modified'], ['built.txt', 'added']], '控えにあった書きかけ（wip.txt）は変わっていない');
  const undone = await s.undo(g.id, { paths: 'all' });
  assert.deepEqual(undone.body.undone, ['a.txt', 'built.txt']);
  assert.equal(read(g.root, 'a.txt'), 'before build\n');
  assert.equal(existsSync(join(g.root, 'built.txt')), false);
  assert.equal(read(g.root, 'wip.txt'), 'owner wip\n');
  assert.equal((await s.changes(g.id, `?base=build&task=${uuid(99)}`)).status, 400, 'ほかの製品・無いタスクは選べない');
});

test('8-4 タスクを消す: 書き換えの記録があっても消せて、記録の行は残り（タスクとの結び付きだけ空になる）、差分と Undo はそのまま動く', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  const task = s.app.tasks.create({ title: 'nightly', origin: 'user', actor: 'user', projectId: p.id, cron: '0 9 * * *', timezone: 'UTC' });
  s.app.db.prepare('UPDATE file_changes SET task_id = ? WHERE project_id = ?').run(task.id, p.id);
  assert.deepEqual((await s.changes(p.id, `?base=records&task=${task.id}`)).body.files.map((f: any) => f.path), ['a.txt']);
  const deleted = await s.json(`/api/tasks/${task.id}`, 'DELETE');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(s.app.tasks.get(task.id), undefined);
  assert.deepEqual(s.rows(p.id).map(r => [r.path, r.action, r.task_id]), [['a.txt', 'modify', null]]);
  assert.equal((await s.changes(p.id, `?base=records&task=${task.id}`)).status, 400, '消したタスクでは絞れない');
  const listed = await s.changes(p.id);
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.undo]), [['a.txt', true]]);
  const undone = await s.undo(p.id, { paths: ['a.txt'] });
  assert.deepEqual([undone.body.undone, undone.body.refused], [['a.txt'], []]);
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('8-4 書いた場所: place が NULL でない行（worktree の書き込み）は差分にも Undo にも出ない', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  const hash = keepContent(changesDir(s.paths), p.id, Buffer.from('elsewhere\n'));
  insertChange(s.app.db, { project_id: p.id, place: 'abcd1234', run_id: 'r', conversation_id: 'c', task_id: null, batch: null, path: 'a.txt', action: 'modify', before_hash: hash, after_hash: sha('v1\n'), size: 10, kept: 1, created_at: Date.now() });
  assert.deepEqual((await s.changes(p.id)).body.files, []);
  const refused = await s.undo(p.id, { paths: ['a.txt'] });
  assert.deepEqual(refused.body.refused, [{ path: 'a.txt', reason: 'not_changed' }]);
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('8-4 持ち主の要求のパスは照らすだけ: 差分に無いパス・外へのパスは書かない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'x\n' }, { git: true });
  writeFileSync(join(s.products, 'victim.txt'), 'keep\n');
  const refused = await s.undo(g.id, { base: 'commit', paths: ['../victim.txt', 'a.txt', 'nothing.txt'] });
  assert.deepEqual(refused.body.refused.map((r: any) => r.reason), ['not_changed', 'not_changed', 'not_changed']);
  assert.equal(readFileSync(join(s.products, 'victim.txt'), 'utf8'), 'keep\n');
  assert.equal(read(g.root, 'a.txt'), 'x\n');
  assert.equal(existsSync(join(g.root, 'nothing.txt')), false);
  assert.equal((await s.undo(g.id, { base: 'commit', paths: 'some' })).status, 400);
});

test('8-4 worktree のブランチの差分: 元のコミットから先端までを読むだけで返す（Undo なし）', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'one\n' }, { git: true });
  const base = git(g.root, 'rev-parse', 'HEAD');
  git(g.root, 'switch', '-q', '-c', 'beat/fix-1a2b');
  writeFileSync(join(g.root, 'a.txt'), 'two\n');
  git(g.root, 'commit', '-q', '-am', 'change');
  git(g.root, 'switch', '-q', 'main');
  s.app.db.prepare("INSERT INTO worktrees (id, project_id, repo, kind, path, branch, base, state, created_at, updated_at) VALUES ('0a1b2c3d', ?, ?, 'task', NULL, 'beat/fix-1a2b', ?, 'branch', 1, 1)").run(g.id, g.root, base);
  const listed = await s.json('/api/worktrees/0a1b2c3d/changes', 'GET');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.status, f.undo, f.hunks]), [['a.txt', 'modified', false, [['@@ -1,1 +1,1 @@', '-one', '+two']]]]);
  assert.equal(read(g.root, 'a.txt'), 'one\n');
  assert.equal((await s.json('/api/worktrees/ffffffff/changes', 'GET')).status, 404);
});

test('8-4 控えの上限: 30 日より古い記録と控えは消え、合計の上限を超えると古いものから消える。使っている控えは残る', t => {
  const base = tempDir(t);
  const db = openDatabase(join(base, 'beat.db'), MIGRATIONS);
  try { pruneCase(db, join(base, 'changes')); } finally { db.close(); }
});

function pruneCase(db: ReturnType<typeof openDatabase>, dir: string): void {
  const now = 100 * 86_400_000;
  const add = (body: string, at: number) => {
    const hash = keepContent(dir, 'proj01', Buffer.from(body));
    insertChange(db, { project_id: 'proj01', place: null, run_id: 'r', conversation_id: 'c', task_id: null, batch: null, path: 'a.txt', action: 'modify', before_hash: hash, after_hash: null, size: body.length, kept: 1, created_at: at });
    return hash;
  };
  const old = add('x'.repeat(100), now - 31 * 86_400_000);
  const shared = add('y'.repeat(100), now - 31 * 86_400_000);
  add('y'.repeat(100), now - 1000);
  const middle = add('z'.repeat(100), now - 2000);
  const fresh = add('w'.repeat(100), now - 500);
  writeFileSync(join(dir, 'proj01', `.${sha('t')}.abc.tmp`), 'left');
  utimesSync(join(dir, 'proj01', `.${sha('t')}.abc.tmp`), new Date(0), new Date(0));
  const first = pruneChanges(db, dir, now, { maxAgeMs: 30 * 86_400_000, maxBytes: 10_000 });
  assert.deepEqual(first, { rows: 2, files: 2 });
  assert.equal(existsSync(join(dir, 'proj01', old)), false, '古い控え');
  assert.equal(existsSync(join(dir, 'proj01', shared)), true, '新しい行が使っている控えは残る');
  const second = pruneChanges(db, dir, now, { maxAgeMs: 30 * 86_400_000, maxBytes: 250 });
  assert.equal(second.files, 1);
  assert.equal(existsSync(join(dir, 'proj01', middle)), false, '上限を超えた分は古い行から');
  assert.equal(existsSync(join(dir, 'proj01', fresh)), true);
  assert.equal(existsSync(join(dir, 'proj01', shared)), true);
  assert.ok(statSync(join(dir, 'proj01', fresh)).size === 100);
}

test('8-4 改行: git の取り出し（--filters）と生の中身のうち、作業の木のファイルの改行に合う方を元にする', () => {
  const lf = Buffer.from('a\nb\n');
  const crlf = Buffer.from('a\r\nb\r\n');
  assert.equal(lineEndingsLike(Buffer.from('x\n'), crlf, lf), lf, 'この PC の autocrlf で CRLF に取り出されても、LF のファイルには LF');
  assert.equal(lineEndingsLike(Buffer.from('x\r\n'), crlf, lf), crlf, 'eol=crlf の製品の CRLF のファイルには CRLF');
  assert.equal(lineEndingsLike(Buffer.from('x\r\n'), lf, lf), lf, '合う方が無ければ取り出しのまま');
  assert.equal(lineEndingsLike(null, crlf, lf), crlf, '消えたファイルは git が取り出すときの形');
});

test('8-4 差分の塊: 3 行の前後つきで、離れた変更は別の塊', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l2', 'L2').replace('l15', 'L15');
  const made = hunksOf(before, after);
  assert.deepEqual([made.added, made.removed], [2, 2]);
  assert.deepEqual(made.hunks, [
    ['@@ -1,6 +1,6 @@', ' l0', ' l1', '-l2', '+L2', ' l3', ' l4', ' l5'],
    ['@@ -13,7 +13,7 @@', ' l12', ' l13', ' l14', '-l15', '+L15', ' l16', ' l17', ' l18'],
  ]);
});

test('8-4 短い名前（8.3）: ENV~1.LOC は .env.local の別名として断り、中身は変わらない。GIT~1 から .git の中へも書かない', { skip: !WINDOWS }, async t => {
  const root = realpathSync.native(tempDir(t));
  writeFileSync(join(root, '.env.local'), 'SECRET=1\n');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  if (!existsSync(join(root, 'ENV~1.LOC')) || !existsSync(join(root, 'GIT~1'))) { t.skip('この場所のドライブに短い名前が無い'); return; }
  assert.equal(readCurrent(root, 'ENV~1.LOC'), 'unknown');
  assert.equal(hiddenPath(root, 'ENV~1.LOC', []), true);
  assert.equal(writeBack(root, 'ENV~1.LOC', Buffer.from('x'), []).ok, false);
  assert.equal(writeBack(root, 'ENV~1.LOC', null, []).ok, false);
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), 'SECRET=1\n');
  assert.equal(writeBack(root, 'GIT~1/hooks/x', Buffer.from('run me'), []).ok, false);
  assert.equal(existsSync(join(root, '.git', 'hooks', 'x')), false);

  const s = await rig(t);
  const p = await s.product('short', { '.env.local': 'SECRET=1\n', 'a.txt': 'a\n' });
  if (!existsSync(join(p.root, 'ENV~1.LOC'))) { t.skip('製品のドライブに短い名前が無い'); return; }
  await s.run(p.id, [call('file_write', { path: 'ENV~1.LOC', content: 'AI\n' })]);
  const written = read(p.root, '.env.local');
  const rows = s.rows(p.id);
  assert.ok(rows.every(r => r.path === '.env.local'), JSON.stringify(rows.map(r => r.path)));
  const listed = await s.changes(p.id);
  assert.ok(listed.body.files.every((f: any) => f.hidden && !f.undo), JSON.stringify(listed.body.files));
  const all = await s.undo(p.id, { paths: 'all' });
  assert.deepEqual(all.body.undone, []);
  const named = await s.undo(p.id, { paths: ['ENV~1.LOC'] });
  assert.deepEqual(named.body.undone, []);
  assert.equal(read(p.root, '.env.local'), written, 'Undo は秘密のファイルを書き戻さない');
});

test('8-4 大文字小文字だけの違い: 同じファイルとして読み書きする（短い名前とは違い、別名として断らない）', { skip: !WINDOWS }, t => {
  const root = realpathSync.native(tempDir(t));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'a.txt'), 'keep\n');
  assert.equal((readCurrent(root, 'sub/A.TXT') as Buffer).toString('utf8'), 'keep\n');
  assert.deepEqual(writeBack(root, 'sub/A.TXT', Buffer.from('x\n'), []), { ok: true });
  assert.equal(readFileSync(join(root, 'sub', 'a.txt'), 'utf8'), 'x\n');
});

test('8-4 大文字小文字の違う 2 回の書き込み: README.md → readme.md → 持ち主の書き足し C のあと、Undo all で元に戻り、Redo で C に戻る', { skip: !WINDOWS }, async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'README.md': 'O\n' });
  await s.run(p.id, [readThen('file_write', { path: 'README.md', content: 'X\n' }), call('file_write', { path: 'readme.md', content: 'Y\n' })]);
  assert.deepEqual(s.rows(p.id).map(r => r.path), ['README.md', 'README.md'], '記録はディスクの上の名前');
  writeFileSync(join(p.root, 'README.md'), 'C\n');
  const listed = await s.changes(p.id);
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.undo]), [['README.md', true]]);
  const undone = await s.undo(p.id, { paths: 'all' });
  assert.deepEqual([undone.body.undone, undone.body.refused], [['README.md'], []]);
  assert.equal(read(p.root, 'README.md'), 'O\n');
  const redone = await s.redo(p.id, undone.body.redo);
  assert.deepEqual([redone.body.redone, redone.body.refused], [['README.md'], []]);
  assert.equal(read(p.root, 'README.md'), 'C\n');
});

test('8-4 大文字小文字だけ違う記録の行は 1 つのファイルにまとめ、Undo でも同じファイルを 2 度書かない（same_file）', { skip: !WINDOWS }, async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'Doc.txt': 'C\n' });
  const dir = changesDir(s.paths);
  const add = (path: string, before: string) => insertChange(s.app.db, { project_id: p.id, place: null, run_id: 'r', conversation_id: 'c', task_id: null, batch: null, path, action: 'modify', before_hash: keepContent(dir, p.id, Buffer.from(before)), after_hash: null, size: 2, kept: 1, created_at: Date.now() });
  add('Doc.txt', 'O\n');
  add('doc.txt', 'X\n');
  const listed = await s.changes(p.id);
  assert.deepEqual(listed.body.files.map((f: any) => f.path), ['Doc.txt']);
  const realRoot = realpathSync.native(p.root);
  const made = undoEntries({ db: s.app.db, dir, projectId: p.id, realRoot, deny: [], now: Date.now() }, [
    { path: 'Doc.txt', before: Buffer.from('O\n'), after: Buffer.from('C\n'), hidden: false },
    { path: 'doc.txt', before: Buffer.from('X\n'), after: Buffer.from('C\n'), hidden: false },
  ], 'all');
  assert.deepEqual([made.undone, made.refused], [['Doc.txt'], [{ path: 'doc.txt', reason: 'same_file' }]]);
  assert.equal(read(p.root, 'Doc.txt'), 'O\n');
});

test('8-4 動いているあいだ（会話の実行）: 製品の会話の実行が動いていれば Undo は 409', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting: Script = async function* (req) { await gate; yield* reply('later')(req); };
  s.adapter().scripts = [waiting];
  const sent = await s.json(`/api/conversations/${uuid(77)}/messages`, 'POST', { text: 'work', projectId: p.id, permissionMode: 'auto' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  try {
    for (let i = 0; i < 200 && !s.app.engine.activeRuns().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(s.app.engine.activeRuns().length > 0);
    const blocked = await s.undo(p.id, { paths: 'all' });
    assert.deepEqual([blocked.status, blocked.body.code], [409, 'project.changes_busy']);
    assert.equal(read(p.root, 'a.txt'), 'v2\n');
  } finally {
    release();
    await settled(s.app, sent.body.runId);
  }
});

test('8-4 書き込みに失敗したら記録の行は残さない（控えは先に取る）', { skip: !WINDOWS }, async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n', 't.csv': 'x\n' });
  chmodSync(join(p.root, 'a.txt'), 0o444);
  chmodSync(join(p.root, 't.csv'), 0o444);
  t.after(() => { try { chmodSync(join(p.root, 'a.txt'), 0o666); chmodSync(join(p.root, 't.csv'), 0o666); } catch { } });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' }), call('table_write', { path: 't.csv', rows: [['y']], overwrite: true })]);
  assert.equal(read(p.root, 'a.txt'), 'v1\n', '書き込みは失敗している');
  const wrote = s.app.db.prepare("SELECT output_preview AS out FROM tool_calls WHERE tool = 'file_write'").get() as { out: string };
  assert.doesNotMatch(wrote.out, /has not been read|changed after it was last read/u, '失敗の理由は読み取り専用で、読んでいないことではない');
  assert.equal(read(p.root, 't.csv'), 'x\n');
  assert.deepEqual(s.rows(p.id), []);
});

test('8-4 Undo all は 200 ファイルまで: 残りの数を more で返す', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'x\n' }, { git: true });
  for (let i = 0; i < 201; i++) writeFileSync(join(g.root, `n${String(i).padStart(3, '0')}.txt`), 'n\n');
  const undone = await s.undo(g.id, { base: 'commit', paths: 'all' });
  assert.equal(undone.status, 200, JSON.stringify(undone.body).slice(0, 300));
  assert.deepEqual([undone.body.undone.length, undone.body.more], [200, 1]);
  const named = await s.undo(g.id, { base: 'commit', paths: ['n200.txt'] });
  assert.deepEqual([named.body.undone, named.body.more], [['n200.txt'], 0]);
});

test('8-4 大きさ: 5MB を超える git の中身は取り出さず（too_large）、今のファイルも読まない（large）', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'big.bin': Buffer.alloc(KEEP_MAX_BYTES + 1, 0x63) }, { git: true });
  writeFileSync(join(g.root, 'big.bin'), 'small\n');
  const listed = await s.changes(g.id, '?base=commit');
  assert.deepEqual(listed.body.files.map((f: any) => [f.path, f.undo]), [['big.bin', false]]);
  const refused = await s.undo(g.id, { base: 'commit', paths: ['big.bin'] });
  assert.deepEqual([refused.body.undone, refused.body.refused], [[], [{ path: 'big.bin', reason: 'too_large' }]]);
  assert.equal(read(g.root, 'big.bin'), 'small\n');
  writeFileSync(join(g.root, 'big.bin'), Buffer.alloc(KEEP_MAX_BYTES + 1, 0x64));
  assert.equal(readCurrent(realpathSync.native(g.root), 'big.bin'), 'large');
});

test('8-4 書き戻しは今のファイルの印（実行の印）を残し、渡された印で新しいファイルを作る', { skip: WINDOWS }, t => {
  const root = realpathSync.native(tempDir(t));
  writeFileSync(join(root, 'run.sh'), 'old\n');
  chmodSync(join(root, 'run.sh'), 0o755);
  assert.deepEqual(writeBack(root, 'run.sh', Buffer.from('new\n'), []), { ok: true });
  assert.equal(statSync(join(root, 'run.sh')).mode & 0o777, 0o755);
  assert.deepEqual(writeBack(root, 'made.sh', Buffer.from('x\n'), [], 0o755), { ok: true });
  assert.equal(statSync(join(root, 'made.sh')).mode & 0o777, 0o755);
});

// A6: 記録の場所（相対パス）の切り出し。ルート直下の `..foo` は親の指定ではなく、ふつうの名前
test('A6: ルート直下の `..foo`（ファイルも、フォルダの中も）は記録の場所になる。`..` そのものと `..` + 区切りで始まるもの（製品の外）は断る', t => {
  const root = realpathSync.native(tempDir(t as never));
  mkdirSync(join(root, '..bar'), { recursive: true });
  writeFileSync(join(root, '..foo'), 'x');
  writeFileSync(join(root, '..bar', 'inner.txt'), 'x');
  writeFileSync(join(root, 'plain.txt'), 'x');
  assert.equal(productRel(root, join(root, '..foo')), '..foo');
  assert.equal(productRel(root, join(root, '..bar', 'inner.txt')), '..bar/inner.txt');
  assert.equal(productRel(root, join(root, 'plain.txt')), 'plain.txt');
  assert.equal(productRel(root, root), null, '製品のルートそのもの');
  assert.equal(productRel(root, join(root, '..')), null, '親');
  assert.equal(productRel(root, join(root, '..', 'sibling.txt')), null, '製品の外');
  assert.equal(productRel(root, join(root, '.git', 'config')), null, '.git の中');
  assert.equal(productRel(root, join(root, '..foo', '..', '.GIT', 'x')), null, '.git の中（大文字小文字ちがい）');
});

test('A6: 相対パスの区切り。Windows ではバックスラッシュも区切り、Windows でない所では / だけ（バックスラッシュは名前の一部）', () => {
  const bs = String.fromCharCode(92);
  assert.deepEqual(relParts(`a${bs}b.txt`, true), ['a', 'b.txt']);
  assert.deepEqual(relParts('a/b.txt', true), ['a', 'b.txt']);
  assert.deepEqual(relParts(`a${bs}b.txt`, false), [`a${bs}b.txt`], 'Linux のファイル名 a(バックスラッシュ)b.txt を、a と b.txt の 2 つに割らない');
  assert.deepEqual(relParts(`a/b${bs}c.txt`, false), ['a', `b${bs}c.txt`]);
  // 親への指定: `..` そのもの、`..` + 区切り。区切りはその場所の区切りだけ
  assert.equal(relParts('..', true), null);
  assert.equal(relParts('..', false), null);
  assert.equal(relParts(`..${bs}x`, true), null);
  assert.equal(relParts('../x', true), null);
  assert.equal(relParts('../x', false), null);
  assert.deepEqual(relParts(`..${bs}x`, false), [`..${bs}x`], 'Linux では ..(バックスラッシュ)x は、その名前のファイル（親ではない）');
  // `..` で始まるだけの名前は親ではない
  assert.deepEqual(relParts('..foo', true), ['..foo']);
  assert.deepEqual(relParts('..foo', false), ['..foo']);
  assert.deepEqual(relParts('...', false), ['...']);
  assert.equal(relParts('', true), null);
});
