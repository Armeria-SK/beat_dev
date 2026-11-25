// 外の中身（ページの文・要素の名前）を、モデルに送る形にする。順は「伏せる（決まった秘密の一覧 + 鍵の形）→ 切る → 枠に見える並びを無害にする」。
// 先に切ると、切り目にまたがる秘密の頭が伏せられずに残る（一覧の秘密は pipeline では伏せない）
import { estimateTextTokens, prefixLength } from '../../engine/tokens.ts';
import { neutralizeFence } from '../../shared/fence.ts';
import { redactSecrets } from '../../shared/redaction.ts';

const MARK = '[REDACTED]';
// 続きの読みの位置を、元の文の上で後ろへ探し直す数（空白の切れ目・行の頭のそれぞれ）
const STEP_TRIES = 32;
const SEPARATOR = /[\s,;{}[\]()<>]/u;

export interface Sent {
  // 送る形の文
  text: string;
  // 伏せたあとの文を途中で切ったか
  cut: boolean;
  // 送った分が元の文の何文字にあたるか（続きの読みの offset）。cut でなければ元の文の長さ。
  // その位置で前後に分けて伏せても、全体を伏せた形と同じになる位置だけを返す（続きが秘密や「password:」と値のあいだから始まらない）。
  // 何か送ったときは 0 より大きい（同じ所を読み続けない）
  rawUsed: number;
}

// maxChars / maxTokens は送る形（伏せ・置き換えのあと）で測る
export function sentText(raw: string, secrets: readonly string[], maxChars: number, maxTokens = Infinity): Sent {
  const redacted = redactSecrets(raw, secrets);
  let room = prefixLength(redacted, maxChars, maxTokens);
  let text = neutralizeFence(redacted.slice(0, room));
  // 枠の文字の置き換えで長くなることがある。収まるまで縮める
  while (room > 0 && (text.length > maxChars || estimateTextTokens(text) > maxTokens)) {
    room = Math.floor(room * 0.9);
    text = neutralizeFence(redacted.slice(0, room));
  }
  const cut = room < redacted.length;
  return { text, cut, rawUsed: cut ? rawOffset(raw, redacted, room, secrets) : raw.length };
}

interface Alignment {
  // 伏せたあとの文の room の位置にあたる元の文の位置（伏せた印の途中なら、その秘密の頭）
  at: number;
  // 最初に伏せた所の、元の文での終わり（伏せた所が無ければ undefined）
  firstEnd: number | undefined;
}

// 伏せたあとの文は、元の文のいくつかの区間を MARK に置き換えたもの。頭から突き合わせて、伏せたあとの位置 room を元の文の位置に写す。
// 区間の終わりは、次の MARK までの伏せていない文が元の文に現れる最初の位置。突き合わせられなければ undefined（呼ぶ側が後ろへ探す）
export function alignCut(raw: string, redacted: string, room: number): Alignment | undefined {
  let i = 0;
  let j = 0;
  let firstEnd: number | undefined;
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
      firstEnd ??= end;
      i = end;
      j = next;
      continue;
    }
    if (raw[i] !== redacted[j]) return undefined;
    i += 1;
    j += 1;
  }
  return { at: at ?? i, firstEnd };
}

// 元の文を n で前後に分けて伏せても全体を伏せた形と同じで、前の分が送った範囲（room）に収まるか
function splits(raw: string, redacted: string, room: number, n: number, secrets: readonly string[]): boolean {
  const head = redactSecrets(raw.slice(0, n), secrets);
  if (head.length > room || !redacted.startsWith(head)) return false;
  return redactSecrets(raw.slice(n), secrets) === redacted.slice(head.length);
}

// 伏せたあとの文の room 文字までが、元の文のどこまでにあたるか（続きの読みの位置）
function rawOffset(raw: string, redacted: string, room: number, secrets: readonly string[]): number {
  if (room <= 0) return 0;
  const aligned = alignCut(raw, redacted, room);
  const start = aligned?.at ?? Math.min(raw.length, room);
  const tried = new Set<number>();
  const accept = (n: number): boolean => {
    if (n <= 0 || tried.has(n)) return false;
    tried.add(n);
    return splits(raw, redacted, room, n, secrets);
  };
  if (accept(start)) return start;
  // 後ろへ: 区切り（空白・JSON の , { [ など）の切れ目、それでもだめなら行の頭（「password:」の前・行ごと）
  let n = start;
  for (let tries = 0; tries < STEP_TRIES && n > 0; tries += 1) {
    let k = n - 2;
    while (k >= 0 && !SEPARATOR.test(raw[k]!)) k -= 1;
    n = k + 1;
    if (accept(n)) return n;
  }
  n = start;
  for (let tries = 0; tries < STEP_TRIES && n > 0; tries += 1) {
    n = raw.lastIndexOf('\n', n - 2) + 1;
    if (accept(n)) return n;
  }
  // 見つからなければ、最初に伏せた所のあとから（同じ所を読み続けない。伏せた所の中身は送らない）
  return aligned?.firstEnd ?? 0;
}
