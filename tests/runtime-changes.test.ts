import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { gitChanges, readGitPrint, submoduleHead } from '../src/changes/git-print.ts';
import { captureSnapshot, fingerprint, INSPECT_MAX, listRunChanges, MAX_DIRTY, makeGuard, compareSnapshots, RUN_KEEP, RUN_SHOWN, saveRunChanges, type Guard, type Print, type RuntimeRunChanges, type Snapshot } from '../src/changes/runtime.ts';
import { walkCurrent } from '../src/changes/diff.ts';
import { KEEP_MAX_BYTES } from '../src/changes/record.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { startApp, uuid, waitFor } from './app-setup.ts';
import { rig } from './helpers/runtime-rig.ts';

// AR-9: 外の実行役の返事のあとに、beat が git の前後から変わったファイルを割り出す（src/changes/runtime.ts）。実行役の自己申告は使わない

const WINDOWS = process.platform === 'win32';
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const SECRET = 'outside-secret-text-42';
let n = 500;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const link = (target: string, path: string): void => symlinkSync(target, path, WINDOWS ? 'junction' : 'dir');

type Rig = Awaited<ReturnType<typeof rig>>;

// 製品のフォルダを作り、git にして最初のコミットまで済ませる（beat には製品として登録される）
async function repo(r: Rig, files: Record<string, string>, options: { commit?: boolean; ignore?: string } = {}) {
  const made = await r.product('prod', {});
  git(made.root, 'init', '-q', '-b', 'main');
  if (options.ignore) writeFileSync(join(made.root, '.gitignore'), options.ignore);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(made.root, rel, '..'), { recursive: true });
    writeFileSync(join(made.root, rel), body);
  }
  if (options.commit !== false) { git(made.root, 'add', '-A'); git(made.root, 'commit', '-q', '-m', 'first'); }
  return made;
}

async function turn(r: Rig, projectId: string, conversation = uuid(++n)): Promise<{ runId: string; conversation: string }> {
  const sent = await r.send(conversation, 'go', { projectId, modelId: 'cc' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const runId = sent.body.runId as string;
  await waitFor(() => r.s.app.runs.get(runId)?.ended_at != null, `run ${runId} ended`, 30_000);
  return { runId, conversation };
}

const seen = (r: Rig, projectId: string, conversation?: string): RuntimeRunChanges[] => listRunChanges(r.s.app.kv, projectId, conversation);
const names = (run: RuntimeRunChanges): string[] => run.files.map(f => `${f.path}:${f.status}`);

test('返事のあいだに変えたファイルを、beat が git の前後から割り出して kv に残す。file_changes・tool_calls・元に戻す対象には何も足さない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'keep.txt': 'same\n' });
  await r.check();
  r.runtime.script = feed => {
    writeFileSync(join(root, 'a.txt'), 'one changed\n');
    rmSync(join(root, 'b.txt'));
    writeFileSync(join(root, 'c.txt'), 'new\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'd.txt'), 'deep\n');
    feed.done();
  };
  const { runId, conversation } = await turn(r, projectId);
  const [run] = seen(r, projectId);
  assert.ok(run);
  assert.deepEqual({ state: run.state, alert: run.alert, outcome: run.outcome, runId: run.runId, conversationId: run.conversationId, projectId: run.projectId, runtime: run.runtime, kind: run.kind },
    { state: 'ok', alert: false, outcome: 'ok', runId, conversationId: conversation, projectId, runtime: 'claude-code', kind: 'claude-code' });
  assert.deepEqual(names(run), ['a.txt:modified', 'b.txt:deleted', 'c.txt:added', 'sub/d.txt:added']);
  assert.ok(run.files.every(f => f.marks.length === 0));
  assert.equal(run.unchecked, 0);
  assert.deepEqual(run.git, []);

  // beat の道具の道には何も書かない
  const db = r.s.app.db;
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM file_changes').get() as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get() as { c: number }).c, 0);

  // 口: 実行役のまとまりとして返る。元に戻す対象の印（undo・hash）は付かない
  const res = await r.s.json(`/api/projects/${projectId}/changes?base=commit`, 'GET');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.runtime.runs[0].files.map((f: { path: string; status: string }) => `${f.path}:${f.status}`), names(run));
  for (const file of res.body.runtime.runs[0].files) assert.deepEqual(Object.keys(file).sort(), ['marks', 'path', 'status']);
  // ふつうの一覧（最後のコミットから）には、いつもどおり git から同じファイルが出る。これは今までの動き
  assert.ok(res.body.files.some((f: { path: string }) => f.path === 'a.txt'));
  // 実行の記録には、数と印だけが残る
  const recorded = JSON.parse(r.s.app.runs.get(runId)!.runtime!) as { changes: { state: string; files: number; alert: boolean } };
  assert.deepEqual(recorded.changes, { state: 'ok', files: 4, unchecked: 0, git: [], alert: false, unseen: false });
  assert.deepEqual(JSON.parse(r.s.app.runs.get(runId)!.flags), ['runtime']);
});

test('返事の前から書きかけだったファイルは、返事で中身が変わったときだけ出る。同じ中身で書き直しただけのもの・触らなかったものは出ない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
  writeFileSync(join(root, 'a.txt'), 'a by owner\n');
  writeFileSync(join(root, 'b.txt'), 'b by owner\n');
  writeFileSync(join(root, 'owner-new.txt'), 'mine\n');
  await r.check();
  r.runtime.script = feed => {
    writeFileSync(join(root, 'a.txt'), 'a by owner\n');
    writeFileSync(join(root, 'b.txt'), 'b by owner and then the runtime\n');
    writeFileSync(join(root, 'd.txt'), 'd by runtime\n');
    feed.done();
  };
  await turn(r, projectId);
  assert.deepEqual(names(seen(r, projectId)[0]!), ['b.txt:modified', 'd.txt:modified']);
});

test('実行役が持ち主の書きかけを元に戻したときも、変わったファイルとして出る（書きかけでなくなっても今の指紋を見る）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  writeFileSync(join(root, 'a.txt'), 'a by owner\n');
  await r.check();
  r.runtime.script = feed => { git(root, 'checkout', '--', 'a.txt'); feed.done(); };
  await turn(r, projectId);
  assert.deepEqual(names(seen(r, projectId)[0]!), ['a.txt:modified']);
});

test('実行役がコミットしたあとでも、そのファイルは出る（HEAD が動いたら 2 つのコミットの差も足す）。git の変化として head も出る。守りには当たらない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await r.check();
  r.runtime.script = feed => {
    writeFileSync(join(root, 'a.txt'), 'a committed\n');
    writeFileSync(join(root, 'new.txt'), 'new committed\n');
    rmSync(join(root, 'b.txt'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'by the runtime');
    feed.done();
  };
  await turn(r, projectId);
  const run = seen(r, projectId)[0]!;
  assert.deepEqual(names(run), ['a.txt:modified', 'b.txt:deleted', 'new.txt:added']);
  assert.ok(run.git.includes('head'), `git: ${run.git.join(',')}`);
  assert.equal(run.alert, false, 'committing is not an alarm');
});

