import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelView, PendingMessage } from '../web/src/api.ts';
import { SLASH_COMMANDS } from '../web/src/chat-logic.ts';
import type { FeedbackItem } from '../web/src/feedback.ts';
import { t } from '../web/src/i18n/index.ts';
import {
  attachRoom, composerView, depthOptions, enterAction, MAX_ATTACHMENTS, MODE_LABEL, modelInEffect, modelOptions, PLACEHOLDER, queuedLine, replaceTargets, slashAvailable, slashItems, UI_SLASH,
  type ComposerInput,
} from '../web/src/ui/composer-state.ts';
import { EMPTY, reduce, type Action, type LiveState } from '../web/src/ui/live-state.ts';
import { dropToast, leaveToast, pushToast, toastDuration, type ToastEntry } from '../web/src/ui/toast-list.ts';

// 新しい画面の入力欄（steps/p1-ui.md の「会話」の入力欄と PR 1-3）の決まり。画面を持たない純粋な関数。

const base: ComposerInput = { hasConversation: true, running: false, mode: 'normal', chatModels: 2, text: 'hi', attachments: 0, uploading: false, sending: false };
const model = (id: string, extra: Partial<ModelView> = {}): ModelView => ({
  id, label: id.toUpperCase(), provider: 'p', model: id, minContext: 0, maxOutputTokens: 0, inChat: true,
  probe: { modelId: id, status: 'ok', server: 's', required: 0, message: '', checkedAt: 0 }, ...extra,
});
const pend = (id: string, text: string, interrupt = false): PendingMessage => ({ id, text, attachments: [], interrupt, createdAt: 0 });
const key = (name: string, extra: Partial<Parameters<typeof enterAction>[0]> = {}) => ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, composing: false, ...extra });

test('ui/composer-state: 返事を作っている最中は Queue・Force・Stop、そうでなければ Send。空の入力では送れない', () => {
  assert.deepEqual(composerView(base), { placeholder: 'reply', disabled: false, actions: 'send', canSubmit: true, canAttach: true });
  assert.deepEqual(composerView({ ...base, running: true }), { placeholder: 'busy', disabled: false, actions: 'busy', canSubmit: true, canAttach: true });
  assert.equal(composerView({ ...base, text: '  \n' }).canSubmit, false);
  assert.equal(composerView({ ...base, running: true, text: '' }).canSubmit, false);
  assert.equal(composerView({ ...base, text: '', attachments: 1 }).canSubmit, true, '添付だけでも送れる');
  assert.equal(composerView({ ...base, uploading: true }).canSubmit, false);
  assert.equal(composerView({ ...base, sending: true }).canSubmit, false);
  assert.equal(composerView({ ...base, attachments: MAX_ATTACHMENTS }).canAttach, false);
});

test('ui/composer-state: モデルが無いと押せない（置き場の文字は No model configured）。読み込み前（null）は押せる', () => {
  assert.deepEqual(composerView({ ...base, chatModels: 0 }), { placeholder: 'noModel', disabled: true, actions: 'send', canSubmit: false, canAttach: false });
  assert.equal(composerView({ ...base, chatModels: null }).disabled, false);
  assert.equal(t(PLACEHOLDER.noModel), 'No model configured');
});

test('ui/composer-state: 置き場の文字: 新しい会話 Message、会話の中 Reply、作成中の文、Plan のとき Describe the change to plan', () => {
  assert.equal(t(PLACEHOLDER[composerView({ ...base, hasConversation: false }).placeholder]), 'Message');
  assert.equal(t(PLACEHOLDER[composerView(base).placeholder]), 'Reply');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan' }).placeholder]), 'Describe the change to plan');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', hasConversation: false }).placeholder]), 'Describe the change to plan');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', running: true }).placeholder]), 'Reply · Queue waits for the next break, Force interrupts');
});

test('ui/composer-state: モードの言葉は Ask / Auto / Plan（持ち主の答え 9。サーバーの normal / auto / plan の順）', () => {
  assert.deepEqual(Object.keys(MODE_LABEL), ['normal', 'auto', 'plan']);
  assert.deepEqual(Object.values(MODE_LABEL).map(k => t(k)), ['Ask', 'Auto', 'Plan']);
});

test('ui/composer-state: Enter は送信、Shift+Enter は改行、作成中の Enter は Queue、作成中の Ctrl / ⌘ + Enter は Force。変換中は何もしない', () => {
  assert.equal(enterAction(key('Enter'), false), 'send');
  assert.equal(enterAction(key('Enter', { shiftKey: true }), false), null);
  assert.equal(enterAction(key('Enter', { shiftKey: true }), true), null);
  assert.equal(enterAction(key('Enter'), true), 'queue');
  assert.equal(enterAction(key('Enter', { ctrlKey: true }), true), 'force');
  assert.equal(enterAction(key('Enter', { metaKey: true }), true), 'force');
  assert.equal(enterAction(key('Enter', { ctrlKey: true }), false), 'send');
  assert.equal(enterAction(key('Enter', { composing: true }), false), null);
  assert.equal(enterAction(key('a'), false), null);
});

test('ui/composer-state: 深さはモデルに efforts があるときだけ。モデルを選んでいなければ、設定の順の先頭の使えるモデルで決める', () => {
  const models = [model('a', { probe: null }), model('b', { efforts: ['low', 'high'] }), model('c')];
  assert.equal(modelInEffect(models, ['a', 'b', 'c'], null)?.id, 'b', '使えない a は飛ばす');
  assert.equal(modelInEffect(models, ['a'], null)?.id, 'a', '使えるものが無ければ先頭');
  assert.equal(modelInEffect(models, ['a', 'b'], 'c')?.id, 'c');
  assert.equal(modelInEffect(models, [], null), undefined);
  assert.deepEqual(depthOptions(modelInEffect(models, ['a', 'b', 'c'], null)), ['low', 'high']);
  assert.deepEqual(depthOptions(modelInEffect(models, ['a', 'b', 'c'], 'c')), []);
  assert.deepEqual(depthOptions(undefined), []);
});

