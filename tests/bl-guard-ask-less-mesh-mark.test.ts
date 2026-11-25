import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Mesh } from '../src/mesh/index.ts';
import { resolvePaths } from '../src/paths.ts';
import { AcceptanceStore } from '../src/projects/acceptance.ts';
import { PlanStore } from '../src/projects/plan.ts';
import { tempDir } from './helpers.ts';

// L102: mesh_read・mesh_search の「外から読んだ」の印（fetched）の付く条件を固定する。この束では印を外す側は直していない（根は pipeline.ts の通信の道具の印の付け方で、受け持ちの外）。
// 外の文を 1 字でも保存した形で印が付くこと・きれいな形では付かないことを、今の振る舞いのまま試験で押さえる

const PROJECT = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const CONV = 'cccccccc-0000-4000-8000-0000000000c1';

const ACCEPTANCE = {
  schema: 1, version: 0, language: 'en',
  items: [{ id: 'A-1', result: 'The upload page shows progress', source: { kind: 'ai_added' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null }],
  notDoing: [],
};
const draft = (taintedRuns: string[]) => ({ ...ACCEPTANCE, taintedRuns }) as never;

function fixture(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const dir = join(paths.projects, PROJECT);
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  db.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at, project_id) VALUES (?, 'chat', 0, 0, ?)").run(CONV, PROJECT);
  const plans = new PlanStore(new KV(db), { projects: paths.projects, backups: paths.backups });
  const acceptance = new AcceptanceStore(db, paths.projects);
  const mesh = new Mesh({ projectsDir: paths.projects, backupsDir: paths.backups, plans, acceptance, timezone: () => 'UTC' });
  const put = (rel: string, text: string): void => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const read = (file: string) => mesh.read(PROJECT, { file }, 20_000, 'en', CONV);
  return { dir, plans, acceptance, mesh, put, read };
}

test('L102: 計画書・受け入れの一覧の印は、外を読んだ実行が書いたとき・beat の外で書き換えられたときだけ付く（きれいなものには付かない）', t => {
  const f = fixture(t);
  f.plans.write(PROJECT, CONV, '# Clean plan\n', { by: 'ai', tainted: false, conversationId: CONV, runId: 'r0' });
  assert.equal(f.read('plan.md').fetched, false, '外を読んでいない実行の計画書');
  f.plans.write(PROJECT, CONV, '# Plan after a web page\n', { by: 'ai', tainted: true, conversationId: CONV, runId: 'r1' });
  assert.equal(f.read('plan.md').fetched, true, '外を読んだ実行の計画書');
  f.plans.write(PROJECT, CONV, '# Clean again\n', { by: 'owner', tainted: false, conversationId: null, runId: null });
  assert.equal(f.read('plan.md').fetched, true, '持ち主の保存では印は消えない');
  f.plans.review(PROJECT, CONV, f.plans.view(PROJECT, CONV).hash!);
  assert.equal(f.read('plan.md').fetched, false, '持ち主が読んで確かめた計画書');
  writeFileSync(join(f.dir, 'conversation-plans', `${CONV}.md`), '# Edited by hand outside beat\n');
  assert.equal(f.read('plan.md').fetched, true, 'beat の外で書き換えられた計画書');

  f.acceptance.writeDraft(PROJECT, CONV, draft([]));
  assert.equal(f.read('acceptance.json').fetched, false, '外を読んだ実行の印が 1 つも無い一覧');
  f.acceptance.writeDraft(PROJECT, CONV, draft(['r-web']));
  assert.equal(f.read('acceptance.json').fetched, true, '外を読んだ実行の印が 1 つある一覧');
});

test('L102: 考える実行の控え（scout/ の下）は、名指しで読めば外扱い。それ以外の mesh のファイル・決まりの文は外扱いにならない', t => {
  const f = fixture(t);
  f.put('scout/ledger.md', '# Scout ledger\n\n- checked the upload flow\n');
  f.put('scout/notes.md', '# Scout notes\nfound a page\n');
  f.put('notes/build.md', '# Build\nupload steps\n');
  assert.equal(f.read('scout/ledger.md').fetched, true, 'scout の控え');
  assert.equal(f.read('Scout\\Notes.md').fetched, true, '大文字・\\ 区切りでも scout の下');
  assert.equal(f.read('notes/build.md').fetched, false, 'ふつうの mesh のファイル');
  f.put('notes/pasted.md', '# Pasted\n- decision [src: external] use the hosted queue\n');
  assert.equal(f.read('notes/pasted.md').fetched, true, '外から来たと自分で書いた行を含むファイル');
});

test('L102: 検索は、名前を指さなくても外の印を含む行に当たれば fetched を返し、きれいな行だけなら返さない', t => {
  const f = fixture(t);
  f.put('notes/build.md', '# Build\nupload steps\n');
  const clean = f.mesh.search(PROJECT, { query: 'upload' }, 20_000, 'en', CONV);
  assert.equal(clean.fetched, false, clean.content);
  f.put('notes/pasted.md', '# Pasted\n- decision [src: external] upload through the hosted queue\n');
  const marked = f.mesh.search(PROJECT, { query: 'upload' }, 20_000, 'en', CONV);
  assert.equal(marked.fetched, true, marked.content);
});
