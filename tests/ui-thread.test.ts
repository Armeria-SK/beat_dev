import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ChecklistItem, Message } from '../web/src/api.ts';
import { imageHost } from '../web/src/markdown-image.ts';
import type { RunNotice } from '../web/src/ui/live-state.ts';
import { setTimezone } from '../web/src/i18n/index.ts';
import { checklistShape, contextMeter, isRising, messageStamp, noticeRows, replyMeta, thinkingSeconds, threadGutter, threadItems } from '../web/src/ui/thread.ts';

// 新しい画面の会話（p1-ui.md の「会話」）: 発言・返事・道具の行のまとまり・流れている返事・承認の行・お知らせの並びを作る純粋な関数。

let next = 1;
const msg = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ id: next++, role, text, runId: 'r1', createdAt: 0, ...extra });
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });

test('ui/thread: 続けて呼んだ道具は 1 つのまとまり（bt-tools）に入り、文の無い道具だけの返事は出さず、まとまりを切らない', () => {
  const items = threadItems({
    messages: [
      msg('user', 'fix it'),
      msg('assistant', '', { toolCalls: [call('a', 'file_read', { path: 'a.ts' })] }),
      msg('tool', 'content', { toolName: 'file_read', toolCallId: 'a' }),
      msg('assistant', '', { toolCalls: [call('b', 'file_edit', { path: 'a.ts', old: 'x', new: 'y' })] }),
      msg('tool', 'Replaced 1 occurrence(s): a.ts', { toolName: 'file_edit', toolCallId: 'b' }),
      msg('assistant', 'Done.'),
    ],
  });
  assert.deepEqual(items.map(i => i.kind), ['owner', 'tools', 'reply']);
  const tools = items[1]!;
  assert.ok(tools.kind === 'tools');
  assert.deepEqual(tools.rows.map(r => [r.name, JSON.parse(r.input).path, r.result?.text]), [['file_read', 'a.ts', 'content'], ['file_edit', 'a.ts', 'Replaced 1 occurrence(s): a.ts']]);
});

test('ui/thread: 手元のサーバーが毎回同じ呼び出し番号を返しても、各行はその回の入力を出し、行の key は重ならない', () => {
  const items = threadItems({
    messages: [
      msg('user', 'look around'),
      msg('assistant', '', { toolCalls: [call('call_0', 'shell_run', { command: 'Get-Location; Get-ChildItem' })] }),
      msg('tool', 'D:\\a', { toolName: 'shell_run', toolCallId: 'call_0' }),
      msg('assistant', '', { toolCalls: [call('call_0', 'shell_run', { command: 'git status' })] }),
      msg('tool', 'clean', { toolName: 'shell_run', toolCallId: 'call_0' }),
      msg('assistant', '', { toolCalls: [call('call_0', 'file_read', { path: 'README.md' })] }),
      msg('tool', '# x', { toolName: 'file_read', toolCallId: 'call_0' }),
    ],
  });
  const tools = items[1]!;
  assert.ok(tools.kind === 'tools');
  assert.deepEqual(tools.rows.map(r => [r.name, r.input]), [
    ['shell_run', JSON.stringify({ command: 'Get-Location; Get-ChildItem' })],
    ['shell_run', JSON.stringify({ command: 'git status' })],
    ['file_read', JSON.stringify({ path: 'README.md' })],
  ]);
  assert.equal(new Set(items.flatMap(i => (i.kind === 'tools' ? i.rows.map(r => r.key) : [i.key]))).size, items.length - 1 + tools.rows.length);
});

