import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { APP_ROOT } from '../src/paths.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, type testConfig } from './helpers.ts';

type Config = ReturnType<typeof testConfig>;
type Options = NonNullable<Parameters<typeof startApp>[1]>;

const PROJECT_KEYS = ['archived_at', 'check_command', 'created_at', 'doc_language', 'doc_language_pinned', 'folder_missing', 'has_plan', 'id', 'is_git', 'last_activity_at', 'name', 'remotes', 'root', 'running', 'scout_mode', 'updated_at', 'waiting'];
const NOTES = ['nested_inside', 'contains_product', 'inside_config_root', 'config_root_read_only', 'not_git'];

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], ...options });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const folder = (name: string) => { const dir = join(products, name); mkdirSync(dir, { recursive: true }); return dir; };
  const product = async (name: string, body: Record<string, unknown> = {}) => {
    const made = await s.json('/api/projects', 'POST', { root: folder(name), ...body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string; name: string; root: string };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const fresh = body.projectId !== undefined && body.permissionMode === undefined && !s.app.conversations.get(id);
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', fresh ? { ...body, permissionMode: 'auto' } : body);
    if (sent.status === 202) await settled(s.app, sent.body.runId);
    return sent;
  };
  return { ...s, products, events, folder, product, send };
}

test('製品の API: 作ると行と data/projects/<id>/ ができ、返す欄は決めた形（snake_case）。一覧に作った順で出る', async t => {
  const s = await setup(t);
  const made = await s.json('/api/projects', 'POST', { root: s.folder('shop'), checkCommand: 'npm test' });
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.body).sort(), ['notes', 'project']);
  const project = made.body.project;
  assert.deepEqual(Object.keys(project).sort(), PROJECT_KEYS);
  assert.match(project.id, /^[A-Za-z0-9_-]{6,64}$/u);
  assert.deepEqual(
    { name: project.name, root: project.root, check_command: project.check_command, scout_mode: project.scout_mode, remotes: project.remotes, archived_at: project.archived_at, is_git: project.is_git, folder_missing: project.folder_missing, waiting: project.waiting, running: project.running, last_activity_at: project.last_activity_at },
    { name: 'shop', root: join(s.products, 'shop'), check_command: 'npm test', scout_mode: 'off', remotes: [], archived_at: null, is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null },
  );
  assert.deepEqual(made.body.notes, ['not_git']);
  assert.ok(made.body.notes.every((n: string) => NOTES.includes(n)));
  assert.ok(statSync(join(s.paths.projects, project.id)).isDirectory(), '知識のフォルダが空でできる');
  assert.deepEqual(readdirSync(join(s.paths.projects, project.id)), []);
  assert.deepEqual(s.events.filter(e => e.type === 'project.changed'), [{ type: 'project.changed', projectId: project.id, change: 'created' }]);

  const second = await s.product('notes', { name: 'Travel Notes' });
  assert.equal(second.name, 'Travel Notes', '名前は打ったとおり');
  const inner = await s.json('/api/projects', 'POST', { root: s.folder('shop/packages/ui') });
  assert.deepEqual(inner.body.notes, ['nested_inside', 'not_git']);
  const listed = await s.json('/api/projects', 'GET');
  assert.deepEqual(listed.body.projects.map((p: { name: string }) => p.name), ['shop', 'Travel Notes', 'ui']);
  assert.deepEqual(Object.keys(listed.body.projects[0]).sort(), PROJECT_KEYS);
  assert.deepEqual((await s.json('/api/projects?archived=1', 'GET')).body.projects, []);
});

