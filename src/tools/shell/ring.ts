// Adapted from deepseek-harness packages/jobs/jobs-local/src/ring.ts (commit fcc0ad4621).
// MIT License, Copyright (c) 2026 DeepSeek. Full license text in THIRD_PARTY.md.

export type JobChannel = 'stdout' | 'stderr' | 'log';

export interface JobAppendOptions {
  channel?: JobChannel;
  gapBefore?: true;
}

export interface JobChunk {
  readonly at: number;
  readonly text: string;
  readonly channel?: JobChannel;
  readonly gapBefore?: true;
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
}

function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, 'utf8');
  let start = raw.length - maxBytes;
  while (start < raw.length && (raw[start]! & 0xC0) === 0x80) start += 1;
  const tail = raw.subarray(start);
  return { text: tail.toString('utf8'), bytes: tail.length };
}

export class OutputRing {
  private readonly chunks: RingChunk[] = [];
  retainedBytes = 0;
  total = 0;
  earliest = 0;

  append(text: string, options: JobAppendOptions | undefined, cap: number): boolean {
    if (text.length === 0) return false;
    const bytes = Buffer.byteLength(text, 'utf8');
    this.chunks.push({
      at: this.total,
      text,
      bytes,
      ...(options?.channel !== undefined ? { channel: options.channel } : {}),
      ...(options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {}),
    });
    this.total += bytes;
    this.retainedBytes += bytes;
    this.trim(cap);
    return true;
  }

  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) break;
      this.retainedBytes -= dropped.bytes;
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined;
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap);
      single.at += single.bytes - tail.bytes;
      single.text = tail.text;
      single.bytes = tail.bytes;
      single.gapBefore = true;
      this.retainedBytes = tail.bytes;
    }
    this.earliest = this.chunks[0]?.at ?? this.total;
  }

  readFrom(from: number): JobOutputRead {
    const chunks: JobChunk[] = [];
    for (const chunk of this.chunks) {
      if (chunk.at + chunk.bytes <= from) continue;
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...(chunk.channel !== undefined ? { channel: chunk.channel } : {}),
        ...(chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {}),
      });
    }
    return { chunks, next: this.total, lossy: from < this.earliest };
  }
}
