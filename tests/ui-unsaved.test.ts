import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import type { WorkerStatus } from '../web/src/api.ts';
import { escStops } from '../web/src/ui/composer-state.ts';
import { workerLine } from '../web/src/ui/overview.ts';
import { mergeRawConfig } from '../web/src/ui/settings/commit.ts';
import { modelReach, providerReach } from '../web/src/ui/settings/view.ts';
import { clearUnsaved, discardGate, followLeave, hasUnsavedEdits, historyIndex, holdLeave, leaveAsks, leaveMove, popIndex, SCREEN_EDITS, setUnsaved, settingsLeaveAsks, SETTINGS_EDITS, unloadGuard } from '../web/src/ui/unsaved.ts';

// 1-6 の前の突き合わせで見つけた「黙って失う・行き止まりになる」所の決まり（前の画面にあった動きを新しい画面に戻したもの）。

type Json = Record<string, any>;

test('設定ファイルの直接編集: 触った項目だけを最新の設定へ当てる。そのあいだに別の所で変わった項目は戻さない', () => {
  const loaded = defaultConfig() as Json;
  const edited = structuredClone(loaded);
  edited.server.port = 4999;
  const latest = structuredClone(loaded);
  latest.worker.maxRunsPerHour = 77;
  const merged = mergeRawConfig(loaded, edited, latest);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.config.server.port, 4999, '触った項目は入る');
  assert.equal(merged.config.worker.maxRunsPerHour, 77, '別の所で保存された変更は残る（開いたときの全文で書き戻さない）');
});

test('設定ファイルの直接編集: 同じ項目が別の所でも変わっていたら、ぶつかりとして返す（呼ぶ側は保存しない）', () => {
  const loaded = defaultConfig() as Json;
  const edited = structuredClone(loaded);
  edited.server.port = 4999;
  const latest = structuredClone(loaded);
  latest.server.port = 4888;
  assert.deepEqual(mergeRawConfig(loaded, edited, latest).conflicts, ['server.port']);
  const same = structuredClone(loaded);
  same.server.port = 4999;
  assert.deepEqual(mergeRawConfig(loaded, edited, same).conflicts, [], '最新がもう同じ値なら、ぶつかりではない');
});

test('書きかけの記録: 画面の書きかけがあるあいだ、別の画面へ動く前に聞く。Settings を重ねるだけ・同じ経路なら聞かない', () => {
  clearUnsaved('');
  assert.equal(hasUnsavedEdits(), false);
  setUnsaved(`${SCREEN_EDITS}skill:notes`, true);
  setUnsaved('settings:persona:soul', true);
  assert.equal(hasUnsavedEdits(SCREEN_EDITS), true);
  const here = { view: 'skills', target: { kind: 'skill', name: 'notes' } } as const;
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, { view: 'skills' }), true, '行を閉じる');
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, { view: 'skills', target: { kind: 'skill', name: 'other' } }), true, '別の行を開く');
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, { view: 'kanban' }), true, '別の画面へ');
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, { view: 'settings' }), false, 'Settings は上に重なるだけ');
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, here), false);
  setUnsaved(`${SCREEN_EDITS}skill:notes`, false);
  assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS), here, { view: 'kanban' }), false, '書きかけが無ければ聞かない');
  assert.equal(hasUnsavedEdits(), true, 'Settings の書きかけは残っている');
  clearUnsaved('settings:');
  assert.equal(hasUnsavedEdits(), false);
});

test('書きかけの記録: タブを閉じる・読み直すとき、書きかけ（スキル・SOUL.md・USER.md・設定ファイル）があれば止める', () => {
  clearUnsaved('');
  const event = () => { const e = { prevented: false, returnValue: undefined as unknown, preventDefault() { e.prevented = true; } }; return e; };
  const idle = event();
  unloadGuard(idle);
  assert.equal(idle.prevented, false);
  for (const key of [`${SCREEN_EDITS}skill:notes`, `${SCREEN_EDITS}skill-new`, 'settings:persona:soul', 'settings:adv:file']) {
    setUnsaved(key, true);
    const e = event();
    unloadGuard(e);
    assert.deepEqual([e.prevented, e.returnValue], [true, ''], key);
    setUnsaved(key, false);
  }
});