test('ui/thread: 1 つの返事で同じ呼び出し番号が 2 回出ても、結果は呼んだ順にそれぞれの入力と組む', () => {
  const items = threadItems({
    messages: [
      msg('user', 'go'),
      msg('assistant', '', { toolCalls: [call('call_0', 'shell_run', { command: 'ls' }), call('call_0', 'shell_run', { command: 'pwd' })] }),
      msg('tool', 'a', { toolName: 'shell_run', toolCallId: 'call_0' }),
      msg('tool', 'b', { toolName: 'shell_run', toolCallId: 'call_0' }),
    ],
  });
  const tools = items[1]!;
  assert.ok(tools.kind === 'tools');
  assert.deepEqual(tools.rows.map(r => [JSON.parse(r.input).command, r.result?.text]), [['ls', 'a'], ['pwd', 'b']]);
});

test('ui/thread: 番号を使い回すとき、動いている行と結果待ちの行も前の行とキーが重ならず、保存されたあとも同じキーのまま', () => {
  const round1 = [
    msg('user', 'go', { runId: 'r2' }),
    msg('assistant', '', { runId: 'r2', toolCalls: [call('call_0', 'shell_run', { command: 'ls' })] }),
    msg('tool', 'one', { runId: 'r2', toolName: 'shell_run', toolCallId: 'call_0' }),
  ];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '' };
  const running = threadItems({ messages: round1, draft: { ...draft, activeTool: 'shell_run', activeInput: '{"command":"pwd"}', toolCallId: 'call_0', settled: [{ callId: 'call_0', name: 'shell_run', input: '{"command":"ls"}' }], settledCount: 1 } }).at(-1)!;
  assert.ok(running.kind === 'tools');
  const keys = running.rows.map(r => r.key);
  assert.equal(new Set(keys).size, 2, `キーが重ならない: ${keys}`);
  const round2 = [...round1, msg('assistant', '', { runId: 'r2', toolCalls: [call('call_0', 'shell_run', { command: 'pwd' })] }), msg('tool', 'two', { runId: 'r2', toolName: 'shell_run', toolCallId: 'call_0' })];
  const saved = threadItems({ messages: round2, draft: { ...draft, settled: [{ callId: 'call_0', name: 'shell_run', input: '{"command":"ls"}' }, { callId: 'call_0', name: 'shell_run', input: '{"command":"pwd"}' }], settledCount: 2 } }).filter(i => i.kind === 'tools').at(-1)!;
  assert.ok(saved.kind === 'tools');
  assert.deepEqual(saved.rows.map(r => r.key), keys, '動いていた行が保存された行になっても、キーは変わらない');
  assert.deepEqual(saved.rows.map(r => r.result?.text), ['one', 'two']);
});

test('ui/thread: 結果が届いたが保存を読む前の行は、同じ番号の前の行が保存済みでも消さない（その回の保存の数で決める）', () => {
  const messages = [
    msg('user', 'go', { runId: 'r2' }),
    msg('assistant', '', { runId: 'r2', toolCalls: [call('call_0', 'shell_run', { command: 'ls' })] }),
    msg('tool', 'one', { runId: 'r2', toolName: 'shell_run', toolCallId: 'call_0' }),
  ];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '', settled: [{ callId: 'call_0', name: 'shell_run', input: '{"command":"ls"}' }, { callId: 'call_0', name: 'shell_run', input: '{"command":"pwd"}' }], settledCount: 2 };
  const tools = threadItems({ messages, draft }).filter(i => i.kind === 'tools').at(-1)!;
  assert.ok(tools.kind === 'tools');
  assert.deepEqual(tools.rows.map(r => [JSON.parse(r.input).command, r.result?.text ?? null]), [['ls', 'one'], ['pwd', null]]);
  const older = [...messages, ...[2, 3, 4].flatMap(n => [msg('assistant', '', { runId: 'r2', toolCalls: [call('call_0', 'shell_run', { command: `c${n}` })] }), msg('tool', `r${n}`, { runId: 'r2', toolName: 'shell_run', toolCallId: 'call_0' })])];
  const trimmed = { ...draft, settled: [{ callId: 'call_0', name: 'shell_run', input: '{"command":"c4"}' }, { callId: 'call_0', name: 'shell_run', input: '{"command":"c5"}' }], settledCount: 5 };
  const rows = threadItems({ messages: older, draft: trimmed }).flatMap(i => (i.kind === 'tools' ? i.rows : []));
  assert.deepEqual(rows.map(r => r.result?.text ?? JSON.parse(r.input).command), ['one', 'r2', 'r3', 'r4', 'c5'], '覚えが古いものから外れていても、まだ保存されていない最後の 1 つだけを出す');
});

