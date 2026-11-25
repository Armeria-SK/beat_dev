import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageText, sentText } from '../src/tools/browser/sent.ts';
import { redactSecrets } from '../src/shared/redaction.ts';

// browser_read mode=text の読み進め（renderTab と同じ形: 頭から offset + 上限 + 4,096 字を読み、pageText に渡す）。
// どの回も、読み始めの位置は「分けて伏せても全体を伏せた形と同じ」になる位置であることを確かめる
function page(raw: string, room: number, secrets: readonly string[] = []): { offsets: number[]; sent: string[] } {
  const whole = redactSecrets(raw, secrets);
  const offsets = [0];
  const sent: string[] = [];
  for (let offset = 0, reads = 0; ; reads += 1) {
    assert.ok(reads < 400, `読み進まない: ${offsets.slice(-5).join(' → ')}`);
    const asked = offset + room + 4096;
    const full = raw.slice(0, asked);
    const out = pageText(full, offset, full.length >= asked, secrets, room);
    assert.equal(out.start, offset, '自分で返した続きの位置は戻さない');
    sent.push(out.text);
    if (out.next === undefined) break;
    assert.ok(out.next > offset, `${offset} で止まった`);
    const head = redactSecrets(raw.slice(0, out.next), secrets);
    assert.ok(whole.startsWith(head) && redactSecrets(raw.slice(out.next), secrets) === whole.slice(head.length), `${out.next} は値の途中: ${JSON.stringify(raw.slice(out.next - 20, out.next + 20))}`);
    offset = out.next;
    offsets.push(offset);
  }
  return { offsets, sent };
}

const key = (i: number): string => `sk-proj-${String(i).padStart(4, '0')}abcdefghijklmnopqrstuvwxyz0123456789`;
const hex = (i: number): string => Array.from({ length: 64 }, (_, k) => ((i * 7 + k * 13) % 16).toString(16)).join('');

test('pageText: 例の鍵が 500 字ごとにある 60,000 字の文を、止まらずに読み進める（重なりは小さい）', () => {
  const parts: string[] = [];
  for (let i = 0; parts.join(' ').length < 60_000; i += 1) parts.push(`${'Lorem ipsum dolor sit amet consectetur. '.repeat(11)}Example key: ${key(i)} end.`);
  const raw = parts.join(' ');
  const { offsets, sent } = page(raw, 2000);
  assert.ok(offsets.length < 60_000 / 1500, `${offsets.length} 回`);
  assert.ok(!sent.some(text => text.includes('sk-proj')), '鍵の頭を送らない');
});

test('pageText: 空白の無い JSON（300 字ごとに token）でも読み進め、値を送らない', () => {
  const items = Array.from({ length: 200 }, (_, i) => `{"id":${i},"token":"tok_${String(i).padStart(4, '0')}_${'Z'.repeat(40)}","note":"${'n'.repeat(200)}"}`);
  const raw = `{"items":[${items.join(',')}]}`;
  const { offsets, sent } = page(raw, 2000);
  assert.ok(offsets.length < raw.length / 1500, `${offsets.length} 回`);
  assert.ok(!sent.some(text => text.includes('ZZZZ') || text.includes('tok_')), sent.find(text => text.includes('ZZZZ'))?.slice(0, 200));
});

test('pageText: 読む上限が鍵の値の中（25 個の sk-proj のあと、Bearer の値が 6085、上限 6096）でも、次の読みが値から始まらない', () => {
  const keys = Array.from({ length: 25 }, (_, i) => `${key(i)}${'q'.repeat(190)}`).join(' ');
  const token = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const lead = `${keys} `;
  const label = 'Authorization: Bearer ';
  const pad = 'x '.repeat(Math.ceil((6085 - lead.length - label.length) / 2)).slice(0, 6085 - lead.length - label.length);
  const raw = `${lead}${pad}${label}${token} and then ${'more words here. '.repeat(400)}`;
  assert.equal(raw.indexOf(token), 6085);
  const first = pageText(raw.slice(0, 6096), 0, true, [], 2000);
  assert.ok(first.next !== undefined);
  assert.ok(!redactSecrets(raw.slice(first.next)).startsWith(token.slice(0, 8)) && !raw.slice(first.next).trimStart().startsWith(token.slice(0, 8)), raw.slice(first.next, first.next + 40));
  const { sent } = page(raw, 2000);
  assert.ok(!sent.some(text => text.includes(token.slice(0, 8)) || text.includes(token.slice(-8))), sent.find(text => text.includes(token.slice(0, 8))));
});

