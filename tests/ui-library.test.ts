import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEvent, ReviewJob, RunRow, SkillVersion, ToolCallRow } from '../web/src/api.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  archivedLine, archivedNothing, durationText, filterLog, jobResult, latestEventByMemory, logFooter, logRows, memoryHistory, memoryStamp, runResult, skillHistory,
  tokensText, toolChoice, toolCounts, toolDecision, undoDeletes,
} from '../web/src/ui/library.ts';
import { maskTarget } from '../web/src/ui/tool-row.ts';

// 新しい画面の Library（steps/p1-ui.md の「画面」の Memory・Skills・Runs・Archived と PR 1-5a）の決まり。画面を持たない純粋な関数（web/src/ui/library.ts）。

const event = (id: number, action: string, extra: Partial<MemoryEvent> = {}): MemoryEvent =>
  ({ id, memory_id: 1, action, before: null, after: null, actor: 'clive', reason: null, undone_at: null, created_at: id * 10, ...extra });

test('ui/library: 記憶の一覧の行は、最後の変化が作成なら「誰が保存したか」、書き換えなら「誰が書き換えたか」と時刻', () => {
  const item = { origin: 'review', created_at: 5, updated_at: 50 };
  assert.deepEqual(memoryStamp(item, undefined), { who: 'beat', edited: false, at: 5 });
  assert.deepEqual(memoryStamp({ ...item, origin: 'user' }, event(1, 'create', { actor: 'user' })), { who: 'you', edited: false, at: 5 });
  assert.deepEqual(memoryStamp(item, event(4, 'update', { actor: 'user' })), { who: 'you', edited: true, at: 40 });
  assert.deepEqual(memoryStamp(item, event(4, 'update', { actor: 'review' })), { who: 'beat', edited: true, at: 40 });
  const latest = latestEventByMemory([event(2, 'update'), event(5, 'update', { memory_id: 2 }), event(3, 'update'), event(1, 'create')]);
  assert.equal(latest.get(1)!.id, 3);
  assert.equal(latest.get(2)!.id, 5);
});

test('ui/library: 記憶の History は新しい順。いちばん新しい変化は Undo、古い版で今と違う中身は Restore、消した・戻した・取り消し済みには付けない', () => {
  const events = [
    event(1, 'create', { after: 'v1' }),
    event(2, 'update', { before: 'v1', after: 'v2', actor: 'user' }),
    event(3, 'update', { before: 'v2', after: 'v3' }),
  ];
  const rows = memoryHistory(events, 'v3');
  assert.deepEqual(rows.map(r => [r.event.id, r.action, r.who]), [[3, 'undo', 'beat'], [2, 'restore', 'you'], [1, 'restore', 'beat']]);
  assert.deepEqual(memoryHistory([...events, event(4, 'update', { before: 'v3', after: 'v1', actor: 'user' })], 'v1').map(r => r.action), ['undo', 'restore', 'restore', null], '今と同じ中身の版（v1）には Restore を出さない');
  assert.equal(memoryHistory([event(1, 'create', { after: 'a' }), event(2, 'forget', { before: 'a' }), event(3, 'restore', { after: 'a' })], 'a')[0]!.action, null);
  assert.equal(memoryHistory([event(1, 'create', { after: 'a', undone_at: 9 })], 'a')[0]!.action, null);
});

const version = (id: string, at: number, who: SkillVersion['who'], body: string, description = 'd'): SkillVersion =>
  ({ id, at, who, lines: body ? body.split('\n').length : 0, description, body });

const writes = (rows: ReturnType<typeof skillHistory>) => rows.map(r => [r.version?.id ?? 'oldest', r.action, r.action === 'delete' ? null : r.target?.body ?? null]);

