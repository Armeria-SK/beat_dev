import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { classifyFetchError, longWaitFetch } from '../src/providers/http.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ProviderError, type ModelRequest, type StreamEvent } from '../src/providers/types.ts';
import { fakeServer, sse } from './helpers.ts';

const model: ModelConfig = { id: 'm', provider: 'p', model: 'test-model', contextLength: 65536, maxOutputTokens: 1024, vision: false };
const request = (): ModelRequest => ({
  model, system: { frozen: 'You are beat', dynamic: 'now', tail: '' }, messages: [{ role: 'user', content: 'hello' }],
  tools: [], maxOutputTokens: 1024, signal: new AbortController().signal,
});
const compat = (baseUrl: string, timeoutMs: number): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl, maxParallel: 1, timeoutMs });
const reply = { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const codeOf = (error: unknown): string | undefined => (error as { cause?: { code?: string } } | undefined)?.cause?.code;

// 300 秒を待たずに「timeoutMs に従う」ことを見るため、abort の signal を付けずに fetch だけを動かす（signal があると、どちらで切れたか分からなくなる）
test('手元のモデルの待ち: 返事の頭が来るまでの待ちは、渡した timeoutMs に従う（短ければ切れ、長ければ待つ）', async t => {
  const server = await fakeServer(async (_req, _body, res) => { await sleep(2000); sse(res, [reply]); });
  t.after(() => server.close());
  const url = `${server.url}/v1/chat/completions`;
  const [short, long] = await Promise.allSettled([
    longWaitFetch(500)(url, { method: 'POST', body: '{}' }),
    longWaitFetch(6000)(url, { method: 'POST', body: '{}' }),
  ]);
  assert.equal(short.status, 'rejected', '頭が 2 秒かかるのに、500 ms の待ちでは切れる');
  if (short.status === 'rejected') assert.equal(codeOf(short.reason), 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(long.status, 'fulfilled', '6 秒の待ちなら、2 秒かかる頭を待てる');
  if (long.status === 'fulfilled') {
    assert.equal(long.value.status, 200);
    assert.match(await long.value.text(), /"ok"/u);
  }
});

test('手元のモデルの待ち: 本文の次の断片が来るまでの待ちも、渡した timeoutMs に従う', async t => {
  const server = await fakeServer(async (_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
    await sleep(2000);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'second' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  const url = `${server.url}/v1/chat/completions`;
  const readAll = async (timeoutMs: number): Promise<string> => (await longWaitFetch(timeoutMs)(url, { method: 'POST', body: '{}' })).text();
  const [short, long] = await Promise.allSettled([readAll(500), readAll(6000)]);
  assert.equal(short.status, 'rejected', '次の断片まで 2 秒かかるのに、500 ms の待ちでは切れる');
  if (short.status === 'rejected') assert.equal(codeOf(short.reason), 'UND_ERR_BODY_TIMEOUT');
  assert.equal(long.status, 'fulfilled');
  if (long.status === 'fulfilled') assert.match(long.value, /first[\s\S]*second/u);
});

test('手元のモデルの待ち: 標準の部品が頭・本文で切った失敗は、つながらないでなく時間切れとして扱う', () => {
  const live = new AbortController().signal;
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timeout'), { code }) });
    const classified = classifyFetchError(error, live);
    assert.equal(classified.kind, 'timeout', code);
    assert.equal(classified.code, 'timeout', code);
  }
  const refused = classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }), live);
  assert.equal(refused.kind, 'provider_error', 'つながらない失敗は今までどおり');
  assert.equal(refused.code, 'connect.code');
});

test('手元のモデルの待ち: 組み込みの fetch を差し替えない adapter は、undici の fetch で送る（組み込みの fetch に別の版の部品を渡さない）', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [reply]));
  t.after(() => server.close());
  const events = await collect(new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, 10_000), {}).stream(request()));
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'end_turn' });
  assert.equal(server.requests[0]!.headers['user-agent'], 'undici', 'Node の組み込みの fetch なら node と名乗る');

  const sent: string[] = [];
  const injected: typeof fetch = async (input, init) => {
    sent.push(String(input));
    return fetch(input, init);
  };
  await collect(new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, 10_000), {}, injected).stream(request()));
  assert.equal(sent.length, 1, '渡した fetch はそのまま使う');
  assert.equal(server.requests[1]!.headers['user-agent'], 'node');
});

test('手元のモデルの待ち: 頭が遅いサーバーは、timeoutMs が短ければ時間切れ（つながらないでなく）、長ければ最後まで読める', async t => {
  const server = await fakeServer(async (_req, _body, res) => { await sleep(2000); sse(res, [reply]); });
  t.after(() => server.close());
  const slow = new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, 1000), {});
  const started = Date.now();
  await assert.rejects(collect(slow.stream(request())), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'timeout');
    return true;
  });
  assert.ok(Date.now() - started < 1900, `約 1 秒で切れる（${Date.now() - started} ms）`);

  const patient = new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, 6000), {});
  const events = await collect(patient.stream(request()));
  assert.equal(events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join(''), 'ok');
});
