// 外の中身（ページの文・要素の名前）を、モデルに送る形にする。順は「伏せる（決まった秘密の一覧 + 鍵の形）→ 切る → 枠に見える並びを無害にする」。
// 先に切ると、切り目にまたがる秘密の頭が伏せられずに残る（一覧の秘密は pipeline では伏せない）
import { estimateTextTokens, prefixLength } from '../../engine/tokens.ts';
import { neutralizeFence } from '../../shared/fence.ts';
import { redactSecrets } from '../../shared/redaction.ts';

// 続きの読み（offset）の位置を、元の文の上で探すときに試す数
const RAW_TRIES = 32;

export interface Sent {
  // 送る形の文
  text: string;
  // 伏せたあとの文を途中で切ったか
  cut: boolean;
  // 送った分が元の文の何文字にあたるか（続きの読みの offset。秘密の途中から始まらない側に倒す。cut でなければ元の文の長さ）
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

// 伏せたあとの文の room 文字までが、元の文のどこまでにあたるか。元の文の先頭 n 文字を伏せた形が、伏せた全体の頭と一致し（秘密の途中で切れていない）、
// 長さが room 以下のいちばん大きい n を、空白の切れ目から探す。見つからなければ、元と伏せたあとが一致する頭の長さ（最初の秘密の前）
function rawOffset(raw: string, redacted: string, room: number, secrets: readonly string[]): number {
  let common = 0;
  while (common < room && raw[common] === redacted[common]) common += 1;
  if (common === room) return room;
  let n = Math.min(raw.length, room + Math.max(0, raw.length - redacted.length));
  for (let tries = 0; tries < RAW_TRIES && n > common; tries += 1) {
    const head = redactSecrets(raw.slice(0, n), secrets);
    if (head.length <= room && redacted.startsWith(head)) return n;
    const space = raw.slice(0, n - 1).search(/\s\S*$/u);
    n = space < 0 ? common : space + 1;
  }
  return common;
}