test('最初のコミットがまだ無い製品で、実行役が最初のコミットを作っても、足したファイルは出る。もとからあった追っていないファイルは出ない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'old.txt': 'old\n' }, { commit: false });
  await r.check();
  r.runtime.script = feed => {
    writeFileSync(join(root, 'made.txt'), 'made\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first by the runtime');
    feed.done();
  };
  await turn(r, projectId);
  assert.deepEqual(names(seen(r, projectId)[0]!), ['made.txt:added']);
});

test('守っているファイルは、git が無視していても（.gitignore の .env）、持ち主の守る一覧にあっても、印が付き、中身は記録に出ない。守りに当たる変更は実行の記録の印と画面の知らせになる', { skip: !gitAvailable }, async t => {
  const r = await rig(t, { configure: config => { config.tools.hooks.preToolUse = [{ matcher: '.*', builtin: 'protect-files', always: ['notes/private.md'] }]; } });
  const { id: projectId, root } = await repo(r, { 'notes/private.md': 'p\n', 'plain.txt': 'x\n', 'CLAUDE.md': 'rules\n' }, { ignore: '.env\n' });
  await r.check();
  r.runtime.script = feed => {
    writeFileSync(join(root, '.env'), `TOKEN=${SECRET}\n`);
    writeFileSync(join(root, 'notes', 'private.md'), 'edited\n');
    writeFileSync(join(root, 'plain.txt'), 'y\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'new rules\n');
    feed.done();
  };
  const { runId } = await turn(r, projectId);
  const run = seen(r, projectId)[0]!;
  const byPath = new Map(run.files.map(f => [f.path, f] as const));
  assert.deepEqual(byPath.get('.env'), { path: '.env', status: 'added', marks: ['protected'] });
  assert.deepEqual(byPath.get('notes/private.md')?.marks, ['protected']);
  assert.deepEqual(byPath.get('CLAUDE.md')?.marks, ['guarded']);
  assert.deepEqual(byPath.get('plain.txt')?.marks, []);
  assert.deepEqual(run.files.map(f => f.path), ['.env', 'CLAUDE.md', 'notes/private.md', 'plain.txt'], 'the marked files come first, each group by path');
  assert.equal(run.alert, true);
  assert.ok(!JSON.stringify([run, r.events]).includes(SECRET), 'what the file says is nowhere');
  assert.deepEqual(JSON.parse(r.s.app.runs.get(runId)!.flags), ['runtime', 'runtime_changes_guarded']);
  const warning = r.events.find(e => e.type === 'warning' && e.runId === runId && e.code === 'runtime_changes_guarded') as Extract<RunEvent, { type: 'warning' }>;
  assert.ok(warning, 'the screen is told');
  assert.match(warning.message, /\.env/u);
  assert.ok(!/CLAUDE\.md/u.test(warning.message), 'a file that beat only asks about is not an alarm');
});

test('リンク・ジャンクションの先は読まず、たどらない。リンクを通る変更には印が付き、外の中身は記録に出ない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'sub/x.txt': 'inside\n', 'plain.txt': 'p\n' });
  const outside = join(r.products, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'x.txt'), SECRET);
  await r.check();
  r.runtime.script = feed => {
    rmSync(join(root, 'sub'), { recursive: true });
    link(outside, join(root, 'sub'));
    feed.done();
  };
  const { runId } = await turn(r, projectId);
  const run = seen(r, projectId)[0]!;
  const linked = run.files.filter(f => f.path === 'sub' || f.path.startsWith('sub/'));
  assert.ok(linked.length > 0, JSON.stringify(run.files));
  assert.ok(linked.every(f => f.marks.includes('link')), JSON.stringify(linked));
  assert.equal(run.alert, true);
  assert.ok(!JSON.stringify([run, r.events]).includes(SECRET));
  assert.ok(r.events.some(e => e.type === 'warning' && e.runId === runId && e.code === 'runtime_changes_guarded'));
});

