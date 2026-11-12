import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prefixLength } from '../engine/tokens.ts';
import { isRemotePath, isSecretPath, windowsHazard } from '../tools/hooks/scope.ts';
import { INSTRUCTION_FILES } from '../tools/policy.ts';

export const INSTRUCTIONS_BUDGET_RATIO = 0.05;
export const INSTRUCTIONS_DEFAULT_TOKENS = 2000;
export const INSTRUCTIONS_BYTES_PER_TOKEN = 14;

const WINDOWS = process.platform === 'win32';
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{2028}\u{2029}]/gu;

export interface Instructions {
  name: (typeof INSTRUCTION_FILES)[number];
  text: string;
  truncated: boolean;
}

export const instructionsBudget = (smallestAvailable: number | undefined): number =>
  smallestAvailable === undefined ? INSTRUCTIONS_DEFAULT_TOKENS : Math.max(1, Math.floor(smallestAvailable * INSTRUCTIONS_BUDGET_RATIO));

export const stripInvisible = (text: string): string => text.replace(INVISIBLE, '');

const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);

export function linkTarget(root: string, linkPath: string, target: string): string | undefined {
  if (isRemotePath(target) || windowsHazard(target) !== undefined) return undefined;
  const resolved = resolve(dirname(linkPath), target);
  if (isRemotePath(resolved) || windowsHazard(resolved) !== undefined || isSecretPath(resolved)) return undefined;
  if (fold(resolved) === fold(resolve(linkPath))) return undefined;
  return INSTRUCTION_FILES.some(name => fold(resolve(root, name)) === fold(resolved)) ? resolved : undefined;
}

type Log = (line: string) => void;

function readHead(path: string, maxBytes: number): { text: string; whole: boolean } | 'refused' {
  const checked = lstatSync(path, { bigint: true });
  if (!checked.isFile() || checked.nlink !== 1n) return 'refused';
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.ino !== checked.ino || opened.dev !== checked.dev) return 'refused';
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
  } finally { closeSync(fd); }
}

export function readInstructions(root: string, budgetTokens: number, log: Log = () => undefined): Instructions | undefined {
  for (const name of INSTRUCTION_FILES) {
    const path = join(root, name);
    try {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry) continue;
      const file = entry.isFile() ? path : entry.isSymbolicLink() ? linkTarget(root, path, readlinkSync(path)) : undefined;
      const head = file === undefined ? 'refused' : readHead(file, budgetTokens * INSTRUCTIONS_BYTES_PER_TOKEN + 16);
      if (head === 'refused') {
        log(`[INFO] Did not read ${name} in the product folder ${root}: only a plain file, or a link to AGENTS.md or CLAUDE.md in the same folder, is read`);
        return undefined;
      }
      const clean = stripInvisible(head.text).trim();
      const keep = prefixLength(clean, clean.length, budgetTokens);
      const text = clean.slice(0, keep).trimEnd();
      if (!text) return undefined;
      const truncated = !head.whole || keep < clean.length;
      if (truncated) log(`[INFO] ${name} in the product folder ${root} is longer than the limit (about ${budgetTokens} tokens), so only its beginning is used`);
      return { name, text, truncated };
    } catch (error) {
      log(`[WARN] Could not read ${name} in the product folder ${root} (${(error as NodeJS.ErrnoException).code ?? 'error'}), so the conversation starts without it`);
      return undefined;
    }
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
