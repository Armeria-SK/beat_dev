import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, PlanDoc } from '../web/src/api.ts';
import { apiDetail, canEdit, canSave, editedBy, followDoc, keptDraft, PLAN_EDITS, planDirty, planState, planStays, rebase, reviewButton, reviewClick, reviewSeen, runningIn, saveOutcome, startDraft, typed } from '../web/src/ui/plan.ts';
import { hasUnsavedEdits, SCREEN_EDITS, setUnsaved } from '../web/src/ui/unsaved.ts';

// Plan の欄（beat 3-1a-u）。画面を持たない決まり: 状態の決め方・書きかけ・保存の結果（web/src/ui/plan.ts）。

const doc = (over: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# Plan\n\nStep one.', hash: 'h1', updated_at: 1000, updated_by: 'ai', tainted: false, writing: false, reviewLocked: false, built_hash: null, ...over });

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

test('ui/plan: 書きかけは、直し始めたときの本文と違うときだけ（サーバーの今の本文とは比べない）', () => {
  const start = startDraft(doc());
  assert.deepEqual(start, { text: '# Plan\n\nStep one.', base: 'h1', baseText: '# Plan\n\nStep one.' });
  assert.deepEqual(startDraft(doc({ content: null, hash: null })), { text: '', base: null, baseText: '' });
  assert.deepEqual(startDraft(null), { text: '', base: null, baseText: '' });
  assert.equal(planDirty(null), false);
  assert.equal(planDirty(start), false);
  assert.equal(planDirty({ ...start, text: '# Plan\n\nStep two.' }), true);
});

test('ui/plan: 触っていない書きかけは、AI が計画書を書き換えたら新しい本文と版に替わる。触った書きかけはそのまま（保存は 409 になる）', () => {
  const start = startDraft(doc());
  const newer = doc({ content: '# Plan\n\nStep one.\nStep two.', hash: 'h2' });
  assert.deepEqual(followDoc(start, newer), { text: newer.content, base: 'h2', baseText: newer.content });
  assert.equal(planDirty(followDoc(start, newer)), false, '本文が変わっても書きかけにはならない');
  const typed = { ...start, text: 'mine' };
  assert.deepEqual(followDoc(typed, newer), typed);
  assert.equal(followDoc(start, doc()), start, '同じ版なら替えない');
  assert.equal(followDoc(null, newer), null);
});

test('ui/plan: 打った文は、画面に出ている書きかけ（その版）に載せる。AI の書き換えより先に届いた打鍵は古い版のままなので、保存は 409 になる', () => {
  const shown = startDraft(doc());
  assert.deepEqual(typed(shown, doc({ content: 'newer', hash: 'h2' }), 'mine'), { ...shown, text: 'mine' });
  assert.deepEqual(typed(null, doc(), 'x'), { text: 'x', base: 'h1', baseText: '# Plan\n\nStep one.' }, '書きかけが無ければ、今の版から始める');
});

test('ui/plan: 読めない・保存できない理由は、サーバーの答えのときだけ出す（読めないファイルなど）', () => {
  assert.equal(apiDetail(Object.assign(new Error('plan.md is not a file'), { status: 400 })), 'plan.md is not a file');
  assert.equal(apiDetail(new TypeError('Failed to fetch')), null);
  assert.equal(apiDetail(null), null);
});

test('ui/plan: Reload は新しい版を基にし直し、書きかけの文は残す（そのまま保存すると新しい版を置き換える）', () => {
  const typed = { text: 'mine', base: 'h1', baseText: '# Plan\n\nStep one.' };
  const newer = doc({ content: 'newer', hash: 'h2' });
  assert.deepEqual(rebase(typed, newer), { text: 'mine', base: 'h2', baseText: 'newer', replaces: true }, '印は書きかけと一緒に残り、欄を開き直しても「置き換える」と出し続ける');
  assert.equal(startDraft(doc()).replaces, undefined);
  assert.equal(planDirty(rebase(typed, newer)), true);
  assert.equal(planDirty(rebase({ ...typed, text: 'newer' }, newer)), false, '新しい版と同じ文なら書きかけではない');
});

test('ui/plan: 保存の結果: 409 は「その間に変わった」（書きかけは残す）、ほかは失敗で、サーバーの理由（秘密・長すぎ・しまった製品）をそのまま見せる', () => {
  assert.deepEqual(saveOutcome({ status: 409, message: 'x' }), { kind: 'changed' });
  assert.deepEqual(saveOutcome(Object.assign(new Error('The plan looks like it holds a secret'), { status: 400 })), { kind: 'failed', detail: 'The plan looks like it holds a secret' });
  assert.deepEqual(saveOutcome(new TypeError('Failed to fetch')), { kind: 'failed', detail: null }, 'サーバーの答えでない失敗は理由を出さない');
});

test('ui/plan (R2): 計画の書きかけは会話ごと。同じ会話の中だけ「離れますか」を出さず、同じ製品の別の会話・新しい会話へ移るときは出す', () => {
  assert.equal(planStays({ view: 'chat', id: 'c1' }, { view: 'chat', id: 'c1' }), 'c1');
  assert.equal(planStays({ view: 'chat', id: 'c1' }, { view: 'chat', id: 'c2' }), null, '同じ製品の別の会話には、その会話の計画がある');
  assert.equal(planStays({ view: 'chat', id: 'c1' }, { view: 'productNew', id: 'p1' }), null, '新しい会話の計画は空');
  assert.equal(planStays({ view: 'productNew', id: 'p1' }, { view: 'chat', id: 'fresh' }), null, '新しい会話の画面には計画の書きかけが無い');
  assert.equal(planStays({ view: 'chat', id: 'c1' }, { view: 'kanban' }), null);
  setUnsaved(`${PLAN_EDITS}c1`, true);
  assert.equal(hasUnsavedEdits(SCREEN_EDITS, `${PLAN_EDITS}c1`), false, '持ち越す書きかけは数えない');
  assert.equal(hasUnsavedEdits(SCREEN_EDITS, `${PLAN_EDITS}c10`), true, '名前の頭が同じ別の会話とは区別する');
  setUnsaved(`${PLAN_EDITS}p1`, false);
});

test('ui/plan: 最後に直した人の言葉: owner → you、ai → beat、outside → outside', () => {
  assert.equal(editedBy(doc({ updated_by: 'owner' })), 'ui.plan.byYou');
  assert.equal(editedBy(doc({ updated_by: 'ai' })), 'ui.plan.byAi');
  assert.equal(editedBy(doc({ updated_by: 'outside' })), 'ui.plan.byOutside');
  assert.equal(editedBy(doc({ updated_by: null })), null);
});

test('ui/plan: 欄を閉じても書きかけは残る。書きかけの記録が消えていれば（Discard を押した）、残した文も捨てる', () => {
  assert.equal(PLAN_EDITS.startsWith('screen:'), true, '別の画面へ行くときの確かめに乗る');
  const kept = { text: 'draft', base: 'h1', baseText: '# Plan' };
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

test('ui/plan: Mark as reviewed は、読むモードで印のある計画書のときだけ出し、書いている最中と送っている最中は押せない', () => {
  const doc = (extra: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# P', hash: 'h1', updated_at: 1, updated_by: 'ai', tainted: true, writing: false, reviewLocked: false, built_hash: null, ...extra });
  assert.equal(reviewButton(doc(), 'read', false, false), 'on');
  assert.equal(reviewButton(doc({ writing: true }), 'read', false, false), 'off', '書いている最中は押せない');
  assert.equal(reviewButton(doc({ reviewLocked: true }), 'read', false, false), 'off', 'Normal の会話が動いているあいだも押せない（plan_write はどのモードでも使える）');
  assert.equal(planState(doc({ reviewLocked: true }), false), 'ready', 'Normal の会話では「書いている最中」にしない');
  assert.equal(canEdit(planState(doc({ reviewLocked: true }), false)), true, 'Edit と Build は使える');
  assert.equal(reviewButton(doc(), 'read', true, false), 'off');
  assert.equal(reviewButton(doc(), 'edit', false, false), 'hidden', '直しているあいだは出さない');
  assert.equal(reviewButton(doc({ tainted: false }), 'read', false, false), 'hidden');
  assert.equal(reviewButton(doc({ hash: null }), 'read', false, false), 'hidden');
  assert.equal(reviewButton(null, 'read', false, false), 'hidden');
});

test('ui/plan: 読み始めた計画書のハッシュを覚え、途中で計画書が変わったら「読み直して」の印を立てる（最初の読み込みでは立てない）', () => {
  const start = reviewSeen({ hash: null, changed: false }, 'h1');
  assert.deepEqual(start, { hash: 'h1', changed: false });
  assert.equal(reviewSeen(start, 'h1'), start, '同じなら変えない');
  assert.deepEqual(reviewSeen(start, 'h2'), { hash: 'h2', changed: true });
  assert.deepEqual(reviewSeen(reviewSeen(start, 'h2'), 'h2'), { hash: 'h2', changed: true }, '印は送るまで残る');
  assert.deepEqual(reviewSeen(start, null), { hash: null, changed: false });
});

test('ui/plan: 「読み直して」が出ているあいだの 1 回目の押しは何も送らず、印を下ろして今の版を覚えるだけ。送るのは読み直したあとの 2 回目', () => {
  const doc = (extra: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# P', hash: 'h2', updated_at: 1, updated_by: 'ai', tainted: true, writing: false, reviewLocked: false, built_hash: null, ...extra });
  const changed = reviewSeen(reviewSeen({ hash: null, changed: false }, 'h1'), 'h2');
  assert.equal(reviewButton(doc(), 'read', false, changed.changed), 'again', '押す前から「読み直した」の形にする');
  assert.equal(reviewButton(doc({ writing: true }), 'read', false, true), 'off');
  assert.equal(reviewButton(doc(), 'edit', false, true), 'hidden');
  const first = reviewClick(changed, 'h2');
  assert.deepEqual(first, { send: null, seen: { hash: 'h2', changed: false } }, '1 回目は送らない');
  assert.equal(reviewButton(doc(), 'read', false, first.seen.changed), 'on');
  assert.deepEqual(reviewClick(first.seen, 'h2'), { send: 'h2', seen: first.seen }, '2 回目で、読み直した版を送る');
  assert.deepEqual(reviewClick({ hash: 'h1', changed: false }, 'h2'), { send: null, seen: { hash: 'h2', changed: true } }, '覚えた版と今の版がずれていれば（印が立つ 1 描画前の押し）、送らずに「読み直して」を立てる');
  assert.deepEqual(reviewClick({ hash: null, changed: false }, 'h2'), { send: null, seen: { hash: 'h2', changed: false } }, 'まだ版を覚えていなければ、覚えるだけ');
  assert.deepEqual(reviewClick({ hash: null, changed: false }, null).send, null);
});