test('製品の API: 選べないフォルダは 400（コードは project.folder_<理由>）、同じフォルダは 409 project.root_in_use。行もフォルダもできない', async t => {
  const s = await setup(t);
  await s.product('shop');
  const before = readdirSync(s.paths.projects);
  const refused = async (body: Record<string, unknown>) => { const r = await s.json('/api/projects', 'POST', body); return [r.status, r.body.error, r.body.code]; };
  assert.deepEqual(await refused({ root: join(s.products, 'shop') }), [409, 'project', 'project.root_in_use']);
  assert.deepEqual(await refused({ root: join(s.products, 'nope') }), [400, 'project', 'project.folder_not_found']);
  assert.deepEqual(await refused({ root: 'relative/path' }), [400, 'project', 'project.folder_not_absolute']);
  assert.deepEqual(await refused({ root: join(APP_ROOT, 'src') }), [400, 'project', 'project.folder_beat'], '抜け道の外は今までどおり');
  const dataDir = await s.json('/api/projects', 'POST', { root: s.paths.data });
  assert.equal(dataDir.status, 400);
  assert.match(dataDir.body.code, /^project\.folder_(beat|app_data)$/u);
  assert.deepEqual(await refused({ root: s.folder('named'), name: 'bad‮name' }), [400, 'project', 'project.bad_name']);
  assert.deepEqual(await refused({ root: s.folder('named'), name: 'x'.repeat(101) }), [400, 'project', 'project.bad_name']);
  assert.deepEqual(await refused({ root: s.folder('named'), checkCommand: 'a\nb' }), [400, 'project', 'project.bad_check_command']);
  for (const hidden of ['­', '⁡', 'ㅤ', String.fromCodePoint(0xE0072), String.fromCharCode(0xA0), String.fromCharCode(0x3000), String.fromCharCode(0x2009), String.fromCharCode(0xFE0F), String.fromCodePoint(0xE0100), String.fromCharCode(0x600), '     ', String.fromCharCode(0x2800), String.fromCharCode(0x115F), String.fromCharCode(0x1160), String.fromCharCode(0xFFA0)]) {
    assert.deepEqual(await refused({ root: s.folder('named'), checkCommand: `npm${hidden} test` }), [400, 'project', 'project.bad_check_command'], `U+${hidden.codePointAt(0)!.toString(16)}`);
  }
  assert.equal((await s.json('/api/projects', 'POST', {})).status, 400);
  assert.deepEqual(readdirSync(s.paths.projects), before);
  assert.equal((await s.json('/api/projects', 'GET')).body.projects.length, 1);
});

test('製品の API: 名前を送らないとき、フォルダの名前が長すぎる・向きを変える文字や幅の無い文字を含むなら、整えた名前を付ける（断らない）', async t => {
  const s = await setup(t);
  const bidi = String.fromCharCode(0x202e);
  const zeroWidth = String.fromCharCode(0x200b);
  const odd = await s.json('/api/projects', 'POST', { root: s.folder(`shop${bidi}site${zeroWidth}`) });
  assert.deepEqual([odd.status, odd.body.project?.name], [201, 'shopsite']);
  const long = await s.json('/api/projects', 'POST', { root: s.folder(`${'n'.repeat(99)} tail-that-is-cut`) });
  assert.deepEqual([long.status, long.body.project?.name], [201, 'n'.repeat(99)]);
  const { defaultProjectName } = await import('../src/projects/store.ts');
  assert.equal(defaultProjectName(join(s.products, bidi)), 'Project', '何も残らないとき');
  assert.equal(defaultProjectName(join(s.products, 'plain name')), 'plain name');
  const named = await s.json('/api/projects', 'POST', { root: s.folder('typed'), name: `bad${bidi}name` });
  assert.deepEqual([named.status, named.body.code], [400, 'project.bad_name'], '打った名前は今までどおり断る');
});

test('製品の API: 抜け道の引数を渡さない App では、beat のフォルダの中も一時フォルダも選べない', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  assert.deepEqual(s.app.projectFolderExempt, []);
  const inBeat = await s.json('/api/projects', 'POST', { root: join(APP_ROOT, 'src') });
  assert.deepEqual([inBeat.status, inBeat.body.code], [400, 'project.folder_beat']);
  const elsewhere = realpathSync.native(tempDir(t));
  const temp = await s.json('/api/projects', 'POST', { root: elsewhere });
  if (process.platform === 'win32') assert.deepEqual([temp.status, temp.body.code], [400, 'project.folder_app_data']);
  assert.equal(existsSync(s.paths.projects) ? readdirSync(s.paths.projects).length : 0, 0);
});

