import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, MemoryFileEvent } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';
import { lineDelta, noteStamp, noteVersions, splitNote, undoTargetOf } from '../web/src/ui/memory-notes.ts';
import { memoryHash } from '../web/src/ui/product-nav.ts';
import { parseRoute } from '../web/src/ui/routes.ts';

// beat 10-4a: Memory の画面の関数・経路・会話の Notice
const event = (id: number, action: MemoryFileEvent['action'], before: string | null, after: string | null, actor: MemoryFileEvent['actor'] = 'beat'): MemoryFileEvent =>
  ({ id, action, actor, summary: null, tainted: false, before, after, created_at: id });

test('memory-notes: splitNote は「# 題」の 1 行目で題と本文に分け、無ければ題は名前で本文は全部', () => {
  assert.deepEqual(splitNote('# Test order\n\nRun A, then B.\n', 'test-order'), { title: 'Test order', body: 'Run A, then B.' });
  assert.deepEqual(splitNote('Written by hand\nsecond line\n', 'hand'), { title: 'hand', body: 'Written by hand\nsecond line' });
});

test('memory-notes: noteStamp は持ち主（と履歴の無いファイル）を edited by you、beat と振り返りを saved by beat にする', () => {
  assert.deepEqual(noteStamp({ updatedBy: 'owner', mtime: 5 }), { who: 'you', edited: true, at: 5 });
  assert.deepEqual(noteStamp({ updatedBy: null, mtime: 5 }), { who: 'you', edited: true, at: 5 });
  assert.deepEqual(noteStamp({ updatedBy: 'beat', mtime: 5 }), { who: 'beat', edited: false, at: 5 });
  assert.deepEqual(noteStamp({ updatedBy: 'review', mtime: 5 }), { who: 'beat', edited: false, at: 5 });
});

test('memory-notes: lineDelta は足した行と消した行を数える（空の行は数えない）', () => {
  assert.deepEqual(lineDelta(null, '# A\n\nx\n'), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta('# A\n\nx\ny\n', '# A\n\nx\nz\n'), { added: 1, removed: 1 });
  assert.equal(en['ui.memory.lines'](1, 1), '+1 −1');
  assert.equal(en['ui.memory.lines'](0, 2), '−2');
});

test('memory-notes: noteVersions は中身を変えたいちばん新しい版に Undo（前の版へ / 作っただけなら消す）、今と違う古い版に Restore。印を外した行・消した行には何も出さない', () => {
  const history = [event(4, 'reviewed', 'b', 'b', 'owner'), event(3, 'update', 'a', 'b'), event(2, 'forget', 'a', null), event(1, 'create', null, 'a')];
  const versions = noteVersions(history, 'b');
  assert.deepEqual(versions.map(v => v.action), [null, 'undo', null, 'restore']);
  assert.deepEqual(versions[1]!.undo, { kind: 'restore', eventId: 1 });
  assert.deepEqual(noteVersions([event(1, 'create', null, 'a')], 'a')[0]!.undo, { kind: 'delete' });
  assert.deepEqual(noteVersions([event(3, 'update', 'b', 'a'), event(2, 'update', 'a', 'b'), event(1, 'create', null, 'a')], 'a').map(v => v.action), ['undo', 'restore', null], '今と同じ中身の古い版には Restore を出さない');
  assert.deepEqual(noteVersions([event(2, 'update', 'a', 'b'), event(1, 'create', null, 'a')], 'c').map(v => v.action), ['restore', 'restore'], '外で直されて今と違うなら Undo を出さない');
  assert.equal(undoTargetOf([event(2, 'update', 'zz', 'b'), event(1, 'create', null, 'a')], 0), undefined, '前の版が見つからなければ戻し先は無い');
});

test('経路と左の Memory: #/memory/<製品> を読み、製品の画面・製品の会話・その製品の Memory からはその製品へ、ほかは選ぶ一覧へ', () => {
  assert.deepEqual(parseRoute('#/memory/p1aaaa'), { view: 'memory', productId: 'p1aaaa' });
  assert.deepEqual(parseRoute('#/memory/..'), { view: 'memory' });
  const conversations = [{ id: 'c1', project_id: 'p1aaaa' }, { id: 'c2', project_id: null }] as unknown as Conversation[];
  assert.equal(memoryHash({ view: 'product', id: 'p1aaaa' }, conversations), '#/memory/p1aaaa');
  assert.equal(memoryHash({ view: 'chat', id: 'c1' }, conversations), '#/memory/p1aaaa');
  assert.equal(memoryHash({ view: 'memory', productId: 'p1aaaa' }, conversations), '#/memory/p1aaaa');
  assert.equal(memoryHash({ view: 'chat', id: 'c2' }, conversations), '#/memory');
  assert.equal(memoryHash({ view: 'overview' }, conversations), '#/memory');
});

test('ui/live-state: memoryFile.changed は会話の中なら Notice（Memory saved · Undo の元）を足し、持ち主の画面から（会話なし）や印を外したときは Library を読み直すだけ', () => {
  const ev = (conversationId: string, action: 'create' | 'reviewed') => ({ type: 'event' as const, event: { type: 'memoryFile.changed' as const, runId: 'r', conversationId, projectId: 'p1aaaa', name: 'test-order', action, eventId: 7 }, hidden: false, now: 1 });
  const inChat = reduce(EMPTY, ev('c1', 'create')).state;
  assert.deepEqual(inChat.notices.get('c1'), [{ runId: 'r', kind: 'memoryNote', action: 'create', projectId: 'p1aaaa', name: 'test-order', eventId: 7 }]);
  assert.equal(inChat.libraryRevision, 1);
  const owner = reduce(EMPTY, ev('', 'create')).state;
  assert.equal(owner.notices.size, 0);
  assert.equal(owner.libraryRevision, 1);
  assert.equal(reduce(EMPTY, ev('c1', 'reviewed')).state.notices.size, 0);
  assert.equal(en['ui.notice.memoryNoteCreate']('memory/test-order.md'), 'Memory saved: memory/test-order.md');
});
