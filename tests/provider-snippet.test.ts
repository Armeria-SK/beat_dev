import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSnippet } from '../src/providers/http.ts';

function bigResponse(totalBytes: number, chunk = 16 * 1024): { response: Response; pulled: () => number } {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      sent += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x61));
    },
  });
  return { response: new Response(body, { status: 500 }), pulled: () => sent };
}

test('readSnippet: 失敗の本文がとても大きくても、全部は読まずに頭だけを読む', async () => {
  const { response, pulled } = bigResponse(32 * 1024 * 1024);
  const text = await readSnippet(response, []);
  assert.equal(text, 'a'.repeat(2000));
  assert.ok(pulled() <= 256 * 1024, `read ${pulled()} bytes`);
});

test('readSnippet: 頭の中の鍵は、切る前に伏せる（読む量を絞っても変わらない）', async () => {
  const secret = 'Zk3qP9xW7mB2vN8cLd5Tq1';
  const text = await readSnippet(new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), { status: 401 }), [secret]);
  assert.ok(!text.includes(secret), text);
  assert.match(text, /^bad key /u);
});
