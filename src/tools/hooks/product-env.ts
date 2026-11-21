import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py)$/iu;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);
const FILE_LIMIT = 2000;
const BYTES_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
const READS = [
  new RegExp(String.raw`process\.env\.${NAME}`, 'gu'),
  new RegExp(String.raw`process\.env\[\s*(['"\x60])${NAME}\1\s*\]`, 'gu'),
  new RegExp(String.raw`os\.environ\[\s*(['"])${NAME}\1\s*\]`, 'gu'),
  new RegExp(String.raw`os\.getenv\(\s*(['"])${NAME}\1`, 'gu'),
  new RegExp(String.raw`Deno\.env\.get\(\s*(['"\x60])${NAME}\1`, 'gu'),
];

export function productEnvNames(root: string): Set<string> {
  const names = new Set<string>();
  let files = 0;
  let total = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 12 || files >= FILE_LIMIT) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files >= FILE_LIMIT || total >= TOTAL_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(path, depth + 1); continue; }
      if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
      const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (size > BYTES_LIMIT) continue;
      let text: string;
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      files++;
      total += size;
      for (const re of READS) for (const m of text.matchAll(re)) names.add(m[m.length - 1]!.toUpperCase());
    }
  };
  visit(root, 0);
  return names;
}

const CACHE_MS = 30_000;
const CACHE_ROOTS = 16;
const cache = new Map<string, { at: number; names: Set<string> }>();

export function productEnvReader(root: string, now: () => number = Date.now): (name: string) => boolean {
  let names: Set<string> | undefined;
  const scan = (): Set<string> => {
    const hit = cache.get(root);
    if (hit && now() - hit.at < CACHE_MS) return hit.names;
    const fresh = productEnvNames(root);
    cache.delete(root);
    if (cache.size >= CACHE_ROOTS) cache.delete(cache.keys().next().value!);
    cache.set(root, { at: now(), names: fresh });
    return fresh;
  };
  return name => (names ??= scan()).has(name.toUpperCase());
}