test('.git のフックと設定が返事のあいだに変わったら、git の変化として出て、知らせになる。設定が beat の git を動かせない形になっても、変化は伝わる', { skip: !gitAvailable }, async t => {
  const hooks = await rig(t);
  const first = await repo(hooks, { 'a.txt': 'a\n' });
  await hooks.check();
  hooks.runtime.script = feed => { writeFileSync(join(first.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hi\n'); feed.done(); };
  const one = await turn(hooks, first.id);
  const run = seen(hooks, first.id)[0]!;
  assert.deepEqual({ state: run.state, git: run.git, alert: run.alert }, { state: 'ok', git: ['hooks'], alert: true });
  assert.deepEqual(run.files, []);
  assert.ok(hooks.events.some(e => e.type === 'warning' && e.runId === one.runId && e.code === 'runtime_git_hooks'));

  const config = await rig(t);
  const second = await repo(config, { 'a.txt': 'a\n' });
  await config.check();
  config.runtime.script = feed => { appendFileSync(join(second.root, '.git', 'config'), '[alias]\n\tx = !echo hi\n'); feed.done(); };
  const two = await turn(config, second.id);
  const changed = seen(config, second.id)[0]!;
  assert.equal(changed.state, 'git_unusable', 'beat does not run git with a setting that can run commands');
  assert.deepEqual(changed.git.sort(), ['config', 'git']);
  assert.equal(changed.alert, true);
  assert.ok(config.events.some(e => e.type === 'warning' && e.runId === two.runId && e.code === 'runtime_git_config'));
});

test('git でない製品では「変えたファイルは分からない」として残し、分かったふりをしない。返事は普通に終わる', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await r.product('plain', { 'a.txt': 'a\n' });
  await r.check();
  r.runtime.script = feed => { writeFileSync(join(root, 'a.txt'), 'changed\n'); feed.done(); };
  const { runId } = await turn(r, projectId);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  const run = seen(r, projectId)[0]!;
  assert.deepEqual({ state: run.state, files: run.files, alert: run.alert }, { state: 'no_git', files: [], alert: false });
  const res = await r.s.json(`/api/projects/${projectId}/changes`, 'GET');
  assert.equal(res.body.runtime.runs[0].state, 'no_git');
});

test('失敗した返事・止めた返事でも、そこまでに変えたファイルは残る', { skip: !gitAvailable }, async t => {
  const failing = await rig(t);
  const a = await repo(failing, { 'a.txt': 'a\n' });
  await failing.check();
  failing.runtime.script = feed => { writeFileSync(join(a.root, 'a.txt'), 'half done\n'); feed.push({ type: 'failed', kind: 'process', message: 'it crashed' }); };
  await turn(failing, a.id);
  const failed = seen(failing, a.id)[0]!;
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(names(failed), ['a.txt:modified']);

  const stopping = await rig(t);
  const b = await repo(stopping, { 'a.txt': 'a\n' });
  await stopping.check();
  stopping.runtime.script = async feed => { writeFileSync(join(b.root, 'a.txt'), 'before the stop\n'); await feed.stopped; };
  const conversation = uuid(++n);
  const sent = await stopping.send(conversation, 'go', { projectId: b.id, modelId: 'cc' });
  const runId = sent.body.runId as string;
  await waitFor(() => stopping.runtime.sent.length > 0, 'the runtime got the message', 30_000);
  stopping.s.app.engine.stop(runId);
  await waitFor(() => stopping.s.app.runs.get(runId)?.ended_at != null, 'stopped', 30_000);
  const stopped = seen(stopping, b.id)[0]!;
  assert.equal(stopped.outcome, 'stopped');
  assert.deepEqual(names(stopped), ['a.txt:modified']);
});

test('返事の前に書きかけが多すぎるときは、比べずに「多すぎて比べられない」と残す（返事は止めない）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  mkdirSync(join(root, 'many'));
  for (let i = 0; i <= MAX_DIRTY; i += 1) writeFileSync(join(root, 'many', `f${i}.txt`), 'x');
  await r.check();
  r.runtime.script = feed => feed.done();
  const { runId } = await turn(r, projectId);
  assert.equal(r.s.app.runs.get(runId)!.ok, 1);
  const run = seen(r, projectId)[0]!;
  assert.deepEqual({ state: run.state, files: run.files, alert: run.alert, unseen: run.unseen }, { state: 'too_many', files: [], alert: false, unseen: false });
});

test('実行ごとの一覧は、製品ごとに新しい RUN_KEEP 件だけ残り、画面へは RUN_SHOWN 件まで。会話で絞れる。会話を消すと一緒に消える', async t => {
  const s = await startApp(t);
  const base = (i: number, conversationId: string, projectId = 'p1'): RuntimeRunChanges => ({
    v: 1, runId: `run${i}`, conversationId, projectId, runtime: 'claude-code', kind: 'claude-code', at: 1000 + i, outcome: 'ok', state: 'ok', files: [{ path: `f${i}.txt`, status: 'added', marks: [] }], more: 0, unchecked: 0, git: [], alert: false, unseen: false,
  });
  for (let i = 0; i < RUN_KEEP + 5; i += 1) saveRunChanges(s.app.kv, base(i, i % 2 === 0 ? 'c-even' : 'c-odd'));
  saveRunChanges(s.app.kv, base(900, 'c-other', 'p2'));
  const rows = (s.app.db.prepare("SELECT COUNT(*) AS c FROM kv WHERE substr(key, 1, 16) = 'runtime-changes:'").get() as { c: number }).c;
  assert.equal(rows, RUN_KEEP + 1, 'p1 keeps RUN_KEEP, p2 keeps its own');
  const shown = listRunChanges(s.app.kv, 'p1');
  assert.equal(shown.length, RUN_SHOWN);
  assert.deepEqual(shown.map(x => x.runId), Array.from({ length: RUN_SHOWN }, (_, i) => `run${RUN_KEEP + 4 - i}`), 'newest first');
  assert.ok(listRunChanges(s.app.kv, 'p1', 'c-even').every(x => x.conversationId === 'c-even'));
  assert.deepEqual(listRunChanges(s.app.kv, 'p2').map(x => x.runId), ['run900']);
  // 壊れた値・形の違う値は読み飛ばす
  s.app.kv.set('runtime-changes:bad:c', '{not json');
  s.app.kv.setJson('runtime-changes:odd:c', { v: 2 });
  assert.equal(listRunChanges(s.app.kv, 'p1').length, RUN_SHOWN);
  // キーの終わりは会話の ID: 会話を消す道（db/erase.ts）が、会話ごとの kv として一緒に消す
  s.app.db.prepare("DELETE FROM kv WHERE length(key) > length(?) AND substr(key, -(length(?) + 1)) = ':' || ?").run('c-even', 'c-even', 'c-even');
  assert.equal(listRunChanges(s.app.kv, 'p1', 'c-even').length, 0);
});

test('会話を消すと、その会話の実行の一覧も消える（本物の削除の口）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  await r.check();
  r.runtime.script = feed => { writeFileSync(join(root, 'a.txt'), 'x\n'); feed.done(); };
  const { conversation } = await turn(r, projectId);
  assert.equal(seen(r, projectId).length, 1);
  const res = await r.s.json(`/api/conversations/${conversation}`, 'DELETE');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(seen(r, projectId).length, 0);
});

// ---- 部品 ----

test('指紋: 守りに当たるもの・5MB を超えるもの・リンクの先は、中身を読まない。リンクはリンクの文字だけ。動いた印は大きさと時刻', async t => {
  const dir = (await startApp(t)).app.paths.data;
  const root = join(dir, 'fp');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plain.txt'), 'hello');
  writeFileSync(join(root, '.env'), 'TOKEN=abc');
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(KEEP_MAX_BYTES + 1));
  const outside = join(dir, 'fp-outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'x.txt'), SECRET);
  link(outside, join(root, 'jump'));
  const reads: string[] = [];
  const read = ((path: string, size: number) => { reads.push(path); return Buffer.alloc(size); }) as Parameters<typeof fingerprint>[4];
  const budget = { left: 1 << 30 };

  assert.match(fingerprint(root, 'plain.txt', true, budget, read).id ?? '', /^sha:/u);
  assert.deepEqual(reads, [join(root, 'plain.txt')]);
  reads.length = 0;
  assert.match(fingerprint(root, '.env', false, budget, read).id ?? '', /^stat:9:/u, 'a protected file is only measured');
  assert.match(fingerprint(root, 'plain.txt', true, { left: 3 }, read).id ?? '', /^stat:/u, 'past the read budget it is only measured');
  assert.match(fingerprint(root, 'big.bin', true, budget, read).id ?? '', /^stat:/u, 'a file over the keep limit is only measured');
  const through = fingerprint(root, 'jump/x.txt', true, budget, read);
  assert.deepEqual({ present: through.present, link: through.link, id: through.id?.slice(0, 5) }, { present: true, link: true, id: 'link:' });
  const target = fingerprint(root, 'jump', true, budget, read);
  assert.equal(target.link, true);
  assert.deepEqual(reads, [], 'nothing behind a link and nothing protected was read');
  assert.ok(!JSON.stringify([through, target]).includes(SECRET));
  assert.deepEqual(fingerprint(root, 'missing.txt', true, budget, read), { present: false, id: '-' });
  assert.deepEqual(fingerprint(root, '../fp-outside/x.txt', true, budget, read), { present: true, id: null }, 'a path that climbs out is not walked');
  assert.deepEqual(reads, []);
});

