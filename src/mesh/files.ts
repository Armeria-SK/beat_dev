import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../shared/messages/tools.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { MeshWriteError } from './map.ts';

export class MeshError extends LocalizedError<ToolMessageKey> {
  readonly fetched: boolean;
  constructor(code: ToolMessageKey, params?: MessageParams, fetched = false) { super(toolText, code, params); this.fetched = fetched; }
}

export interface MeshFile { rel: string; abs: string; mtime: number }

const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/iu;
const SHORT_NAME = /~\d/u;
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const SAFE_NAME = /^[\p{L}\p{N}\p{M}\-_./]+$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029<>`]/u;
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const hidden = (part: string): boolean => part.toLowerCase() === '.obsidian' || /\.tmp-[0-9a-f]+$/iu.test(part);

export const isMarkdown = (rel: string): boolean => rel.toLowerCase().endsWith('.md');

export const safeName = (rel: string): boolean => SAFE_NAME.test(rel) && Array.from(rel).length <= 60;

export function safeText(text: string, max: number): string | undefined {
  if (UNSAFE_TEXT.test(text)) return undefined;
  const trimmed = text.replace(/\s+/gu, ' ').trim();
  return Array.from(trimmed).slice(0, max).join('') || undefined;
}

export function scrubText(text: string, max: number): string {
  return Array.from(text.replace(new RegExp(UNSAFE_TEXT.source, 'gu'), ' ').replace(/\s+/gu, ' ').trim()).slice(0, max).join('');
}

export function dateIn(ms: number, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try { return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timezone }).format(ms); } catch { return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' }).format(ms); }
}

export function listMeshFiles(meshDir: string): MeshFile[] {
  let root: string;
  try { root = realpathSync.native(meshDir); } catch { return []; }
  const out: MeshFile[] = [];
  const seen = new Set<string>([root.toLowerCase()]);
  const walk = (dir: string, prefix: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      if (hidden(name)) continue;
      let real: string;
      try { real = realpathSync.native(join(dir, name)); } catch { continue; }
      if (!isInside(root, real) || seen.has(real.toLowerCase())) continue;
      seen.add(real.toLowerCase());
      let stat;
      try { stat = statSync(real); } catch { continue; }
      const rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) { if (depth < MAX_DEPTH) walk(real, rel, depth + 1); }
      else if (stat.isFile() && stat.nlink === 1 && isMarkdown(name)) out.push({ rel, abs: real, mtime: Math.floor(stat.mtimeMs) });
    }
  };
  walk(root, '', 1);
  return out;
}

export function unsafeMeshPath(input: string): boolean {
  if (!input || CONTROLS.test(input) || input.includes(':')) return true;
  const slashed = input.replaceAll('\\', '/');
  if (slashed.startsWith('/')) return true;
  return slashed.split('/').some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part) || DEVICE.test(part) || SHORT_NAME.test(part) || hidden(part));
}

export function resolveMeshPath(meshDir: string, input: string, known: () => string[]): { abs: string; rel: string } {
  const bad = () => new MeshError('mesh.bad_path', { path: input });
  if (unsafeMeshPath(input)) throw bad();
  const parts = input.replaceAll('\\', '/').split('/');
  const root = realpathSync.native(meshDir);
  let real: string;
  try { real = realpathSync.native(join(root, ...parts)); } catch { throw new MeshError('mesh.not_found', { path: input, files: known().join(', ') || '-' }); }
  if (!isInside(root, real)) throw bad();
  const rel = relative(root, real).split(sep).join('/');
  if (!rel || rel.split('/').some(hidden)) throw bad();
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.nlink !== 1) throw new MeshError('mesh.not_found', { path: input, files: known().join(', ') || '-' });
  return { abs: real, rel };
}

export function readOwn(file: string, name: string): string | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1) throw new MeshWriteError('file_unusable', { file: name });
  return readFileSync(file, 'utf8');
}

export function replaceFile(file: string, content: string): void {
  const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temp, content);
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, file); return; } catch (error) {
        if (attempt >= 4 || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
