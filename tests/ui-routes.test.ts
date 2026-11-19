import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_FALLBACK_MS, HOME, isConversation, latch, parseRoute, routeBehind, routeHash, routeProductId, settingsCloser, settingsDepth, settleRoute, type Route } from '../web/src/ui/routes.ts';

// 新しい画面（web/src/ui）の経路。p1-ui.md の「枠」: #/ #/c/<id> #/overview #/kanban #/tasks/<id> #/schedule #/notifications #/memory
// #/skills[/<名前>|/draft/<名前>] #/runs[/tools|/reviews] #/archived #/settings[/<区分>]。

const ROUTES: Array<[string, Route]> = [
  ['#/', { view: 'new' }],
  ['#/c/abc', { view: 'chat', id: 'abc' }],
  ['#/overview', { view: 'overview' }],
  ['#/kanban', { view: 'kanban' }],
  ['#/tasks/t1', { view: 'task', id: 't1' }],
  ['#/schedule', { view: 'schedule' }],
  ['#/notifications', { view: 'notifications' }],
  ['#/memory', { view: 'memory' }],
  ['#/memory/prod_01-AB', { view: 'memory', productId: 'prod_01-AB' }],
  ['#/skills', { view: 'skills' }],
  ['#/skills/tidy', { view: 'skills', target: { kind: 'skill', name: 'tidy' } }],
  ['#/skills/draft/tidy', { view: 'skills', target: { kind: 'draft', name: 'tidy' } }],
  ['#/runs', { view: 'runs' }],
  ['#/runs/run', { view: 'runs', tab: 'run' }],
  ['#/runs/tools', { view: 'runs', tab: 'tools' }],
  ['#/runs/reviews', { view: 'runs', tab: 'reviews' }],
  ['#/archived', { view: 'archived' }],
  ['#/settings', { view: 'settings' }],
  ['#/settings/models', { view: 'settings', section: 'models' }],
  ['#/p/prod_01-AB', { view: 'product', id: 'prod_01-AB' }],
  ['#/p/prod_01-AB/new', { view: 'productNew', id: 'prod_01-AB' }],
  ['#/p/prod_01-AB/settings', { view: 'productSettings', id: 'prod_01-AB' }],
  ['#/products/new', { view: 'newProduct' }],
  ['#/pending', { view: 'pending' }],
  ['#/pending/prod_01-AB', { view: 'pending', productId: 'prod_01-AB' }],
  ['#/questions', { view: 'questions' }],
  ['#/questions/prod_01-AB', { view: 'questions', productId: 'prod_01-AB' }],
];

test('ui/routes: Questions の経路（5-2-u）。形の合わない製品の ID は全製品の Questions。製品の画面でも会話でもない', () => {
  for (const hash of ['#/questions/short', '#/questions/has.dot1', '#/questions/..%2Fxxxx']) assert.deepEqual(parseRoute(hash), { view: 'questions' }, hash);
  assert.equal(routeProductId({ view: 'questions', productId: 'prod_01-AB' }), null);
  assert.equal(isConversation({ view: 'questions' }), false);
});

test('ui/routes: Pending の経路（4-U1）。形の合わない製品の ID は全製品の Pending', () => {
  for (const hash of ['#/pending/short', '#/pending/has.dot1', '#/pending/..%2Fxxxx']) assert.deepEqual(parseRoute(hash), { view: 'pending' }, hash);
  assert.equal(routeProductId({ view: 'pending', productId: 'prod_01-AB' }), null, '製品の画面ではない（製品の Pending の欄を開く入口）');
  assert.equal(isConversation({ view: 'pending' }), false);
});

test('ui/routes: 製品の経路。形の合わない ID・足りない経路はホーム、知らない続きは製品の Overview', () => {
  for (const hash of ['#/p', '#/p/', '#/p/short', '#/p/has.dot1', '#/p/..%2Fxxxx', `#/p/${'a'.repeat(65)}`, '#/p/a%20bcdef/new', '#/products', '#/products/other']) {
    assert.deepEqual(parseRoute(hash), HOME, hash);
  }
  assert.deepEqual(parseRoute('#/p/abcdef/else'), { view: 'product', id: 'abcdef' });
  assert.equal(routeHash(parseRoute('#/p/abcdef/else')), '#/p/abcdef');
  assert.equal(isConversation({ view: 'product', id: 'abcdef' }), false);
});