test('ui/library: スキルの History の Restore は、その行の変化が作った中身へ戻す（Memory と同じ）。Undo はいちばん新しい変化の前へ。最後の行はいちばん古い控えそのもの', () => {
  const current = { description: 'd', body: 'Z' };
  // beat-auto が X を登録 → 持ち主が Y に直す → 承認した下書きが Z に変える（控えは新しい順: Y・X・空）
  const rows = skillHistory([version('3-beat', 3, 'beat', 'Y'), version('2-you', 2, 'you', 'X'), version('1-beat-auto', 1, 'beat-auto', '', '')], current);
  assert.deepEqual(writes(rows), [['3-beat', 'undo', 'Y'], ['2-you', 'restore', 'Y'], ['1-beat-auto', 'restore', 'X'], ['oldest', 'delete', null]]);
  assert.deepEqual(rows.map(r => r.who), ['beat', 'you', 'beat', 'beat']);
  assert.equal(rows[2]!.created, true, '空の控えの次の変化は「作った」変化');
  assert.deepEqual([rows[0]!.delta, rows[1]!.delta], [{ added: 1, removed: 1 }, { added: 1, removed: 1 }]);
});

test('ui/library: スキルの History は、サーバーの並び（新しい順。同じミリ秒の控えも並びで決まる）のまま。今と同じ中身へ戻す行には出さない', () => {
  const current = { description: 'd', body: 'a\nb\nc' };
  const rows = skillHistory([version('1-beat-2', 1, 'beat', 'a\nb'), version('1-you', 1, 'you', 'a')], current);
  assert.deepEqual(writes(rows), [['1-beat-2', 'undo', 'a\nb'], ['1-you', 'restore', 'a\nb'], ['oldest', 'restore', 'a']]);
  assert.deepEqual(writes(skillHistory([version('1-you', 1, 'you', 'a\nb\nc')], current)), [['1-you', null, 'a\nb\nc'], ['oldest', null, 'a\nb\nc']]);
});

test('ui/library: 聞かずに登録した新しいスキル（控えが空の 1 つだけ）は、Undo ではなく Delete の 1 行。中身のある beat-auto の控えはふつうに戻せる', () => {
  const current = { description: 'd', body: 'x\ny' };
  const fresh = skillHistory([version('1-beat-auto', 1, 'beat-auto', '', '')], current);
  assert.deepEqual(fresh.map(r => [r.action, r.auto, r.created]), [['delete', true, true]]);
  assert.deepEqual(writes(skillHistory([version('1-beat-auto', 1, 'beat-auto', 'old')], current)), [['1-beat-auto', 'undo', 'old'], ['oldest', 'restore', 'old']]);
});

test('ui/library: 道具の方針は保存の直前に読み直した今の方針で決め直す。ほかで Block に締められていたら、Allow → Ask のつもりでも確かめを出す。確かめた緩め方と同じときだけ保存', () => {
  const fresh = (policy: 'allow' | 'ask' | 'block') => ({ name: 'shell_run', policy, configurable: true });
  assert.deepEqual(toolDecision(fresh('block'), 'ask', null), { kind: 'confirm', item: { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'block', to: 'ask' } });
  assert.deepEqual(toolDecision(fresh('allow'), 'ask', null), { kind: 'save' });
  const askedFromAsk = { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'ask', to: 'allow' } as const;
  assert.deepEqual(toolDecision(fresh('ask'), 'allow', askedFromAsk), { kind: 'save' });
  assert.deepEqual(toolDecision(fresh('block'), 'allow', askedFromAsk), { kind: 'confirm', item: { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'block', to: 'allow' } }, '確かめたあとに締められていたら、もう一度');
  assert.deepEqual(toolDecision(fresh('allow'), 'allow', askedFromAsk), { kind: 'none' });
});

test('ui/library: 道具の方針を緩める（Block → Ask・Allow、Ask → Allow）ときは、設定の「広がる変更」と同じ確かめ（toolPolicyLoosened）を出す。締めるときはすぐ保存、変えられない道具は何もしない', () => {
  const tool = (policy: 'allow' | 'ask' | 'block', configurable = true) => ({ name: 'shell_run', policy, configurable });
  assert.deepEqual(toolChoice(tool('block'), 'allow'), { kind: 'confirm', item: { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'block', to: 'allow' } });
  assert.deepEqual(toolChoice(tool('ask'), 'allow'), { kind: 'confirm', item: { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'ask', to: 'allow' } });
  assert.deepEqual(toolChoice(tool('block'), 'ask'), { kind: 'confirm', item: { kind: 'tool-policy-loosened', tool: 'shell_run', from: 'block', to: 'ask' } });
  assert.deepEqual(toolChoice(tool('allow'), 'ask'), { kind: 'save' });
  assert.deepEqual(toolChoice(tool('ask'), 'block'), { kind: 'save' });
  assert.deepEqual(toolChoice(tool('ask'), 'ask'), { kind: 'none' });
  assert.deepEqual(toolChoice(tool('allow', false), 'block'), { kind: 'none' });
  assert.deepEqual(toolCounts([tool('allow'), tool('allow'), tool('ask'), tool('block')]), { allow: 2, ask: 1, block: 1 });
});