test('ui/thread: 実行の途中から画面を開いた（数え直しになった）ときも、まだ保存されていない番号の結果待ちの行は消さない', () => {
  const messages = [
    msg('user', 'go', { runId: 'r2' }),
    msg('assistant', '', { runId: 'r2', toolCalls: [call('id_1', 'shell_run', { command: 'ls' })] }),
    msg('tool', 'one', { runId: 'r2', toolName: 'shell_run', toolCallId: 'id_1' }),
  ];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '', settled: [{ callId: 'id_2', name: 'shell_run', input: '{"command":"pwd"}' }], settledCount: 1 };
  const rows = threadItems({ messages, draft }).flatMap(i => (i.kind === 'tools' ? i.rows : []));
  assert.deepEqual(rows.map(r => [r.key, r.result?.text ?? null]), [['t-id_1', 'one'], ['t-id_2', null]]);
});

test('ui/thread: 返事の文があいだに入ると、道具のまとまりは分かれる。コピーは 1 回の返事の最後の文だけで、その回の文を全部まとめる', () => {
  const items = threadItems({
    messages: [
      msg('user', 'go'),
      msg('assistant', 'First.', { toolCalls: [call('a', 'shell_run', { command: 'ls' })] }),
      msg('tool', 'out', { toolName: 'shell_run', toolCallId: 'a' }),
      msg('assistant', 'Second.', { toolCalls: [call('b', 'shell_run', { command: 'pwd' })] }),
      msg('tool', 'out', { toolName: 'shell_run', toolCallId: 'b' }),
      msg('assistant', 'Last.'),
    ],
  });
  assert.deepEqual(items.map(i => i.kind), ['owner', 'reply', 'tools', 'reply', 'tools', 'reply']);
  const replies = items.filter(i => i.kind === 'reply');
  assert.deepEqual(replies.map(r => r.kind === 'reply' && r.copyText), [null, null, 'First.\n\nSecond.\n\nLast.']);
});

test('ui/thread: 発言と返事に時刻を持たせる。返事の時刻と AI の名前は 1 回の返事の最後の文にだけ出す', () => {
  const items = threadItems({
    messages: [
      msg('user', 'go', { createdAt: 1000 }),
      msg('assistant', 'First.', { toolCalls: [call('a', 'shell_run', { command: 'ls' })], createdAt: 2000 }),
      msg('tool', 'out', { toolName: 'shell_run', toolCallId: 'a', createdAt: 2500 }),
      msg('assistant', 'Last.', { createdAt: 3000 }),
    ],
  });
  assert.deepEqual(items.map(i => (i.kind === 'owner' ? [i.kind, i.at] : i.kind === 'reply' ? [i.kind, i.at, i.stamped] : [i.kind])), [['owner', 1000], ['reply', 2000, false], ['tools'], ['reply', 3000, true]]);
  const live = threadItems({ messages: [msg('user', 'go'), msg('assistant', 'So far.', { runId: 'r9' })], draft: { runId: 'r9', conversationId: 'c', modelId: 'm', text: '' } });
  assert.deepEqual(live.filter(i => i.kind === 'reply').map(i => i.kind === 'reply' && i.stamped), [false], '作っている最中の回には、まだ時刻を出さない');
});

