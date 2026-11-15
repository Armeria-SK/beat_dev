import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { ApiError, type ModelView, type Probe } from '../web/src/api.ts';
import {
  firstLine, liveRenderDelay, replyTurns, isNearBottom, isRenameWithoutTitle, newConversationId, renameTitleOf,
  mergeNotice, SLASH_COMMANDS, sendChoiceOf, sendFailureOf, TextThrottle,
} from '../web/src/chat-logic.ts';
import { en } from '../web/src/i18n/en.ts';
import { setTimezone } from '../web/src/i18n/index.ts';
import { undoMemoryEvent } from '../web/src/memory-undo.ts';

const reset = () => { setTimezone('Asia/Tokyo'); };
afterEach(reset);

const probe = (patch: Partial<Probe> = {}): Probe => ({
  modelId: 'm', status: 'too_small', server: 'generic', declared: 8192, measured: 8192, modelMax: 32768, effective: 8192, required: 17260,
  message: 'too small', checkedAt: 1, ...patch,
});
const model = (id: string, patch: Partial<ModelView> = {}): ModelView => ({
  id, label: id, provider: 'p', model: `${id}-name`, minContext: 4096, maxOutputTokens: 512, inChat: true, probe: null, ...patch,
});

test('sendFailureOf: ApiError の 409 は context と見分け、ApiError 以外は渡された代わりの文にする', () => {
  const overflow = sendFailureOf(new ApiError(409, { error: 'context_overflow', errorKind: 'context_overflow', errorMessage: 'ダメ', detail: { hint: '直す' } }), 'x');
  assert.deepEqual({ message: overflow.message, hint: overflow.hint, context: overflow.context }, { message: 'ダメ', hint: '直す', context: true });
  const busy = sendFailureOf(new ApiError(409, { error: 'busy', message: '返事中' }), 'x');
  assert.deepEqual({ message: busy.message, hint: busy.hint, context: busy.context }, { message: '返事中', hint: null, context: false });
  const network = sendFailureOf(new TypeError('fetch failed'), '送れませんでした');
  assert.deepEqual({ message: network.message, hint: network.hint, context: network.context }, { message: '送れませんでした', hint: null, context: false });
});

test('slash の説明文は、全コマンドぶん en にある', () => {
  assert.deepEqual(SLASH_COMMANDS.map(c => c.name), ['new', 'task', 'tasks', 'skills', 'log', 'memory', 'stop', 'rename', 'archive', 'summary']);
  for (const command of SLASH_COMMANDS) {
    assert.ok(en[command.desc].length > 0, `en: ${command.desc}`);
  }
});

test('renameTitleOf / isRenameWithoutTitle: /rename のあとの題だけを取り出す', () => {
  assert.equal(renameTitleOf('/rename 新しい題'), '新しい題');
  assert.equal(renameTitleOf('  /rename   前後の空白は除く  '), '前後の空白は除く');
  assert.equal(renameTitleOf('/rename 改行を\n含む題'), '改行を\n含む題');
  assert.equal(renameTitleOf('/rename'), null);
  assert.equal(renameTitleOf('/rename   '), null);
  assert.equal(renameTitleOf('/renameX 題'), null, '別のコマンド名は拾わない');
  assert.equal(renameTitleOf('普通の発言 /rename 題'), null);
  assert.equal(renameTitleOf(`/rename ${'a'.repeat(500)}`)?.length, 200, 'サーバーの上限（200 字）に切る');
  assert.equal(isRenameWithoutTitle('/rename'), true);
  assert.equal(isRenameWithoutTitle('/rename '), true);
  assert.equal(isRenameWithoutTitle('/rename x'), false);
});

test('firstLine: 結果の最初の空でない行を、長ければ切って返す', () => {
  assert.equal(firstLine('\n\n  結果です\n2 行目'), '結果です');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('x'.repeat(200)).length, 161);
});

test('isNearBottom: 下から 80px 以内にいるときだけ、新しい発言へ自動で追いかける', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 520 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 }), true, '短くて全部見えているとき');
});