test('製品の API: PATCH で名前・確かめのコマンド・しまう / 戻すを変える。root は受けない。出来事 project.changed が流れる', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const patch = (body: unknown, id = shop.id) => s.json(`/api/projects/${id}`, 'PATCH', body);
  const renamed = await patch({ name: 'Shop Site', checkCommand: 'npm run check' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(Object.keys(renamed.body), ['project']);
  assert.deepEqual([renamed.body.project.name, renamed.body.project.check_command], ['Shop Site', 'npm run check']);
  assert.equal((await patch({ checkCommand: null })).body.project.check_command, null);
  assert.equal((await patch({ refreshRemotes: true })).status, 200);
  const moved = await patch({ root: s.folder('other') });
  assert.deepEqual([moved.status, moved.body.code], [400, 'project.root_fixed']);
  assert.equal((await patch({ archived: 'yes' })).status, 400);
  assert.equal((await patch({ refreshRemotes: false })).status, 400);
  assert.equal((await patch({ name: 'a​b' })).body.code, 'project.bad_name');

  const archived = await patch({ archived: true });
  assert.equal(typeof archived.body.project.archived_at, 'number');
  assert.deepEqual((await s.json('/api/projects', 'GET')).body.projects, []);
  assert.deepEqual((await s.json('/api/projects?archived=1', 'GET')).body.projects.map((p: { id: string }) => p.id), [shop.id]);
  const restored = await patch({ archived: false });
  assert.equal(restored.body.project.archived_at, null);
  assert.deepEqual(s.events.filter(e => e.type === 'project.changed').map(e => (e as { change: string }).change), ['created', 'updated', 'updated', 'updated', 'archived', 'restored']);
});

test('製品の API: しまった製品を戻すとき、同じフォルダの使っている製品がもうあれば 409 project.root_in_use（500 にならない）', async t => {
  const s = await setup(t);
  const first = await s.product('shop');
  await s.json(`/api/projects/${first.id}`, 'PATCH', { archived: true });
  const second = await s.product('shop');
  assert.notEqual(second.id, first.id);
  const back = await s.json(`/api/projects/${first.id}`, 'PATCH', { archived: false });
  assert.deepEqual([back.status, back.body.error, back.body.code], [409, 'project', 'project.root_in_use']);
  assert.equal(typeof s.app.projects.get(first.id)!.archived_at, 'number', 'しまったまま');
  const { ProjectError } = await import('../src/projects/store.ts');
  assert.throws(() => s.app.projects.create({ name: 'dup', root: second.root, rootKey: s.app.projects.get(second.id)!.root_key, checkCommand: null }), (e: unknown) => e instanceof ProjectError && e.code === 'root_in_use');
  assert.equal(readdirSync(s.paths.projects).length, 2, '断った分のフォルダは作らない');
});

test('製品の API: 形の合わない ID・無い ID は 404 で、フォルダを作らない・読まない', async t => {
  const s = await setup(t);
  await s.product('shop');
  const before = readdirSync(s.paths.projects);
  for (const id of ['..%2Fx', '..%5C..%5Cx', 'a'.repeat(65), 'abc', 'bad.id.with.dots', uuid(9)]) {
    const r = await s.json(`/api/projects/${id}`, 'PATCH', { name: 'x' });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found'], id);
  }
  assert.deepEqual(readdirSync(s.paths.projects), before);
  assert.ok(!existsSync(join(s.paths.data, 'x')));
  const { projectDir, ProjectError } = await import('../src/projects/store.ts');
  for (const id of ['../x', '..', 'a/b', 'a\\b', 'short', '']) assert.throws(() => projectDir(s.paths.projects, id), ProjectError, id);
  assert.equal(projectDir(s.paths.projects, before[0]!), join(s.paths.projects, before[0]!));
});

test('製品の行: フォルダが無くなる・別のフォルダにすり替わると folder_missing。待ちの数は、提案・返事待ちのタスクと承認待ち', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const other = await s.product('other');
  const row = async (id = shop.id) => (await s.json('/api/projects', 'GET')).body.projects.find((p: { id: string }) => p.id === id);
  s.app.tasks.create({ title: 'idea', origin: 'self', propose: true, actor: 'test', projectId: shop.id });
  const asked = s.app.tasks.create({ title: 'ask', origin: 'user', actor: 'test', runAt: Date.now() + 3_600_000, projectId: shop.id });
  s.app.tasks.setWaiting(asked.id, 'question', 'Which one?');
  s.app.tasks.create({ title: 'elsewhere', origin: 'self', propose: true, actor: 'test' });
  s.app.conversations.create({ id: uuid(1), projectId: shop.id });
  assert.deepEqual((await row()).waiting, { proposals: 1, questions: 1, pending: 0 });
  assert.equal(typeof (await row()).last_activity_at, 'number');
  assert.deepEqual((await row(other.id)).waiting, { proposals: 0, questions: 0, pending: 0 });

  rmSync(join(s.products, 'shop'), { recursive: true });
  assert.equal((await row()).folder_missing, true);
  const refresh = await s.json(`/api/projects/${shop.id}`, 'PATCH', { refreshRemotes: true });
  assert.deepEqual([refresh.status, refresh.body.code], [409, 'project.folder_missing'], 'フォルダが無いときの取り直しは、古い一覧を 200 で返さず断る');
  mkdirSync(join(s.products, 'shop'));
  assert.equal((await row()).folder_missing, false);
  rmSync(join(s.products, 'shop'), { recursive: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(s.products, 'other'), join(s.products, 'shop'), 'junction');
  assert.equal((await row()).folder_missing, true, 'ジャンクションにすり替えた（実体が変わった）');
});

test('製品の会話: 新しい ID へ最初の発言を projectId つきで送ると、行ができた時から project_id が入っている（モデルの選択を一緒に送っても）', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const created: Array<string | null> = [];
  const original = s.app.conversations.ensure.bind(s.app.conversations);
  s.app.conversations.ensure = (id, options) => {
    const existed = Boolean(s.app.conversations.get(id));
    const result = original(id, options);
    if (!existed && result) created.push(s.app.conversations.projectOf(id));
    return result;
  };
  s.adapter().scripts = [reply('ok'), reply('ok'), reply('ok')];
  const sent = await s.send(uuid(1), { text: 'Build the cart', projectId: shop.id, modelId: 'm1', permissionMode: 'plan' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.deepEqual(created, [shop.id], '行を作った呼び出しが project_id を書いた（あとから UPDATE していない）');
  const row = s.app.conversations.get(uuid(1))!;
  assert.deepEqual([row.project_id, row.model_id, row.permission_mode, row.kind], [shop.id, 'm1', 'plan', 'chat']);
  const read = await s.json(`/api/conversations/${uuid(1)}/messages`, 'GET');
  assert.equal(read.body.conversation.project_id, shop.id);

  assert.equal((await s.send(uuid(1), { text: 'again' })).status, 202, 'もうある製品の会話は、projectId 無しでそのまま続く');
  assert.equal((await s.send(uuid(1), { text: 'again', projectId: shop.id })).status, 202);
  assert.equal(s.app.conversations.get(uuid(1))!.project_id, shop.id);

  s.adapter().scripts = [reply('ok')];
  assert.equal((await s.send(uuid(2), { text: 'no product' })).status, 202);
  assert.equal(s.app.conversations.get(uuid(2))!.project_id, null);
  assert.deepEqual(created, [shop.id, null]);
});

test('製品の会話: 無い製品・しまった製品は 400 で行ができない。もうある会話に違う projectId は 409。PATCH の projectId は 400。POST /api/conversations は今のまま', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const other = await s.product('other');
  const gone = await s.product('gone');
  await s.json(`/api/projects/${gone.id}`, 'PATCH', { archived: true });
  const codes = async (id: string, body: Record<string, unknown>) => { const r = await s.send(id, body); return [r.status, r.body.error, r.body.code]; };
  assert.deepEqual(await codes(uuid(1), { text: 'x', projectId: uuid(77) }), [400, 'project', 'project.unknown']);
  assert.deepEqual(await codes(uuid(1), { text: 'x', projectId: '../x' }), [400, 'project', 'project.unknown']);
  assert.deepEqual(await codes(uuid(1), { text: 'x', projectId: 5 }), [400, 'project', 'project.unknown']);
  assert.deepEqual(await codes(uuid(1), { text: 'x', projectId: gone.id, modelId: 'm1' }), [400, 'project', 'project.archived']);
  assert.equal(s.app.conversations.get(uuid(1)), undefined, '断った発言で行ができない');
  assert.equal(s.adapter().calls.length, 0);

  s.adapter().scripts = [reply('ok'), reply('ok')];
  assert.equal((await s.send(uuid(1), { text: 'x', projectId: shop.id })).status, 202);
  assert.equal((await s.send(uuid(2), { text: 'x' })).status, 202);
  assert.deepEqual(await codes(uuid(1), { text: 'x', projectId: other.id }), [409, 'project', 'project.mismatch']);
  assert.deepEqual(await codes(uuid(2), { text: 'x', projectId: shop.id }), [409, 'project', 'project.mismatch'], '製品なしの会話に、あとから製品は付かない');
  assert.equal(s.app.conversations.messages(uuid(1)).filter(m => m.role === 'user').length, 1, '断った発言は保存しない');
  assert.deepEqual([s.app.conversations.get(uuid(1))!.project_id, s.app.conversations.get(uuid(2))!.project_id], [shop.id, null]);

  const patched = await s.json(`/api/conversations/${uuid(2)}`, 'PATCH', { projectId: shop.id });
  assert.deepEqual([patched.status, patched.body.code], [400, 'project.fixed_on_conversation']);
  assert.equal((await s.json(`/api/conversations/${uuid(1)}`, 'PATCH', { projectId: null })).status, 400);
  assert.equal(s.app.conversations.get(uuid(1))!.project_id, shop.id);

  const plain = await s.json('/api/conversations', 'POST', { title: 'old door', projectId: shop.id });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.conversation.project_id, null, 'この口からは製品の会話は作れない');

  const renamed = await s.json(`/api/conversations/${uuid(1)}`, 'PATCH', { title: 'Cart' });
  assert.equal(renamed.body.conversation.project_id, shop.id);
  assert.deepEqual(s.events.filter(e => e.type === 'conversation.changed'), [{ type: 'conversation.changed', conversationId: uuid(1), change: 'renamed', projectId: shop.id }]);
});