test('pageText: 詰めた JSON で読む上限が JWT の中でも、署名の一部を送らない', () => {
  const jwt = (i: number): string => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI${String(i).padStart(6, '0')}In0.${hex(i).slice(0, 43)}`;
  const raw = `{"sessions":[${Array.from({ length: 400 }, (_, i) => `{"id":${i},"token":"${jwt(i)}"}`).join(',')}]}`;
  const inside = raw.indexOf('.', raw.indexOf('eyJ', 6000) + 30) + 10;
  const first = pageText(raw.slice(0, inside), 0, true, [], 2000);
  assert.ok(first.next !== undefined && first.next < inside);
  const { sent } = page(raw, 2000);
  for (let i = 0; i < 400; i += 1) assert.ok(!sent.some(text => text.includes(hex(i).slice(0, 12))), `署名 ${i}`);
});

test('pageText: 1,200 行の要求の記録（Authorization: Bearer と 64 桁）を既定の大きさで読み進めても、どの回も値から始まらない', () => {
  const raw = Array.from({ length: 1200 }, (_, i) => `GET /i/${i} 200 Authorization: Bearer ${hex(i)}`).join('\n');
  const { sent } = page(raw, 20_000);
  for (let i = 0; i < 1200; i += 25) assert.ok(!sent.some(text => text.includes(hex(i).slice(0, 16))), `値 ${i}`);
});

test('pageText: JWT が 3 つある文で、1 回目の続きの位置が送った所の近く（同じ文を 2 回送らない）', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const prose = 'The quick brown fox jumps over the lazy dog. ';
  const raw = `${prose.repeat(20)}token ${jwt} ${prose.repeat(40)}again ${jwt} ${prose.repeat(40)}last ${jwt} ${prose.repeat(230)}`;
  const out = pageText(raw.slice(0, 2000 + 4096), 0, true, [], 2000);
  assert.ok(out.next !== undefined);
  const head = redactSecrets(raw.slice(0, out.next)).length;
  assert.ok(head <= 2000 && head >= 1950, `送った 2,000 字のうち続きの前に入るのは ${head} 字`);
});

test('pageText: 「password:」「--password」「Authorization: Basic」の値の手前・印の頭・印の中で切っても、続きが値から始まらない', () => {
  const cases = [
    ['password: hunter2secretvalue', 'hunter2secretvalue'],
    ['--password hunter2secretvalue', 'hunter2secretvalue'],
    ['Authorization: Basic aHVudGVyMnNlY3JldA==', 'aHVudGVyMnNlY3JldA'],
  ] as const;
  for (const [secret, value] of cases) {
    const raw = `${'Some words here. '.repeat(30)}${secret} more words after it. ${'Tail text. '.repeat(30)}`;
    const redacted = redactSecrets(raw);
    const mark = redacted.indexOf('[REDACTED]');
    assert.ok(mark > 0 && !redacted.includes(value), redacted);
    for (const delta of [-1, 0, 3]) {
      const out = pageText(raw, 0, false, [], mark + delta);
      assert.ok(out.next !== undefined && out.next > 0, `${secret} ${delta}`);
      assert.ok(!out.text.includes(value), `${secret} ${delta}`);
      const next = redactSecrets(raw.slice(out.next));
      assert.ok(!next.includes(value), `${secret} ${delta}: 続き ${next.slice(0, 60)}`);
      assert.ok(redactSecrets(raw.slice(0, out.next)).length <= mark + delta, `${secret} ${delta}: 送っていない所を飛ばさない`);
    }
  }
});

test('pageText: 秘密で始まり、送れるのが印の途中までのときは、秘密のあとから続ける（同じ所を読み続けない）', () => {
  const SECRET = `Qz${'9'.repeat(40)}`;
  const exact = pageText(`${SECRET} rest of the page`, 0, false, [SECRET], 3);
  assert.equal(exact.text, '[RE');
  assert.equal(exact.next, SECRET.length);
  const raw = 'password: hunter2secretvalue rest of the page';
  const context = pageText(raw, 0, false, [], 13);
  assert.ok(context.next !== undefined && context.next > 0, `${context.next}`);
  assert.ok(!redactSecrets(raw.slice(context.next)).includes('hunter2'));
});

test('pageText: モデルが選んだ offset が値の中・決まった秘密の 1 字目のあと・Bearer の直後なら、手前のきれいな位置まで戻す', () => {
  const PLAIN = 'Zq7-plainpass-Xv93-Lm2k';
  const raw = `${'Intro words. '.repeat(20)}password: hunter2-Rv8sQ and ${PLAIN} then Authorization: Bearer abcdefghijklmnop0123456789 end. ${'Tail. '.repeat(20)}`;
  for (const offset of [raw.indexOf('hunter2') + 3, raw.indexOf(PLAIN) + 1, raw.indexOf('Bearer') + 'Bearer'.length]) {
    const out = pageText(raw, offset, false, [PLAIN], 5000);
    assert.ok(out.start <= offset, `${offset}`);
    for (const value of ['Rv8sQ', 'q7-plain', 'abcdefghij']) assert.ok(!out.text.includes(value), `${offset}: ${out.text.slice(0, 80)}`);
  }
});

test('sentText: 伏せてから切る（切り目にまたがる決まった秘密の頭を送らない）', () => {
  const PLAIN = 'Zq7-plainpass-Xv93-Lm2k';
  const out = sentText(`${'a'.repeat(95)} ${PLAIN} tail`, [PLAIN], 100);
  assert.ok(out.cut && !out.text.includes('Zq7'), out.text);
});

test('pageText: 読む上限の直前が「password: 」で値が上限の向こうでも、続きが値から始まらない', () => {
  const lead = 'Some words here. '.repeat(400);
  const raw = `${lead}password: hunter2secretvalue more words. ${'Tail text. '.repeat(50)}`;
  const limit = raw.indexOf('hunter2');
  const out = pageText(raw.slice(0, limit), 0, true, [], 20_000);
  assert.ok(out.next !== undefined && out.next > 0);
  assert.ok(!redactSecrets(raw.slice(out.next)).includes('hunter2'), raw.slice(out.next, out.next + 40));
});