test('walkCurrent: 無い・リンク・ふつうのファイル・フォルダ・安全でないパスを分ける（readCurrent と同じ見方）', async t => {
  const dir = (await startApp(t)).app.paths.data;
  const root = join(dir, 'walk');
  mkdirSync(join(root, 'folder'), { recursive: true });
  writeFileSync(join(root, 'f.txt'), 'abc');
  const outside = join(dir, 'walk-outside');
  mkdirSync(outside, { recursive: true });
  link(outside, join(root, 'jump'));
  assert.deepEqual(walkCurrent(root, 'nope.txt'), { kind: 'absent' });
  assert.deepEqual(walkCurrent(root, 'f.txt/below'), { kind: 'absent' });
  assert.deepEqual(walkCurrent(root, 'folder'), { kind: 'absent' });
  const file = walkCurrent(root, 'f.txt');
  assert.ok(file.kind === 'file' && file.size === 3);
  assert.deepEqual(walkCurrent(root, 'jump/x'), { kind: 'unknown', why: 'link', at: join(root, 'jump') });
  assert.equal(walkCurrent(root, '../x').kind, 'unknown');
  assert.deepEqual(walkCurrent(root, '.git/config'), { kind: 'unknown', why: 'unsafe', at: root });
});

test('比べる: 中身が同じなら出さず、比べられないものは数え、守りの印が付いたものを先に並べ、上限を超えた分は数だけ', () => {
  const guard: Guard = { realRoot: '/r', inspect: rel => (rel.startsWith('secret') ? { marks: ['protected'], readable: false } : { marks: [], readable: true }) };
  const sha = (id: string): Print => ({ present: true, id });
  const gone: Print = { present: false, id: '-' };
  const snap = (dirty: Record<string, Print>, extra: { later?: Record<string, Print>; headDiff?: Record<string, string>; codes?: Record<string, string> } = {}): Snapshot => ({
    head: 'h', dirty: new Map(Object.entries(dirty).map(([path, print]) => [path, { code: extra.codes?.[path] ?? ' M', print }])),
    later: new Map(Object.entries(extra.later ?? {})), headDiff: new Map(Object.entries(extra.headDiff ?? {})), nested: new Set(), gitlinks: new Map(), flagged: new Map(),
  });
  const before = snap({ same: sha('1'), edited: sha('1'), vanished: sha('1'), 'link-a': { present: true, id: null, link: true }, 'link-b': { present: true, id: null, link: true }, 'secret.key': { present: true, id: 'stat:1:1' } });
  const after = snap({ same: sha('1'), edited: sha('2'), 'link-a': { present: true, id: null, link: true }, 'link-b': gone, fresh: sha('9'), 'secret.key': { present: true, id: 'stat:2:2' } }, { later: { vanished: gone }, headDiff: { committed: 'M', same: 'M' }, codes: { fresh: '??' } });
  const result = compareSnapshots(guard, before, after);
  assert.deepEqual(result.files.map(f => `${f.path}:${f.status}:${f.marks.join('+')}`), [
    'link-b:deleted:link', 'secret.key:modified:protected', 'committed:modified:', 'edited:modified:', 'fresh:added:', 'vanished:deleted:',
  ]);
  assert.equal(result.unchecked, 1, 'link-a could not be compared');
  assert.equal(result.alert, true);

  const many = snap(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`f${String(i).padStart(3, '0')}`, sha('a')])));
  const changed = snap(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`f${String(i).padStart(3, '0')}`, sha('b')])));
  const capped = compareSnapshots({ realRoot: '/r', inspect: () => ({ marks: [], readable: true }) }, many, changed);
  assert.deepEqual({ shown: capped.files.length, more: capped.more, alert: capped.alert }, { shown: 200, more: 5, alert: false });
});

test('makeGuard: 守りは Changes の欄と同じ部品。秘密の名前・.git・持ち主の守る一覧・beat の聞く場所に印が付く', async t => {
  const s = await startApp(t, { configure: config => { config.tools.hooks.preToolUse = [{ matcher: '.*', builtin: 'protect-files', always: ['locked/**'] }]; } });
  const root = join(s.app.paths.data, 'guard');
  mkdirSync(root, { recursive: true });
  const guard = makeGuard(s.app.config(), s.app.paths, root);
  const marks = (rel: string): string => guard.inspect(rel).marks.join('+');
  assert.equal(marks('src/app.ts'), '');
  assert.equal(marks('.env.local'), 'protected');
  assert.equal(marks('keys/id_rsa'), 'protected');
  assert.equal(marks('locked/a.txt'), 'protected');
  assert.equal(marks('CLAUDE.md'), 'guarded');
  assert.equal(marks('.git/hooks/pre-commit'), 'unsafe');
  assert.equal(marks('a\\b.txt'), 'unsafe');
  assert.equal(guard.inspect('.env').readable, false);
  assert.equal(guard.inspect('src/app.ts').readable, true);
});

// ---- 安全審査の指摘（M1〜M6・L1・L2・V1）。どれも、その行を壊すと赤くなることを確かめてある ----

// 実行役が「更新の時刻を元に戻した」ときの時刻（秒）。ミリ秒より細かい端数を持たない値にして、戻したあとも同じ時刻になるようにする
const SAME_TIME = 1_700_000_000;

// 台本で 1 回の返事のあいだに何かをさせ、その返事の一覧を返す
async function change(r: Rig, projectId: string, script: () => void): Promise<{ runId: string; run: RuntimeRunChanges }> {
  r.runtime.script = feed => { script(); feed.done(); };
  const done = await turn(r, projectId);
  const run = seen(r, projectId).find(x => x.runId === done.runId);
  assert.ok(run, 'the run was recorded');
  return { runId: done.runId, run };
}
const warned = (r: Rig, runId: string, code: string): boolean => r.events.some(e => e.type === 'warning' && e.runId === runId && e.code === code);
const flagsOf = (r: Rig, runId: string): string[] => JSON.parse(r.s.app.runs.get(runId)!.flags) as string[];

