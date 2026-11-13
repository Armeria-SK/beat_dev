import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import type { WorkerStatus } from '../web/src/api.ts';
import { escStops } from '../web/src/ui/composer-state.ts';
import { workerLine } from '../web/src/ui/overview.ts';
import { mergeRawConfig } from '../web/src/ui/settings/commit.ts';
import { modelReach, providerReach } from '../web/src/ui/settings/view.ts';
import { clearUnsaved, hasUnsavedEdits, leaveAsks, SCREEN_EDITS, setUnsaved, unloadGuard } from '../web/src/ui/unsaved.ts';

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
