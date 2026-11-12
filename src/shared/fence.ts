import { randomBytes } from 'node:crypto';

export const PLACEHOLDER_NONCE = '0'.repeat(16);

export const newNonce = (): string => randomBytes(8).toString('hex');

export function makeFence(nonce: string = newNonce()): { nonce: string; mark: (name: string) => string; clean: (text: string) => string } {
  return { nonce, mark: name => `<<${name}-${nonce}>>`, clean: text => strip(text, nonce) };
}

function strip(text: string, nonce: string): string {
  let current = text;
  for (let next = current.replaceAll(nonce, ''); next !== current; next = current.replaceAll(nonce, '')) current = next;
  return current;
}