test('M1: 返事のあとに書きかけが多すぎて一覧を作れなかったら、「何が変わったか分からない」を守りの印と知らせにする（返事の前が多すぎたときは、前から分かっていたので立てない）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  await r.check();
  const { runId, run } = await change(r, projectId, () => {
    mkdirSync(join(root, 'many'));
    for (let i = 0; i <= MAX_DIRTY; i += 1) writeFileSync(join(root, 'many', `f${i}.txt`), 'x');
  });
  assert.deepEqual({ state: run.state, files: run.files, alert: run.alert, unseen: run.unseen }, { state: 'too_many_after', files: [], alert: true, unseen: true });
  assert.deepEqual(flagsOf(r, runId), ['runtime', 'runtime_changes_guarded']);
  assert.ok(warned(r, runId, 'runtime_changes_unseen'), 'the screen is told that the list is missing');
  const recorded = JSON.parse(r.s.app.runs.get(runId)!.runtime!) as { changes: { unseen: boolean; alert: boolean } };
  assert.deepEqual({ unseen: recorded.changes.unseen, alert: recorded.changes.alert }, { unseen: true, alert: true });
  // 次の返事は、すでに多い状態から始まる: 前が取れないので、状態に理由が出るだけ（印は立てない）
  const next = await change(r, projectId, () => undefined);
  assert.deepEqual({ state: next.run.state, alert: next.run.alert, unseen: next.run.unseen }, { state: 'too_many', alert: false, unseen: false });
  assert.ok(!warned(r, next.runId, 'runtime_changes_unseen'));
});

test('M1: .git/config.worktree も .git/config と同じに見る。変わったら設定の変化として守りに当たる', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  await r.check();
  const { runId, run } = await change(r, projectId, () => writeFileSync(join(root, '.git', 'config.worktree'), '[core]\n\tquotepath = false\n'));
  assert.deepEqual({ state: run.state, git: run.git, alert: run.alert }, { state: 'ok', git: ['config'], alert: true });
  assert.ok(warned(r, runId, 'runtime_git_config'));
});

test('M2: .git/info/exclude が変わったら、git の無視の決まりの変化として守りに当たる（変えたファイルを git の一覧から隠せる）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  await r.check();
  const { runId, run } = await change(r, projectId, () => appendFileSync(join(root, '.git', 'info', 'exclude'), 'secret-work/\n'));
  assert.deepEqual({ git: run.git, alert: run.alert }, { git: ['exclude'], alert: true });
  assert.ok(warned(r, runId, 'runtime_git_other'));
  assert.ok(flagsOf(r, runId).includes('runtime_changes_guarded'));
});

test('M2: skip-worktree・assume-unchanged の印が付いたら、その変更は git の一覧に出ないので、印が付いたこと自体を守りに当たる変化にする。もとから付いていて変わらないものは出さない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await r.check();
  const hidden = await change(r, projectId, () => {
    git(root, 'update-index', '--skip-worktree', 'a.txt');
    writeFileSync(join(root, 'a.txt'), 'changed behind the flag\n');
  });
  assert.deepEqual({ files: names(hidden.run), git: hidden.run.git, alert: hidden.run.alert }, { files: [], git: ['index'], alert: true });
  assert.ok(warned(r, hidden.runId, 'runtime_git_other'));
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual({ git: quiet.run.git, alert: quiet.run.alert }, { git: [], alert: false });
  const assumed = await change(r, projectId, () => git(root, 'update-index', '--assume-unchanged', 'b.txt'));
  assert.deepEqual({ git: assumed.run.git, alert: assumed.run.alert }, { git: ['index'], alert: true });
});

test('M2: サブモジュールの中のフック・設定が変わったら modules の変化として守りに当たる', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  mkdirSync(join(root, '.git', 'modules', 'x', 'hooks'), { recursive: true });
  writeFileSync(join(root, '.git', 'modules', 'x', 'config'), '[core]\n\tbare = false\n');
  await r.check();
  const hook = await change(r, projectId, () => writeFileSync(join(root, '.git', 'modules', 'x', 'hooks', 'pre-commit'), '#!/bin/sh\necho hi\n'));
  assert.deepEqual({ git: hook.run.git, alert: hook.run.alert }, { git: ['modules'], alert: true });
  const config = await change(r, projectId, () => appendFileSync(join(root, '.git', 'modules', 'x', 'config'), '[core]\n\teditor = vim\n'));
  assert.deepEqual({ git: config.run.git, alert: config.run.alert }, { git: ['modules'], alert: true });
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual(quiet.run.git, []);
});

test('M2: サブモジュール（git の目に入らない）は、指す先のコミットが変わった・中の HEAD が動いたことを「確かめられないもの」として数える。変わらなければ数えない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${head},lib/sub`);
  git(root, 'commit', '-q', '-m', 'add a submodule pointer');
  mkdirSync(join(root, 'lib', 'sub', '.git'), { recursive: true });
  writeFileSync(join(root, 'lib', 'sub', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await r.check();
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual({ state: quiet.run.state, unchecked: quiet.run.unchecked, alert: quiet.run.alert }, { state: 'ok', unchecked: 0, alert: false });
  const inside = await change(r, projectId, () => writeFileSync(join(root, 'lib', 'sub', '.git', 'HEAD'), 'ref: refs/heads/other\n'));
  assert.deepEqual({ files: names(inside.run), unchecked: inside.run.unchecked }, { files: [], unchecked: 1 });
  const pointer = await change(r, projectId, () => git(root, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},lib/sub`));
  assert.deepEqual({ files: names(pointer.run), unchecked: pointer.run.unchecked }, { files: [], unchecked: 1 });
});

test('M3: .git/hooks がリンクやジャンクションに差し替えられたら、link の変化として守りに当たる。先の中身は読まず、記録にも出ない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  const outside = join(r.products, 'outside-hooks');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'pre-commit'), `#!/bin/sh\n# ${SECRET}\n`);
  await r.check();
  const { runId, run } = await change(r, projectId, () => { rmSync(join(root, '.git', 'hooks'), { recursive: true }); link(outside, join(root, '.git', 'hooks')); });
  assert.ok(run.git.includes('hooks') && run.git.includes('link'), `git: ${run.git.join(',')}`);
  assert.equal(run.alert, true);
  assert.ok(warned(r, runId, 'runtime_git_hooks'));
  assert.ok(warned(r, runId, 'runtime_git_other'));
  assert.ok(!JSON.stringify([run, r.events]).includes(SECRET));
});

// 部品を直接動かす試験で、プロセスの中のファイルの開き方を見張る（beat の git が使う道だけ。子プロセスの git は別）
function watchFs(t: { after: (fn: () => void) => void }, names: ReadonlyArray<'openSync' | 'lstatSync' | 'readdirSync' | 'readlinkSync' | 'statSync' | 'readFileSync'>): string[] {
  const touched: string[] = [];
  for (const name of names) {
    const original = fs[name] as (...a: unknown[]) => unknown;
    const patched = mock.method(fs, name, ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string') touched.push(`${name} ${path}`);
      return original(path, ...rest);
    }) as never);
    t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  }
  syncBuiltinESMExports();
  return touched;
}

