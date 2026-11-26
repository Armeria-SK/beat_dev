import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelView, PendingMessage } from '../web/src/api.ts';
import { SLASH_COMMANDS } from '../web/src/chat-logic.ts';
import type { FeedbackItem } from '../web/src/feedback.ts';
import { t } from '../web/src/i18n/index.ts';
import {
  attachLeftOut, attachRoom, bareCommand, cancelClearsInterrupt, composerView, createDrafts, depthOptions, enterAction, firstMode, MAX_ATTACHMENTS, MODE_LABEL, modeHint, modelInEffect, modelOptions, NEW_DRAFT, NO_RUNTIME, runtimeInEffect, runtimeShown, PLACEHOLDER, queuedLine, queueRow, replaceTargets,
  slashAvailable, slashItems,
  submitMessage, toastLift, UI_SLASH,
  type ComposerInput, type RuntimeUse, type SubmitDeps, type SubmitInput,
} from '../web/src/ui/composer-state.ts';
import { EMPTY, reduce, type Action, type LiveState } from '../web/src/ui/live-state.ts';
import { dropToast, leaveToast, pushToast, toastDuration, type ToastEntry } from '../web/src/ui/toast-list.ts';

// 新しい画面の入力欄（steps/p1-ui.md の「会話」の入力欄と PR 1-3）の決まり。画面を持たない純粋な関数。

const base: ComposerInput = { hasConversation: true, running: false, mode: 'auto', chatModels: 2, text: 'hi', attachments: 0, uploading: false, sending: false };
const model = (id: string, extra: Partial<ModelView> = {}): ModelView => ({
  id, label: id.toUpperCase(), provider: 'p', model: id, maxOutputTokens: 0, limits: { context: null, maxOutput: null, required: null }, inChat: true,
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
  assert.equal(t(PLACEHOLDER[composerView({ ...base, hasConversation: false, product: true }).placeholder]), 'Describe what to build', '製品の新しい会話');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, product: true }).placeholder]), 'Reply', '製品の会話の中は Reply のまま');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan' }).placeholder]), 'Describe the change to plan');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', hasConversation: false }).placeholder]), 'Describe the change to plan');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', running: true }).placeholder]), 'Reply · Queue waits for the next break, Force interrupts');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', hasConversation: false, product: true, planless: true }).placeholder]), 'Describe what to build', '計画書の無い製品の最初の会話は Plan でも Describe what to build（beat 3-1a-u）');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', hasConversation: false, product: true, planless: false }).placeholder]), 'Describe the change to plan', '計画書のある製品で Plan を選んだら、計画の直し');
  assert.equal(t(PLACEHOLDER[composerView({ ...base, mode: 'plan', product: true, planless: true }).placeholder]), 'Describe the change to plan', '会話が始まったあと');
});

test('ui/composer-state: 新しい製品の会話のモードの初めの値: 計画書が無い製品は Plan、ある製品・分からない（古いサーバー）・製品の外は Auto（beat 3-1a-u）', () => {
  assert.equal(firstMode({ has_plan: false }), 'plan');
  assert.equal(firstMode({ has_plan: true }), 'auto');
  assert.equal(firstMode({}), 'auto');
  assert.equal(firstMode(undefined), 'auto');
});

