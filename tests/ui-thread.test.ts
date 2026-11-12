import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Approval, ChecklistItem, Message } from '../web/src/api.ts';
import { imageHost } from '../web/src/markdown-image.ts';
import type { RunNotice } from '../web/src/ui/live-state.ts';
import { checklistShape, contextMeter, noticeRows, threadItems } from '../web/src/ui/thread.ts';

// 新しい画面の会話（p1-ui.md の「会話」）: 発言・返事・道具の行のまとまり・流れている返事・承認の行・お知らせの並びを作る純粋な関数。

let next = 1;
const msg = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ id: next++, role, text, runId: 'r1', createdAt: 0, ...extra });
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const approval = (id: string): Approval => ({
  id, runId: 'r2', conversationId: 'c', tool: 'file_write', title: 'Write x.txt', body: 'x', reasons: [], details: [], paths: [], expiresAt: 0, onceOnly: false, preview: [],
});

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

test('ui/thread: 返事を作っている最中は、流れている文 → 動いている道具の行 → 何も無ければ caret だけ。承認を待つ間は道具の行の代わりに承認の行', () => {
  const base = [msg('user', 'go')];
  const draft = { runId: 'r2', conversationId: 'c', modelId: 'm', text: '' };
  assert.deepEqual(threadItems({ messages: base, draft: { ...draft, text: 'Hel' } }).at(-1), { kind: 'live', key: 'live-r2', text: 'Hel' });
  assert.deepEqual(threadItems({ messages: base, draft }).at(-1), { kind: 'live', key: 'live-r2', text: '' });
  const running = threadItems({ messages: base, draft: { ...draft, activeTool: 'shell_run', activeInput: '{"command":"npm test"}', toolStartedAt: 5 } }).at(-1)!;
  assert.ok(running.kind === 'tools');
  assert.deepEqual(running.rows[0]!.running, { startedAt: 5, checking: false, helperTools: null, helperConversation: null });
  const waiting = threadItems({ messages: base, draft: { ...draft, activeTool: 'file_write' }, approvals: [approval('a1')] }).at(-1)!;
  assert.ok(waiting.kind === 'tools');
  assert.deepEqual(waiting.rows.map(r => [r.key, r.approval?.id, r.running]), [['approval-a1', 'a1', undefined]]);
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
  const unknown = threadItems({ messages: base, draft: { ...draft, activeTool: 'shell_run' } }).at(-1)!;
  assert.ok(unknown.kind === 'tools');
  assert.equal(unknown.rows[0]!.key, 'run-r2-shell_run', '呼び出しの id を知らないとき（つなぎ直しのあと）は今までのキー');
});

test('ui/thread: お知らせ: 静かなものは続けて並べず 1 行にまとめ、warn はそれぞれ 1 行、失敗（fail）は最後に 1 つだけ', () => {
  const n = (x: Partial<RunNotice> & Pick<RunNotice, 'kind'>): RunNotice => ({ runId: 'r', ...x }) as RunNotice;
  const rows = noticeRows([
    n({ kind: 'compaction', summarized: 4 }),
    n({ kind: 'memory', action: 'create', content: 'tea', eventId: 1 }),
    n({ kind: 'error', errorKind: 'timeout' }),
    n({ kind: 'switch', from: 'a', to: 'b', reason: 'x' }),
    n({ kind: 'stopped' }),
    n({ kind: 'auto', tool: 'file_read', reason: '' }),
    n({ kind: 'warning', code: 'retrying', message: 'm' }),
  ]);
  assert.deepEqual(rows.map(r => [r.weight, r.notices.map(x => x.kind)]), [
    ['quiet', ['compaction', 'memory']],
    ['warn', ['switch']],
    ['quiet', ['stopped', 'auto']],
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