test('ui/thread: 時刻の書き方。今日は時刻だけ、別の日は日付つき、別の年は年つき。重ねると年月日とタイムゾーン（サーバーのタイムゾーンで）', () => {
  setTimezone('Asia/Tokyo');
  try {
    const now = Date.UTC(2026, 10, 12, 3, 0);
    assert.deepEqual(messageStamp(Date.UTC(2026, 10, 12, 0, 5), now), { text: '09:05', title: '2026/11/12 09:05 Asia/Tokyo (UTC+09:00)' });
    assert.equal(messageStamp(Date.UTC(2026, 10, 11, 14, 59), now)!.text, '11/11 23:59', '東京ではきのう');
    assert.equal(messageStamp(Date.UTC(2026, 10, 11, 15, 0), now)!.text, '00:00', '東京では今日（UTC ではきのう）');
    assert.equal(messageStamp(Date.UTC(2025, 11, 31, 3, 0), now)!.text, '2025/12/31 12:00');
    assert.equal(messageStamp(0, now), null, '時刻の無い発言には出さない');
    assert.equal(replyMeta('beat', messageStamp(Date.UTC(2026, 10, 12, 0, 5), now)), 'beat · 09:05');
    assert.equal(replyMeta(undefined, messageStamp(Date.UTC(2026, 10, 12, 0, 5), now)), '09:05', '名前がまだ読めていなければ時刻だけ');
    assert.equal(replyMeta('  ', null), '');
    setTimezone('America/New_York');
    assert.equal(messageStamp(Date.UTC(2026, 10, 12, 0, 5), now)!.text, '19:05', '設定のタイムゾーンで書く（ニューヨークでは同じ日の 19:05）');
  } finally { setTimezone('Asia/Tokyo'); }
});

test('ui/thread: 「考え中 N 秒」は待ち始めから 1 秒たってから。待ち始めが分からなければ出さない', () => {
  assert.equal(thinkingSeconds(null, 5000), null);
  assert.equal(thinkingSeconds(1000, 1900), null);
  assert.equal(thinkingSeconds(1000, 2000), 1);
  assert.equal(thinkingSeconds(1000, 13_999), 12);
  assert.equal(thinkingSeconds(5000, 1000), null, '時計がずれていても負の数は出さない');
});

test('ui/thread: 返事を作っている最中は、流れている文 → 動いている道具の行 → 何も無ければ caret だけ', () => {
  const base = [msg('user', 'go')];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '' };
  assert.deepEqual(threadItems({ messages: base, draft: { ...draft, text: 'Hel' } }).at(-1), { kind: 'live', key: 'live-r2', text: 'Hel', since: null });
  assert.deepEqual(threadItems({ messages: base, draft }).at(-1), { kind: 'live', key: 'live-r2', text: '', since: null });
  assert.deepEqual(threadItems({ messages: base, draft: { ...draft, waitingSince: 700 } }).at(-1), { kind: 'live', key: 'live-r2', text: '', since: 700 }, '待ち始めの時刻を「考え中 N 秒」のために渡す');
  const running = threadItems({ messages: base, draft: { ...draft, activeTool: 'shell_run', activeInput: '{"command":"npm test"}', toolStartedAt: 5 } }).at(-1)!;
  assert.ok(running.kind === 'tools');
  assert.deepEqual(running.rows[0]!.running, { startedAt: 5, checking: false, helperTools: null, helperConversation: null });
});