test('ui/composer-state: モデルの一覧は Auto と設定のモデル全部。使えないモデルは選べない（今選んでいるものは除く）', () => {
  const options = modelOptions([model('a', { probe: null }), model('b')], 'a');
  assert.deepEqual(options.map(o => [o.id, o.checked, o.disabled]), [[null, false, false], ['a', true, false], ['b', false, false]]);
  assert.deepEqual(modelOptions([model('a', { probe: null })], null).map(o => [o.id, o.checked, o.disabled]), [[null, true, false], ['a', false, true]]);
});

test('ui/composer-state: スラッシュコマンド: 今の一覧を 1 つも落とさず /plan を足す。効かないものは出さない', () => {
  const names = UI_SLASH.map(c => c.name) as string[];
  for (const command of SLASH_COMMANDS) assert.ok(names.includes(command.name), command.name);
  assert.ok(names.includes('plan'));
  for (const command of UI_SLASH) assert.equal(typeof t(command.desc), 'string');
  const none = { hasConversation: false, running: false, hasSummary: false, archived: false };
  assert.deepEqual(slashAvailable(none).map(c => c.name), ['new', 'plan', 'task', 'tasks', 'skills', 'log', 'memory']);
  const all = { hasConversation: true, running: true, hasSummary: true, archived: false };
  assert.deepEqual(slashAvailable(all).map(c => c.name), names);
  assert.ok(!slashAvailable({ ...all, archived: true }).some(c => c.name === 'archive'));
  assert.deepEqual(slashItems('/ta', all).map(c => c.name), ['task', 'tasks']);
  assert.deepEqual(slashItems('/rename x', all), [], '引数を書き始めたら閉じる');
  assert.deepEqual(slashItems('hello', all), []);
  assert.deepEqual(slashItems('hello', all, true).map(c => c.name), names, 'ボタンで開いたときは全部');
  assert.deepEqual(slashItems('/', none).length, 7);
});

test('ui/composer-state: 待たせる発言は 1 つ: もう一度 Queue するとき取り消すのは、割り込みでない待ちの発言の全部', () => {
  assert.deepEqual(replaceTargets([pend('1', 'a'), pend('2', 'b', true), pend('3', 'c')]).map(p => p.id), ['1', '3']);
  assert.deepEqual(replaceTargets([]), []);
  assert.equal(queuedLine(pend('1', ' two\n lines ')), 'two lines');
  assert.equal(queuedLine({ text: '', attachments: [{ id: 'u', name: 'spec.pdf', kind: 'pdf' }] }), 'spec.pdf');
});

test('ui/composer-state: 添付は 5 つまで', () => {
  assert.equal(attachRoom(0, 3), 3);
  assert.equal(attachRoom(4, 3), 1);
  assert.equal(attachRoom(5, 1), 0);
});

test('ui/toast-list: 2 つまで（古いものから外れる）、5 秒、操作つきは 6 秒', () => {
  const entry = (id: number, item: FeedbackItem = { title: String(id) }): ToastEntry => ({ id, item, leaving: false });
  const list = pushToast(pushToast(pushToast([], entry(1)), entry(2)), entry(3));
  assert.deepEqual(list.map(e => e.id), [2, 3]);
  assert.deepEqual(leaveToast(list, 2).map(e => e.leaving), [true, false]);
  assert.deepEqual(dropToast(list, 2).map(e => e.id), [3]);
  assert.equal(toastDuration({ title: 'x' }), 5000);
  assert.equal(toastDuration({ title: 'x', action: { label: 'Undo', run: () => undefined } }), 6000);
  assert.equal(toastDuration({ title: 'x', durationMs: 100 }), 100);
});

test('ui/live-state: Force で割り込んだ回は、Stopped の代わりに、新しい実行に Interrupted のお知らせを 1 つ残す', () => {
  const run = (s: LiveState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a).state, s);
  const ev = (event: Extract<Action, { type: 'event' }>['event']): Action => ({ type: 'event', event, hidden: false });
  const started = run(EMPTY, ev({ type: 'run.start', runId: 'r1', conversationId: 'c', modelId: 'm' }));
  const flagged = run(started, { type: 'interrupt', conversationId: 'c', on: true });
  const ended = run(flagged, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
  assert.equal(ended.notices.get('c'), undefined, '割り込みで止まった回に Stopped は出さない');
  const next = run(ended, ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.deepEqual(next.notices.get('c'), [{ runId: 'r2', kind: 'interrupted' }]);
  assert.equal(next.interrupting.has('c'), false);
  const later = run(next, ev({ type: 'run.end', runId: 'r2', conversationId: 'c', ok: true }), ev({ type: 'run.start', runId: 'r3', conversationId: 'c', modelId: 'm' }));
  assert.equal(later.notices.get('c'), undefined, '次の実行では片づく');
  const plain = run(started, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
  assert.deepEqual(plain.notices.get('c'), [{ runId: 'r1', kind: 'stopped' }], 'Stop はこれまでどおり Stopped');
  const undone = run(next, { type: 'interrupt', conversationId: 'c', on: false });
  assert.equal(undone.notices.get('c'), undefined, '割り込みにならなかった（待たされなかった）ときは取り消す');
  const other = run(flagged, ev({ type: 'run.start', runId: 'x', conversationId: 'd', modelId: 'm' }));
  assert.equal(other.notices.get('d'), undefined);
  assert.ok(other.interrupting.has('c'));
});