test('undoMemoryEvent: 取り消しが通ったときだけ「取り消し済み」になり、同じ出来事は二度送らない', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url).includes('/9001/') ? Response.json({ ok: true }) : Response.json({ error: 'nope' }, { status: 500 });
  }) as typeof fetch;
  try {
    assert.equal(await undoMemoryEvent(9002), false, '失敗したときは false');
    assert.equal(await undoMemoryEvent(9001), true);
    assert.equal(await undoMemoryEvent(9001), true, '取り消し済みなら、もう一度は送らない');
    assert.deepEqual(calls, ['/api/memory-events/9002/undo', '/api/memory-events/9001/undo']);
  } finally { globalThis.fetch = original; }
});

test('mergeNotice: 同じ実行の同じ key のお知らせは置き換え、key が無い・違うものは並べる。多すぎたら古いものから落とす', () => {
  type N = { runId: string; message: string; key?: string };
  const a: N = { runId: 'r1', key: 'compaction', message: '要約 4 件' };
  const warn: N = { runId: 'r1', message: '再試行' };
  assert.deepEqual(mergeNotice([a, warn], { runId: 'r1', key: 'compaction', message: '要約 9 件' }), [{ runId: 'r1', key: 'compaction', message: '要約 9 件' }, warn], '位置は元のまま、内容だけ更新');
  assert.deepEqual(mergeNotice([a], { runId: 'r2', key: 'compaction', message: '別の実行' }).map(n => n.message), ['要約 4 件', '別の実行'], '実行が違えば並べる');
  assert.equal(mergeNotice([a], { runId: 'r1', message: '再試行' }).length, 2, 'key が無いものは並べる');
  assert.equal(mergeNotice([warn, warn], { runId: 'r1', message: 'x' }, 3).length, 3);
  assert.deepEqual(mergeNotice([warn, a], { runId: 'r1', message: 'x' }, 2).map(n => n.message), ['要約 4 件', 'x'], '多すぎたら古いものから');
});

test('辞書: 段階 5 の英語に日本語が混ざらず、関数の文は引数を使う', () => {
  const kana = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const keys = Object.keys(en).filter(k => /^(chat|approval|slash|markdown|ui\.(notice|approval|composer|tool|thread))\./u.test(k));
  assert.ok(keys.length > 80, `会話のキーが ${keys.length} 件しか読めていない`);
  for (const key of keys) {
    const entry = (en as Record<string, unknown>)[key];
    const out = typeof entry === 'function' ? (entry as (...a: unknown[]) => string)('x', 3) : entry;
    assert.equal(typeof out, 'string', key);
    assert.ok(!kana.test(String(out)), `${key} の英語に日本語が混ざっている: ${String(out)}`);
  }
});

test('liveRenderDelay: 短い返事は届くたびに描き、長い返事は長さに比例して間引く（上限 1 秒）', () => {
  assert.equal(liveRenderDelay(0), 0);
  assert.equal(liveRenderDelay(2999), 0, '3,000 文字までは、これまでどおり届くたびに描く');
  assert.equal(liveRenderDelay(3000), 30);
  assert.equal(liveRenderDelay(10_000), 100);
  assert.equal(liveRenderDelay(50_000), 500);
  assert.equal(liveRenderDelay(1_000_000), 1000, '上限は 1 秒');
  const lengths = [3000, 6000, 12_000, 25_000, 50_000, 100_000];
  const delays = lengths.map(liveRenderDelay);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]!), '長いほど間隔は広い（縮まない）');
});

