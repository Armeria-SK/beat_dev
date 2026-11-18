import { loadTsx } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from '../src/shared/messages/define.ts';
import { ApiError } from '../web/src/api.ts';
import { sendFailureOf } from '../web/src/chat-logic.ts';
import { t } from '../web/src/i18n/index.ts';
import { issueMessage, problemsOf } from '../web/src/settings/model.ts';
import type { RunNotice } from '../web/src/ui/live-state.ts';
import { setExplainLanguage } from '../web/src/i18n/state.ts';
import { JA_SERVER } from '../web/src/i18n/ja-server/index.ts';
import { DOMAINS, errorBodyText, probeMessage, serverText, warningText } from '../web/src/server-text.ts';

// beat i18n I-3: サーバーの文（コードつき）の日本語は画面の側の表（web/src/i18n/ja-server）。表に無いコードは英語。

const { noticeText } = await loadTsx<{ noticeText: (tr: typeof t, n: RunNotice) => string }>('../web/src/ui/Conversation.tsx', import.meta.url);

const names = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/gu)].map(m => m[1]!))].sort();
const english = (domain: string): Record<string, string> => DOMAINS[domain]!.tables.en;

test('日本語の表の分野と鍵は、すべて英語の表（src/shared/messages）にある', () => {
  assert.deepEqual(Object.keys(JA_SERVER).filter(domain => !(domain in DOMAINS)), []);
  const extra = Object.entries(JA_SERVER).flatMap(([domain, table]) => Object.keys(table).filter(key => !Object.hasOwn(english(domain), key)).map(key => `${domain}.${key}`));
  assert.deepEqual(extra, []);
});

test('日本語の文は空でなく、差し込み {名前} の集まりが英語と同じ（D-6）', () => {
  const bad: string[] = [];
  for (const [domain, table] of Object.entries(JA_SERVER)) {
    for (const [key, text] of Object.entries(table)) {
      if (typeof text !== 'string' || text.trim() === '') { bad.push(`${domain}.${key}: empty`); continue; }
      const want = names(english(domain)[key] ?? '');
      const got = names(text);
      if (want.join() !== got.join()) bad.push(`${domain}.${key}: en {${want}} ja {${got}}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('ja では日本語、日本語の無いコードは英語、差し込みの値が足りなければ null。en は今までどおり英語', () => {
  const http = JA_SERVER.http as Record<string, string | undefined>;
  assert.equal(serverText('http.required', { field: 'title' }, 'ja'), format(http.required!, { field: 'title' }));
  assert.notEqual(serverText('http.required', { field: 'title' }, 'ja'), serverText('http.required', { field: 'title' }, 'en'));
  assert.equal(serverText('http.required', { field: 'title' }, 'en'), format(english('http').required!, { field: 'title' }));
  assert.equal(serverText('http.required', {}, 'ja'), null, '{field} が足りない');
  assert.equal(serverText('http.mystery', {}, 'ja'), null, '英語の表に無いコード');
  const saved = http.required;
  try {
    delete http.required;
    assert.equal(serverText('http.required', { field: 'title' }, 'ja'), format(english('http').required!, { field: 'title' }), '日本語が無ければ英語');
  } finally { http.required = saved; }
});

test('API のエラー・返事の失敗・警告も、ja なら日本語（呼ぶ側の言語は説明の言語）', () => {
  const body = { code: 'http.task_missing', message: 'The task was not found' };
  assert.equal(errorBodyText(body, 'ja'), JA_SERVER.http!.task_missing);
  assert.equal(errorBodyText({ errorCode: 'pending.not_found', errorParams: { id: 4 } }, 'ja'), format(JA_SERVER.pending!.not_found!, { id: 4 }));
  try {
    setExplainLanguage('ja');
    assert.equal(new ApiError(404, body).message, JA_SERVER.http!.task_missing, 'ApiError は説明の言語で書く');
    setExplainLanguage('en');
    assert.equal(new ApiError(404, body).message, english('http').task_missing);
  } finally { setExplainLanguage('en'); }
  assert.equal(warningText({ code: 'something_new', message: 'server text' }, 'ja'), 'server text');
  assert.equal(warningText({ code: 'context_trimmed', message: 'server text', params: { count: 3 } }, 'ja'), format(JA_SERVER.engine!['warn.context_trimmed']!, { count: 3 }));
  const probe = probeMessage({ message: 'server text', messageCode: 'provider.probe.too_small', messageParams: { effective: 8192, required: 32768, sourceKind: 'measured', n: 8192 } }, 'ja');
  assert.equal(probe, format(JA_SERVER.provider!['probe.too_small']!, { effective: 8192, required: 32768, source: format(JA_SERVER.provider!['probe.source.measured']!, { n: 8192 }) }), 'モデルの確認の文は、組み立ての部品も日本語');
});

test('見張り: 15 分野の英語の鍵のうち、日本語の無いものの数を出す（段階 7 の本線が鍵を足し終えるまでは落とさない。I-4 で落ちる形に）', t => {
  assert.equal(Object.keys(DOMAINS).length, 15);
  const missing = Object.keys(DOMAINS).flatMap(domain => Object.keys(english(domain)).filter(key => JA_SERVER[domain]?.[key] === undefined).map(key => `${domain}.${key}`));
  const total = Object.values(DOMAINS).reduce((sum, catalog) => sum + Object.keys(catalog.tables.en).length, 0);
  t.diagnostic(`server codes without Japanese: ${missing.length} of ${total}`);
  assert.ok(missing.length <= total);
});

test('表に無い名前（プロトタイプの名前）は null。en・ja どちらでも', () => {
  for (const language of ['en', 'ja'] as const) {
    for (const code of ['http.constructor', 'http.toString', 'http.__proto__', 'constructor.x', 'toString.required', 'hasOwnProperty.x']) assert.equal(serverText(code, {}, language), null, `${language} ${code}`);
  }
});

test('呼ぶ側（使えるモデルが無い 409・設定の問題・会話のお知らせ）も、説明の言語が ja なら日本語', () => {
  try {
    setExplainLanguage('ja');
    const ja = (domain: string, key: string): string => JA_SERVER[domain]![key]!;
    const body = { errorCode: 'engine.no_usable', errorMessage: 'srv', problems: [{ modelId: 'm', status: 'unknown', message: 'srv', messageCode: 'provider.probe.unknown' }] };
    const failure = sendFailureOf(new ApiError(409, body), 'x', []);
    assert.equal(failure.message, format(ja('engine', 'no_usable'), { lines: format(ja('engine', 'problem.line'), { id: 'm', message: ja('provider', 'probe.unknown'), hintPart: '' }) }));
    const issue = { path: 'server.port', message: 'srv', code: 'config.number.min', params: { min: 1 } };
    assert.equal(issueMessage(issue), format(ja('config', 'number.min'), { min: 1 }));
    assert.equal(problemsOf({ issues: [issue] }, 'fallback', {})[0]!.message, format(ja('config', 'number.min'), { min: 1 }));
    assert.equal(noticeText(t, { runId: 'r', kind: 'warning', code: 'context_trimmed', message: 'srv', params: { count: 3 } }), format(ja('engine', 'warn.context_trimmed'), { count: 3 }));
    assert.equal(noticeText(t, { runId: 'r', kind: 'error', errorKind: 'internal', errorCode: 'engine.run.no_provider', errorParams: { id: 'p' }, errorMessage: 'srv' }), format(ja('engine', 'run.no_provider'), { id: 'p' }));
  } finally { setExplainLanguage('en'); }
});