// 部品の試験用の、コミットまで済んだ git の製品（beat の製品としては登録しない）
async function plainRepo(t: Parameters<typeof startApp>[0]): Promise<{ root: string; dir: string }> {
  const dir = (await startApp(t)).app.paths.data;
  const root = join(dir, `gp${++n}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  return { root, dir };
}

test('M3: git の指紋は、リンクの先を開かない。先の中身が変わっても指紋は変わらず、リンクだったことだけ残る', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  const outside = join(dir, 'outside-hooks');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'pre-commit'), SECRET);
  rmSync(join(root, '.git', 'hooks'), { recursive: true });
  link(outside, join(root, '.git', 'hooks'));
  const opened = watchFs(t, ['openSync', 'readdirSync']);
  const one = await readGitPrint(root, dir);
  writeFileSync(join(outside, 'pre-commit'), `${SECRET} and more`);
  const two = await readGitPrint(root, dir);
  assert.ok(one && two);
  assert.deepEqual(one.links, ['hooks']);
  assert.equal(one.hooks, two.hooks, 'what is behind the link is not part of the print');
  assert.ok(!opened.some(entry => entry.includes('outside-hooks')), opened.filter(entry => entry.includes('outside-hooks')).join(', '));
});

test('M3: 大きすぎる .git/config は開かない（大きさと時刻だけ）。中身を同じ大きさで書き換えても、時刻と番号で変化は分かる', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  const config = join(root, '.git', 'config');
  appendFileSync(config, `# ${'x'.repeat(2 * 1024 * 1024)}\n`);
  utimesSync(config, SAME_TIME, SAME_TIME);
  const opened = watchFs(t, ['openSync']);
  const one = await readGitPrint(root, dir);
  assert.ok(one);
  assert.ok(!opened.some(entry => entry === `openSync ${config}`), 'a config over the cap is not opened');
  const until = Date.now() + 60;
  while (Date.now() < until) { /* 時刻の粒度を越える */ }
  const bytes = readFileSync(config);
  bytes[bytes.length - 3] = 'y'.charCodeAt(0);
  writeFileSync(config, bytes);
  utimesSync(config, SAME_TIME, SAME_TIME);
  const two = await readGitPrint(root, dir);
  assert.ok(two);
  assert.notEqual(one.config, two.config);
});

test('M3: フォルダは見る数に上限を置く。ただしフックの決まった名前は、埋め草のファイルで押し出されても必ず見る', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  const hooks = join(root, '.git', 'hooks');
  for (let i = 0; i < 500; i += 1) writeFileSync(join(hooks, `a${String(i).padStart(3, '0')}`), 'x');
  const opened = watchFs(t, ['openSync']);
  const one = await readGitPrint(root, dir);
  assert.ok(one);
  assert.ok(opened.filter(entry => entry.startsWith(`openSync ${hooks}`)).length < 450, 'the walk stops at its cap');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho hi\n');
  const two = await readGitPrint(root, dir);
  assert.ok(two);
  assert.ok(gitChanges(one, two).includes('hooks'), 'a real hook name sorted behind the padding is still seen');
});

test('M3: ネットワークの先を指す gitdir: は、見ない（接続しない）。サブモジュールの gitdir: も同じ', { skip: !gitAvailable || !WINDOWS }, async t => {
  const dir = (await startApp(t)).app.paths.data;
  const root = join(dir, `remote${++n}`);
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, '.git'), 'gitdir: \\\\evil-host\\share\\repo\n');
  writeFileSync(join(root, 'sub', '.git'), 'gitdir: //evil-host/share/repo\n');
  const touched = watchFs(t, ['openSync', 'lstatSync', 'readdirSync', 'readlinkSync', 'statSync', 'readFileSync']);
  assert.equal(await readGitPrint(root, dir), undefined);
  assert.equal(submoduleHead(root, 'sub'), 'remote');
  assert.deepEqual(touched.filter(entry => /^\w+ [\\/]{2}/u.test(entry)), []);
});

test('M4: 無視されている秘密の名前のファイルも、書きかけの数の上限に数える（無視で上限を迂回して、読む数を増やさせない）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'cfg/keep.txt': 'k\n' }, { ignore: '.env.*\n' });
  mkdirSync(join(root, 'cfg'), { recursive: true });
  for (let i = 0; i <= MAX_DIRTY; i += 1) writeFileSync(join(root, 'cfg', `.env.${i}`), 'v');
  await r.check();
  const { run } = await change(r, projectId, () => undefined);
  assert.equal(run.state, 'too_many');
});

test('M4: 変わったパスが多いときは、守りに当たるか確かめる数に上限を置き、名前で分かる守り（秘密の名前）を先に確かめる。残りは確かめられないものとして数える', () => {
  let inspected = 0;
  const guard: Guard = { realRoot: '/r', inspect: rel => { inspected += 1; return rel.includes('secret') ? { marks: ['protected'], readable: false } : { marks: [], readable: true }; } };
  const empty = (headDiff: Record<string, string> = {}): Snapshot => ({ head: 'h', dirty: new Map(), later: new Map(), headDiff: new Map(Object.entries(headDiff)), nested: new Set(), gitlinks: new Map(), flagged: new Map() });
  const diff = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`src/f${String(i).padStart(4, '0')}.ts`, 'M']));
  diff['zzz/secret.key'] = 'M';
  const result = compareSnapshots(guard, empty(), empty(diff));
  assert.ok(inspected <= INSPECT_MAX, `inspected ${inspected}`);
  assert.equal(result.unchecked, 5001 - INSPECT_MAX);
  assert.equal(result.files[0]?.path, 'zzz/secret.key', 'the secret name sorted last is still looked at, and listed first');
  assert.deepEqual(result.files[0]?.marks, ['protected']);
  assert.equal(result.alert, true);
});

test('M4: 指紋を取る繰り返しは、一定の数ごとに手を空け、時間切れを過ぎたら止まる', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  for (let i = 0; i < 200; i += 1) writeFileSync(join(root, `u${String(i).padStart(3, '0')}.txt`), 'x');
  const real = realpathSync.native(root);
  assert.deepEqual(await captureSnapshot({ realRoot: real, inspect: () => ({ marks: [], readable: true }) }, dir, { limitMs: 0 }), { ok: false, state: 'timeout' });
  // 手を空けているか: 順番に 1 つずつ回る setImmediate の列が、64 個ごとの区切りで進む
  let ticks = 0;
  let running = true;
  const pump = (): void => { ticks += 1; if (running) setImmediate(pump); };
  setImmediate(pump);
  const at: number[] = [];
  const done = await captureSnapshot({ realRoot: real, inspect: () => { at.push(ticks); return { marks: [], readable: true }; } }, dir, { limitMs: 60_000 });
  running = false;
  assert.equal(done.ok, true);
  assert.ok(at.length >= 128, `${at.length} paths were looked at`);
  assert.ok(at[63]! > at[62]!, 'it gave way after 64 paths');
  assert.equal(at[1], at[0], 'and not between every path');
});