test('行を作るほかの所: 製品のタスクの会話・子の担当の会話・振り返りの会話・繰り返しのひな形から作った実行が、同じ project_id を持つ', async t => {
  const s = await setup(t, { configure: (c: Config) => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  const projectOf = (id: string | null) => s.app.conversations.get(id!)!.project_id;

  const made = await s.json('/api/tasks', 'POST', { title: 'Sort the photos', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  assert.equal(made.status, 201);
  assert.equal(made.body.task.project_id, shop.id);
  assert.equal(made.body.task.proposed_by, null);
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const ran = s.app.tasks.get(made.body.task.id)!;
  assert.ok(ran.conversation_id);
  assert.equal(projectOf(ran.conversation_id), shop.id, 'タスクの会話');

  const plainTask = await s.json('/api/tasks', 'POST', { title: 'No product', when: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(plainTask.body.task.project_id, null);
  for (const projectId of [uuid(50), '../x']) {
    const bad = await s.json('/api/tasks', 'POST', { title: 'x', projectId });
    assert.deepEqual([bad.status, bad.body.code], [400, 'project.unknown']);
  }

  const template = await s.json('/api/tasks', 'POST', { title: 'Weekly check', repeat: { freq: 'daily', values: { time: '09:00' } }, projectId: shop.id });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const child = s.app.tasks.spawnNow(template.body.task.id)!;
  assert.equal(child.project_id, shop.id, 'ひな形から作った実行の行');
  assert.equal(child.parent_id, template.body.task.id);
  s.app.tasks.finish(child.id, 'cancelled', null, 'test');

  s.adapter().scripts = [call('agent_run', { task: 'Look it up', title: 'Lookup' }), reply('child answer'), reply('parent answer')];
  assert.equal((await s.send(uuid(1), { text: 'Ask a helper', projectId: shop.id })).status, 202);
  const childConversation = s.app.db.prepare('SELECT id, project_id FROM conversations WHERE parent_run_id IS NOT NULL').get() as { id: string; project_id: string | null };
  assert.equal(childConversation.project_id, shop.id, '子の担当の会話');

  s.adapter().scripts = [reply('No changes'), reply('No changes'), reply('No changes'), reply('No changes')];
  s.app.reviews.enqueue('manual', `manual:${uuid(1)}`, { conversationId: uuid(1) });
  const reviewJob = () => s.app.reviews.list().find(j => j.dedup_key === `manual:${uuid(1)}`)!;
  for (let i = 0; i < 4 && !reviewJob().review_conversation_id; i++) await s.app.worker.tick();
  const job = reviewJob();
  assert.ok(job.review_conversation_id);
  assert.equal(projectOf(job.review_conversation_id), shop.id, '振り返りの会話');

  const archived = await s.product('gone');
  await s.json(`/api/projects/${archived.id}`, 'PATCH', { archived: true });
  const refused = await s.json('/api/tasks', 'POST', { title: 'x', projectId: archived.id });
  assert.deepEqual([refused.status, refused.body.code], [400, 'project.archived']);
});

test('会話の一覧: 製品なし 100 件 + 使っている製品ごと 30 件。はみ出た分は more。製品の会話が多くても製品なしの会話は押し出されない。しまった製品の会話は出ない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const small = await s.product('small');
  const gone = await s.product('gone');
  let clock = 1_000;
  const add = (n: number, projectId: string | null, label: string) => {
    for (let i = 0; i < n; i++) {
      const c = s.app.conversations.create({ title: `${label} ${i}`, projectId });
      s.app.db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(clock++, c.id);
    }
  };
  add(105, null, 'none');
  add(3, small.id, 'small');
  add(3, gone.id, 'gone');
  add(205, shop.id, 'shop');
  s.app.conversations.create({ kind: 'task', title: 'task conversation', projectId: shop.id });
  s.app.conversations.archive(s.app.conversations.create({ title: 'shop archived', projectId: shop.id }).id);
  await s.json(`/api/projects/${gone.id}`, 'PATCH', { archived: true });

  const listed = await s.json('/api/conversations', 'GET');
  assert.deepEqual(Object.keys(listed.body).sort(), ['conversations', 'more']);
  const rows = listed.body.conversations as Array<{ title: string; project_id: string | null; last_message_at: number }>;
  const count = (id: string | null) => rows.filter(r => r.project_id === id).length;
  assert.deepEqual([count(null), count(shop.id), count(small.id), count(gone.id)], [100, 30, 3, 0]);
  assert.deepEqual(listed.body.more, { none: 5, [shop.id]: 175 });
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1]!.last_message_at >= r.last_message_at), '新しい順');
  assert.deepEqual(rows.filter(r => r.project_id === shop.id).map(r => r.title).slice(0, 2), ['shop 204', 'shop 203'], '製品ごとに新しい方から');
  assert.equal(rows.filter(r => r.project_id === null)[0]!.title, 'none 104');
  assert.ok('message_count' in rows[0]! && 'has_summary' in rows[0]! && 'archived_at' in rows[0]!, '今までの欄はそのまま');

  const more = await s.json(`/api/conversations?project=${shop.id}&limit=200`, 'GET');
  assert.equal(more.body.conversations.length, 200);
  assert.ok(more.body.conversations.every((r: { project_id: string }) => r.project_id === shop.id));
  assert.deepEqual(more.body.more, { [shop.id]: 5 });
  assert.equal((await s.json(`/api/conversations?project=${shop.id}&limit=9999`, 'GET')).body.conversations.length, 200, 'limit は 200 まで');
  assert.equal((await s.json(`/api/conversations?project=${shop.id}&limit=7`, 'GET')).body.conversations.length, 7);
  const none = await s.json('/api/conversations?project=none', 'GET');
  assert.equal(none.body.conversations.length, 100);
  assert.ok(none.body.conversations.every((r: { project_id: null }) => r.project_id === null));
  assert.deepEqual(none.body.more, { none: 5 });
  assert.deepEqual((await s.json(`/api/conversations?project=${small.id}`, 'GET')).body.more, {});
  assert.equal((await s.json('/api/conversations?project=..%2Fx', 'GET')).status, 400);

  const searched = await s.json('/api/conversations?q=small', 'GET');
  assert.deepEqual(searched.body.conversations.map((r: { title: string }) => r.title), ['small 2', 'small 1', 'small 0']);
  const archived = await s.json('/api/conversations?archived=1', 'GET');
  assert.deepEqual(archived.body.conversations.map((r: { title: string; project_id: string }) => [r.title, r.project_id]), [['shop archived', shop.id]]);
});

test('今ある口の製品の欄と絞り込み: タスク・時間割・実行の記録・道具の記録・振り返り・通知・履歴', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('about the cart'), reply('about nothing')];
  const inShop = await s.send(uuid(1), { text: 'cart total question', projectId: shop.id });
  const plain = await s.send(uuid(2), { text: 'plain total question' });

  const mine = s.app.tasks.create({ title: 'Shop task', origin: 'user', actor: 'test', runAt: Date.now() + 3_600_000, projectId: shop.id });
  const other = s.app.tasks.create({ title: 'Plain task', origin: 'user', actor: 'test', runAt: Date.now() + 3_600_000 });
  const done = s.app.tasks.create({ title: 'Shop done', origin: 'user', actor: 'test', runAt: Date.now() + 3_600_000, projectId: shop.id });
  s.app.tasks.finish(done.id, 'done', 'ok', 'test');
  s.app.tasks.create({ title: 'Shop daily', origin: 'user', actor: 'test', cron: '0 9 * * *', timezone: 'UTC', projectId: shop.id });
  s.app.tasks.create({ title: 'Plain daily', origin: 'user', actor: 'test', cron: '0 10 * * *', timezone: 'UTC' });

  const titles = (list: Array<{ title: string }>) => list.map(x => x.title).sort();
  const all = (await s.json('/api/tasks', 'GET')).body;
  assert.deepEqual(titles(all.active), ['Plain daily', 'Plain task', 'Shop daily', 'Shop task']);
  assert.equal(all.active.find((x: { title: string }) => x.title === 'Shop task').project_id, shop.id);
  const scoped = (await s.json(`/api/tasks?project=${shop.id}`, 'GET')).body;
  assert.deepEqual([titles(scoped.active), titles(scoped.finished), scoped.finishedTotal, titles(scoped.repeating)], [['Shop daily', 'Shop task'], ['Shop done'], 1, ['Shop daily']]);
  const unscoped = (await s.json('/api/tasks?project=none', 'GET')).body;
  assert.deepEqual([titles(unscoped.active), titles(unscoped.finished), unscoped.finishedTotal, titles(unscoped.repeating)], [['Plain daily', 'Plain task'], [], 0, ['Plain daily']]);
  const page = (await s.json(`/api/tasks/finished?project=${shop.id}`, 'GET')).body;
  assert.deepEqual([titles(page.tasks), page.total], [['Shop done'], 1]);
  assert.equal((await s.json('/api/tasks/finished?project=none', 'GET')).body.total, 0);
  assert.equal((await s.json(`/api/tasks/${mine.id}`, 'GET')).body.task.project_id, shop.id);
  assert.equal((await s.json(`/api/tasks/${other.id}`, 'GET')).body.task.project_id, null);

  const from = Date.now();
  const schedule = (await s.json(`/api/schedule?from=${from}&to=${from + 2 * 86_400_000}`, 'GET')).body;
  const byTitle = (list: Array<{ title: string; projectId: string | null }>) => Object.fromEntries(list.map(x => [x.title, x.projectId]));
  assert.deepEqual(byTitle(schedule.templates), { 'Shop daily': shop.id, 'Plain daily': null });
  assert.deepEqual(byTitle(schedule.slots), { 'Shop daily': shop.id, 'Plain daily': null, 'Shop task': shop.id, 'Plain task': null });
  assert.ok(schedule.slots.every((slot: object) => 'projectId' in slot && 'taskId' in slot));

  s.app.runs.start('orphan-run', 'chat');
  const runs = (await s.json('/api/runs', 'GET')).body;
  const runProject = Object.fromEntries(runs.runs.map((r: { id: string; project_id: string | null }) => [r.id, r.project_id]));
  assert.deepEqual(runProject, { [inShop.body.runId]: shop.id, [plain.body.runId]: null, 'orphan-run': null });
  assert.equal(runs.total, 3);
  const shopRuns = (await s.json(`/api/runs?project=${shop.id}`, 'GET')).body;
  assert.deepEqual([shopRuns.runs.map((r: { id: string }) => r.id), shopRuns.total], [[inShop.body.runId], 1]);
  const noneRuns = (await s.json('/api/runs?project=none', 'GET')).body;
  assert.deepEqual([noneRuns.runs.length, noneRuns.total], [2, 2]);

  const insertCall = (id: string, runId: string, conversationId: string | null) => s.app.db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, created_at) VALUES (?, ?, ?, 'file_read', '{}', 'allow', 'policy', ?)").run(id, runId, conversationId, Date.now());
  insertCall('tc-shop', inShop.body.runId, uuid(1));
  insertCall('tc-plain', plain.body.runId, uuid(2));
  const calls = (await s.json('/api/tool-calls', 'GET')).body;
  assert.deepEqual(Object.fromEntries(calls.toolCalls.map((c: { id: string; project_id: string | null }) => [c.id, c.project_id])), { 'tc-shop': shop.id, 'tc-plain': null });
  const shopCalls = (await s.json(`/api/tool-calls?project=${shop.id}`, 'GET')).body;
  assert.deepEqual([shopCalls.toolCalls.map((c: { id: string }) => c.id), shopCalls.total], [['tc-shop'], 1]);
  assert.equal((await s.json('/api/tool-calls?project=none', 'GET')).body.total, 1);

  s.app.reviews.enqueue('manual', 'manual:shop', { conversationId: uuid(1) });
  s.app.reviews.enqueue('manual', 'manual:plain', { conversationId: uuid(2) });
  s.app.reviews.enqueue('task', 'task:shop', { taskId: mine.id });
  const reviews = (await s.json('/api/reviews', 'GET')).body;
  assert.deepEqual(Object.fromEntries(reviews.jobs.map((j: { dedup_key: string; project_id: string | null }) => [j.dedup_key, j.project_id])), { 'manual:shop': shop.id, 'manual:plain': null, 'task:shop': shop.id });
  const shopReviews = (await s.json(`/api/reviews?project=${shop.id}`, 'GET')).body;
  assert.deepEqual([shopReviews.jobs.map((j: { dedup_key: string }) => j.dedup_key).sort(), shopReviews.total], [['manual:shop', 'task:shop'], 2]);
  assert.equal((await s.json('/api/reviews?project=none', 'GET')).body.total, 1);

  s.app.notifications.notify({ kind: 'info', title: 'from a shop chat', link: `#/c/${uuid(1)}` });
  s.app.notifications.notify({ kind: 'task_done', title: 'from a shop task', link: `#/tasks/${mine.id}` });
  s.app.notifications.notify({ kind: 'info', title: 'from a plain task', link: `#/tasks/${other.id}` });
  s.app.notifications.notify({ kind: 'info', title: 'no link' });
  const notifications = (await s.json('/api/notifications', 'GET')).body.notifications as Array<{ title: string; project_id: string | null }>;
  assert.deepEqual(Object.fromEntries(notifications.map(n => [n.title, n.project_id])), { 'from a shop chat': shop.id, 'from a shop task': shop.id, 'from a plain task': null, 'no link': null });

  const hits = (await s.json('/api/history?q=total%20question', 'GET')).body.hits as Array<{ conversationId: string; projectId: string | null }>;
  assert.deepEqual(Object.fromEntries(hits.map(h => [h.conversationId, h.projectId])), { [uuid(1)]: shop.id, [uuid(2)]: null });
});