const runRow = (id: string, at: number, extra: Partial<RunRow> = {}): RunRow => ({
  id, kind: 'chat', conversation_id: 'c1', model_id: 'm', attempts: 1, started_at: at, duration_ms: 1000, ok: 1, error_kind: null, error_message: null,
  input_tokens: 1000, output_tokens: 200, cache_read_tokens: null, est_prompt_tokens: null, flags: [], ...extra,
});
const callRow = (id: string, at: number, extra: Partial<ToolCallRow> = {}): ToolCallRow => ({
  id, run_id: 'r1', conversation_id: 'c1', tool: 'shell_run', input: JSON.stringify({ command: 'npm test' }), decision: 'allow', decided_by: 'policy',
  approval_id: null, ok: 1, duration_ms: 8100, output_preview: null, full_ref: null, created_at: at, autoReason: null, grantFolder: null, ...extra,
});
const job = (id: number, at: number, status: ReviewJob['status'], extra: Partial<ReviewJob> = {}): ReviewJob => ({
  id, trigger: 'idle', triggerLabel: 'idle', status, note: null, conversation_id: null, task_id: null, run_id: null, created_at: at, finished_at: null, changes: [], ...extra,
});

test('ui/library: Runs は実行・道具・振り返りを時刻の新しい順に 1 つの表にする。What は題か道具と対象、Result は Running・Ok・Failed・Stopped・Fallback・Queued', () => {
  const rows = logRows({
    runs: [runRow('r1', 100), runRow('r2', 300, { ok: null, conversation_id: null, kind: 'task' }), runRow('r3', 50, { flags: ['fallback'] })],
    calls: [callRow('t1', 200)],
    jobs: [job(1, 250, 'pending', { note: 'saved 1' }), job(2, 10, 'done', { run_id: 'r3', finished_at: 2010 })],
    runLabel: kind => kind.toUpperCase(),
    titleOf: id => (id === 'c1' ? 'Shape the plan' : null),
  });
  assert.deepEqual(rows.map(r => r.key), ['run:r2', 'review:1', 'tool:t1', 'run:r1', 'run:r3', 'review:2']);
  assert.deepEqual(rows.map(r => r.result), ['running', 'queued', 'ok', 'ok', 'fallback', 'ok']);
  assert.equal(rows[0]!.what, 'TASK');
  assert.equal(rows[2]!.what, 'shell_run · npm test');
  assert.equal(rows[3]!.what, 'CHAT · Shape the plan');
  assert.equal(rows[3]!.tokens, 1200);
  assert.equal(rows[5]!.model, 'm', '振り返りのモデルは、その実行の記録から');
  assert.equal(rows[5]!.durationMs, 2000);
  assert.deepEqual(filterLog(rows, 'tool').map(r => r.key), ['tool:t1']);
  assert.deepEqual(filterLog(rows, 'review').map(r => r.key), ['review:1', 'review:2']);
  assert.equal(runResult({ ok: 0, error_kind: 'timeout', flags: ['fallback'] }), 'failed');
  assert.equal(runResult({ ok: 0, error_kind: 'cancelled', flags: [] }), 'stopped');
  assert.equal(jobResult('running'), 'running');
  assert.equal(jobResult('failed'), 'failed');
});

test('ui/library: 道具の行の対象に秘密が混ざっていても伏せる（Runs の What）', () => {
  const rows = logRows({ runs: [], calls: [callRow('t', 1, { tool: 'web_fetch', input: JSON.stringify({ url: 'https://x.test/a?api_key=SECRET123' }) })], jobs: [], runLabel: k => k, titleOf: () => null });
  assert.equal(rows[0]!.what.includes('SECRET123'), false);
});

