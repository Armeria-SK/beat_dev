import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONVERSATION_MIN, closePane, fitLayout, GUTTER, maxPanes, openable, PANE_DEFAULT, PANE_MIN, PANES, panesWidth, parseLayout, resizePane, selectView, showSplit, tabOrder, togglePanes,
  visiblePanes, type PaneLayout,
} from '../web/src/ui/panes.ts';

// 会話の右の欄（beat 3-1a-u）。画面を持たない決まり: 開ける欄・開く・閉じる・並び・幅の範囲・覚えた形の読み方（web/src/ui/panes.ts）。

const product = { productId: 'p1' };
const loose = { productId: null };

test('ui/panes: 欄の表は、あとの段が 1 行ずつ足せる形（名前・数を持つか・開ける条件）。この段は Plan だけで、製品の会話でだけ開ける', () => {
  assert.deepEqual(PANES.map(p => p.view), ['plan']);
  assert.equal(PANES[0]!.counted, false, 'Plan は数を持たない（数は Questions・Kanban・Pending だけ）');
  assert.deepEqual(openable(product), ['plan']);
  assert.deepEqual(openable(loose), [], '製品に属さない会話には開ける欄が無い（Panes のボタンを出さない）');
});

test('ui/panes: タブの並びはデザインの順。狭い幅では Questions・Kanban・Pending・Notifications を先に', () => {
  assert.deepEqual(tabOrder(['browser', 'kanban', 'plan', 'questions'], false), ['plan', 'questions', 'kanban', 'browser']);
  assert.deepEqual(tabOrder(['browser', 'plan', 'notifications', 'pending', 'kanban', 'questions'], true), ['questions', 'kanban', 'pending', 'notifications', 'plan', 'browser']);
  assert.deepEqual(tabOrder(['plan'], true), ['plan']);
});

test('ui/panes: Panes のボタンは、見えている欄が無ければ最初の開ける欄を開き、あれば全部閉じる。開ける欄が無ければ何もしない', () => {
  assert.deepEqual(togglePanes([], ['plan']), [{ view: 'plan', width: PANE_DEFAULT }]);
  assert.deepEqual(togglePanes([{ view: 'plan', width: 420 }], ['plan']), []);
  assert.deepEqual(togglePanes([], []), []);
});

test('ui/panes: 閉じる・タブを替えると、その欄だけが変わる', () => {
  const two = [{ view: 'plan', width: 400 }, { view: 'plan', width: 350 }] as PaneLayout;
  assert.deepEqual(closePane(two, 0), [{ view: 'plan', width: 350 }]);
  assert.deepEqual(closePane(two, 5), two, '無い番号は何もしない');
  assert.deepEqual(selectView(two, 1, 'plan'), two);
});

test('ui/panes: 見えるのは、今の会話で開ける欄だけ（覚えた形は消さない）', () => {
  const layout = [{ view: 'plan', width: 400 }] as PaneLayout;
  assert.deepEqual(visiblePanes(layout, ['plan']), layout);
  assert.deepEqual(visiblePanes(layout, []), []);
});

test('ui/panes: 欄の数は、会話 340px・欄 300px（と溝）が収まるまで。Split は開けるタブが 2 つ以上で、もう 1 枚収まるときだけ', () => {
  assert.equal(maxPanes(CONVERSATION_MIN + PANE_MIN + GUTTER * 2), 1);
  assert.equal(maxPanes(CONVERSATION_MIN + PANE_MIN + GUTTER * 2 - 1), 0);
  assert.equal(maxPanes(CONVERSATION_MIN + (PANE_MIN + GUTTER) * 3 + GUTTER), 3);
  const one = [{ view: 'plan', width: 400 }] as PaneLayout;
  assert.equal(showSplit(['plan'], one, 3000), false, 'Plan だけでは Split を出さない');
  assert.equal(showSplit(['plan', 'pending'] as never, one, 3000), true);
  assert.equal(showSplit(['plan', 'pending'] as never, one, CONVERSATION_MIN + PANE_MIN * 2 + GUTTER * 2), false, 'もう 1 枚は収まらない');
});

test('ui/panes: 幅を合わせる: 会話が 340px を切らないよう欄を縮め、300px より狭くはしない。収まらない欄は後ろから見せない', () => {
  const room = 1152;
  assert.deepEqual(fitLayout([{ view: 'plan', width: 400 }], room), [{ view: 'plan', width: 400 }]);
  const wide = fitLayout([{ view: 'plan', width: 2000 }], room);
  assert.equal(wide[0]!.width, room - CONVERSATION_MIN - GUTTER * 2);
  const three = fitLayout([{ view: 'plan', width: 500 }, { view: 'plan', width: 500 }, { view: 'plan', width: 500 }] as PaneLayout, room);
  assert.deepEqual(three.map(p => p.width), [488, PANE_MIN], '後ろの欄から縮め、足りた所で止める');
  assert.ok(three.every(p => p.width >= PANE_MIN));
  assert.ok(CONVERSATION_MIN + panesWidth(three) <= room, 'conversation keeps 340px');
  assert.deepEqual(fitLayout([{ view: 'plan', width: 400 }], 500), [], '1 枚も収まらない');
});

test('ui/panes: つまみ: 最初の欄の左は会話との境（左へ動かすと欄が広がる）。欄のあいだは隣と幅を分け合う。どちらも範囲の外へは出ない', () => {
  const room = 1152;
  const one = [{ view: 'plan', width: 400 }] as PaneLayout;
  assert.equal(resizePane(one, 0, -50, room)[0]!.width, 450);
  assert.equal(resizePane(one, 0, 50, room)[0]!.width, 350);
  assert.equal(resizePane(one, 0, 500, room)[0]!.width, PANE_MIN, '300px より狭くならない');
  assert.equal(resizePane(one, 0, -5000, room)[0]!.width, room - CONVERSATION_MIN - GUTTER * 2, '会話が 340px を切らない');
  const two = [{ view: 'plan', width: 400 }, { view: 'plan', width: 350 }] as PaneLayout;
  assert.deepEqual(resizePane(two, 1, 30, room).map(p => p.width), [430, 320]);
  assert.deepEqual(resizePane(two, 1, 200, room).map(p => p.width), [400 + 50, PANE_MIN], '隣を 300px より狭くしない');
  assert.deepEqual(resizePane(two, 1, -200, room).map(p => p.width), [PANE_MIN, 350 + 100]);
});

test('ui/panes: 欄の列の幅は、欄の幅と、各欄の左の溝と右の余白の合計', () => {
  assert.equal(panesWidth([]), 0);
  assert.equal(panesWidth([{ view: 'plan', width: 400 }]), 400 + GUTTER * 2);
  assert.equal(panesWidth([{ view: 'plan', width: 400 }, { view: 'plan', width: 300 }] as PaneLayout), 700 + GUTTER * 3);
});

test('ui/panes: 覚えた形の読み方: 壊れた・知らない値は捨て、幅は 300px 以上の整数にする', () => {
  assert.deepEqual(parseLayout(null), []);
  assert.deepEqual(parseLayout('not json'), []);
  assert.deepEqual(parseLayout('{"view":"plan"}'), []);
  assert.deepEqual(parseLayout('[{"view":"plan","width":420.6},{"view":"nope","width":400},{"view":"plan","width":"x"},{"view":"plan","width":10}]'), [{ view: 'plan', width: 421 }, { view: 'plan', width: PANE_MIN }]);
});