test('replyTurns: 1 回の返事（同じ runId）は見出し 1 つ。中間の文は見出しなしで続き、コピーは最後の文に 1 つ（その回の文を全部まとめる）', () => {
  const m = (id: number, role: string, runId: string | null, text = '') => ({ id, role, runId, text });
  const one = [
    m(1, 'user', null, '調べて'), m(2, 'assistant', 'r1', '調べます。'), m(3, 'tool', 'r1'), m(4, 'assistant', 'r1', '原因がほぼ確定しました。'), m(5, 'tool', 'r1'), m(6, 'assistant', 'r1', '以上です。'),
  ];
  const turns = replyTurns(one);
  assert.deepEqual([2, 4, 6].map(id => turns.get(id)?.head), [true, false, false], '見出しは最初の文だけ');
  assert.deepEqual([2, 4, 6].map(id => turns.get(id)?.copyText), [null, null, '調べます。\n\n原因がほぼ確定しました。\n\n以上です。'], 'コピーは最後に 1 つ');
  assert.equal(turns.has(1) || turns.has(3), false, '発言と道具の行は対象外');

  const live = replyTurns(one, 'r1');
  assert.deepEqual([2, 4, 6].map(id => live.get(id)?.head), [true, false, false]);
  assert.equal(live.get(6)?.copyText, null, 'まだ続いている最中の返事には、コピーを付けない');
  assert.equal(replyTurns(one, 'other').get(6)?.copyText !== null, true, '別の実行が動いていても関係ない');

  const two = replyTurns([...one, m(7, 'user', null, 'ありがとう'), m(8, 'assistant', 'r2', 'どういたしまして')]);
  assert.equal(two.get(8)?.head, true, '次の発言のあとは、新しい返事');
  assert.equal(two.get(8)?.copyText, 'どういたしまして');
  assert.equal(two.get(2)?.head, true);

  const mixed = replyTurns([m(1, 'assistant', 'r1', 'a'), m(2, 'assistant', 'r2', 'b'), m(3, 'assistant', null, 'c'), m(4, 'assistant', null, 'd')]);
  assert.deepEqual([1, 2, 3, 4].map(id => mixed.get(id)?.head), [true, true, true, true], '別の runId・runId の無い文は、それぞれが 1 回の返事');
  assert.deepEqual([1, 2, 3, 4].map(id => mixed.get(id)?.copyText), ['a', 'b', 'c', 'd']);
});

test('sendFailureOf: 「使えるモデルがない」の 409 は、problems の行を、同じ状態のモデルの確認（コード付き）から画面の言語で組み立て直す', async () => {
  const { errorProbeText } = await import('../src/providers/context.ts');
  const { providerError } = await import('../src/providers/types.ts');
  const { engineText } = await import('../src/shared/messages/engine.ts');
  const served = errorProbeText(providerError('provider_error', 'connect', {}), 'en');
  const SERVER_LINE = 'the line as the server wrote it';
  const unreachable = probe({ modelId: 'local', status: 'unreachable', message: SERVER_LINE, ...(served.messageCode ? { messageCode: served.messageCode } : {}), ...(served.messageParams ? { messageParams: served.messageParams as Record<string, string | number> } : {}) });
  const body = {
    error: 'provider_error', errorKind: 'provider_error', errorCode: 'engine.no_usable',
    errorMessage: engineText('en', 'no_usable', { lines: engineText('en', 'problem.line', { id: 'local', message: SERVER_LINE, hintPart: '' }) }),
    problems: [{ modelId: 'local', status: 'unreachable', message: SERVER_LINE }],
  };
  const models = [model('local', { probe: unreachable })];
  const expectedEn = engineText('en', 'no_usable', { lines: engineText('en', 'problem.line', { id: 'local', message: 'Cannot connect to the provider', hintPart: '' }) });

  assert.equal(sendFailureOf(new ApiError(409, body), 'x', models).message, expectedEn, '画面はサーバーの書いた行ではなく、コードから組み立てる');
  assert.notEqual(sendFailureOf(new ApiError(409, body), 'x', models).message, body.errorMessage);

  assert.equal(sendFailureOf(new ApiError(409, body), 'x', []).message.includes('Nothing was sent'), true, 'モデルの確認が無くても、問題の文はサーバーのままで枠は英語');
  const stale = [model('local', { probe: { ...unreachable, status: 'ok' } })];
  assert.equal(sendFailureOf(new ApiError(409, body), 'x', stale).message.includes(SERVER_LINE), true, '状態が違う確認は使わず、サーバーの行のまま');
  const withHint = { ...body, problems: [{ modelId: 'local', status: 'unreachable', message: SERVER_LINE, hint: '直し方' }] };
  assert.equal(sendFailureOf(new ApiError(409, withHint), 'x', models).message.includes('(直し方)'), true, 'hint は付く（英語の括弧）');
  const none = { ...body, problems: [] };
  assert.equal(sendFailureOf(new ApiError(409, none), 'x', models).message, engineText('en', 'no_usable', { lines: engineText('en', 'problem.none') }));
  const other = { error: 'busy', errorMessage: '忙しい', errorCode: 'engine.send.busy' };
  assert.equal(sendFailureOf(new ApiError(409, other), 'x', models).message, engineText('en', 'send.busy'), 'ほかのコードは ApiError の訳のまま');
  const coded = { ...body, problems: [{ modelId: 'local', status: 'unreachable', message: SERVER_LINE, messageCode: served.messageCode, messageParams: served.messageParams }] };
  assert.equal(sendFailureOf(new ApiError(409, coded), 'x', []).message, expectedEn, 'problems 自身にコードが付いていれば、モデルの一覧が無くても英語');
  const wrongStatus = { models: [model('local', { probe: { ...unreachable, status: 'ok', messageCode: 'provider.probe.unknown' } })] };
  assert.equal(sendFailureOf(new ApiError(409, coded), 'x', wrongStatus.models).message, expectedEn, 'コードがあれば、モデルの一覧の状態には頼らない');
  const otherWithProblems = { ...body, errorCode: 'engine.send.busy', problems: body.problems };
  assert.equal(sendFailureOf(new ApiError(409, otherWithProblems), 'x', models).message, engineText('en', 'send.busy'), 'problems があっても、「使えるモデルがない」以外のコードは組み立て直さない');
  const unknown = { ...body, problems: [{ nope: true }] };
  assert.equal(sendFailureOf(new ApiError(409, unknown), 'x', models).message, new ApiError(409, unknown).message);
});