test('フォルダの一覧の API: POST で受け、フォルダの名前だけを返す。ネットワークのパスは 400、無いパスは 400。出発点は path 無し', async t => {
  const s = await setup(t);
  s.folder('alpha');
  s.folder('.ssh');
  await s.product('beta');
  const listed = await s.json('/api/folders/list', 'POST', { path: s.products });
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body).sort(), ['entries', 'parent', 'path', 'truncated']);
  assert.equal(listed.body.path, s.products);
  assert.deepEqual(listed.body.entries, [
    { name: 'alpha', path: join(s.products, 'alpha'), selectable: true, isGit: false, link: false },
    { name: 'beta', path: join(s.products, 'beta'), selectable: false, reason: 'project.root_in_use', isGit: false, link: false },
  ]);
  const start = await s.json('/api/folders/list', 'POST', {});
  assert.deepEqual([start.status, start.body.path, start.body.parent, start.body.truncated], [200, null, null, false]);
  assert.ok(start.body.entries.length >= 1 && start.body.entries.every((e: { path: string; selectable: boolean }) => typeof e.path === 'string' && typeof e.selectable === 'boolean'));
  const missing = await s.json('/api/folders/list', 'POST', { path: join(s.products, 'nope') });
  assert.deepEqual([missing.status, missing.body.code], [400, 'project.folder_not_found']);
  assert.doesNotMatch(JSON.stringify(missing.body), /nope/u, 'エラーの文にパスを出さない');
  if (process.platform === 'win32') {
    const remote = await s.json('/api/folders/list', 'POST', { path: '\\\\server\\share' });
    assert.deepEqual([remote.status, remote.body.code], [400, 'project.folder_remote']);
  }
  assert.equal((await s.api('/api/folders/list')).status, 405, 'GET では受けない（パスを URL に載せない）');
  const noOrigin = await fetch(`${s.origin}/api/folders/list`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(noOrigin.status, 403, 'よその origin からは呼べない');
});
