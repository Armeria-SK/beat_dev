import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../web/src/api.ts';

// 画面の API の呼び出し: 止めた通信の本文の読み取りが落ちたら、空の成功（{}）にせず失敗にする（backlog 196 のレビューの直し）。

test('api: 見出しが届いたあとで止めた通信は、本文が読めなくても失敗で終わる（空の設定を成功として返さない）', async () => {
  const original = globalThis.fetch;
  const stop = new AbortController();
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: () => { stop.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')); },
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(api.settings(stop.signal), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    const plain = new AbortController();
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('empty')) })) as unknown as typeof fetch;
    assert.deepEqual(await api.settings(plain.signal), {}, '止めていない通信で本文が JSON でないときは、前と同じく空');
  } finally { globalThis.fetch = original; }
});