test('ui/routes: 知らない製品の経路はホーム（一覧を読み終えてから。製品の口が無いサーバーでは一覧が空）', () => {
  const routes: Route[] = [{ view: 'product', id: 'abcdef' }, { view: 'productNew', id: 'abcdef' }, { view: 'productSettings', id: 'abcdef' }];
  for (const route of routes) {
    assert.equal(routeProductId(route), 'abcdef');
    assert.equal(settleRoute(route, null), route, '読み込み中は動かさない');
    assert.equal(settleRoute(route, ['abcdef', 'other1']), route);
    assert.deepEqual(settleRoute(route, []), HOME);
    assert.deepEqual(settleRoute(route, ['other1']), HOME);
  }
  for (const route of [{ view: 'newProduct' }, { view: 'chat', id: 'abcdef' }, { view: 'overview' }, HOME] as Route[]) {
    assert.equal(routeProductId(route), null);
    assert.equal(settleRoute(route, []), route);
  }
});

test('ui/routes: どの経路も読めて、書き戻すと同じハッシュになる', () => {
  for (const [hash, route] of ROUTES) {
    assert.deepEqual(parseRoute(hash), route, hash);
    assert.equal(routeHash(route), hash, hash);
  }
});

test('ui/routes: 通知に保存された古い経路を新しい画面へ読み替える（#/tasks → Kanban、#/today → Overview、#/review → Skills、#/curiosity → Kanban）', () => {
  assert.deepEqual(parseRoute('#/tasks'), { view: 'kanban' });
  assert.deepEqual(parseRoute('#/today'), { view: 'overview' });
  assert.deepEqual(parseRoute('#/review'), { view: 'skills' });
  assert.deepEqual(parseRoute('#/curiosity'), { view: 'kanban' });
  assert.deepEqual(parseRoute('#/tasks/0193'), { view: 'task', id: '0193' });
});

test('ui/routes: 知らない経路・空・Object の名前は新しい会話になる', () => {
  for (const hash of ['', '#', '#/nope', '#/constructor', '#/__proto__', '#/toString', '#/c', '#/c/', '#/tasks/']) {
    const route = parseRoute(hash);
    assert.deepEqual(route, hash.startsWith('#/tasks') ? { view: 'kanban' } : HOME, hash);
  }
});

test('ui/routes: 名前は符号化して書き、読むときに戻す（壊れた符号化はそのまま）', () => {
  const route: Route = { view: 'chat', id: 'a b/c' };
  assert.equal(routeHash(route), '#/c/a%20b%2Fc');
  assert.deepEqual(parseRoute(routeHash(route)), route);
  assert.deepEqual(parseRoute('#/c/%E0%A4%A'), { view: 'chat', id: '%E0%A4%A' });
  assert.deepEqual(parseRoute('#/skills/draft/a%2Fb'), { view: 'skills', target: { kind: 'draft', name: 'a/b' } });
});

test('ui/routes: Settings はモーダルなので、後ろには直前の画面を残す（直前が無ければ新しい会話）', () => {
  const kanban: Route = { view: 'kanban' };
  assert.deepEqual(routeBehind({ view: 'settings' }, kanban), kanban);
  assert.deepEqual(routeBehind({ view: 'settings' }, null), HOME);
  assert.deepEqual(routeBehind(kanban, { view: 'memory' }), kanban);
});

test('ui/routes: 会話の 2 つ（新しい会話と会話）だけが bt-app、ほかは画面（bt-shell）', () => {
  assert.equal(isConversation({ view: 'new' }), true);
  assert.equal(isConversation({ view: 'chat', id: 'x' }), true);
  for (const [, route] of ROUTES.filter(([, r]) => r.view !== 'new' && r.view !== 'chat')) assert.equal(isConversation(route), false, route.view);
});

test('ui/routes: latch は reset まで 1 回だけ動く（Settings を閉じる history.back() を、2 回目の Esc や二度押しで重ねない）', () => {
  let calls = 0;
  const closer = latch(() => { calls += 1; });
  closer.fire(); closer.fire(); closer.fire();
  assert.equal(calls, 1);
  closer.reset();
  closer.fire(); closer.fire();
  assert.equal(calls, 2);
});

