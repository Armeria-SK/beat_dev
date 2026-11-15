import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineGate, readOutput, stripAnsi, type GateUnit } from '../src/tools/shell/background.ts';
import { OutputRing } from '../src/tools/shell/ring.ts';

const KEY = `sk-ant-${'A'.repeat(32)}`;

test('ring: absolute offsets by UTF-8 byte length, empty chunks dropped', () => {
  const ring = new OutputRing();
  assert.equal(ring.append('', undefined, 1024), false);
  assert.equal(ring.append('héllo', { channel: 'stdout' }, 1024), true);
  assert.equal(ring.append('wörld', { channel: 'stderr', gapBefore: true }, 1024), true);
  assert.equal(ring.total, 12);
  assert.equal(ring.earliest, 0);
  assert.equal(ring.retainedBytes, 12);
  assert.deepEqual(ring.readFrom(0), {
    chunks: [{ at: 0, text: 'héllo', channel: 'stdout' }, { at: 6, text: 'wörld', channel: 'stderr', gapBefore: true }],
    next: 12,
    lossy: false,
  });
});

test('ring: reading from inside a chunk returns the whole overlapping chunk', () => {
  const ring = new OutputRing();
  ring.append('abc', undefined, 1024);
  ring.append('def', undefined, 1024);
  assert.deepEqual(ring.readFrom(4).chunks, [{ at: 3, text: 'def' }]);
  assert.deepEqual(ring.readFrom(6), { chunks: [], next: 6, lossy: false });
});

test('ring: evicting old chunks never moves offsets and reports the loss', () => {
  const ring = new OutputRing();
  ring.append('aaaa', undefined, 8);
  ring.append('bbbb', undefined, 8);
  ring.append('cc', undefined, 8);
  assert.equal(ring.earliest, 4);
  assert.equal(ring.retainedBytes, 6);
  assert.deepEqual(ring.readFrom(0), { chunks: [{ at: 4, text: 'bbbb' }, { at: 8, text: 'cc' }], next: 10, lossy: true });
  assert.equal(ring.readFrom(4).lossy, false);
});

test('ring: a lone oversized chunk keeps a UTF-8-safe tail', () => {
  const ring = new OutputRing();
  ring.append('ééé', undefined, 3);
  assert.equal(ring.retainedBytes, 2);
  assert.equal(ring.earliest, 4);
  assert.deepEqual(ring.readFrom(0), { chunks: [{ at: 4, text: 'é', gapBefore: true }], next: 6, lossy: true });
});

test('ring: trimming to a smaller cap leaves total alone; an empty ring stays at 0', () => {
  const ring = new OutputRing();
  ring.append('12345678', undefined, 64);
  ring.append('abcdefgh', undefined, 64);
  ring.trim(8);
  assert.equal(ring.total, 16);
  assert.equal(ring.earliest, 8);
  assert.deepEqual(ring.readFrom(8), { chunks: [{ at: 8, text: 'abcdefgh' }], next: 16, lossy: false });
  const empty = new OutputRing();
  empty.trim(1);
  assert.equal(empty.earliest, 0);
});


const BODY = `MIIE${'Q'.repeat(60)}\n`;
const joinText = (units: GateUnit[]) => units.map(unit => unit.text).join('');

test('gate: releases whole lines, holds the partial line, flushes it at the end', () => {
  const gate = new LineGate();
  assert.deepEqual(gate.push('one\ntw'), [{ text: 'one\n', continues: false }]);
  assert.deepEqual(gate.push('o\nthr'), [{ text: 'two\n', continues: false }]);
  assert.equal(gate.held, 3);
  assert.deepEqual(gate.push('', true), [{ text: 'thr', continues: false }]);
});

test('gate: a key split across two writes is redacted, never shown in halves', () => {
  const gate = new LineGate();
  assert.deepEqual(gate.push(`token=${KEY.slice(0, 12)}`), []);
  const out = joinText(gate.push(`${KEY.slice(12)}\n`));
  assert.doesNotMatch(out, /AAAAAAAA/u);
  assert.match(out, /\[REDACTED\]/u);
});

test('gate: colour codes inside or glued before a key are removed before redaction', () => {
  for (const line of [`key ${KEY.slice(0, 7)}\u001b[31m${KEY.slice(7)}\u001b[0m\n`, `\u001b[1m${KEY}\n`]) {
    const out = joinText(new LineGate().push(line));
    assert.doesNotMatch(out, /\u001b|AAAAAAAA/u, JSON.stringify(out));
    assert.match(out, /\[REDACTED\]/u);
  }
});

test('gate: a partial line past the limit is cut at the last separator, so a token is never split', () => {
  const gate = new LineGate();
  const first = gate.push(`${'x'.repeat(5000)} ${KEY.slice(0, 20)}`);
  assert.deepEqual(first, [{ text: `${'x'.repeat(5000)} `, continues: false }]);
  const second = gate.push(`${KEY.slice(20)}\n`);
  assert.equal(second[0]!.continues, true);
  assert.doesNotMatch(joinText([...first, ...second]), /AAAAAAAA/u);
  const json = new LineGate();
  const parts = [...json.push(`{"pad":"${'p'.repeat(5000)}", "access_token":"${KEY.slice(0, 15)}`), ...json.push(`${KEY.slice(15)}"}\n`)];
  assert.doesNotMatch(joinText(parts), /AAAAAAAA/u);
  assert.equal(new LineGate().push('y'.repeat(5000))[0]!.text.length, 5000);
  assert.deepEqual(new LineGate().push('y'.repeat(4000)), []);
});

