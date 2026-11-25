// 外の中身（ページの文・要素の名前）を、モデルに送る形にする。順は「伏せる（決まった秘密の一覧 + 鍵の形）→ 切る → 枠に見える並びを無害にする」。
// 先に切ると、切り目にまたがる秘密の頭が伏せられずに残る（一覧の秘密は pipeline では伏せない）
import { estimateTextTokens, prefixLength } from '../../engine/tokens.ts';
import { neutralizeFence } from '../../shared/fence.ts';
import { redactSecrets } from '../../shared/redaction.ts';

const MARK = '[REDACTED]';
// 区切りの位置を探す数（区切り・行の頭・伏せた所の終わりのそれぞれ）
const STEP_TRIES = 32;
const SEPARATOR = /[\s,;{}[\]()<>]/u;
// 読む上限で切れた読みでは、上限の手前この字数より後ろで区切らない（上限の向こうに値がある「password:」の後ろで区切らない）
export const TAIL_MARGIN = 1024;

export interface Sent {
  // 送る形の文
  text: string;
  // 伏せたあとの文を途中で切ったか
  cut: boolean;
}

// 伏せたあとの文の頭を、送る形で上限に収める（枠の文字の置き換えで長くなることがあるので、収まるまで縮める）
function fitPrefix(redacted: string, maxChars: number, maxTokens: number): { room: number; text: string } {
  let room = prefixLength(redacted, maxChars, maxTokens);
  let text = neutralizeFence(redacted.slice(0, room));
  while (room > 0 && (text.length > maxChars || estimateTextTokens(text) > maxTokens)) {
    room = Math.floor(room * 0.9);
    text = neutralizeFence(redacted.slice(0, room));
  }
  return { room, text };
}

// maxChars / maxTokens は送る形（伏せ・置き換えのあと）で測る
export function sentText(raw: string, secrets: readonly string[], maxChars: number, maxTokens = Infinity): Sent {
  const redacted = redactSecrets(raw, secrets);
  const { room, text } = fitPrefix(redacted, maxChars, maxTokens);
  return { text, cut: room < redacted.length };
}

export interface Paged {
  // 送る形の文
  text: string;
  // 送った文の、ページの文の上の頭（求められた offset を、きれいに分けられる位置まで戻したもの）
  start: number;
  // 続きの読みの offset（続きが無ければ undefined）。いつも start より後ろで、きれいに分けられる位置
  next: number | undefined;
  // 上限で切れた読みで、きれいに分けられる位置が無かった（伏せた所が読める範囲の終わりまで続く）。文はまだ続くが、この offset からは見せられない
  blocked: boolean;
}

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu;
const PEM_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

// browser_read の本文の 1 回分。full はページの文の頭から読んだもの、limited は読む上限で切れたか（その先にも文がある）。
// 「きれいに分けられる位置」p: 文を p で前後に分けて伏せても、分けずに伏せた形と同じになる位置（秘密の途中・「password:」と値のあいだではない）。
// 送るのは、きれいな 2 つの位置のあいだを伏せた形だけ。上限で切れた読みでは、最後の空白と、上限の TAIL_MARGIN 字手前より前の位置だけを使う
export function pageText(full: string, offset: number, limited: boolean, secrets: readonly string[], maxChars: number, maxTokens = Infinity): Paged {
  if (offset >= full.length && !limited) return { text: '', start: offset, next: undefined, blocked: false };
  const start = offset <= 0 ? 0 : cleanStart(full, Math.min(offset, full.length), secrets);
  const tail = full.slice(start);
  const redacted = redactSecrets(tail, secrets);
  let safe = { q: tail.length, head: redacted.length };
  if (limited) {
    const space = tail.search(/\s\S*$/u);
    let bound = Math.min(space > 0 ? space : tail.length - 1, tail.length - TAIL_MARGIN);
    // 上限の向こうまで続くかもしれないものの中では区切らない（切った読みでの確かめでは、続きの形が見えない）:
    // END の無い秘密鍵の BEGIN の印の前、区切りの無い並び（長い JWT など）の頭
    for (const begin of tail.matchAll(PEM_BEGIN)) if (begin.index < bound && !PEM_END.test(tail.slice(begin.index))) { bound = begin.index; break; }
    while (bound > 0 && !SEPARATOR.test(tail[bound - 1]!)) bound -= 1;
    const found = bound > 0 ? findBack(tail, redacted, bound, Infinity, secrets) : undefined;
    // きれいに分けられる位置が無い（伏せた所〔長い鍵・行の終わりまでの Cookie の値〕が、読める範囲の終わりまで続く）:
    // 何も送らず、続きの位置も出さない（確かめられない位置からは続けない）。呼ぶ側が、続きがあることを知らせる
    if (found === undefined) return { text: '', start, next: undefined, blocked: true };
    safe = found;
  }
  const { room, text } = fitPrefix(redacted.slice(0, safe.head), maxChars, maxTokens);
  if (room >= safe.head) return { text, start, next: limited ? start + safe.q : undefined, blocked: false };
  const target = Math.min(alignCut(tail, redacted, room)?.at ?? room, safe.q);
  // 送った所の中で一番後ろのきれいな位置。無ければ、その先のきれいな位置（送らなかった分は飛ばす）、それも無ければ安全な終わり
  const back = findBack(tail, redacted, target, room, secrets);
  const next = back ?? findForward(tail, redacted, target, safe.q, secrets) ?? safe;
  return { text, start, next: start + next.q, blocked: false };
}

// p で分けて伏せても全体と同じか。同じなら前の分の伏せた長さ、違えば undefined
function cleanSplit(raw: string, redacted: string, p: number, secrets: readonly string[]): number | undefined {
  const head = redactSecrets(raw.slice(0, p), secrets);
  if (!redacted.startsWith(head)) return undefined;
  return redactSecrets(raw.slice(p), secrets) === redacted.slice(head.length) ? head.length : undefined;
}

