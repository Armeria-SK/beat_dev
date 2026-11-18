const MARK = '…';

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

function cutText(text: string, chars: number): string {
  const end = chars > 0 && isHighSurrogate(text.charCodeAt(chars - 1)) ? chars - 1 : chars;
  return `${text.slice(0, end)}${MARK}`;
}

function shaped(value: unknown, chars: number, entries: number): unknown {
  if (typeof value === 'string') return value.length > chars + 1 ? cutText(value, chars) : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, entries).map(item => shaped(item, chars, entries));
    return value.length > entries ? [...kept, `${MARK} ${value.length - entries} more`] : kept;
  }
  const all = Object.entries(value);
  const kept: Record<string, unknown> = Object.fromEntries(all.slice(0, entries).map(([key, item]) => [key, shaped(item, chars, entries)]));
  if (all.length > entries) kept[MARK] = `${all.length - entries} more`;
  return kept;
}

function measure(value: unknown, out = { longest: 0, widest: 0 }): { longest: number; widest: number } {
  if (typeof value === 'string') out.longest = Math.max(out.longest, value.length);
  else if (value !== null && typeof value === 'object') {
    const items = Array.isArray(value) ? value : Object.values(value);
    out.widest = Math.max(out.widest, items.length);
    for (const item of items) measure(item, out);
  }
  return out;
}

function largest(high: number, ok: (n: number) => boolean): number | undefined {
  if (!ok(0)) return undefined;
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ok(mid)) low = mid; else high = mid - 1;
  }
  return low;
}

export function previewJson(value: unknown, maxChars: number): string {
  const whole = JSON.stringify(value) ?? 'null';
  if (whole.length <= maxChars) return whole;
  const { longest, widest } = measure(value);
  const text = (chars: number, entries: number) => JSON.stringify(shaped(value, chars, entries));
  const fits = (chars: number, entries: number) => text(chars, entries).length <= maxChars;
  const entries = fits(0, widest) ? widest : largest(widest, n => fits(0, n));
  if (entries === undefined) return JSON.stringify(MARK);
  return text(largest(longest, n => fits(n, entries))!, entries);
}
