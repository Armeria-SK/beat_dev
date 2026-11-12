import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prefixLength } from '../engine/tokens.ts';
import { isInside } from '../tools/hooks/scope.ts';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const INSTRUCTIONS_BUDGET_RATIO = 0.05;
export const INSTRUCTIONS_DEFAULT_TOKENS = 2000;

const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁩﻿\u{E0000}-\u{E007F}]/gu;

export interface Instructions {
  name: (typeof INSTRUCTION_FILES)[number];
  text: string;
  truncated: boolean;
}

export const instructionsBudget = (smallestAvailable: number | undefined): number =>
  smallestAvailable === undefined ? INSTRUCTIONS_DEFAULT_TOKENS : Math.max(1, Math.floor(smallestAvailable * INSTRUCTIONS_BUDGET_RATIO));

export const stripInvisible = (text: string): string => text.replace(INVISIBLE, '');

function readHead(path: string, maxBytes: number): { text: string; whole: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    const whole = read === stat.size;
    let text = buffer.subarray(0, read).toString('utf8');
    if (!whole) text = text.replace(/�+$/u, '');
    return { text, whole };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

export function readInstructions(root: string, budgetTokens: number): Instructions | undefined {
  let realRoot: string;
  try { realRoot = realpathSync.native(root); } catch { return undefined; }
  for (const name of INSTRUCTION_FILES) {
    const path = join(root, name);
    if (!lstatSync(path, { throwIfNoEntry: false })) continue;
    let real: string;
    try { real = realpathSync.native(path); } catch { return undefined; }
    if (!isInside(realRoot, real)) return undefined;
    try { if (!statSync(real).isFile()) return undefined; } catch { return undefined; }
    const head = readHead(real, budgetTokens * 4 + 16);
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