test('sendFailureOf: モデルが 1 つも無い 409（problems が空）だけ noModels になり、「モデルを設定する」案内を出せる', () => {
  const none = { error: 'provider_error', errorKind: 'provider_error', errorCode: 'engine.no_usable', errorMessage: '使えるモデルがないため送信しませんでした', problems: [] };
  assert.equal(sendFailureOf(new ApiError(409, none), 'x', []).noModels, true);
  const broken = { ...none, problems: [{ modelId: 'local', status: 'unreachable', message: '接続できません' }] };
  assert.equal(sendFailureOf(new ApiError(409, broken), 'x', []).noModels, false, 'モデルがあるけれど使えないときは、設定を開くだけ');
  assert.equal(sendFailureOf(new ApiError(409, { error: 'busy', errorCode: 'engine.send.busy', problems: [] }), 'x', []).noModels, false);
  assert.equal(sendFailureOf(new Error('x'), 'x', []).noModels, false);
});

test('sendChoiceOf: 新しい会話の最初の発言は、画面で覚えている選びを一緒に送る。使えるモデルで送る道は、押したモデルを明示して送る（覚えている古い選びは使わない）', () => {
  const stale = { modelId: 'broken', effort: 'high' };
  assert.deepEqual(sendChoiceOf(null, stale), { modelId: 'broken', effort: 'high' }, '新しい会話: 画面の選びを送る');
  assert.deepEqual(sendChoiceOf(null, { modelId: null, effort: null }), {}, '自動のまま');
  assert.deepEqual(sendChoiceOf('c1', stale), {}, '会話があれば、サーバーが覚えているので送らない');
  assert.deepEqual(sendChoiceOf(null, stale, { modelId: 'alt' }), { modelId: 'alt' }, '新しい会話でも、押したモデルを送る（覚えている選びや考える深さは持ち越さない）');
  assert.deepEqual(sendChoiceOf('c1', stale, { modelId: 'alt' }), { modelId: 'alt' }, '会話があるときも、押したモデルを一緒に送って会話に覚えさせる');
  assert.deepEqual(sendChoiceOf(null, stale, { modelId: 'alt', effort: 'low' }), { modelId: 'alt', effort: 'low' });
});

