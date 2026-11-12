import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, PlanDoc } from '../web/src/api.ts';
import { canEdit, canSave, editedBy, keptDraft, PLAN_EDITS, planDirty, planState, runningIn, saveOutcome } from '../web/src/ui/plan.ts';

// Plan の欄（beat 3-1a-u）。画面を持たない決まり: 状態の決め方・書きかけ・保存の結果（web/src/ui/plan.ts）。

const doc = (over: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# Plan\n\nStep one.', hash: 'h1', updated_at: 1000, updated_by: 'ai', tainted: false, writing: false, ...over });

test('ui/plan: 状態は 読み込み中 / 計画書が無い / 書いている最中 / 読める / 読めない', () => {
  assert.equal(planState(null, false), 'loading');
  assert.equal(planState(null, true), 'failed');
  assert.equal(planState(doc({ content: null, hash: null }), false), 'empty');
  assert.equal(planState(doc({ content: '' }), false), 'empty', '空の文書は無いのと同じ');
  assert.equal(planState(doc({ writing: true }), false), 'writing');
  assert.equal(planState(doc({ content: null, writing: true }), false), 'writing', 'まだ 1 字も無くても、計画モードの会話が動いていれば書いている最中');
  assert.equal(planState(doc(), false), 'ready');
});

test('ui/plan: 直せるのは 読める・無い のときだけ。Save は書きかけがあり、書いている最中でも保存中でもないときだけ押せる', () => {
  assert.equal(canEdit('ready'), true);
  assert.equal(canEdit('empty'), true, '持ち主が手で計画書を書き始められる');
  assert.equal(canEdit('writing'), false);
  assert.equal(canEdit('loading'), false);
  assert.equal(canEdit('failed'), false);
  assert.equal(canSave('ready', true, false), true);
  assert.equal(canSave('ready', false, false), false);
  assert.equal(canSave('ready', true, true), false);
  assert.equal(canSave('writing', true, false), false);
  assert.equal(canSave('empty', true, false), true);
});

test('ui/plan: 書きかけは、読んだ本文と違うときだけ', () => {
  assert.equal(planDirty(null, doc()), false);
  assert.equal(planDirty('# Plan\n\nStep one.', doc()), false);
  assert.equal(planDirty('# Plan\n\nStep two.', doc()), true);
  assert.equal(planDirty('', doc({ content: null })), false);
  assert.equal(planDirty('x', doc({ content: null })), true);
  assert.equal(planDirty('x', null), true);
});

test('ui/plan: 保存の結果: 409 は「その間に変わった」（書きかけは残す）、ほかは失敗', () => {
  assert.equal(saveOutcome({ status: 409 }), 'changed');
  assert.equal(saveOutcome({ status: 400 }), 'failed');
  assert.equal(saveOutcome(new Error('x')), 'failed');
});

test('ui/plan: 最後に直した人の言葉: owner → you、ai → beat、outside → outside', () => {
  assert.equal(editedBy(doc({ updated_by: 'owner' })), 'ui.plan.byYou');
  assert.equal(editedBy(doc({ updated_by: 'ai' })), 'ui.plan.byAi');
  assert.equal(editedBy(doc({ updated_by: 'outside' })), 'ui.plan.byOutside');
  assert.equal(editedBy(doc({ updated_by: null })), null);
});

test('ui/plan: 欄を閉じても書きかけは残る。書きかけの記録が消えていれば（Discard を押した）、残した文も捨てる', () => {
  assert.equal(PLAN_EDITS.startsWith('screen:'), true, '別の画面へ行くときの確かめに乗る');
  const kept = { text: 'draft', base: 'h1' };
  assert.deepEqual(keptDraft(kept, true), kept, '書き始めたときの版（baseHash）も一緒に残す。あとから AI が書いても、保存は 409 になる');
  assert.equal(keptDraft(kept, false), null);
  assert.equal(keptDraft(undefined, true), null);
});

test('ui/plan: その製品の会話で動いている実行の数（変われば欄を読み直す。書いている最中かはサーバーが決める）', () => {
  const conversations = [{ id: 'a', project_id: 'p1' }, { id: 'b', project_id: 'p2' }, { id: 'c' }] as Conversation[];
  const drafts = [{ conversationId: 'a' }, { conversationId: 'b' }, { conversationId: 'c' }, { conversationId: 'unknown' }];
  assert.equal(runningIn(drafts, conversations, 'p1'), 1);
  assert.equal(runningIn(drafts, conversations, 'p3'), 0);
});
