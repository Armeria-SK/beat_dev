import type { BackgroundItem } from '../api.ts';
import { t } from '../i18n/index.ts';

// beat 6-4: Terminal の欄の、画面の外の小さな関数（帯の札・持っているもの・行の組み立て・リンク）

export const POLL_MS = 2000;
export const MAX_LINES = 2000;

export interface TermLine { n: number; text: string; gap?: true }
export interface TermText { lines: TermLine[]; open: boolean; count: number; trimmed: boolean }
export interface TerminalFocus { id: string; n: number }

export const EMPTY_TEXT: TermText = { lines: [], open: false, count: 0, trimmed: false };

export function pillOf(item: BackgroundItem): { tone: 'running' | 'ok' | 'danger' | undefined; label: string } {
  if (item.state === 'running') return { tone: 'running', label: t('ui.term.running') };
  if (item.state === 'stopped') return { tone: undefined, label: t('ui.term.stopped') };
  if (item.spawnFailed) return { tone: 'danger', label: t('ui.term.notStarted') };
  if (item.exitCode === null) return { tone: 'danger', label: t('ui.term.exitedPlain') };
  return { tone: item.exitCode === 0 ? 'ok' : 'danger', label: t('ui.term.exited', item.exitCode) };
}

export function holdsText(item: BackgroundItem, now: number): string {
  return [
    item.port !== null && t('ui.term.port', item.port),
    uptimeText((item.endedAt ?? now) - item.startedAt),
  ].filter(Boolean).join(' · ');
}

// 経過時間（Design の「2h 14m」の形）
export function uptimeText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  return h > 0 ? `${h}h ${m}m` : total >= 60 ? `${m}m` : `${total}s`;
}

export function pickJob(items: readonly BackgroundItem[], wanted: string | null): string | null {
  if (wanted && items.some(i => i.id === wanted)) return wanted;
  return (items.find(i => i.state === 'running') ?? items[0])?.id ?? null;
}

// 出力を行に足す。text は行の切れ目まで（書きかけを 4KB で出したときだけ改行で終わらない。その続きは次の text の頭）。
// skipped は前に読んだ所からこの text までに飛んだバイト数。飛んだら印の行を入れ、書きかけの行にはつながない
export function addText(prev: TermText, text: string, skipped = 0, max = MAX_LINES): { next: TermText; added: number } {
  const gap = skipped > 0 && prev.lines.length > 0;
  if (!text && !gap) return { next: prev, added: 0 };
  const parts = text ? text.split('\n') : [];
  const open = text ? parts.at(-1) !== '' : false;
  if (text && !open) parts.pop();
  const lines = [...prev.lines];
  let count = prev.count;
  let added = 0;
  if (gap) { lines.push({ n: count++, text: '', gap: true }); added++; }
  parts.forEach((part, i) => {
    const last = lines.at(-1);
    if (i === 0 && prev.open && !gap && last) lines[lines.length - 1] = { n: last.n, text: last.text + part };
    else { lines.push({ n: count++, text: part }); added++; }
  });
  const over = lines.length > max;
  return { next: { lines: over ? lines.slice(lines.length - max) : lines, open, count, trimmed: prev.trimmed || over }, added };
}

// 宛先が localhost そのものの http だけ（localhost@… や localhost.… のようなよその宛先、ほかの語の続きは外す）。
// 前が「Local:」のようなコロンでもよい。後ろに点やコロンが続いても、その次が語の字や - でなければ（「…」「.)」）リンクにする
const LOCALHOST = /(?<![\w/.@-])http:\/\/localhost(?::\d{1,5})?(?![\w@-]|[.:][\w-])(?:\/[^\s"'<>`]*)?/gu;

export type LinePart = { text: string; href?: string };

// リンクにするのは http://localhost の宛先だけ（Design）
export function linkParts(line: string): LinePart[] {
  const out: LinePart[] = [];
  let at = 0;
  for (const match of line.matchAll(LOCALHOST)) {
    const url = match[0].replace(/[.,;:)\]]+$/u, '');
    const start = match.index;
    if (start > at) out.push({ text: line.slice(at, start) });
    out.push({ text: url, href: url });
    at = start + url.length;
  }
  if (at < line.length || out.length === 0) out.push({ text: line.slice(at) });
  return out;
}

export function atBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
}
