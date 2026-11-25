import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sentText } from '../src/tools/browser/sent.ts';
import { redactSecrets } from '../src/shared/redaction.ts';

// browser_read mode=text の読み進め（renderTab と同じ形: 上限 + 4,096 字を読み、上限で切れていたら最後の空白まで、伏せてから room で切る）
function page(raw: string, room: number, secrets: readonly string[] = []): { offsets: number[]; sent: string[] } {
  const offsets = [0];
  const sent: string[] = [];
  for (let offset = 0, reads = 0; offset < raw.length; reads += 1) {
    assert.ok(reads < 200, `読み進まない: ${offsets.slice(-5).join(' → ')}`);
    const asked = offset + room + 4096;
    const window = raw.slice(offset, asked);
    const last = asked <= raw.length ? window.search(/\s\S*$/u) : -1;
    const wanted = last > 0 ? window.slice(0, last) : window;
    const out = sentText(wanted, secrets, room);
    sent.push(out.text);
    if (!out.cut && asked > raw.length) break;
    assert.ok(out.rawUsed > 0, `${offset} で止まった`);
    offset += out.rawUsed;
    offsets.push(offset);
  }
  return { offsets, sent };
}

const key = (i: number): string => `sk-proj-${String(i).padStart(4, '0')}abcdefghijklmnopqrstuvwxyz0123456789`;

test('sentText: 例の鍵が 500 字ごとにある 60,000 字の文を、止まらずに読み進める（重なりは小さい）', () => {
  const parts: string[] = [];
  for (let i = 0; parts.join(' ').length < 60_000; i += 1) parts.push(`${'Lorem ipsum dolor sit amet consectetur. '.repeat(11)}Example key: ${key(i)} end.`);
  const raw = parts.join(' ');
  const { offsets, sent } = page(raw, 2000);
  for (let i = 1; i < offsets.length; i += 1) assert.ok(offsets[i]! > offsets[i - 1]!, offsets.join(' → '));
  assert.ok(offsets.length < 60_000 / 1500, `${offsets.length} 回`);
  assert.ok(!sent.some(text => text.includes('sk-proj')), '鍵の頭を送らない');
});

test('sentText: 空白の無い JSON（300 字ごとに token）でも読み進め、値を送らない', () => {
  const items = Array.from({ length: 200 }, (_, i) => `{"id":${i},"token":"tok_${String(i).padStart(4, '0')}_${'Z'.repeat(40)}","note":"${'n'.repeat(200)}"}`);
  const raw = `{"items":[${items.join(',')}]}`;
  const { offsets, sent } = page(raw, 2000);
  for (let i = 1; i < offsets.length; i += 1) assert.ok(offsets[i]! > offsets[i - 1]!, offsets.join(' → '));
  assert.ok(offsets.length < raw.length / 1500, `${offsets.length} 回`);
  assert.ok(!sent.some(text => text.includes('ZZZZ') || text.includes('tok_')), sent.find(text => text.includes('ZZZZ'))?.slice(0, 200));
});

test('sentText: JWT が 3 つある文で、1 回目の続きの位置が送った所の近く（同じ文を 2 回送らない）', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const prose = 'The quick brown fox jumps over the lazy dog. ';
  const raw = `${prose.repeat(20)}token ${jwt} ${prose.repeat(40)}again ${jwt} ${prose.repeat(40)}last ${jwt} ${prose.repeat(230)}`;
  assert.ok(raw.length > 15_000);
  const out = sentText(raw.slice(0, 2000 + 4096), [], 2000);
  assert.ok(out.cut);
  assert.ok(out.rawUsed > 1900, `${out.rawUsed}`);
  const head = redactSecrets(raw.slice(0, out.rawUsed)).length;
  assert.ok(head <= 2000 && head >= 1950, `送った 2,000 字のうち続きの前に入るのは ${head} 字`);
});

test('sentText: 「password:」「--password」「Authorization: Basic」の値の手前・印の頭・印の中で切っても、続きが値から始まらない', () => {
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
      const out = sentText(raw, [], mark + delta);
      assert.ok(out.cut && out.rawUsed > 0, `${secret} ${delta}`);
      assert.ok(!out.text.includes(value), `${secret} ${delta}`);
      const next = redactSecrets(raw.slice(out.rawUsed));
      assert.ok(!next.includes(value), `${secret} ${delta}: 続き ${next.slice(0, 60)}`);
      assert.ok(redactSecrets(raw.slice(0, out.rawUsed)).length <= mark + delta, `${secret} ${delta}: 送っていない所を飛ばさない`);
    }
  }
});

test('sentText: 秘密で始まり、送れるのが印の途中までのときは、秘密のあとから続ける（同じ所を読み続けない）', () => {
  const SECRET = `Qz${'9'.repeat(40)}`;
  const exact = sentText(`${SECRET} rest of the page`, [SECRET], 3);
  assert.equal(exact.text, '[RE');
  assert.equal(exact.rawUsed, SECRET.length);
  const context = sentText('password: hunter2secretvalue rest of the page', [], 13);
  assert.ok(context.rawUsed > 0, `${context.rawUsed}`);
  assert.ok(!redactSecrets('password: hunter2secretvalue rest of the page'.slice(context.rawUsed)).includes('hunter2'));
});
