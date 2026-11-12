import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { errorProbeText, evaluateContext } from '../src/providers/context.ts';
import { providerError } from '../src/providers/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { noUsableText } from '../web/src/chat-logic.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

// 送る前の 409（使えるモデルが無い）の problems。モデルごとに、今までの文（message / hint）のほかに、
// モデルの確認と同じ messageCode / messageParams を添える（画面が、サーバーの書いた文にかかわらずコードから組み立てられるように）。

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { probe: boolean }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: provider => (adapter = new FakeAdapter(provider)) });
  if (options.probe) await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, adapter: () => adapter };
}

const FRAME_EN = 'Nothing was sent because there is no model that can be used. Check the settings screen.\n';

// 送信は、本物のエンジンの返す SendOutcome を、HTTP の本文と同じく JSON にしたもので確かめる。
async function blockedBody(s: Awaited<ReturnType<typeof startApp>>): Promise<Record<string, any>> {
  const outcome = s.app.engine.send('c1', 'hi');
  assert.ok(!outcome.ok);
  const { ok: _ok, httpStatus, ...body } = outcome as Record<string, any>;
  assert.equal(httpStatus, 409);
  return JSON.parse(JSON.stringify(body)) as Record<string, any>;
}

test('送る前の 409（確認していない）: 英語の文で、problems に messageCode が付く', async t => {
  const s = await startApp(t, { probe: false });
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'context_overflow');
  assert.equal(body.errorCode, 'engine.no_usable');
  assert.equal(body.errorMessage, `${FRAME_EN}- m: Not checked yet`);
  assert.deepEqual(body.detail, { reason: 'context_unknown' });
  assert.deepEqual(body.problems, [{ modelId: 'm', status: 'unknown', message: 'Not checked yet', messageCode: 'engine.problem.unchecked' }]);
});

test('送る前の 409（接続できない）: モデルの確認の messageCode / messageParams をそのまま problems に付ける', async t => {
  const s = await startApp(t, { probe: false });
  const unreachable = errorProbeText(providerError('provider_error', 'connect', {}), 'en');
  s.adapter().probeResult = { status: 'unreachable', ...unreachable };
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'provider_error');
  assert.equal(body.errorMessage, `${FRAME_EN}- m: Cannot connect to the provider`);
  assert.deepEqual(body.problems, [{
    modelId: 'm', status: 'unreachable', message: 'Cannot connect to the provider',
    messageCode: 'provider.connect', messageParams: {},
  }]);
});

test('送る前の 409（長さが足りない）: 直し方（hint）と、出どころ・数のコードが付く', async t => {
  const s = await startApp(t, { probe: false });
  s.adapter().probeResult = evaluateContext({ modelId: 'm', server: 'generic', required: 32768, declared: 8192, hint: '直し方のテスト', language: 'en', now: 1 });
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'context_overflow');
  assert.equal(body.errorMessage, `${FRAME_EN}- m: The context length is too small: measured 8,192 < required 32,768 (configured 8,192) (直し方のテスト)`);
  assert.deepEqual(body.detail, { reason: 'server_ctx_too_small', hint: '直し方のテスト' });
  assert.deepEqual(body.problems, [{
    modelId: 'm', status: 'too_small', message: 'The context length is too small: measured 8,192 < required 32,768 (configured 8,192)', hint: '直し方のテスト',
    messageCode: 'provider.probe.too_small', messageParams: { effective: '8,192', required: '32,768', sourceKind: 'declared', n: '8,192' },
  }]);
});

test('送る前の 409: コードの無いモデルの確認（古いアダプタなど）は、今までどおり文だけで、コードのキーは付けない', async t => {
  const s = await startApp(t, { probe: false });
  s.adapter().probeResult = { status: 'error', message: '想定外の失敗' };
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.deepEqual(body.problems, [{ modelId: 'm', status: 'error', message: '想定外の失敗' }]);
  assert.equal(body.errorMessage, `${FRAME_EN}- m: 想定外の失敗`);
});

test('画面の組み立て: サーバーの 409 を、problems 自身のコードだけ（モデルの一覧なし）で組み立て直し、サーバーの書いた文には頼らない', async t => {
  const scenarios: Array<{ name: string; probe: () => Record<string, unknown> | null }> = [
    { name: '確認していない', probe: () => null },
    { name: '接続できない', probe: () => ({ status: 'unreachable', ...errorProbeText(providerError('provider_error', 'connect', {}), 'en') }) },
    { name: '長さが足りない（直し方つき）', probe: () => evaluateContext({ modelId: 'm', server: 'generic', required: 32768, measured: 8192, hint: 'same hint', language: 'en', now: 1 }) as never },
    { name: '長さが分からない', probe: () => evaluateContext({ modelId: 'm', server: 'generic', required: 32768, language: 'en', now: 1 }) as never },
  ];
  for (const scenario of scenarios) {
    const s = await startApp(t, { probe: false });
    const probe = scenario.probe();
    if (probe) { s.adapter().probeResult = probe; await s.app.status.probeAll(s.app.config()); }
    const body = await blockedBody(s);
    const marked = { ...body, errorMessage: 'SERVER TEXT', problems: body.problems.map((p: Record<string, unknown>) => ({ ...p, message: 'SERVER LINE' })) };
    // 直し方（hint）はサーバーの種類ごとの手順で、画面は訳さずそのまま出す。比べるときは外す
    const stripHint = (text: string, b: Record<string, any>): string => { const hint = b.problems[0]?.hint as string | undefined; return hint ? text.replace(` (${hint})`, '') : text; };
    assert.ok(!noUsableText(marked, [], 'en')!.includes('SERVER LINE'), `${scenario.name}: サーバーの書いた行を使わない`);
    assert.equal(stripHint(noUsableText(marked, [], 'en')!, marked), stripHint(body.errorMessage, body), `${scenario.name}: コードから組み立てた文が、サーバーの英語の文と同じ`);
    assert.equal(noUsableText(body, [], 'en'), body.errorMessage, `${scenario.name}: 同じ文`);
  }
});
