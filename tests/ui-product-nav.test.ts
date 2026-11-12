import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Conversation, type FolderEntry, type Project } from '../web/src/api.ts';
import { t } from '../web/src/i18n/index.ts';
import { errorBodyText, serverText } from '../web/src/server-text.ts';
import { entryReason, folderName, nameFor, newProjectInput, noteKeys, upTarget } from '../web/src/ui/folder-pick.ts';
import { loadProjectList, productNav, projectLoads, settleLeave } from '../web/src/ui/product-nav.ts';
import { parseRoute, routeHash, type Route } from '../web/src/ui/routes.ts';
import { clearUnsaved, hasUnsavedEdits, leaveAsks, SCREEN_EDITS, setUnsaved } from '../web/src/ui/unsaved.ts';

// 2-2a（p2-product.md）: サイドバーの Products の節、製品の一覧の読み込み、経路の落ち着け方、New product の決まり。

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id.toUpperCase(), root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});
const conv = (id: string, at: number, projectId: string | null = null): Conversation => ({ id, title: id, created_at: 0, last_message_at: at, project_id: projectId });
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map(r => r.id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('ui/product-nav: 製品の会話は製品の下、製品なしは No product、知らない製品（しまった・まだ読んでいない）の会話はどこにも出さない', () => {
  const projects = [project('p2bbbb', { created_at: 20 }), project('p1aaaa', { created_at: 10, waiting: { proposals: 1, questions: 2, pending: 0 } })];
  const nav = productNav(projects, [conv('a', 5, 'p1aaaa'), conv('b', 4), conv('c', 3, 'gone01'), conv('d', 2, 'p1aaaa')], {}, new Map());
  assert.deepEqual(nav.rows.map(r => r.project.id), ['p1aaaa', 'p2bbbb'], '作った順');
  assert.deepEqual(ids(nav.rows[0]!.sessions), ['a', 'd']);
  assert.deepEqual(ids(nav.rows[1]!.sessions), []);
  assert.deepEqual(ids(nav.none), ['b'], '製品の会話を No product に混ぜない');
  assert.ok(![...nav.none, ...nav.rows.flatMap(r => r.sessions)].some(c => c.id === 'c'), '知らない製品の会話は隠す');
  assert.equal(nav.rows[0]!.waiting, 3);
  assert.equal(nav.rows[0]!.nameHref, '#/c/a', '名前はいちばん新しい会話を開く');
  assert.equal(nav.rows[1]!.nameHref, '#/p/p2bbbb/new', '会話が無ければ新しい会話');
});

test('ui/product-nav: "N more" は more の数。読み足した分を合わせると N more は消え、ほかの製品の会話は混ぜない', () => {
  const projects = [project('p1aaaa')];
  const before = productNav(projects, [conv('a', 5, 'p1aaaa')], { p1aaaa: 31, none: 4 }, new Map());
  assert.equal(before.rows[0]!.more, 31);
  const extra = new Map([['p1aaaa', [conv('a', 5, 'p1aaaa'), conv('old', 1, 'p1aaaa'), conv('x', 9, 'p9zzzz')]]]);
  const after = productNav(projects, [conv('a', 5, 'p1aaaa')], { p1aaaa: 31 }, extra);
  assert.equal(after.rows[0]!.more, 0);
  assert.deepEqual(ids(after.rows[0]!.sessions), ['a', 'old']);
});

test('ui/product-nav: loadProjectList は 404 を「製品なし」の空の一覧に、ほかの失敗は何もしない（null）', async () => {
  const list = [project('p1aaaa')];
  assert.deepEqual(await loadProjectList(async () => ({ projects: list })), list);
  assert.deepEqual(await loadProjectList(async () => { throw new ApiError(404, { error: 'not_found' }); }), []);
  assert.equal(await loadProjectList(async () => { throw new ApiError(500, {}); }), null);
  assert.equal(await loadProjectList(async () => { throw new TypeError('Failed to fetch'); }), null);
  assert.equal(await loadProjectList(async () => ({}) as { projects: Project[] }), null, '形の合わない応答は当てない');
});

test('ui/product-nav: 作った直後に、作る前に出した GET /api/projects が古い一覧で届いても、作った製品を消さない', async () => {
  const pending = [deferred<{ projects: Project[] }>(), deferred<{ projects: Project[] }>()];
  let call = 0;
  const applied: string[][] = [];
  const loads = projectLoads(() => pending[call++]!.promise, projects => applied.push(ids(projects)));
  const stale = loads.load();
  loads.supersede();
  pending[0]!.resolve({ projects: [project('p1aaaa')] });
  await stale;
  assert.deepEqual(applied, [], '作る前の読み込みは捨てる');
  const fresh = loads.load();
  pending[1]!.resolve({ projects: [project('p1aaaa'), project('p2bbbb')] });
  await fresh;
  assert.deepEqual(applied, [['p1aaaa', 'p2bbbb']]);
});

test('ui/product-nav: 重なった読み込みは、あとに出した方だけを当てる', async () => {
  const pending = [deferred<{ projects: Project[] }>(), deferred<{ projects: Project[] }>()];
  let call = 0;
  const applied: string[][] = [];
  const loads = projectLoads(() => pending[call++]!.promise, projects => applied.push(ids(projects)));
  const first = loads.load();
  const second = loads.load();
  pending[1]!.resolve({ projects: [project('p2bbbb')] });
  await second;
  pending[0]!.resolve({ projects: [project('p1aaaa')] });
  await first;
  assert.deepEqual(applied, [['p2bbbb']]);
});

test('ui/product-nav: 書きかけのある製品の画面で製品が一覧から消えても、ホームへ動かす → 書きかけの確かめ → 戻す、の輪にならない', () => {
  clearUnsaved('');
  const settings: Route = { view: 'productSettings', id: 'p1aaaa' };
  setUnsaved(`${SCREEN_EDITS}product`, true);
  const replaced: string[] = [];
  const moved = settleLeave(settings, ['p2bbbb'], { clearEdits: () => clearUnsaved(SCREEN_EDITS), replace: hash => replaced.push(hash) });
  assert.equal(moved, true);
  assert.deepEqual(replaced, ['#/']);
  assert.equal(hasUnsavedEdits(SCREEN_EDITS), false);
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), settings, parseRoute(replaced[0]!)), false, 'ホームへの移動で書きかけの確かめが出ない（出ると元の画面へ戻され、また動かされる）');

  setUnsaved(`${SCREEN_EDITS}product`, true);
  const stay = settleLeave(settings, ['p1aaaa'], { clearEdits: () => clearUnsaved(SCREEN_EDITS), replace: hash => replaced.push(hash) });
  assert.equal(stay, false);
  assert.equal(hasUnsavedEdits(SCREEN_EDITS), true, '製品がまだあるときは書きかけを消さない');
  assert.equal(settleLeave(settings, null, { clearEdits: () => clearUnsaved(SCREEN_EDITS), replace: hash => replaced.push(hash) }), false, '一覧を読み終えるまでは動かさない');
  assert.equal(settleLeave({ view: 'productNew', id: 'p3cccc' }, ['p3cccc'], { clearEdits: () => clearUnsaved(SCREEN_EDITS), replace: hash => replaced.push(hash) }), false, '作った直後の製品（一覧に足した）は動かさない');
  clearUnsaved('');
});

