import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { actionKey, actorKey, BOOK_TAB_KEY, canUndo, MEMORY_TABS, memoryRef, originKey, roleKey, TAB_KEY } from '../web/src/memory-page.ts';
import { usageFraction, usageIsHigh } from '../web/src/usage.ts';

test('使用量: 0〜1 に収め、上限が 0 以下なら 0', () => {
  assert.equal(usageFraction(0, 100), 0);
  assert.equal(usageFraction(50, 100), 0.5);
  assert.equal(usageFraction(150, 100), 1, '上限を超えても 1');
  assert.equal(usageFraction(-5, 100), 0);
  assert.equal(usageFraction(10, 0), 0);
  assert.equal(usageFraction(10, -1), 0);
});

test('使用量: 8 割を「超えた」ときだけ高い（ちょうど 8 割は高くない）', () => {
  assert.equal(usageIsHigh(80, 100), false);
  assert.equal(usageIsHigh(81, 100), true);
  assert.equal(usageIsHigh(100, 100), true);
  assert.equal(usageIsHigh(0, 100), false);
  assert.equal(usageIsHigh(50, 0), false, '上限が 0 なら高いとは言わない');
});

test('記憶の値の読み替え: 出どころ・変更の種類・やった人・発言の役。知らない値は読み替えない', () => {
  assert.equal(originKey('user'), 'memory.origin.user');
  assert.equal(originKey('review'), 'memory.origin.review');
  assert.equal(originKey('beat'), 'memory.origin.beat');
  assert.equal(originKey('something-new'), 'memory.origin.beat', '知らない出どころは beat が会話の中で覚えたものとして扱う');
  assert.deepEqual(['create', 'update', 'forget', 'restore'].map(actionKey), ['memory.action.create', 'memory.action.update', 'memory.action.forget', 'memory.action.restore']);
  assert.equal(actionKey('merge'), undefined);
  assert.deepEqual(['beat', 'user', 'review'].map(actorKey), ['memory.actor.beat', 'memory.actor.user', 'memory.actor.review']);
  assert.equal(actorKey('robot'), undefined);
  assert.deepEqual(['user', 'assistant', 'tool'].map(roleKey), ['memory.role.user', 'memory.role.assistant', 'memory.role.tool']);
  assert.equal(roleKey('system'), undefined);
});

test('取り消せる変更: まだ取り消していない、復元ではないものだけ', () => {
  assert.equal(canUndo({ action: 'create', undone_at: null }), true);
  assert.equal(canUndo({ action: 'update', undone_at: null }), true);
  assert.equal(canUndo({ action: 'forget', undone_at: null }), true);
  assert.equal(canUndo({ action: 'restore', undone_at: null }), false, '復元は取り消せない');
  assert.equal(canUndo({ action: 'create', undone_at: 1_700_000_000_000 }), false, '取り消し済み');
});

test('記憶の呼び名: ユーザーの本は u、メモの本は n', () => {
  assert.equal(memoryRef({ book: 'user', id: 12 }), '[u12]');
  assert.equal(memoryRef({ book: 'notes', id: 3 }), '[n3]');
});

test('切り替え: 3 つ（ユーザーについて・メモと教訓・会話を探す）で、どれにも名前がある', () => {
  assert.deepEqual([...MEMORY_TABS], ['user', 'notes', 'search']);
  assert.deepEqual(Object.keys(TAB_KEY).sort(), [...MEMORY_TABS].sort());
  assert.deepEqual(Object.keys(BOOK_TAB_KEY).sort(), ['notes', 'user']);
  for (const tab of MEMORY_TABS) assert.ok(TAB_KEY[tab] in en, tab);
});

test('辞書: 記憶のページの文字は en にある', () => {
  const keys = Object.keys(en).filter(k => k.startsWith('memory.'));
  assert.ok(keys.length >= 13, `${keys.length} 件しか読めていない`);
  for (const key of ['memory.origin.user', 'memory.origin.review', 'memory.origin.beat', 'memory.action.create', 'memory.actor.user', 'memory.role.tool']) {
    assert.ok(key in en, key);
  }
});