test('gate: a private key arriving over three writes never shows its body', () => {
  const gate = new LineGate();
  const out = joinText([
    ...gate.push(`ok\n-----BEGIN PRIVATE KEY-----\n${BODY}`),
    ...gate.push(BODY),
    ...gate.push(`${BODY}-----END PRIVATE KEY-----\nafter\n`),
  ]);
  assert.doesNotMatch(out, /QQQQ/u);
  assert.match(out, /^ok\n/u);
  assert.match(out, /after\n$/u);
  assert.match(out, /\[REDACTED\]/u);
});

test('gate: a private key longer than the hold is released as one [REDACTED] and its body is dropped', () => {
  const gate = new LineGate(4096, 200);
  const parts = [
    ...gate.push(`before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY.repeat(5)}`),
    ...gate.push(BODY.repeat(5)),
  ];
  assert.equal(joinText(parts), 'before\n[REDACTED]\n');
  assert.ok(gate.held < 300, `held ${gate.held}`);
  parts.push(...gate.push(`${BODY}-----END RSA PRIVATE KEY-----\nafter\n`));
  assert.equal(joinText(parts), 'before\n[REDACTED]\nafter\n');
});

test('gate: a private key still open at the end is redacted', () => {
  const gate = new LineGate();
  const out = joinText([...gate.push(`-----BEGIN PRIVATE KEY-----\n${BODY}`), ...gate.push(BODY, true)]);
  assert.doesNotMatch(out, /QQQQ/u);
});

test('gate: a sensitive assignment whose value is on the next line waits for that line', () => {
  const gate = new LineGate();
  assert.deepEqual(gate.push('password:\n'), []);
  const out = joinText(gate.push('  hunter2-very-secret\n'));
  assert.doesNotMatch(out, /hunter2/u);
  assert.match(out, /password:/u);
  assert.deepEqual(new LineGate().push('name:\n'), [{ text: 'name:\n', continues: false }]);
});

test('readOutput: after old output is dropped, a read never starts mid-line', () => {
  const ring = new OutputRing();
  ring.append('line one\n', { channel: 'stdout' }, 50);
  ring.append(`partial ${KEY.slice(0, 5)}`, { channel: 'stdout' }, 50);
  ring.append(`${KEY.slice(5)} tail\nnext\n`, { channel: 'stdout', continues: true }, 50);
  assert.ok(ring.earliest > 0);
  assert.equal(ring.readFrom(0).chunks[0]!.continues, true);
  assert.equal(ring.readFrom(0).chunks[0]!.gapBefore, undefined);
  const read = readOutput(ring, 0);
  assert.equal(read.text, 'next\n');
  assert.equal(read.next, ring.total);
  assert.equal(read.skipped, ring.total - Buffer.byteLength('next\n'));
});

test('readOutput: a position inside a line drops through the newline and counts it as skipped', () => {
  const ring = new OutputRing();
  ring.append('export ANTHROPIC=abc\nsecond\n', undefined, 1024);
  assert.deepEqual(readOutput(ring, 5), { text: 'second\n', next: 28, skipped: 16 });
  assert.deepEqual(readOutput(ring, 21), { text: 'second\n', next: 28, skipped: 0 });
  ring.append('日本\n語', undefined, 1024);
  assert.deepEqual(readOutput(ring, 29), { text: '語', next: ring.total, skipped: 6 });
});

test('readOutput: resuming at the start of a continuation keeps it', () => {
  const ring = new OutputRing();
  ring.append('head ', undefined, 1024, 4096);
  ring.append('rest\n', { continues: true }, 1024, 4096);
  assert.equal(ring.chunkCount, 2);
  assert.deepEqual(readOutput(ring, 5), { text: 'rest\n', next: 10, skipped: 0 });
});

test('readOutput: NaN, negative and fractional positions are read from the start or rounded down', () => {
  const ring = new OutputRing();
  ring.append('aa\nbb\n', undefined, 1024);
  assert.deepEqual(readOutput(ring, Number.NaN), { text: 'aa\nbb\n', next: 6, skipped: 0 });
  assert.deepEqual(readOutput(ring, -1e12), { text: 'aa\nbb\n', next: 6, skipped: 0 });
  assert.deepEqual(readOutput(ring, 3.7), { text: 'bb\n', next: 6, skipped: 0 });
  assert.deepEqual(readOutput(ring, 99), { text: '', next: 6, skipped: 0 });
});