test('ui/thread: 動いている道具の行と、結果が届いたあとの行は同じキー（呼び出しの id）。まとまりのキーも変わらない（行が 2 回現れない）', () => {
  const base = [msg('user', 'go')];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '' };
  const running = threadItems({ messages: base, draft: { ...draft, activeTool: 'shell_run', activeInput: '{"command":"ls"}', toolCallId: 'call_9' } }).at(-1)!;
  const finished = threadItems({
    messages: [...base, msg('assistant', '', { toolCalls: [call('call_9', 'shell_run', { command: 'ls' })] }), msg('tool', 'out', { toolName: 'shell_run', toolCallId: 'call_9' })],
    draft,
  }).find(i => i.kind === 'tools')!;
  assert.ok(running.kind === 'tools' && finished.kind === 'tools');
  assert.deepEqual([running.key, running.rows[0]!.key], ['t-call_9', 't-call_9']);
  assert.deepEqual([finished.key, finished.rows[0]!.key], [running.key, running.rows[0]!.key]);
  const settled = { ...draft, settled: [{ callId: 'call_9', name: 'shell_run', input: '{"command":"ls"}' }] };
  const gap = threadItems({ messages: base, draft: settled }).find(i => i.kind === 'tools')!;
  assert.ok(gap.kind === 'tools');
  assert.deepEqual([gap.key, gap.rows.map(r => [r.key, r.result, r.running])], ['t-call_9', [['t-call_9', null, undefined]]], '結果が届いてから保存された発言を読むまでのあいだも、行は残る');
  const after = threadItems({ messages: [...base, msg('tool', 'out', { runId: 'r2', toolName: 'shell_run', toolCallId: 'call_9' })], draft: settled }).filter(i => i.kind === 'tools');
  assert.deepEqual(after.flatMap(i => (i.kind === 'tools' ? i.rows.map(r => r.result?.text) : [])), ['out'], '読んだあとは 1 行だけ');
  const unknown = threadItems({ messages: base, draft: { ...draft, activeTool: 'shell_run' } }).at(-1)!;
  assert.ok(unknown.kind === 'tools');
  assert.equal(unknown.rows[0]!.key, 'run-r2-shell_run', '呼び出しの id を知らないとき（つなぎ直しのあと）は今までのキー');
});

test('ui/thread: 現れる動きは、初めて見えてから 600ms のあいだ続ける（すぐ次の描き直しで消さない）。開いたときからある行（-∞）は動かさない', () => {
  assert.equal(isRising(undefined, 1000), true);
  assert.equal(isRising(900, 1000), true);
  assert.equal(isRising(400, 1000), false);
  assert.equal(isRising(Number.NEGATIVE_INFINITY, 0), false);
});

test('ui/thread: お知らせ: 静かなものは続けて並べず 1 行にまとめ、warn はそれぞれ 1 行、失敗（fail）は最後に 1 つだけ', () => {
  const n = (x: Partial<RunNotice> & Pick<RunNotice, 'kind'>): RunNotice => ({ runId: 'r', ...x }) as RunNotice;
  const rows = noticeRows([
    n({ kind: 'compaction', summarized: 4 }),
    n({ kind: 'memory', action: 'create', content: 'tea', eventId: 1 }),
    n({ kind: 'error', errorKind: 'timeout' }),
    n({ kind: 'switch', from: 'a', to: 'b', reason: 'x' }),
    n({ kind: 'stopped' }),
    n({ kind: 'interrupted' }),
    n({ kind: 'warning', code: 'retrying', message: 'm' }),
  ]);
  assert.deepEqual(rows.map(r => [r.weight, r.notices.map(x => x.kind)]), [
    ['quiet', ['compaction', 'memory']],
    ['warn', ['switch']],
    ['quiet', ['stopped', 'interrupted']],
    ['warn', ['warning']],
    ['fail', ['error']],
  ]);
});

test('ui/thread: 作業の一覧は 8 件までそのまま、超えたら済んだものを「N done」の 1 行にまとめる', () => {
  const items = (done: number, open: number): ChecklistItem[] => [
    ...Array.from({ length: done }, (_, i) => ({ text: `d${i}`, status: 'done' as const })),
    { text: 'now', status: 'in_progress' as const },
    ...Array.from({ length: open }, (_, i) => ({ text: `o${i}`, status: 'pending' as const })),
  ];
  assert.deepEqual(checklistShape(items(3, 4)), { total: 8, done: 3, doneHidden: 0, rows: items(3, 4) });
  const big = checklistShape(items(6, 3));
  assert.equal(big.total, 10);
  assert.equal(big.doneHidden, 6);
  assert.deepEqual(big.rows.map(r => r.text), ['now', 'o0', 'o1', 'o2']);
});

