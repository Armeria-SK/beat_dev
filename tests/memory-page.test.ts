import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRef } from '../web/src/memory-page.ts';

test('記憶の呼び名: ユーザーの本は u、メモの本は n', () => {
  assert.equal(memoryRef({ book: 'user', id: 12 }), '[u12]');
  assert.equal(memoryRef({ book: 'notes', id: 3 }), '[n3]');
});