test('入力欄の Esc: 返事を作っている最中だけ止める。メニューが開いている・変換中・動いていないときは止めない', () => {
  assert.equal(escStops({ key: 'Escape', composing: false }, true, false), true);
  assert.equal(escStops({ key: 'Escape', composing: false }, false, false), false);
  assert.equal(escStops({ key: 'Escape', composing: false }, true, true), false);
  assert.equal(escStops({ key: 'Escape', composing: true }, true, false), false);
  assert.equal(escStops({ key: 'Enter', composing: false }, true, false), false);
});

test('Overview の裏の係の 1 行: この 1 時間の実行数と上限、次に起きる時刻（止めている・動いている・係が off のときは時刻を出さない）', () => {
  const worker = (patch: Partial<WorkerStatus> = {}): WorkerStatus => ({
    enabled: true, autonomy: false, paused: false, quiet: false, running: null, runningAll: [], maxParallel: 1, nextWakeAt: 5000, runsLastHour: 3, maxRunsPerHour: 20, ...patch,
  });
  assert.deepEqual(workerLine(worker(), 1000), { runs: 3, max: 20, nextWakeAt: 5000 });
  assert.deepEqual(workerLine(worker(), 9000), { runs: 3, max: 20, nextWakeAt: 9000 }, '過ぎた時刻は今として出す');
  assert.equal(workerLine(worker({ paused: true }), 1000)?.nextWakeAt, null);
  assert.equal(workerLine(worker({ nextWakeAt: null }), 1000)?.nextWakeAt, null);
  assert.equal(workerLine(worker({ runningAll: [{ runId: 'r', kind: 'review', taskId: null, title: null } as unknown as WorkerStatus['runningAll'][number]] }), 1000)?.nextWakeAt, null);
  assert.equal(workerLine(worker({ enabled: false }), 1000), null);
  assert.equal(workerLine(null, 1000), null);
});

test('モデルの確かめの札: 小さすぎるモデルは Reachable と出さない（提供元は届いているので、提供元の札は届いているまま）', () => {
  assert.equal(modelReach('too_small'), 'small');
  assert.equal(modelReach('ok'), 'ok');
  assert.equal(modelReach('unreachable'), 'warn');
  assert.equal(modelReach('no_api_key'), 'danger');
  assert.equal(modelReach('from-the-future'), 'danger');
  const model = (status: string) => ({ id: 'm', provider: 'p', probe: { status } }) as never;
  assert.equal(providerReach('p', [model('too_small')]), 'ok');
});

test('設定ファイルの直接編集: ぶつかりがあるときは、どの項目も当てずに最新の設定をそのまま返す（何も書かない）', () => {
  const loaded = defaultConfig() as Json;
  const edited = structuredClone(loaded);
  edited.server.port = 4999;
  edited.worker.maxRunsPerHour = 55;
  const latest = structuredClone(loaded);
  latest.server.port = 4888;
  const merged = mergeRawConfig(loaded, edited, latest);
  assert.deepEqual(merged.conflicts, ['server.port']);
  assert.deepEqual(merged.config, latest);
});

function fakeHistory(entries: string[], index: number) {
  const h = {
    entries, index, missed: 0,
    go(by: number) { const to = h.index + by; if (to >= 0 && to < h.entries.length) h.index = to; else h.missed += 1; },
    replace(hash: string) { h.entries[h.index] = hash; },
    push(hash: string) { h.entries.splice(h.index + 1, Infinity, hash); h.index += 1; },
  };
  return h;
}