test('ui/thread: ContextMeter は 0〜100 に丸め、85 以上で high。読めない値は出さない', () => {
  assert.deepEqual(contextMeter(0.384), { value: 38, high: false });
  assert.deepEqual(contextMeter(0.85), { value: 85, high: true });
  assert.deepEqual(contextMeter(1.7), { value: 100, high: true });
  assert.equal(contextMeter(null), null);
  assert.equal(contextMeter(Number.NaN), null);
});

test('Markdown の画像: 読み込まず、http(s) のときだけホストを出す', () => {
  assert.equal(imageHost('https://example.com/a.png'), 'example.com');
  assert.equal(imageHost('http://192.168.0.2:8080/x'), '192.168.0.2:8080');
  assert.equal(imageHost(''), null);
  assert.equal(imageHost('/local.png'), null);
  assert.equal(imageHost('javascript:alert(1)'), null);
  assert.equal(imageHost('ftp://example.com/a.png'), null);
  assert.equal(imageHost(undefined), null);
});

test('ui/thread: plan_write で計画書を書いた実行が終わると、その実行の最後に「Plan written」の知らせを 1 つ出す。動いている実行・失敗した書き込み・別の道具には出さない', () => {
  const written = threadItems({
    messages: [
      msg('user', 'build me an uploader', { runId: 'p1' }),
      msg('assistant', '', { runId: 'p1', toolCalls: [call('w1', 'plan_write', { content: '# Plan' }), call('w2', 'plan_write', { content: '# Plan 2' })] }),
      msg('tool', 'Wrote plan.md', { runId: 'p1', toolName: 'plan_write', toolCallId: 'w1' }),
      msg('tool', 'Wrote plan.md', { runId: 'p1', toolName: 'plan_write', toolCallId: 'w2' }),
      msg('assistant', 'The plan is in the Plan pane.', { runId: 'p1' }),
      msg('user', 'thanks', { runId: 'p2' }),
      msg('assistant', 'ok', { runId: 'p2' }),
    ],
  });
  assert.deepEqual(written.map(i => i.kind), ['owner', 'tools', 'reply', 'plan', 'owner', 'reply']);
  assert.equal(written[3]!.key, 'plan-p1');

  const live = threadItems({
    messages: [
      msg('user', 'go', { runId: 'p3' }),
      msg('assistant', '', { runId: 'p3', toolCalls: [call('w3', 'plan_write', { content: '# Plan' })] }),
      msg('tool', 'Wrote plan.md', { runId: 'p3', toolName: 'plan_write', toolCallId: 'w3' }),
    ],
    draft: { runId: 'p3', conversationId: 'c', text: 'writing', activeTool: null } as never,
  });
  assert.ok(!live.some(i => i.kind === 'plan'), '実行の終わりまで出さない');

  const failed = threadItems({
    messages: [
      msg('user', 'go', { runId: 'p4' }),
      msg('assistant', '', { runId: 'p4', toolCalls: [call('w4', 'plan_write', { content: 'sk-' })] }),
      msg('tool', 'Refused', { runId: 'p4', toolName: 'plan_write', toolCallId: 'w4', isError: true }),
      msg('assistant', '', { runId: 'p4', toolCalls: [call('w5', 'file_read', { path: 'a' })] }),
      msg('tool', 'x', { runId: 'p4', toolName: 'file_read', toolCallId: 'w5' }),
      msg('assistant', 'Could not write it.', { runId: 'p4' }),
    ],
  });
  assert.ok(!failed.some(i => i.kind === 'plan'));
});

