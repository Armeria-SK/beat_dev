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

test('readSnippet: 頭だけ読むとき、境目で切れた長い鍵のかけらを、伏せ字で縮んだ分だけ前へ引き込まない', async () => {
  const key = Array.from({ length: 4000 }, (_, i) => 'Zk3qP9xW7mB2vN8cLd5T'[(i * 7) % 20]).join('');
  const body = `${key} `.repeat(40);
  const text = await readSnippet(new Response(body, { status: 500 }), [key]);
  const fragments = Array.from({ length: key.length - 8 }, (_, i) => key.slice(i, i + 8));
  assert.ok(!fragments.some(part => text.includes(part)), 'no part of the key is left');
  assert.ok(text.includes('[REDACTED]'));
});

test('readSnippet: 頭だけ読む境目が ASCII でない鍵の文字の途中に落ちても、鍵のかけらを残さない', async () => {
  const key = `Q${'é'.repeat(3000)}`;
  const body = Buffer.from(`${key} `.repeat(40), 'utf8');
  assert.equal(body[64 * 1024 - 1], 0xc3, 'the 64 KiB cut lands inside a two-byte character');
  const text = await readSnippet(new Response(body, { status: 500 }), [key]);
  assert.ok(!text.includes(`Q${'é'.repeat(8)}`), 'no part of the key is left');
  assert.ok(text.includes('[REDACTED]'));
});