test('stripAnsi: removes CSI, OSC, charset and other escapes; an unterminated OSC stops at the newline', () => {
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done \u001b(Bx\u001b[2K'), 'ok done x');
  assert.equal(stripAnsi('\u001b7save\u001b8 \u001b=\u001b>\u001bc'), 'save ');
  assert.equal(stripAnsi('ok\n\u001b]2;x\nERROR: build failed\nnext\n'), 'ok\n\nERROR: build failed\nnext\n');
});

test('ring: tiny appends stay cheap (head index, merging of small appends)', () => {
  const plain = new OutputRing();
  let began = performance.now();
  for (let i = 0; i < 400_000; i += 1) plain.append('x', undefined, 256 * 1024);
  const plainMs = performance.now() - began;
  assert.equal(plain.retainedBytes, 256 * 1024);
  assert.equal(plain.chunkCount, 256 * 1024);
  const merged = new OutputRing();
  began = performance.now();
  for (let i = 0; i < 400_000; i += 1) merged.append('x\n', undefined, 256 * 1024, 4096);
  const mergedMs = performance.now() - began;
  assert.ok(merged.chunkCount <= 65, `chunks ${merged.chunkCount}`);
  assert.equal(merged.total, 800_000);
  assert.ok(plainMs < 3000 && mergedMs < 3000, `plain ${plainMs.toFixed(0)} ms, merged ${mergedMs.toFixed(0)} ms`);
  assert.equal(merged.readFrom(merged.total - 10).chunks.length, 1);
});

test('gate: a stray BEGIN without END ends at the first line that is not key-shaped, and the stream goes on', () => {
  const gate = new LineGate();
  const parts = [
    ...gate.push(`boot ok\n-----BEGIN PRIVATE KEY-----\n${BODY}MIIEtrunc`),
    ...gate.push('ated\nserver ready on http://localhost:3000\n'),
  ];
  for (let i = 0; i < 1000; i += 1) parts.push(...gate.push(`GET /item/${i} 200\n`));
  parts.push(...gate.push('', true));
  const out = joinText(parts);
  assert.doesNotMatch(out, /QQQQ|MIIE/u);
  assert.match(out, /^boot ok\n\[REDACTED\]\nserver ready on http:\/\/localhost:3000\nGET \/item\/0 200\n/u);
  assert.match(out, /GET \/item\/999 200\n$/u);
  assert.equal(gate.held, 0);
});

test('gate: a key ends at a blank line after its body, and a final open key keeps the lines after it', () => {
  const gate = new LineGate();
  const out = joinText([...gate.push(`-----BEGIN PRIVATE KEY-----\n${BODY}\nnext line\n`), ...gate.push('tail', true)]);
  assert.equal(out, '[REDACTED]\n\nnext line\ntail');
});

test('gate: an encrypted key with headers and a blank line before the body stays redacted over several writes', () => {
  const gate = new LineGate();
  const out = joinText([
    ...gate.push('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n'),
    ...gate.push('DEK-Info: AES-128-CBC,0123456789ABCDEF\n\n'),
    ...gate.push(BODY),
    ...gate.push(`${BODY}-----END RSA PRIVATE KEY-----\nafter\n`),
  ]);
  assert.doesNotMatch(out, /QQQQ|DEK-Info/u);
  assert.equal(out, '[REDACTED]\nafter\n');
});

test('gate: past the hold, only the key is redacted and the first line that is not key-shaped resumes the stream', () => {
  const gate = new LineGate(4096, 200);
  const parts = [...gate.push(`-----BEGIN PRIVATE KEY-----\n${BODY.repeat(5)}`), ...gate.push(BODY.repeat(20))];
  assert.equal(joinText(parts), '[REDACTED]\n');
  parts.push(...gate.push('GET / 200\n'), ...gate.push('', true));
  assert.equal(joinText(parts), '[REDACTED]\nGET / 200\n');
});

for (const [name, head, value] of [
  ['JSON', `{"pad":"${'p'.repeat(5000)}", "password": `, '"hunter2-very-secret-value"}\n'],
  ['Python repr', `{'pad': '${'p'.repeat(5000)}', 'DB_PASSWORD': `, "'Zq9xYvB7nM2kL4pR8sT1'}\n"],
  ['Bearer', `${'p'.repeat(5000)} Authorization: Bearer `, 'abcDEF1234567890ghiJKL\n'],
  ['flag', `${'p'.repeat(5000)} run --token `, 'tok_9f8e7d6c5b4a3210 now\n'],
] as const) {
  test(`gate: a release past the limit never separates a sensitive name from its value (${name})`, () => {
    const gate = new LineGate();
    const first = gate.push(head);
    const out = joinText([...first, ...gate.push(value)]);
    const secret = /hunter2|Zq9x|abcDEF|tok_9f/u;
    assert.doesNotMatch(out, secret, out.slice(-120));
    assert.ok(first.length === 1 && !secret.test(first[0]!.text));
  });
}

test('gate: a run with no separator split into three pieces never shows the key tail', () => {
  const gate = new LineGate();
  const out = joinText([
    ...gate.push(`${'a'.repeat(4200)}&access_token=sk-ant-api03-${'K'.repeat(12)}`),
    ...gate.push('K'.repeat(5000)),
    ...gate.push(`${'K'.repeat(20)} done\n`),
  ]);
  assert.doesNotMatch(out, /KKKK/u);
  assert.match(out, / done\n$/u);
});
