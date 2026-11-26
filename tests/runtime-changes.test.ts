import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint, listRunChanges, MAX_DIRTY, makeGuard, compareSnapshots, RUN_KEEP, RUN_SHOWN, saveRunChanges, type Guard, type Print, type RuntimeRunChanges, type Snapshot } from '../src/changes/runtime.ts';
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
  assert.deepEqual(recorded.changes, { state: 'ok', files: 4, unchecked: 0, git: [], alert: false });
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
  assert.deepEqual({ state: run.state, files: run.files }, { state: 'too_many', files: [] });
});

test('実行ごとの一覧は、製品ごとに新しい RUN_KEEP 件だけ残り、画面へは RUN_SHOWN 件まで。会話で絞れる。会話を消すと一緒に消える', async t => {
  const s = await startApp(t);
  const base = (i: number, conversationId: string, projectId = 'p1'): RuntimeRunChanges => ({
    v: 1, runId: `run${i}`, conversationId, projectId, runtime: 'claude-code', kind: 'claude-code', at: 1000 + i, outcome: 'ok', state: 'ok', files: [{ path: `f${i}.txt`, status: 'added', marks: [] }], more: 0, unchecked: 0, git: [], alert: false,
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
    later: new Map(Object.entries(extra.later ?? {})), headDiff: new Map(Object.entries(extra.headDiff ?? {})),
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
