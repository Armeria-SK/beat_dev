import { randomBytes } from 'node:crypto';

// 答えの本文の中の区切り（<<< と >>>）は全角にして、枠を偽装されないようにする
export function neutralizeFence(text: string): string {
  return text.replace(/<{3,}/gu, m => '＜'.repeat(m.length)).replace(/>{3,}/gu, m => '＞'.repeat(m.length));
}

export const PLACEHOLDER_NONCE = '0'.repeat(16);

export const newNonce = (): string => randomBytes(8).toString('hex');

export function makeFence(nonce: string = newNonce()): { nonce: string; mark: (name: string) => string; clean: (text: string) => string } {
  return { nonce, mark: name => `<<${name}-${nonce}>>`, clean: text => strip(text, nonce) };
}

// 大文字・小文字を区別せずに消す（印を大文字で書いても、印と読まれうるので）
function strip(text: string, nonce: string): string {
  if (!nonce) return text;
  const pattern = new RegExp(nonce.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
  let current = text;
  for (let next = current.replace(pattern, ''); next !== current; next = current.replace(pattern, '')) current = next;
  return current;
}