function fakeClose(start: string, landing: string, behind = true) {
  const log: string[] = [];
  let hash = start;
  let generation = 0;
  const timers: Array<() => void> = [];
  const closer = settingsCloser({
    hasBehind: () => behind,
    behindHash: () => '#/kanban',
    depth: () => null,
    back: () => { log.push('back'); if (landing !== hash) { hash = landing; generation += 1; } },
    replace: next => { log.push(`replace ${next}`); hash = next; generation += 1; },
    currentHash: () => hash,
    generation: () => generation,
    later: (run, ms) => { assert.equal(ms, CLOSE_FALLBACK_MS); timers.push(run); },
  });
  return { closer, log, timers, hash: () => hash, navigate: (next: string) => { hash = next; generation += 1; } };
}

test('ui/routes: Settings を閉じて戻った先がまだ Settings（アドレス欄で #/settings/ を打った履歴）なら、約 300ms 後に後ろの画面へ置き換える', () => {
  const f = fakeClose('#/settings', '#/settings');
  f.closer.fire();
  for (const run of f.timers) run();
  assert.deepEqual(f.log, ['back', 'replace #/kanban']);
  assert.equal(f.hash(), '#/kanban');
});

test('ui/routes: 戻るで Settings から出られたときは置き換えない（ふだんの閉じ方）', () => {
  const f = fakeClose('#/settings', '#/kanban');
  f.closer.fire();
  for (const run of f.timers) run();
  assert.deepEqual(f.log, ['back']);
});

test('ui/routes: 後ろの画面が無い（#/settings を直接開いた）ときは戻らずに新しい会話へ置き換える', () => {
  const f = fakeClose('#/settings', '#/settings', false);
  f.closer.fire();
  assert.deepEqual(f.log, ['replace #/']);
  assert.equal(f.timers.length, 0);
});

test('ui/routes: 閉じたあと、待つあいだに別の経路へ動いていれば（generation が変わる）置き換えない', () => {
  const f = fakeClose('#/settings', '#/kanban');
  f.closer.fire();
  f.navigate('#/settings/models');
  for (const run of f.timers) run();
  assert.deepEqual(f.log, ['back']);
  assert.equal(f.hash(), '#/settings/models');
});

test('ui/routes: アドレス欄で #/settings/<区分> を何度も打って履歴を積んでも、閉じると Settings の前の画面へ戻る（積んだ分だけ戻る。backlog 181）', () => {
  assert.equal(settingsDepth(4, 6), 3, 'Settings を開いた位置から今までの 3 つ');
  assert.equal(settingsDepth(4, 4), 1);
  assert.equal(settingsDepth(null, 6), null, '履歴の位置が分からなければ数えない');
  assert.equal(settingsDepth(6, 4), null);
  const log: string[] = [];
  let hash = '#/settings/models';
  const closer = settingsCloser({
    hasBehind: () => true,
    behindHash: () => '#/kanban',
    depth: () => 3,
    back: by => { log.push(`back ${by}`); hash = '#/kanban'; },
    replace: next => { log.push(`replace ${next}`); hash = next; },
    currentHash: () => hash,
    generation: () => 0,
    later: () => undefined,
  });
  closer.fire();
  assert.deepEqual(log, ['back 3']);
  const once: string[] = [];
  settingsCloser({
    hasBehind: () => true, behindHash: () => '#/kanban', depth: () => null,
    back: by => { once.push(`back ${by}`); }, replace: () => undefined, currentHash: () => '#/kanban', generation: () => 0, later: () => undefined,
  }).fire();
  assert.deepEqual(once, ['back 1'], '数えられなければ 1 つ戻る（あとは置き換えの保険）');
});

test('ui/routes の配線: App は Settings を開いた履歴の位置を覚え、閉じるときに積んだ分だけ戻る（backlog 181）', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('depth: () => settingsDepth(settingsStart.current, historyIndex()),'));
  assert.ok(app.includes('back: by => history.go(-by),'));
  assert.ok(/if \(next\.view === 'settings' && viewRef\.current !== 'settings'\) \{ settingsOpener\.current = document\.activeElement; settingsStart\.current = historyIndex\(\); \}/u.test(app), 'Settings を開いたときの位置');
});