test('ui/library: 件数の 1 行は「今日の分で出ている行 of 今日の全体」。絞り込みに合わせ、全体は 3 つの API の total の和', () => {
  const rows = logRows({ runs: [runRow('a', 1000), runRow('b', 10)], calls: [callRow('c', 2000)], jobs: [job(1, 3000, 'done')], runLabel: k => k, titleOf: () => null });
  const totals = { run: 40, tool: 1200, review: 3 };
  assert.deepEqual(logFooter(rows, 'all', totals, 500), { shown: 3, total: 1243 });
  assert.deepEqual(logFooter(rows, 'run', totals, 500), { shown: 1, total: 40 });
  assert.deepEqual(logFooter(rows, 'tool', { run: 0, tool: 0, review: 0 }, 500), { shown: 1, total: 1 }, '全体が出ている行より少なく見えることはない');
});

test('ui/library: 長さは 1 分未満が秒（8.1s）、それ以上は 0:42 の形。トークンは 1000 から k', () => {
  assert.equal(durationText(null), '—');
  assert.equal(durationText(8100), '8.1s');
  assert.equal(durationText(42_000), '42.0s');
  assert.equal(durationText(62_000), '1:02');
  assert.equal(durationText(3_723_000), '1:02:03');
  assert.equal(tokensText(null), '—');
  assert.equal(tokensText(612), '612');
  assert.equal(tokensText(18_200), '18.2k');
});

test('ui/library: しまった会話の行は、メッセージ数としまった時刻（1-5s より前にしまったものは時刻なし）', () => {
  assert.deepEqual(archivedLine({ message_count: 48, archived_at: 123 }), { messages: 48, archivedAt: 123 });
  assert.deepEqual(archivedLine({ message_count: 3, archived_at: null }), { messages: 3, archivedAt: null });
  assert.deepEqual(archivedLine({}), { messages: null, archivedAt: null });
});

test('ui/library: しまった会話が 1 つも無いときは "Nothing archived" の 1 行だけ。探して見つからないだけのとき・打っている途中は検索の欄を残す', () => {
  assert.equal(archivedNothing([], '', ''), true);
  assert.equal(archivedNothing(null, '', ''), false, 'まだ読めていない');
  assert.equal(archivedNothing([{}], '', ''), false);
  assert.equal(archivedNothing([], 'zz', 'zz'), false, '探して見つからない');
  assert.equal(archivedNothing([], 'zz', ''), false, '欄を空にした直後（まだ前の検索の結果）は欄を消さない');
  assert.equal(archivedNothing([], '', 'z'), false, '打ち始めた');
});

test('ui/library: 記憶の History のいちばん新しい行が「作成」のときの Undo は記憶を消すので、Delete と同じ確かめを通す', () => {
  const [created] = memoryHistory([event(1, 'create', { after: 'a' })], 'a');
  assert.equal(created!.action, 'undo');
  assert.equal(undoDeletes(created!), true);
  const [edited, first] = memoryHistory([event(2, 'update', { after: 'b' }), event(1, 'create', { after: 'a' })], 'b');
  assert.equal(undoDeletes(edited!), false, '書き換えの Undo は前の中身へ戻すだけ');
  assert.equal(undoDeletes(first!), false, '古い行の Restore は消さない');
});

test('ui/library: Runs の振り返りの行は、What の列でも秘密を伏せる（詳細も同じ関数を通す）', () => {
  const job = { id: 1, status: 'done', triggerLabel: 'After a session', note: 'saw https://user:hunter2secret@example.com/x', created_at: 1, finished_at: 2, run_id: null, changes: [] } as unknown as ReviewJob;
  const [row] = logRows({ runs: [], calls: [], jobs: [job], runLabel: k => k, titleOf: () => null });
  assert.equal(row!.what.includes('hunter2secret'), false);
  assert.equal(maskTarget(job.note!).includes('hunter2secret'), false);
  const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'screens', 'Runs.tsx'), 'utf8');
  assert.equal(source.includes('{job.note}'), false, '詳細に生の note を出さない');
});
