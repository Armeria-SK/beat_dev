import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prefixLength } from '../engine/tokens.ts';
import { isInside } from '../tools/hooks/scope.ts';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const INSTRUCTIONS_BUDGET_RATIO = 0.05;
export const INSTRUCTIONS_DEFAULT_TOKENS = 2000;

const INVISIBLE = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

export interface Instructions {
  name: (typeof INSTRUCTION_FILES)[number];
  text: string;
  truncated: boolean;
}

export const instructionsBudget = (smallestAvailable: number | undefined): number =>
  smallestAvailable === undefined ? INSTRUCTIONS_DEFAULT_TOKENS : Math.max(1, Math.floor(smallestAvailable * INSTRUCTIONS_BUDGET_RATIO));

export const stripInvisible = (text: string): string => text.replace(INVISIBLE, '');

function insideReal(realRoot: string, path: string): string | undefined {
  try {
    const real = realpathSync.native(path);
    return isInside(realRoot, real) ? real : undefined;
  } catch { return undefined; }
}

function readHead(realRoot: string, path: string, maxBytes: number): { text: string; whole: boolean } | undefined {
  let fd: number | undefined;
  try {
    const real = insideReal(realRoot, path);
    if (!real || !statSync(real).isFile()) return undefined;
    fd = openSync(real, 'r');
    const opened = fstatSync(fd, { bigint: true });
    const again = insideReal(realRoot, path);
    const now = again === undefined ? undefined : statSync(again, { bigint: true });
    if (!opened.isFile() || !now || now.ino !== opened.ino || now.dev !== opened.dev) return undefined;
    const total = Number(opened.size);
    const size = Math.min(total, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    const whole = read === total;
    let text = buffer.subarray(0, read).toString('utf8');
    if (!whole) text = text.replace(/\u{FFFD}+$/u, '');
    return { text, whole };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

export function readInstructions(root: string, budgetTokens: number): Instructions | undefined {
  let realRoot: string;
  try { realRoot = realpathSync.native(root); } catch { return undefined; }
  for (const name of INSTRUCTION_FILES) {
    const path = join(root, name);
    if (!lstatSync(path, { throwIfNoEntry: false })) continue;
    const head = readHead(realRoot, path, budgetTokens * 4 + 16);
    if (!head) return undefined;
    const clean = stripInvisible(head.text).trim();
    const keep = prefixLength(clean, clean.length, budgetTokens);
    const text = clean.slice(0, keep).trimEnd();
    if (!text) return undefined;
    return { name, text, truncated: !head.whole || keep < clean.length };
  }
  return undefined;
}

export function instructionsSection(found: Instructions | undefined): string | undefined {
  if (!found) return undefined;
  return [
    `# Product instructions (${found.name})`,
    '',
    found.text,
    ...(found.truncated ? ['', `(${found.name} is longer than the limit, so only its beginning is included here.)`] : []),
  ].join('\n');
}