test('sendChoiceOf: 権限モードは、新しい会話の最初の発言にだけ、auto 以外のときに添える。会話があれば送らない。「この計画で進める」のように押した選びは、そのまま送る', () => {
  const none = { modelId: null, effort: null };
  assert.deepEqual(sendChoiceOf(null, { ...none, permissionMode: 'plan' }), { permissionMode: 'plan' });
  assert.deepEqual(sendChoiceOf(null, { ...none, permissionMode: 'auto' }), {}, 'auto は送らない（新しい会話はいつも auto から）');
  assert.deepEqual(sendChoiceOf(null, none), {});
  assert.deepEqual(sendChoiceOf('c1', { ...none, permissionMode: 'auto' }), {}, '会話があれば、サーバーが覚えている');
  assert.deepEqual(sendChoiceOf('c1', { ...none, permissionMode: 'plan' }, { permissionMode: 'auto' }), { permissionMode: 'auto' }, '計画から進めるときは、auto に戻す選びを一緒に送る');
  assert.deepEqual(sendChoiceOf(null, { modelId: 'm', effort: 'low', permissionMode: 'plan' }), { modelId: 'm', effort: 'low', permissionMode: 'plan' });
});

test('sendChoiceOf（3-1a）: 新しい製品の会話の最初の発言は、auto でも権限モードを送る（送らないとサーバーが計画モードにするので、持ち主の選んだ auto を区別する）', () => {
  const none = { modelId: null, effort: null };
  assert.deepEqual(sendChoiceOf(null, { ...none, permissionMode: 'auto' }, undefined, true), { permissionMode: 'auto' });
  assert.deepEqual(sendChoiceOf(null, none, undefined, true), { permissionMode: 'auto' }, 'モードが分からなければ auto として送る');
  assert.deepEqual(sendChoiceOf(null, { ...none, permissionMode: 'plan' }, undefined, true), { permissionMode: 'plan' });
  assert.deepEqual(sendChoiceOf('c1', { ...none, permissionMode: 'auto' }, undefined, true), {}, '会話があれば、サーバーが覚えている');
  assert.deepEqual(sendChoiceOf(null, { ...none, permissionMode: 'auto' }, undefined, false), {}, '製品に属さない会話は今までどおり');
});

