import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { actionKey, actorKey, BOOK_TAB_KEY, memoryRef, originKey, roleKey, TAB_KEY } from '../web/src/memory-page.ts';

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

test('記憶の呼び名: ユーザーの本は u、メモの本は n', () => {
  assert.equal(memoryRef({ book: 'user', id: 12 }), '[u12]');
  assert.equal(memoryRef({ book: 'notes', id: 3 }), '[n3]');
});

test('切り替え: 3 つ（ユーザーについて・メモと教訓・会話を探す）で、どれにも名前がある', () => {
  assert.deepEqual(Object.keys(TAB_KEY).sort(), ['notes', 'search', 'user']);
  assert.deepEqual(Object.keys(BOOK_TAB_KEY).sort(), ['notes', 'user']);
  for (const key of Object.values(TAB_KEY)) assert.ok(key in en, key);
});

test('辞書: 記憶のページの文字は en にある', () => {
  const keys = Object.keys(en).filter(k => k.startsWith('memory.'));
  assert.ok(keys.length >= 13, `${keys.length} 件しか読めていない`);
  for (const key of ['memory.origin.user', 'memory.origin.review', 'memory.origin.beat', 'memory.action.create', 'memory.actor.user', 'memory.role.tool']) {
    assert.ok(key in en, key);
  }
});