test('M6: 実行役を閉じる呼びかけに時間内に答えない・閉じ込めに失敗した実行役は、まだ動いているかもしれないので、返事のあとのファイルを取らず、「分からない」を守りの印と知らせにする', { skip: !gitAvailable }, async t => {
  const hung = await rig(t);
  const a = await repo(hung, { 'a.txt': 'a\n' });
  await hung.check();
  hung.runtime.hang.close = true;
  t.after(() => hung.runtime.release());
  const one = await change(hung, a.id, () => writeFileSync(join(a.root, 'a.txt'), 'changed while it may still run\n'));
  assert.deepEqual({ state: one.run.state, files: one.run.files, alert: one.run.alert, unseen: one.run.unseen }, { state: 'unknown', files: [], alert: true, unseen: true });
  assert.ok(warned(hung, one.runId, 'runtime_changes_unseen'));
  assert.ok(flagsOf(hung, one.runId).includes('runtime_changes_guarded'));

  const loose = await rig(t);
  const b = await repo(loose, { 'a.txt': 'a\n' });
  await loose.check();
  loose.runtime.containReason = 'no job object here';
  const two = await change(loose, b.id, () => writeFileSync(join(b.root, 'a.txt'), 'changed\n'));
  assert.deepEqual({ state: two.run.state, files: two.run.files, alert: two.run.alert, unseen: two.run.unseen }, { state: 'unknown', files: [], alert: true, unseen: true });
  assert.ok(warned(loose, two.runId, 'runtime_changes_unseen'));
});

test('L1: 守って中身を読まないファイルは、同じ大きさで書き換えて更新の時刻を元に戻しても、変更の時刻とファイルの番号で違いが分かる', async t => {
  const dir = (await startApp(t)).app.paths.data;
  const root = join(dir, `l1-${++n}`);
  mkdirSync(root, { recursive: true });
  const file = join(root, '.env');
  writeFileSync(file, 'TOKEN=aaaa\n');
  utimesSync(file, SAME_TIME, SAME_TIME);
  const budget = { left: 1 << 30 };
  const one = fingerprint(root, '.env', false, budget);
  const until = Date.now() + 60;
  while (Date.now() < until) { /* 時刻の粒度を越える */ }
  writeFileSync(file, 'TOKEN=bbbb\n');
  utimesSync(file, SAME_TIME, SAME_TIME);
  const two = fingerprint(root, '.env', false, budget);
  const head = (id: string | null): string => (id ?? '').split(':').slice(0, 3).join(':');
  assert.equal(head(one.id), head(two.id), 'the same size and the same update time, as a hiding runtime would leave it');
  assert.notEqual(one.id, two.id);
});

test('L2: 中に別の .git があるフォルダ（入れ子のリポジトリ）は、安全でないパスとして警告せず、「確かめられないもの」として数える。もとからあって変わらなければ数えない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  mkdirSync(join(root, 'lib'));
  git(join(root, 'lib'), 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'lib', 'x.txt'), 'x\n');
  await r.check();
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual({ state: quiet.run.state, files: names(quiet.run), unchecked: quiet.run.unchecked, alert: quiet.run.alert }, { state: 'ok', files: [], unchecked: 0, alert: false });
  const appeared = await change(r, projectId, () => {
    mkdirSync(join(root, 'vendor'));
    git(join(root, 'vendor'), 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'vendor', 'y.txt'), 'y\n');
  });
  assert.deepEqual({ files: names(appeared.run), unchecked: appeared.run.unchecked, alert: appeared.run.alert }, { files: [], unchecked: 1, alert: false });
});