test('newConversationId: 新しい会話の id は UUID v4 の形（http の画面で randomUUID が無くても）', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  assert.match(newConversationId(), uuid, 'ふつうの環境（randomUUID がある）');
  const insecure = { getRandomValues: (bytes: Uint8Array) => { bytes.fill(255); return bytes; } };
  assert.match(newConversationId(insecure), uuid, 'http の画面（randomUUID が無い）でも UUID v4 の形になる');
  assert.equal(newConversationId(insecure), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

// 時計と待ちを差し替えて、画面の部品（useThrottledText）と同じ流れを動かす: 描く → 待ちを置く → 鳴ったら描き直す
function drive(initial: string) {
  const state = { clock: 0, redraws: 0, pending: undefined as { fn: () => void; at: number } | undefined, cancelled: 0 };
  const throttle = new TextThrottle(initial);
  const timers = {
    now: () => state.clock,
    redraw: () => { state.redraws++; },
    setTimer: (fn: () => void, ms: number) => { state.pending = { fn, at: state.clock + ms }; const mine = state.pending; return () => { if (state.pending === mine) { state.pending = undefined; state.cancelled++; } }; },
  };
  let cancel: (() => void) | undefined;
  let lastText: string | undefined;
  // 描く（届いた文で描き直す）→ 前の待ちを止めて、必要なら新しい待ちを置く
  const render = (text: string, at: number): string => {
    state.clock = at;
    const drawn = throttle.next(text, at);
    // useEffect(…, [text]) と同じ: 文が変わったときだけ、前の待ちを止めて置き直す
    if (text !== lastText) { cancel?.(); cancel = throttle.arm(text, timers); lastText = text; }
    return drawn;
  };
  // 待ちが鳴る（鳴る時刻を ms 早める・遅らせるを指定できる）
  const ring = (offset: number): void => {
    const pending = state.pending;
    assert.ok(pending, '待ちが置かれていない');
    state.pending = undefined;
    state.clock = pending.at + offset;
    pending.fn();
  };
  return { state, throttle, render, ring };
}

test('流れている文の間引き: 時計が少し早く鳴っても、届いた残りは必ず描かれる（描き残さない）', () => {
  const T1 = 'あ'.repeat(5000);
  const T2 = `${T1}${'い'.repeat(300)}`;
  for (const offset of [0, -0.4, -1, -30, 5]) {
    const d = drive('');
    assert.equal(d.render(T1, 1000), T1, '間隔が過ぎていれば、すぐ描く');
    assert.equal(d.render(T2, 1010), T1, '間隔の内に届いた分は、まだ描かない');
    assert.ok(d.state.pending, '残りを描く待ちが置かれている');
    d.ring(offset);
    assert.equal(d.state.redraws, 1, `鳴ったら描き直しを頼む（${offset} ms）`);
    // 描き直しで描く文（時計が早かった場合も、残りは描いてある）
    assert.equal(d.render(T2, d.state.clock), T2, `鳴る時刻が ${offset} ms ずれても、残りを描く`);
    assert.equal(d.state.pending, undefined, '描き終えたら、もう待ちは要らない');
  }
});

test('流れている文の間引き: 短い返事は届くたびに描き、続きが無いときは待ちを置かない。前の待ちは止める', () => {
  const d = drive('');
  assert.equal(d.render('こんにちは', 10), 'こんにちは');
  assert.equal(d.render('こんにちは、世界', 11), 'こんにちは、世界');
  assert.equal(d.state.pending, undefined);
  const long = drive('');
  const base = 'a'.repeat(4000);
  long.render(base, 1000);
  long.render(`${base}b`, 1001);
  assert.ok(long.state.pending);
  long.render(`${base}bc`, 1002);
  assert.equal(long.state.cancelled, 1, '届くたびに前の待ちを止めて置き直す');
  assert.notEqual(long.render('別の文'.repeat(2000), 1003), base, '文が前の続きでなければ、すぐ描き直す');
});

const CJK_CHARS = /[぀-ヿ一-鿿]/u;

test('作業の一覧の部品: 項目の文は文字のまま出す（Markdown・リンク・生の HTML を通さない）。辞書の文は日英にそろう', () => {
  const source = readFileSync(new URL('../web/src/ui/Checklist.tsx', import.meta.url), 'utf8').replace(/\r/g, '').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /Markdown/u, 'Markdown.tsx を通さない');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(source, /href|<a[\s>]|linkify|innerHTML/iu, 'リンクにしない');
  assert.match(source, /<span>\{item\.text\}<\/span>/u, '項目の文は、そのまま文字として 1 か所だけに入れる');
  assert.equal(source.match(/item\.text/gu)?.length, 1);
  assert.match(source, /tainted && <p className="bt-meta ui-checklist__note">\{t\('ui\.checklist\.tainted'\)\}<\/p>/u, '外の内容を読んだあとに書かれた一覧には、小さな注記を付ける');
  const keys = ['ui.checklist', 'ui.checklist.count', 'ui.checklist.done', 'ui.checklist.tainted'] as const;
  for (const key of keys) {
    assert.ok(key in en, key);
    assert.doesNotMatch(typeof en[key] === 'string' ? en[key] : en[key](1, 2), CJK_CHARS, `${key}: 英語に日本語が混ざらない`);
  }
  assert.equal(en['ui.checklist.count'](2, 5), '2 / 5');
});

test('作業の一覧の置き場所: 実行中は入力欄（Composer）の直前に 1 つ。出来事（checklist）が届いていればそれを、無ければ開いたときに読んだ一覧を出す', () => {
  const chat = readFileSync(new URL('../web/src/ui/Conversation.tsx', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.equal(chat.match(/<Checklist\b/gu)?.length, 2, '終わったあとの会話の中と、実行中の入力欄の上');
  const pinned = chat.indexOf('{running && checklist.length > 0 && <Checklist');
  const between = chat.slice(pinned, chat.indexOf('<Composer', pinned));
  assert.ok(pinned > 0 && pinned < chat.indexOf('<Composer'), '実行中の一覧は入力欄の上');
  assert.equal(between.match(/className="[^"]*"/gu)?.filter(c => !c.includes('ui-pinned') && !c.includes('bt-meta')).length ?? 0, 0, '一覧と入力欄のあいだにあるのは、同じ固定の段（Plan の「この計画で進める」）だけ');
  assert.match(chat, /const checklist = liveChecklist \?\? readList\?\.items \?\? \[\];/u, '出来事が先、読んだ一覧はその次');
  assert.match(readFileSync(new URL('../web/src/ui/live-state.ts', import.meta.url), 'utf8'), /case 'checklist\.updated':/u);
});