test('ui/thread: 保存された道具の結果と、流れている実行の済んだ道具は、どちらも gate（判定役の理由・Pending の番号・Not run）を行に運ぶ', () => {
  const items = threadItems({
    messages: [
      msg('user', 'go'),
      msg('assistant', '', { toolCalls: [call('a', 'shell_run', { command: 'ls' }), call('b', 'shell_run', { command: 'npm publish' })] }),
      msg('tool', 'ok', { toolName: 'shell_run', toolCallId: 'a', gate: { by: 'judge', reason: 'lists files' } }),
      msg('tool', 'Parked as #12 in Pending', { toolName: 'shell_run', toolCallId: 'b', gate: { by: 'pending', id: 12 } }),
    ],
  });
  const saved = items.find(i => i.kind === 'tools')!;
  assert.ok(saved.kind === 'tools');
  assert.deepEqual(saved.rows.map(r => r.gate), [{ by: 'judge', reason: 'lists files' }, { by: 'pending', id: 12 }]);
  const live = threadItems({
    messages: [msg('user', 'go', { runId: 'r2' })],
    draft: { runId: 'r2', conversationId: 'c', modelId: 'm', text: '', settled: [{ callId: 'x', name: 'agent_run', input: '{}', gate: { by: 'not-parked' } }], settledCount: 1 },
  }).find(i => i.kind === 'tools')!;
  assert.ok(live.kind === 'tools');
  assert.deepEqual(live.rows.map(r => r.gate), [{ by: 'not-parked' }]);
});

test('ui/thread: 会話の列は 1 つ（幅と左端が同じ）。持ち主の吹き出しは列の 85% まで、入力欄は発言の欄の両わきのスクロールバーの分だけ内へ寄せる（backlog 533、持ち主 2026-11-14）', () => {
  assert.equal(threadGutter({ offsetWidth: 600, clientWidth: 580 }), 10, '両わきに同じ幅の空きがあるので半分');
  assert.equal(threadGutter({ offsetWidth: 600, clientWidth: 600 }), 0, '重ねて出るスクロールバーなら 0');
  assert.equal(threadGutter({ offsetWidth: 600, clientWidth: 601 }), 0, '負にしない');
  const css = readFileSync(new URL('../web/src/ui/styles/frame.css', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../web/src/ui/Conversation.tsx', import.meta.url), 'utf8');
  assert.match(css, /\.bt-app__main \.bt-thread > \.bt-msg--owner \{[^}]*max-width: calc\(min\(100%, 720px\) \* 0\.85\);/u, '吹き出しの幅は発言の欄ではなく列（720px まで）の 85%');
  assert.match(css, /\.bt-app__main \.bt-composer \{[^}]*width: calc\(100% - 2 \* var\(--ui-gutter, 0px\)\);/u, '入力欄は発言の列と同じ幅');
  assert.match(css, /\.bt-app__main > \.ui-pinned \{[^}]*width: calc\(100% - 2 \* var\(--ui-gutter, 0px\)\);/u);
  assert.match(css, /\.bt-app__main > \.ui-offline \{[^}]*width: calc\(100% - 2 \* var\(--ui-gutter, 0px\)\);/u);
  assert.ok(page.includes("el.parentElement?.style.setProperty('--ui-gutter', `${threadGutter(el)}px`)"), '空きの幅は発言の欄から測って渡す');
});

test('ui/parts: 静かな知らせ・warn の知らせも、渡された text を題のあとに出す（Build が凍ったときの理由、フォルダが無い製品の説明。backlog 500）', () => {
  const parts = readFileSync(new URL('../web/src/ui/parts.tsx', import.meta.url), 'utf8');
  const quiet = parts.slice(parts.indexOf('<div className={`bt-notice${tone ?'), parts.indexOf('export function Toast('));
  assert.ok(quiet.includes('{text ? <span className="ui-notice__text">{title} · {text}</span> : title}'), 'fail 以外でも text を描く');
  const plan = readFileSync(new URL('../web/src/ui/panes/PlanPane.tsx', import.meta.url), 'utf8');
  assert.ok(plan.includes(`<Notice tone="warn" icon="alert" title={t('ui.plan.buildFrozen')} text={buildNotice.detail ?? undefined} />`), '凍ったときの理由を渡している');
});