test('V1: git が使えなくなって変更の一覧が 409 で失敗しても、実行役の返事ごとのまとまりは返す（使えなくなった返事そのものが入る）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  await r.check();
  const first = await change(r, projectId, () => writeFileSync(join(root, 'a.txt'), 'changed\n'));
  const poisoned = await change(r, projectId, () => appendFileSync(join(root, '.git', 'config'), '[alias]\n\tx = !echo hi\n'));
  assert.equal(poisoned.run.state, 'git_unusable');
  for (const query of ['', '?base=commit']) {
    const res = await r.s.json(`/api/projects/${projectId}/changes${query}`, 'GET');
    assert.equal(res.status, 409, `${query}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'project.changes_git_unusable');
    const runs = (res.body.runtime?.runs ?? []) as RuntimeRunChanges[];
    assert.deepEqual(runs.map(x => x.runId).sort(), [first.runId, poisoned.runId].sort(), query);
    assert.deepEqual(runs.find(x => x.runId === poisoned.runId)?.state, 'git_unusable');
    assert.deepEqual(names(runs.find(x => x.runId === first.runId)!), ['a.txt:modified']);
  }
});

// ---- 安全審査の 2 回目の指摘（commondir・modules の入れ子・切ったときの印・フック名の読み方・印の付いたファイルの変更） ----

test('審査 1: .git/commondir が書かれて、別のリポジトリ（クローン）のフックと設定が使われる形になったら、フック・設定の変化として守りに当たる', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  const clone = join(r.products, 'clone');
  git(r.products, 'clone', '-q', root, clone);
  await r.check();
  const { runId, run } = await change(r, projectId, () => {
    writeFileSync(join(clone, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n');
    writeFileSync(join(root, '.git', 'commondir'), `${join(clone, '.git')}\n`);
  });
  assert.ok(run.git.includes('hooks') && run.git.includes('config'), `git: ${run.git.join(',')}`);
  assert.equal(run.alert, true);
  assert.ok(warned(r, runId, 'runtime_git_hooks'));
  assert.ok(warned(r, runId, 'runtime_git_config'));
});

test('審査 1 の対: commondir が git と同じ読み方で読まれる（先がネットワークの先なら見ない）。普通の製品の指紋は commondir が無くても取れる', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  const plain = await readGitPrint(root, dir);
  assert.ok(plain && plain.git, 'a plain repository is read');
  if (!WINDOWS) return;
  writeFileSync(join(root, '.git', 'commondir'), '\\\\evil-host\\share\\repo\n');
  const touched = watchFs(t, ['openSync', 'lstatSync', 'readdirSync', 'readlinkSync', 'statSync', 'readFileSync']);
  assert.equal(await readGitPrint(root, dir), undefined);
  assert.deepEqual(touched.filter(entry => /^\w+ [\\/]{2}/u.test(entry)), []);
});

test('審査 2: サブモジュールのフォルダの名前がパス（lib/sub）で何段にもなっていても、中のフック・設定の変化を見る。サブモジュールの中の modules も', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  const modules = join(root, '.git', 'modules');
  const module = (...parts: string[]): string => {
    const dir = join(modules, ...parts);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'config'), '[core]\n\tbare = false\n');
    return dir;
  };
  const sub = module('lib', 'sub');
  const inner = module('outer', 'modules', 'inner');
  writeFileSync(join(modules, 'outer', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(modules, 'outer', 'config'), '[core]\n\tbare = false\n');
  await r.check();
  const hook = await change(r, projectId, () => writeFileSync(join(sub, 'hooks', 'pre-commit'), '#!/bin/sh\necho hi\n'));
  assert.deepEqual({ git: hook.run.git, alert: hook.run.alert }, { git: ['modules'], alert: true });
  const deep = await change(r, projectId, () => writeFileSync(join(inner, 'hooks', 'commit-msg'), '#!/bin/sh\necho hi\n'));
  assert.deepEqual({ git: deep.run.git, alert: deep.run.alert }, { git: ['modules'], alert: true });
  const config = await change(r, projectId, () => appendFileSync(join(sub, 'config'), '[core]\n\teditor = vim\n'));
  assert.deepEqual({ git: config.run.git, alert: config.run.alert }, { git: ['modules'], alert: true });
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual(quiet.run.git, []);
});

test('審査 3: 確かめる数の上限で切ったときは、切った分に印が付くかどうか分からないので、必ず alert にする。リンクを通る変更は、切る前に先に確かめる', () => {
  const guard: Guard = { realRoot: '/r', inspect: () => ({ marks: [], readable: true }) };
  const sha = (id: string): Print => ({ present: true, id });
  const snap = (dirty: Record<string, Print>): Snapshot => ({
    head: 'h', dirty: new Map(Object.entries(dirty).map(([path, print]) => [path, { code: ' M', print }])),
    later: new Map(), headDiff: new Map(), nested: new Set(), gitlinks: new Map(), flagged: new Map(),
  });
  const paths = Array.from({ length: INSPECT_MAX + 1 }, (_, i) => `src/f${String(i).padStart(4, '0')}.ts`);
  const before = snap(Object.fromEntries(paths.map(path => [path, sha('a')])));
  const plain = compareSnapshots(guard, before, snap(Object.fromEntries(paths.map(path => [path, sha('b')]))));
  assert.equal(plain.unchecked, 1);
  assert.equal(plain.alert, true, 'a cut is never silent');
  const justUnder = compareSnapshots(guard, snap(Object.fromEntries(paths.slice(1).map(path => [path, sha('a')]))), snap(Object.fromEntries(paths.slice(1).map(path => [path, sha('b')]))));
  assert.deepEqual({ unchecked: justUnder.unchecked, alert: justUnder.alert }, { unchecked: 0, alert: false }, 'nothing cut, nothing marked: no alarm');
  const lastIsLink = compareSnapshots(guard, before, snap(Object.fromEntries([...paths.slice(0, -1).map(path => [path, sha('b')]), [paths.at(-1)!, { present: true, id: 'b', link: true } as Print]])));
  const linked = lastIsLink.files.find(file => file.path === paths.at(-1));
  assert.deepEqual(linked?.marks, ['link'], 'the changed file that went through a link is looked at before the cut');
  assert.equal(lastIsLink.alert, true);
});

test('審査 4: フックの決まった名前を上限と別に読むのはこの製品の .git/hooks だけ。サブモジュールのフックは上限の中だけ', { skip: !gitAvailable }, async t => {
  const { root, dir } = await plainRepo(t);
  const hooks = join(root, '.git', 'modules', 'm', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(root, '.git', 'modules', 'm', 'HEAD'), 'ref: refs/heads/main\n');
  for (let i = 0; i < 500; i += 1) writeFileSync(join(hooks, `a${String(i).padStart(3, '0')}`), 'x');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n');
  const opened = watchFs(t, ['openSync']);
  const print = await readGitPrint(root, dir);
  assert.ok(print);
  const inModule = opened.filter(entry => entry.startsWith(`openSync ${hooks}`));
  assert.ok(inModule.length < 450, `${inModule.length} files of the module hooks were opened`);
  assert.ok(!inModule.includes(`openSync ${join(hooks, 'pre-commit')}`), 'a fixed hook name behind the padding of a submodule is not read outside the cap');
});

test('審査 5: すでに skip-worktree・assume-unchanged の印が付いていたファイルを返事が書き換えたら、一覧に出る（印そのものは変わらないので index の変化は出ない）。書き換えなければ出ない', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  git(root, 'update-index', '--skip-worktree', 'a.txt');
  git(root, 'update-index', '--assume-unchanged', 'b.txt');
  writeFileSync(join(root, 'c.txt'), 'c by the owner\n');
  await r.check();
  const quiet = await change(r, projectId, () => undefined);
  assert.deepEqual({ files: names(quiet.run), git: quiet.run.git, alert: quiet.run.alert }, { files: [], git: [], alert: false });
  const edited = await change(r, projectId, () => {
    writeFileSync(join(root, 'a.txt'), 'a edited behind skip-worktree\n');
    writeFileSync(join(root, 'b.txt'), 'b edited behind assume-unchanged\n');
  });
  assert.deepEqual({ files: names(edited.run), git: edited.run.git }, { files: ['a.txt:modified', 'b.txt:modified'], git: [] });
  const again = await change(r, projectId, () => undefined);
  assert.deepEqual(names(again.run), [], 'what was already written before this reply is not listed again');
});

test('審査 1: commondir ファイルそのものも設定の指紋に入れる（もとから commondir があり、同じ中身の写しから別の写しへ向け直されても、変化として分かる）', { skip: !gitAvailable }, async t => {
  const r = await rig(t);
  const { id: projectId, root } = await repo(r, { 'a.txt': 'a\n' });
  const twins = ['twin-a', 'twin-b'].map(name => {
    const clone = join(r.products, name);
    git(r.products, 'clone', '-q', root, clone);
    writeFileSync(join(clone, '.git', 'config'), readFileSync(join(root, '.git', 'config')));
    return join(clone, '.git');
  });
  writeFileSync(join(root, '.git', 'commondir'), `${twins[0]}\n`);
  await r.check();
  const { run } = await change(r, projectId, () => writeFileSync(join(root, '.git', 'commondir'), `${twins[1]}\n`));
  assert.ok(run.git.includes('config'), `git: ${run.git.join(',')}`);
  assert.ok(!run.git.includes('hooks'), 'the hooks of the twins are the same');
  assert.equal(run.alert, true);
});