test('書きかけの確かめ: ブラウザの「戻る」で出たとき、戻った先の履歴を今の画面で上書きしない（元の位置へ戻すだけ。Discard で同じ所へ行き直す）', () => {
  const back = fakeHistory(['#/kanban', '#/skills/notes'], 1);
  back.go(-1);
  const moved = leaveMove(1, historyIndex({ currentEntry: { index: back.index } }));
  assert.equal(moved, -1);
  holdLeave(moved, '#/skills/notes', back);
  assert.deepEqual([back.entries, back.index], [['#/kanban', '#/skills/notes'], 1], '戻る先（#/kanban）は消えない');
  followLeave({ to: '#/kanban', moved, at: 1 }, back.index, back);
  assert.deepEqual([back.entries, back.index, back.missed], [['#/kanban', '#/skills/notes'], 0, 0], 'Discard は「戻る」をやり直す（履歴を足さない）');

  const link = fakeHistory(['#/kanban', '#/skills/notes'], 1);
  link.push('#/memory');
  const forward = leaveMove(1, link.index);
  holdLeave(forward, '#/skills/notes', link);
  assert.deepEqual([link.entries, link.index], [['#/kanban', '#/skills/notes', '#/memory'], 1], 'リンクで動いたときも、書きかけの画面の履歴を 2 つにしない');
  followLeave({ to: '#/memory', moved: forward, at: 1 }, link.index, link);
  assert.deepEqual([link.entries, link.index, link.missed], [['#/kanban', '#/skills/notes', '#/memory'], 2, 0]);

  const swapped = fakeHistory(['#/kanban', '#/memory'], 1);
  holdLeave(leaveMove(1, 1), '#/skills/notes', swapped);
  assert.deepEqual(swapped.entries, ['#/kanban', '#/skills/notes'], '同じ位置で置き換わった（location.replace）ときは、その場で元へ置き換える');

  const old = fakeHistory(['#/kanban', '#/skills/notes'], 0);
  assert.equal(leaveMove(1, historyIndex(undefined)), null, '履歴の位置が分からないブラウザ');
  holdLeave(null, '#/skills/notes', old);
  assert.deepEqual(old.entries, ['#/skills/notes', '#/skills/notes'], '位置が分からなければ、前と同じく置き換える');
  followLeave({ to: '#/kanban', moved: null, at: null }, null, old);
  assert.equal(old.entries[old.index], '#/kanban');
  assert.equal(historyIndex({ currentEntry: null }), null);
  assert.equal(historyIndex({ currentEntry: { index: -1 } }), null);
});

test('書きかけの確かめ（画面の中）: 書きかけがあるときは、閉じる・別の行を開く前に聞く。Discard でその操作を続け、Keep では何もしない', () => {
  const asked: boolean[] = [];
  const ran: string[] = [];
  const gate = discardGate(on => asked.push(on));
  assert.equal(gate.attempt(false, () => ran.push('close')), true, '書きかけが無ければそのまま進む');
  assert.deepEqual([ran, asked], [['close'], []]);

  assert.equal(gate.attempt(true, () => ran.push('open other row')), false);
  assert.deepEqual([ran, asked], [['close'], [true]], '書きかけがあれば、進まずに聞く');
  gate.keep();
  assert.deepEqual([ran, asked], [['close'], [true, false]], 'Keep: 書きかけはそのまま');
  gate.confirm();
  assert.deepEqual(ran, ['close'], 'Keep のあとに Discard が来ても、前の操作は走らない');

  gate.attempt(true, () => ran.push('cancel'));
  gate.attempt(true, () => ran.push('new'));
  gate.confirm();
  assert.deepEqual(ran, ['close', 'new'], 'Discard: 最後に頼んだ操作だけを続ける');
  assert.equal(asked.at(-1), false);
});

test('書きかけの確かめ: 確かめが出ているあいだに Settings を開いて履歴が変わっても、Discard は必ず行き先へ着く（古い「動いた分」を信じない）', () => {
  const link = fakeHistory(['#/kanban', '#/memory'], 1);
  link.push('#/overview');
  const forward = leaveMove(1, link.index);
  holdLeave(forward, '#/memory', link);
  link.push('#/settings');
  assert.deepEqual(link.entries, ['#/kanban', '#/memory', '#/settings'], 'Settings を開くと、先の履歴（#/overview）は切られる');
  followLeave({ to: '#/overview', moved: forward, at: 1 }, link.index, link);
  assert.deepEqual([link.entries[link.index], link.missed], ['#/overview', 0], 'リンクで動いた分は、いつも行き先を足して着く');

  const back = fakeHistory(['#/kanban', '#/memory'], 1);
  back.go(-1);
  const moved = leaveMove(1, back.index);
  holdLeave(moved, '#/memory', back);
  back.push('#/settings');
  followLeave({ to: '#/kanban', moved, at: 1 }, back.index, back);
  assert.deepEqual([back.entries, back.index, back.missed], [['#/kanban', '#/memory', '#/settings', '#/kanban'], 3, 0], '「戻る」で出たあと位置が変わっていたら、行き先を足して着く（書きかけの画面に残らない）');
});

