import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEvent } from '../web/src/events.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';

// backlog（#268 の審査の残り (5)）: Build の Checklist が更新されるたびに、会話を丸ごと読み直さない。
// 会話の画面（Conversation.tsx）は revision（revisions の数 + epoch）が進んだときだけ会話を取り直すので、
// Checklist の更新の知らせではこれを進めず、知らせに載った表だけを checklists に入れる。
// 直し自体は main の 4da09c06 で入っている（画面ごとの確かめは tests/bl-web3-build-checklist-app-dom.test.ts）。ここではその決まりを固定する。

const items = [{ text: 'Read the plan', status: 'done' as const }, { text: 'Write the parser', status: 'in_progress' as const }];
const updated = (conversationId: string): RunEvent => ({ type: 'checklist.updated', runId: 'r1', conversationId, items, tainted: false });

test('bl-early checklist: 更新の知らせは会話の取り直し（revisions・epoch）を進めず、取得の作用も出さない', () => {
  for (const conversationId of ['tc1', 'c1']) {
    const { state, effects } = reduce(EMPTY, { type: 'event', event: updated(conversationId), hidden: false });
    assert.deepEqual(effects, [], '会話・Checklist の取得は起きない');
    assert.equal(state.revisions.get(conversationId), undefined, '会話の revision は進まない');
    assert.equal(state.epoch, EMPTY.epoch);
    assert.deepEqual(state.checklists.get(conversationId), items, '知らせに載った表で欄を直す');
  }
});

test('bl-early checklist: 再接続（resync）では今までどおり全部を読み直す（知らせだけでずれた場面を戻す）', () => {
  const { state, effects } = reduce(EMPTY, { type: 'resync', drafts: [] });
  assert.equal(state.epoch, EMPTY.epoch + 1, 'epoch が進み、会話の画面は取り直す');
  assert.ok(effects.some(e => e.kind === 'refresh' && e.what === 'conversations'));
});