test('ui/composer-state: モードの言葉は Design の Normal / Plan（サーバーの auto / plan の順）', () => {
  assert.deepEqual(Object.keys(MODE_LABEL), ['auto', 'plan']);
  assert.deepEqual(Object.values(MODE_LABEL).map(k => t(k)), ['Normal', 'Plan']);
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

test('ui/composer-state（#266）: 発言の無い製品の会話の「自動」は #runtimeRoute と同じ。先頭の候補が実行役のモデルなら、確かめが済んでいなくてもそれ（深さもそのモデルの）。先頭が提供元のモデルなら、実行役のモデルは使えていても選ばない', () => {
  const unchecked = model('cc', { runtime: 'claude-code', provider: '', probe: { modelId: 'cc', status: 'unreachable', server: 'claude-code', required: 0, message: '', checkedAt: 0 }, efforts: ['low', 'high'] });
  const checked = { ...unchecked, probe: { ...unchecked.probe!, status: 'ok' as const } };
  const provider = model('a', { efforts: ['medium'] });
  const first: RuntimeUse = { bound: null, allowed: true };
  const pick = (models: ModelView[], order: string[], use: RuntimeUse) => modelInEffect(runtimeShown(models, use), order, null, use);

  assert.equal(modelInEffect([unchecked, provider], ['cc', 'a'], null)?.id, 'a', 'with no use given, the old rule: the first usable one');
  assert.equal(pick([unchecked, provider], ['cc', 'a'], first)?.id, 'cc', 'the first send goes to the runtime model the server picks, though it is not checked yet');
  assert.deepEqual(depthOptions(pick([unchecked, provider], ['cc', 'a'], first)), ['low', 'high'], 'so the depths are the runtime model\'s, the ones the server accepts');
  assert.equal(pick([unchecked, provider], ['cc', 'a'], NO_RUNTIME)?.id, 'a', 'a conversation that is not a fresh product one never goes to a runtime');
  assert.equal(pick([unchecked, provider], ['cc', 'a'], { bound: 'claude-code', allowed: false })?.id, 'cc', 'a bound conversation keeps its own runtime');
  assert.equal(pick([checked, provider], ['a', 'cc'], first)?.id, 'a', 'a runtime model that is not first is never the automatic one');
  assert.equal(pick([checked, model('a', { probe: null, efforts: ['medium'] })], ['a', 'cc'], first)?.id, 'a', 'the provider model is first and not usable: the server still stays on the provider chain');
  assert.equal(pick([checked, provider], ['cc', 'a'], first)?.id, 'cc');
  assert.equal(modelInEffect([unchecked, provider], ['cc', 'a'], 'a', first)?.id, 'a', 'a chosen model wins');
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
  const none = { hasConversation: false, running: false, hasSummary: false, archived: false, product: false };
  assert.deepEqual(slashAvailable(none).map(c => c.name), ['new', 'plan', 'task', 'tasks', 'skills', 'log', 'memory']);
  const all = { hasConversation: true, running: true, hasSummary: true, archived: false, product: true, scout: true };
  assert.deepEqual(slashAvailable(all).map(c => c.name), names);
  assert.ok(!slashAvailable({ ...all, archived: true }).some(c => c.name === 'archive'));
  assert.deepEqual(slashItems('/ta', all).map(c => c.name), ['task', 'tasks']);
  assert.deepEqual(slashItems('/rename x', all), [], '引数を書き始めたら閉じる');
  assert.deepEqual(slashItems('hello', all), []);
  assert.deepEqual(slashItems('hello', all, true).map(c => c.name), names, 'ボタンで開いたときは全部');
  assert.deepEqual(slashItems('/', none).length, 7);
});

test('ui/composer-state: /build は製品の会話でだけ出る（欄を開いて対応表まで送るだけで、作りはしない）', () => {
  const ctx = { hasConversation: true, running: false, hasSummary: false, archived: false };
  assert.ok(slashAvailable({ ...ctx, product: true }).some(c => c.name === 'build'));
  assert.ok(!slashAvailable({ ...ctx, product: false }).some(c => c.name === 'build'));
  assert.ok(slashAvailable({ ...ctx, hasConversation: false, product: true }).some(c => c.name === 'build'), '新しい製品の会話でも欄は開ける');
  assert.equal(bareCommand('/build')?.name, 'build');
  assert.equal(t('ui.slash.build'), 'Review the plan before building');
  assert.equal(UI_SLASH.find(c => c.name === 'build')?.desc, 'ui.slash.build');
});

test('ui/composer-state: /propose（考える役を今すぐ動かす）は、考える役が Off でない製品の会話でだけ出る。/p + Enter は今までどおり /plan、/t は /task と /tasks だけ', () => {
  const ctx = { hasConversation: true, running: false, hasSummary: false, archived: false };
  assert.ok(slashAvailable({ ...ctx, scout: true }).some(c => c.name === 'propose'));
  assert.ok(!slashAvailable({ ...ctx, scout: false }).some(c => c.name === 'propose'));
  assert.ok(!slashAvailable(ctx).some(c => c.name === 'propose'), '製品の会話かどうか分からないときは出さない');
  assert.ok(slashAvailable({ ...ctx, hasConversation: false, scout: true }).some(c => c.name === 'propose'), '新しい製品の会話でも出す');
  assert.equal(bareCommand('/propose')?.name, 'propose');
  assert.equal(t('ui.slash.propose'), 'Ask for proposals now');
  const on = { ...ctx, scout: true };
  assert.deepEqual(slashItems('/p', on).map(c => c.name), ['plan', 'propose'], '/p + Enter で開くのは今までどおり最初の /plan');
  assert.deepEqual(slashItems('/p', ctx).map(c => c.name), ['plan']);
  assert.deepEqual(slashItems('/pr', on).map(c => c.name), ['propose']);
  assert.deepEqual(slashItems('/t', on).map(c => c.name), ['task', 'tasks'], '/t には /propose は混ざらない');
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
  assert.deepEqual(later.notices.get('c'), [{ runId: 'r2', kind: 'interrupted' }], '次の実行でも消さず、起きた位置に残る（話が進めば上へ流れる）');
  const plain = run(started, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
  assert.deepEqual(plain.notices.get('c'), [{ runId: 'r1', kind: 'stopped' }], 'Stop はこれまでどおり Stopped');
  const undone = run(next, { type: 'interrupt', conversationId: 'c', on: false });
  assert.equal(undone.notices.get('c'), undefined, '割り込みにならなかった（待たされなかった）ときは取り消す');
  const again = run(later, { type: 'interrupt', conversationId: 'c', on: true }, { type: 'interrupt', conversationId: 'c', on: false });
  assert.deepEqual(again.notices.get('c'), [{ runId: 'r2', kind: 'interrupted' }], '始まる前に取り消した割り込みは、前の回の Interrupted を消さない');
  const other = run(flagged, ev({ type: 'run.start', runId: 'x', conversationId: 'd', modelId: 'm' }));
  assert.equal(other.notices.get('d'), undefined);
  assert.ok(other.interrupting.has('c'));
});

test('ui/live-state: Force の待ちの発言を取り消したら割り込みの印を外す。止まった回は Stopped になり、次のふつうの実行に Interrupted は付かない', () => {
  const run = (s: LiveState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a).state, s);
  const ev = (event: Extract<Action, { type: 'event' }>['event']): Action => ({ type: 'event', event, hidden: false });
  assert.equal(cancelClearsInterrupt([pend('p1', 'a', true), pend('p2', 'b')], 'p1'), true);
  assert.equal(cancelClearsInterrupt([pend('p1', 'a', true), pend('p2', 'b')], 'p2'), false);
  assert.equal(cancelClearsInterrupt([], 'p1'), false);
  const forced = run(EMPTY, ev({ type: 'run.start', runId: 'r1', conversationId: 'c', modelId: 'm' }), { type: 'interrupt', conversationId: 'c', on: true });
  const cancelled = run(forced, { type: 'interrupt', conversationId: 'c', on: false }, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
  assert.deepEqual(cancelled.notices.get('c'), [{ runId: 'r1', kind: 'stopped' }]);
  const next = run(cancelled, ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.deepEqual(next.notices.get('c'), [{ runId: 'r1', kind: 'stopped' }], 'Stopped は起きた位置に残り、Interrupted は足さない');
});

function submitHarness(fail: { cancel?: unknown; send?: unknown; rename?: unknown } = {}, queued = true) {
  const calls: string[] = [];
  const deps: SubmitDeps = {
    rename: async (id, title) => { calls.push(`rename ${id} ${title}`); if (fail.rename) throw fail.rename; },
    cancelPending: async (id, pendingId) => { calls.push(`cancel ${id} ${pendingId}`); if (fail.cancel) throw fail.cancel; },
    send: async (target, text, files, interrupt) => { calls.push(`send ${target} ${text} [${files.join(',')}]${interrupt ? ' interrupt' : ''}`); if (fail.send) throw fail.send; return { queued }; },
    isGone: error => error === 'gone',
    interrupt: (target, on) => { calls.push(`interrupt ${target} ${on ? 'on' : 'off'}`); },
  };
  return { calls, deps };
}
const input = (extra: Partial<SubmitInput> = {}): SubmitInput => ({ kind: 'send', text: 'hello', attachmentIds: [], conversationId: 'c', target: 'c', running: false, pending: [], ...extra });

test('ui/composer-state: 送る順番。ふつうの送信はお知らせを片づけずに送る（お知らせは起きた位置に残って流れる）。新しい会話は新しい ID へ送る', async () => {
  const h = submitHarness({}, false);
  assert.deepEqual(await submitMessage(input({ attachmentIds: ['u1', 'u2'] }), h.deps), { kind: 'sent', queued: false, replaced: null, effortReset: false });
  assert.deepEqual(h.calls, ['send c hello [u1,u2]']);
  const reset = { ...submitHarness().deps, send: async () => ({ queued: false, effortReset: true }) };
  assert.deepEqual(await submitMessage(input(), reset), { kind: 'sent', queued: false, replaced: null, effortReset: true }, '送信の返事の effortReset を画面へ渡す');
  const fresh = submitHarness({}, false);
  await submitMessage(input({ conversationId: null, target: 'new-id', kind: 'queue', pending: [pend('p', 'x')] }), fresh.deps);
  assert.deepEqual(fresh.calls, ['send new-id hello []'], '会話がまだ無いときは置き換えるものが無い');
});

test('ui/composer-state: Queue は、前の待ち（割り込みでないもの）を取り消してから送る。もう無かった待ち（404）は置き換えたことにしない', async () => {
  const pending = [pend('p1', 'old one'), pend('f', 'forced', true), pend('p2', 'old two')];
  const h = submitHarness();
  const out = await submitMessage(input({ kind: 'queue', running: true, pending }), h.deps);
  assert.deepEqual(h.calls, ['cancel c p1', 'cancel c p2', 'send c hello []']);
  assert.deepEqual(out, { kind: 'sent', queued: true, replaced: pending[2], effortReset: false });
  const gone = submitHarness({ cancel: 'gone' });
  assert.deepEqual(await submitMessage(input({ kind: 'queue', running: true, pending }), gone.deps), { kind: 'sent', queued: true, replaced: null, effortReset: false });
  const send = submitHarness();
  await submitMessage(input({ kind: 'send', pending }), send.deps);
  assert.deepEqual(send.calls, ['send c hello []'], 'Queue でなければ待ちに触らない');
});

test('ui/composer-state: 置き換えの途中で失敗したら、消えた前の待ちを結果に入れて返す（画面が「前の文は消えた」と言えるように）', async () => {
  const pending = [pend('p1', 'old one')];
  const h = submitHarness({ send: 'boom' });
  assert.deepEqual(await submitMessage(input({ kind: 'queue', running: true, pending }), h.deps), { kind: 'failed', error: 'boom', replaced: pending[0] });
  assert.deepEqual(h.calls, ['cancel c p1', 'send c hello []']);
  const cancel = submitHarness({ cancel: 'server down' });
  assert.deepEqual(await submitMessage(input({ kind: 'queue', running: true, pending }), cancel.deps), { kind: 'failed', error: 'server down', replaced: null });
  assert.deepEqual(cancel.calls, ['cancel c p1'], '取り消せなかったら送らない');
});

test('ui/composer-state: Force は、返事を作っている最中だけ割り込みの印を付けて送る。待たされなかった・失敗したら印を外す', async () => {
  const h = submitHarness();
  assert.deepEqual(await submitMessage(input({ kind: 'force', running: true, pending: [pend('p1', 'kept')] }), h.deps), { kind: 'sent', queued: true, replaced: null, effortReset: false });
  assert.deepEqual(h.calls, ['interrupt c on', 'send c hello [] interrupt'], 'Force は前の待ちを消さない');
  const direct = submitHarness({}, false);
  await submitMessage(input({ kind: 'force', running: true }), direct.deps);
  assert.deepEqual(direct.calls, ['interrupt c on', 'send c hello [] interrupt', 'interrupt c off']);
  const failed = submitHarness({ send: 'boom' });
  assert.equal((await submitMessage(input({ kind: 'force', running: true }), failed.deps)).kind, 'failed');
  assert.deepEqual(failed.calls.at(-1), 'interrupt c off');
  const idle = submitHarness({}, false);
  await submitMessage(input({ kind: 'force', running: false }), idle.deps);
  assert.deepEqual(idle.calls, ['send c hello []'], '動いていなければふつうの送信');
});

test('ui/composer-state: 書きかけの文は会話ごとに覚える（別の会話へ移っても残る）。空にしたら忘れる', () => {
  const drafts = createDrafts();
  assert.equal(drafts.get('a'), '');
  drafts.set('a', 'half a thought');
  drafts.set(NEW_DRAFT, 'first words');
  assert.equal(drafts.get('a'), 'half a thought');
  assert.equal(drafts.get('b'), '', 'ほかの会話には出ない');
  assert.equal(drafts.get(NEW_DRAFT), 'first words');
  drafts.set('a', '');
  assert.equal(drafts.get('a'), '', '送ったら（空にしたら）残らない');
});

test('ui/composer-state: 添付も会話ごとに覚える（別の会話へ移っても残る）。消した会話の書きかけは文も添付も忘れる', () => {
  const drafts = createDrafts();
  const file = (id: string) => ({ id, name: `${id}.txt`, mime: 'text/plain', kind: 'text' as const, size: 1, chars: 1, pages: null });
  assert.deepEqual(drafts.files('a'), []);
  drafts.setFiles('a', [file('u1'), file('u2')]);
  drafts.set('a', 'see attached');
  assert.deepEqual(drafts.files('a').map(f => f.id), ['u1', 'u2'], '移って戻っても添付が残る');
  assert.deepEqual(drafts.files('b'), [], 'ほかの会話には出ない');
  drafts.setFiles('b', [file('u3')]);
  drafts.forget('a');
  assert.equal(drafts.get('a'), '');
  assert.deepEqual(drafts.files('a'), [], '消した会話の書きかけは残さない');
  assert.deepEqual(drafts.files('b').map(f => f.id), ['u3']);
  drafts.setFiles('b', []);
  assert.deepEqual(drafts.files('b'), [], '送ったら（空にしたら）残らない');
});

test('ui/composer-state: 知っているコマンド名とちょうど同じ文は、今は出していないコマンドでも発言として送らない', () => {
  assert.equal(bareCommand('/archive')?.name, 'archive');
  assert.equal(bareCommand('  /Stop ')?.name, 'stop');
  assert.equal(bareCommand('/summary')?.name, 'summary');
  for (const command of UI_SLASH) assert.equal(bareCommand(`/${command.name}`)?.name, command.name);
  assert.equal(bareCommand('/stop now'), null, '続きのある文はふつうの発言');
  assert.equal(bareCommand('/unknown'), null);
  assert.equal(bareCommand('stop'), null);
  assert.equal(bareCommand('/usr/bin'), null);
});

test('ui/composer-state: 待ちの行は 1 つだけ（いちばん新しい待ち）。ほかは数で言う', () => {
  assert.equal(queueRow([]), null);
  assert.deepEqual(queueRow([pend('1', 'a')]), { shown: pend('1', 'a'), more: 0 });
  assert.deepEqual(queueRow([pend('1', 'a'), pend('2', 'b', true)]), { shown: pend('2', 'b', true), more: 1 });
});

test('ui/composer-state: 上限を超えて選んだ添付は、はみ出た数を知らせる', () => {
  assert.equal(attachLeftOut(0, 5), 0);
  assert.equal(attachLeftOut(0, 7), 2);
  assert.equal(attachLeftOut(4, 3), 2);
  assert.equal(attachLeftOut(5, 1), 1);
});

test('ui/composer-state: /rename は題を書き換えるだけで送らない。題が無い・会話が無いときは何もしない', async () => {
  const h = submitHarness();
  assert.deepEqual(await submitMessage(input({ text: '/rename New title' }), h.deps), { kind: 'renamed' });
  assert.deepEqual(h.calls, ['rename c New title']);
  const none = submitHarness();
  assert.deepEqual(await submitMessage(input({ text: '/rename' }), none.deps), { kind: 'ignored' });
  assert.deepEqual(await submitMessage(input({ text: '/rename X', conversationId: null }), none.deps), { kind: 'ignored', why: 'rename_unsent' }, '新しい会話では、まだ送っていないと知らせられるように理由を返す');
  assert.deepEqual(none.calls, []);
  const bad = submitHarness({ rename: 'nope' });
  assert.deepEqual(await submitMessage(input({ text: '/rename X' }), bad.deps), { kind: 'failed', error: 'nope', replaced: null });
});

test('ui/composer-state: トーストを入力欄の上へ持ち上げる高さ（画面の下から入力欄の上の端まで）', () => {
  assert.equal(toastLift(900, 716.4), 184);
  assert.equal(toastLift(900, 950), 0);
});

test('ui/composer-state（AR-7）: 実行役のモデルは、まだ発言の無い製品の会話でだけ選べる。結ばれた会話はその実行役のモデルだけ。権限モードの切り替えは実行役の会話でも出し、説明だけ実行役用にする', () => {
  const models = [model('a'), model('cc', { runtime: 'claude-code', provider: '' }), model('cx', { runtime: 'codex', provider: '' })];
  const ids = (use: RuntimeUse) => modelOptions(models, null, use).map(o => o.id);
  assert.deepEqual(ids(NO_RUNTIME), [null, 'a'], 'a conversation with no product, or one already started with a provider, does not offer runtimes');
  assert.deepEqual(ids({ bound: null, allowed: true }), [null, 'a', 'cc', 'cx']);
  assert.deepEqual(ids({ bound: 'claude-code', allowed: false }), [null, 'cc'], 'a bound conversation can only stay with its own runtime');
  assert.deepEqual(modelOptions(models, null, { bound: null, allowed: true }).map(o => o.runtime), [null, null, 'claude-code', 'codex']);
  assert.deepEqual(modelOptions(models, null).map(o => o.id), [null, 'a'], 'the default is no runtime');

  const cc = models[1];
  assert.equal(runtimeInEffect({ bound: 'claude-code', allowed: false }, undefined), true);
  assert.equal(runtimeInEffect({ bound: null, allowed: true }, cc), true);
  assert.equal(runtimeInEffect({ bound: null, allowed: false }, cc), false, 'a runtime model that cannot be used here is not "in effect"');
  assert.equal(runtimeInEffect({ bound: null, allowed: true }, models[0]), false);
  assert.deepEqual(runtimeShown(models, { bound: null, allowed: false }).map(m => m.id), ['a']);
  assert.deepEqual([modeHint('auto', false), modeHint('plan', false)], ['mode.autoDesc', 'mode.planDesc']);
  assert.deepEqual([modeHint('auto', true), modeHint('plan', true)], ['mode.runtimeAutoDesc', 'mode.runtimePlanDesc'], 'the plan mode of a runtime conversation is not described as the tool filter of beat');
});