// 区切り・行の頭・伏せた所の終わりと頭（とその手前の区切り）で、from から後ろへきれいな位置を探す（0 は数えない）。前の分の伏せた長さが maxHead 以下のものだけ
export function findBack(raw: string, redacted: string, from: number, maxHead: number, secrets: readonly string[]): { q: number; head: number } | undefined {
  const tried = new Set<number>();
  const accept = (q: number): { q: number; head: number } | undefined => {
    if (q <= 0 || q > from || tried.has(q)) return undefined;
    tried.add(q);
    const head = cleanSplit(raw, redacted, q, secrets);
    return head !== undefined && head <= maxHead ? { q, head } : undefined;
  };
  const first = accept(from);
  if (first) return first;
  // from が伏せた所の中なら、まずその頭と手前の区切りを試す（長い秘密鍵の中の offset で、区切り・行の頭を 64 回試さない）
  const spans = alignCut(raw, redacted, redacted.length);
  const before = (at: number): number => { let k = at - 2; while (k >= 0 && !SEPARATOR.test(raw[k]!)) k -= 1; return k + 1; };
  const inside = spans?.starts.findIndex((begin, k) => begin < from && from < spans.ends[k]!) ?? -1;
  if (inside >= 0) {
    const begin = spans!.starts[inside]!;
    for (const candidate of [begin, before(begin), before(before(begin))]) {
      const found = accept(candidate);
      if (found) return found;
    }
  }
  let q = from;
  for (let tries = 0; tries < STEP_TRIES && q > 0; tries += 1) {
    let k = q - 2;
    while (k >= 0 && !SEPARATOR.test(raw[k]!)) k -= 1;
    q = k + 1;
    const found = accept(q);
    if (found) return found;
  }
  q = from;
  for (let tries = 0; tries < STEP_TRIES && q > 0; tries += 1) {
    q = raw.lastIndexOf('\n', q - 2) + 1;
    const found = accept(q);
    if (found) return found;
  }
  // 伏せた所の終わり・頭・頭の手前の区切り 2 つ（長い秘密鍵・Cookie の値の中に from があると、区切りと行の頭の 32 回では頭まで届かない）
  const heads = (spans?.starts ?? []).flatMap(begin => { const one = before(begin); return [begin, one, before(one)]; });
  const ends = [...new Set([...(spans?.ends ?? []), ...heads])].filter(end => end <= from).sort((a, b) => b - a).slice(0, STEP_TRIES * 2);
  for (const end of ends) {
    const found = accept(end);
    if (found) return found;
  }
  return undefined;
}

// from より後ろ、to まで（to を含む）で、最初のきれいな位置（伏せた所の終わりと区切りから）
function findForward(raw: string, redacted: string, from: number, to: number, secrets: readonly string[]): { q: number; head: number } | undefined {
  const ends = (alignCut(raw, redacted, redacted.length)?.ends ?? []).filter(end => end > from && end <= to);
  const separators: number[] = [];
  for (let k = from; k < to && separators.length < STEP_TRIES; k += 1) if (SEPARATOR.test(raw[k]!)) separators.push(k + 1);
  const candidates = [...new Set([...ends.slice(0, STEP_TRIES), ...separators])].filter(q => q > from && q <= to).sort((a, b) => a - b);
  for (const q of candidates) {
    const head = cleanSplit(raw, redacted, q, secrets);
    if (head !== undefined) return { q, head };
  }
  return undefined;
}

// モデルが選んだ offset を、ページの文の頭からみてきれいな位置まで戻す（値の途中から読ませない）。見つからなければ 0
function cleanStart(full: string, offset: number, secrets: readonly string[]): number {
  const redacted = redactSecrets(full, secrets);
  return findBack(full, redacted, offset, Infinity, secrets)?.q ?? 0;
}

interface Alignment {
  // 伏せたあとの文の room の位置にあたる元の文の位置（伏せた印の途中なら、その秘密の頭）
  at: number;
  // 伏せた所の、元の文での終わり（頭から順）
  ends: number[];
  // 伏せた所の、元の文での頭（頭から順）
  starts: number[];
}

// 伏せたあとの文は、元の文のいくつかの区間を MARK に置き換えたもの。頭から突き合わせて、伏せたあとの位置 room を元の文の位置に写す。
// 区間の終わりは、次の MARK までの伏せていない文が元の文に現れる最初の位置。突き合わせられなければ undefined。
// 写した位置は近くに置くためだけに使い、使う前にいつも cleanSplit で確かめる
export function alignCut(raw: string, redacted: string, room: number): Alignment | undefined {
  let i = 0;
  let j = 0;
  const ends: number[] = [];
  const starts: number[] = [];
  let at: number | undefined;
  while (j < redacted.length) {
    if (at === undefined && j >= room) at = i;
    if (redacted.startsWith(MARK, j) && !raw.startsWith(MARK, i)) {
      let next = j + MARK.length;
      while (redacted.startsWith(MARK, next)) next += MARK.length;
      const nextMark = redacted.indexOf(MARK, next);
      const plain = redacted.slice(next, nextMark < 0 ? redacted.length : nextMark);
      const end = plain === '' ? raw.length : raw.indexOf(plain, i + 1);
      if (end < 0) return undefined;
      if (at === undefined && room < next) at = i;
      starts.push(i);
      ends.push(end);
      i = end;
      j = next;
      continue;
    }
    if (raw[i] !== redacted[j]) return undefined;
    i += 1;
    j += 1;
  }
  return { at: at ?? i, ends, starts };
}
