// Adapted from deepseek-harness packages/jobs/jobs-local/src/ring.ts (commit fcc0ad4621).
// MIT License, Copyright (c) 2026 DeepSeek. Full license text in THIRD_PARTY.md.

export type JobChannel = 'stdout' | 'stderr' | 'log';

export interface JobAppendOptions {
  channel?: JobChannel;
  gapBefore?: true;
  continues?: true;
}

export interface JobChunk {
  readonly at: number;
  readonly text: string;
  readonly channel?: JobChannel;
  readonly gapBefore?: true;
  readonly continues?: true;
}

export interface JobOutputRead {
  chunks: readonly JobChunk[];
  next: number;
  lossy: boolean;
}

interface RingChunk {
  at: number;
  text: string;
  bytes: number;
  channel?: JobChannel;
  gapBefore?: true;
  continues?: true;
}

const COMPACT_AFTER = 1024;

function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, 'utf8');
  let start = raw.length - maxBytes;
  while (start < raw.length && (raw[start]! & 0xC0) === 0x80) start += 1;
  const tail = raw.subarray(start);
  return { text: tail.toString('utf8'), bytes: tail.length };
}

export class OutputRing {
  private readonly chunks: RingChunk[] = [];
  private head = 0;
  retainedBytes = 0;
  total = 0;
  earliest = 0;

  get chunkCount(): number {
    return this.chunks.length - this.head;
  }

  append(text: string, options: JobAppendOptions | undefined, cap: number, mergeBelow = 0): boolean {
    if (text.length === 0) return false;
    const bytes = Buffer.byteLength(text, 'utf8');
    const last = this.chunks.length > this.head ? this.chunks[this.chunks.length - 1] : undefined;
    if (last !== undefined && last.bytes + bytes <= mergeBelow && last.channel === options?.channel && options?.gapBefore === undefined && options?.continues === undefined) {
      last.text += text;
      last.bytes += bytes;
    } else {
      this.chunks.push({
        at: this.total,
        text,
        bytes,
        ...(options?.channel !== undefined ? { channel: options.channel } : {}),
        ...(options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {}),
        ...(options?.continues !== undefined ? { continues: options.continues } : {}),
      });
    }
    this.total += bytes;
    this.retainedBytes += bytes;
    this.trim(cap);
    return true;
  }

  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length - this.head > 1) {
      const dropped = this.chunks[this.head];
      if (dropped === undefined) break;
      this.head += 1;
      this.retainedBytes -= dropped.bytes;
    }
    if (this.head > COMPACT_AFTER && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
    const single = this.chunks.length - this.head === 1 ? this.chunks[this.head] : undefined;
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap);
      single.at += single.bytes - tail.bytes;
      single.text = tail.text;
      single.bytes = tail.bytes;
      single.gapBefore = true;
      this.retainedBytes = tail.bytes;
    }
    this.earliest = this.chunks[this.head]?.at ?? this.total;
  }

  readFrom(from: number): JobOutputRead {
    let low = this.head;
    let high = this.chunks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const chunk = this.chunks[mid]!;
      if (chunk.at + chunk.bytes <= from) low = mid + 1;
      else high = mid;
    }
    const chunks: JobChunk[] = [];
    for (let i = low; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i]!;
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...(chunk.channel !== undefined ? { channel: chunk.channel } : {}),
        ...(chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {}),
        ...(chunk.continues !== undefined ? { continues: chunk.continues } : {}),
      });
    }
    return { chunks, next: this.total, lossy: from < this.earliest };
  }
}