test('書きかけの確かめ: 同じ経路どうしの履歴を行き来しても（hashchange が出ない）、覚えている履歴の位置を合わせ直す', () => {
  assert.equal(popIndex(2, '#/memory', '#/memory', 0), 0, '同じ経路の別の履歴へ動いた');
  assert.equal(popIndex(2, '#/memory', '#/kanban', 1), 2, '経路が変わる動きは hashchange の側で決める（ここでは変えない）');
  assert.equal(popIndex(2, '#/memory', '#/memory', null), null);
});

test('書きかけの確かめ: App は、動きを受け入れるたびに履歴の位置と経路を一緒に覚え直す（経路を覚え忘れると、同じ経路どうしの行き来で位置がずれる）', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /entryIndex\.current = historyIndex\(\);\s*entryHash\.current = location\.hash;/u);
  assert.match(app, /popIndex\(entryIndex\.current, entryHash\.current, location\.hash, historyIndex\(\)\)/u);
});

test('設定ファイルの直接編集: モデルの並びだけを変えて保存すると、その並びが書かれる（何も書かずに "Saved" と出さない。backlog 265）', () => {
  const loaded = defaultConfig() as Json;
  loaded.providers = [{ id: 'a', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1' }, { id: 'b', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1' }];
  const edited = structuredClone(loaded);
  edited.providers.reverse();
  const merged = mergeRawConfig(loaded, edited, structuredClone(loaded));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.config.providers.map((p: Json) => p.id), ['b', 'a']);
});

test('Settings の書きかけ: ブラウザの戻るなどで Settings の外へ動くときも聞く。Settings の中の区分の行き来では聞かない（backlog 194）', () => {
  clearUnsaved('');
  assert.equal(settingsLeaveAsks(hasUnsavedEdits(SETTINGS_EDITS), 'settings', { view: 'kanban' }), false, '書きかけが無ければ聞かない');
  setUnsaved(`${SETTINGS_EDITS}adv:file`, true);
  assert.equal(settingsLeaveAsks(hasUnsavedEdits(SETTINGS_EDITS), 'settings', { view: 'kanban' }), true, 'Settings の外へ');
  assert.equal(settingsLeaveAsks(hasUnsavedEdits(SETTINGS_EDITS), 'settings', { view: 'settings', section: 'models' }), false, '区分の行き来は Settings の確かめが受け持つ');
  assert.equal(settingsLeaveAsks(hasUnsavedEdits(SETTINGS_EDITS), 'kanban', { view: 'skills' }), false, 'Settings を開いていないとき');
  clearUnsaved(SETTINGS_EDITS);
});

test('Settings の書きかけの配線: App は Settings の外へ動く前に戻して確かめを Settings に渡し、Replay と設定ファイルの欄の Close も確かめを通す（backlog 194）', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  const onHash = app.slice(app.indexOf('const onHash = () => {'), app.indexOf("addEventListener('hashchange', onHash);"));
  assert.ok(onHash.includes('if (settingsLeaveAsks(hasUnsavedEdits(SETTINGS_EDITS), viewRef.current, next)) {'), 'Settings の書きかけを見る');
  assert.ok(onHash.indexOf('holdLeave(moved, entryHash.current, LEAVE_ENV);') > onHash.indexOf('settingsLeaveAsks('), 'Settings の経路へ戻す');
  assert.ok(app.includes('held={settingsHeld}'), '確かめは Settings の帯で出す');
  const page = readFileSync(new URL('../web/src/ui/settings/Settings.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('useEffect(() => { if (held) setLeave(() => held); }, [held]);'), 'Settings は渡された動きを帯で聞く');
  assert.ok(page.includes('<PersonaPanel onReplay={() => guard(onReplay)} />'), 'Replay も確かめを通す');
  const custom = readFileSync(new URL('../web/src/ui/settings/customize.tsx', import.meta.url), 'utf8');
  assert.ok(custom.includes("onClick={() => ctx.guard(() => { setText(null); ctx.cancel(); })}>{t('ui.close')}"), '設定ファイルの欄の Close も確かめを通す');
});