test('ui/folder-pick: フォルダの名前・上へ・選べない理由・作る口へ送る形', () => {
  assert.equal(folderName('C:\\work\\uploader\\'), 'uploader');
  assert.equal(folderName('/home/me/field-notes'), 'field-notes');
  assert.equal(folderName('   '), '');
  assert.equal(upTarget({ path: null, parent: null, entries: [], truncated: false }), undefined, '出発点の一覧には上が無い');
  assert.equal(upTarget({ path: 'C:\\', parent: null, entries: [], truncated: false }), null, 'ドライブの直下から上は出発点の一覧');
  assert.equal(upTarget({ path: 'C:\\a\\b', parent: 'C:\\a', entries: [], truncated: false }), 'C:\\a');

  const entry = (over: Partial<FolderEntry>): FolderEntry => ({ name: 'x', path: 'C:\\x', selectable: true, isGit: false, link: false, ...over });
  assert.equal(entryReason(entry({})), null);
  assert.deepEqual(entryReason(entry({ selectable: false, reason: 'project.folder_home' })), { kind: 'code', code: 'project.folder_home' });
  assert.deepEqual(entryReason(entry({ selectable: false, link: true, reason: 'project.folder_link' })), { kind: 'link' });

  assert.equal(nameFor('C:\\work\\uploader', '', false), 'uploader', '既定はフォルダの名前');
  assert.equal(nameFor('C:\\work\\uploader', 'My App', true), 'My App', '打った名前はそのまま（大文字小文字も）');
  assert.equal(newProjectInput('  ', 'n', ''), null);
  assert.deepEqual(newProjectInput(' C:\\work\\a ', ' A ', '  '), { root: 'C:\\work\\a', name: 'A' });
  assert.deepEqual(newProjectInput('C:\\work\\a', '', 'npm test'), { root: 'C:\\work\\a', checkCommand: 'npm test' });
  assert.deepEqual(noteKeys(['nested_inside', 'not_git', 'something_new']).map(k => t(k)), ['This folder is inside another product.', 'Not a git folder.']);
});

test('ui/product-nav: 製品のエラーのコードは画面の文にする。リンクの文は「開いて見る」と言わない（開いても同じ理由で断られるため）', () => {
  assert.equal(errorBodyText({ error: 'project', code: 'project.folder_missing', message: 'x' }, 'en'), 'The folder of this product could not be found');
  assert.equal(errorBodyText({ error: 'project', code: 'project.root_in_use', message: 'x' }, 'en'), 'Another product already uses this folder');
  assert.equal(errorBodyText({ error: 'project', code: 'project.unheard_of', message: 'x' }, 'en'), null, '表に無いコードはサーバーの文に戻す');
  const link = serverText('project.folder_link', null, 'en') ?? '';
  assert.ok(link.length > 0);
  assert.doesNotMatch(link, /open it/iu);
  assert.match(t('ui.np.link'), /open it/iu, '一覧の行（開けば解ける）の文');
  assert.equal(routeHash({ view: 'productNew', id: 'p1aaaa' }), '#/p/p1aaaa/new');
});
