import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutput, stripAnsi } from '../src/tools/shell/background.ts';
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

test('readOutput: returns whole lines only and holds the partial line for the next read', () => {
  const ring = new OutputRing();
  ring.append('one\ntw', undefined, 1024);
  const first = readOutput(ring, 0, false);
  assert.deepEqual(first, { text: 'one\n', next: 4, skipped: 0 });
  ring.append('o\nthr', undefined, 1024);
  const second = readOutput(ring, first.next, false);
  assert.deepEqual(second, { text: 'two\n', next: 8, skipped: 0 });
  assert.deepEqual(readOutput(ring, second.next, true), { text: 'thr', next: 11, skipped: 0 });
});

test('readOutput: next is a raw ring position, byte-exact across multibyte text', () => {
  const ring = new OutputRing();
  ring.append('日本\n語', undefined, 1024);
  const read = readOutput(ring, 0, false);
  assert.equal(read.text, '日本\n');
  assert.equal(read.next, Buffer.byteLength('日本\n'));
  assert.equal(readOutput(ring, read.next, true).text, '語');
  assert.equal(readOutput(ring, 1, true).text, '本\n語');
});

test('readOutput: a partial line longer than the limit is released', () => {
  const ring = new OutputRing();
  ring.append('x'.repeat(5000), undefined, 1 << 20);
  assert.equal(readOutput(ring, 0, false).text.length, 5000);
  assert.equal(readOutput(ring, 0, false, 10_000).text, '');
});

test('readOutput: a key split across two writes is redacted, never shown in halves', () => {
  const ring = new OutputRing();
  ring.append(`token=${KEY.slice(0, 12)}`, undefined, 1024);
  const first = readOutput(ring, 0, false);
  assert.equal(first.text, '');
  assert.equal(first.next, 0);
  ring.append(`${KEY.slice(12)}\n`, undefined, 1024);
  const second = readOutput(ring, first.next, false);
  assert.doesNotMatch(second.text, /AAAAAAAA/u);
  assert.match(second.text, /\[REDACTED\]/u);
});

test('readOutput: colour codes inside a key are removed before redaction', () => {
  const ring = new OutputRing();
  ring.append(`key ${KEY.slice(0, 7)}\u001b[31m${KEY.slice(7)}\u001b[0m\n`, undefined, 1024);
  const read = readOutput(ring, 0, false);
  assert.doesNotMatch(read.text, /\u001b/u);
  assert.doesNotMatch(read.text, /AAAAAAAA/u);
  assert.match(read.text, /\[REDACTED\]/u);
});

test('readOutput: reading below the retained range reports the skipped bytes', () => {
  const ring = new OutputRing();
  ring.append('aaaa\n', undefined, 8);
  ring.append('bbbb\n', undefined, 8);
  assert.deepEqual(readOutput(ring, 0, false), { text: 'bbbb\n', next: 10, skipped: 5 });
  assert.deepEqual(readOutput(ring, 99, false), { text: '', next: 10, skipped: 0 });
});

test('stripAnsi: removes CSI, OSC and charset sequences and keeps text', () => {
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done \u001b(Bx\u001b[2K'), 'ok done x');
});
