import { lineDelta } from '../../../src/shared/line-delta.ts';
import { isSensitiveName, redactSecrets } from '../../../src/shared/redaction.ts';
import type { UiIconName } from './icons.ts';

export type ToolVerb = 'edit' | 'run' | 'search' | 'helper' | 'tool';

export type ToolMeta =
  | { kind: 'lines'; added: number; removed: number }
  | { kind: 'exit'; code: string; seconds: string }
  | { kind: 'failed' }
  | { kind: 'returned' }
  | null;

export interface ToolRowView {
  verb: ToolVerb;
  name: string;
  icon: UiIconName;
  target: string;
  meta: ToolMeta;
}

export interface ToolResult { text: string; isError: boolean }

const EDIT = new Set(['file_write', 'file_edit', 'table_write']);
const SEARCH = new Set([
  'file_read', 'file_list', 'file_search', 'doc_read', 'image_view',
  'web_search', 'web_fetch', 'browser_read',
  'history_search', 'history_read', 'memory_search', 'skill_view',
]);
const TARGET_KEYS: Readonly<Record<string, readonly string[]>> = {
  shell_run: ['command'],
  agent_run: ['title', 'task'],
  file_search: ['text', 'name', 'path'],
  web_search: ['query'],
  web_fetch: ['url'],
};
const COMMON_KEYS = ['path', 'command', 'query', 'url', 'title', 'name', 'topic', 'text', 'content'];
const MAX_TARGET = 240;

const VERB_ICON: Record<ToolVerb, UiIconName> = { edit: 'pencil', run: 'terminal', search: 'search', helper: 'branch', tool: 'wrench' };

function record(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;
const QUERY_PARAM = /([?&])([^=&#\s]+)=([^&#\s]*)/gu;

export function maskTarget(value: string): string {
  return redactSecrets(value)
    .replace(USERINFO, '$1[REDACTED]@')
    .replace(QUERY_PARAM, (match, sep: string, name: string) => (isSensitiveName(name) ? `${sep}${name}=[REDACTED]` : match));
}

function oneLine(value: string): string {
  const line = maskTarget(value).replace(/\s+/gu, ' ').trim();
  return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET)}…` : line;
}

function pick(args: Record<string, unknown> | null, keys: readonly string[]): string {
  if (!args) return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return '';
}

export function toolVerb(name: string): ToolVerb {
  if (EDIT.has(name)) return 'edit';
  if (name === 'shell_run') return 'run';
  if (SEARCH.has(name)) return 'search';
  if (name === 'agent_run') return 'helper';
  return 'tool';
}

const num = (text: string): number => Number(text.replace(/,/gu, ''));

function editMeta(name: string, args: Record<string, unknown> | null, result: ToolResult): ToolMeta {
  if (name === 'file_write') {
    const counted = /; \+([\d,]+) -([\d,]+) lines\)\s*$/u.exec(result.text);
    if (counted) return { kind: 'lines', added: num(counted[1]!), removed: num(counted[2]!) };
    const content = args?.['content'];
    if (/^Created: /u.test(result.text) && typeof content === 'string') return { kind: 'lines', ...lineDelta('', content) };
    return null;
  }
  if (name === 'file_edit') {
    const old = args?.['old'];
    const next = args?.['new'];
    if (typeof old !== 'string' || typeof next !== 'string') return null;
    const times = Number(/^Replaced (\d+) occurrence/u.exec(result.text)?.[1] ?? 1);
    const delta = lineDelta(old, next);
    return { kind: 'lines', added: delta.added * times, removed: delta.removed * times };
  }
  return null;
}

function storedEcho(text: string, command: string): string | undefined {
  if (!text.startsWith('$ ')) return undefined;
  const lines = text.split('\n');
  const count = command.split('\n').length;
  return lines.length > count ? `${lines.slice(0, count).join('\n')}\n` : undefined;
}

function runMeta(result: ToolResult, command: unknown): ToolMeta {
  const failed: ToolMeta = result.isError ? { kind: 'failed' } : null;
  if (typeof command !== 'string') return failed;
  const echo = [command, redactSecrets(command)].map(c => `$ ${c}\n`).find(e => result.text.startsWith(e)) ?? storedEcho(result.text, command);
  if (!echo) return failed;
  const header = result.text.slice(echo.length).replace(/^\n/u, '').split('\n', 1)[0]!;
  const match = /^\(.*, exit code: ([^,()]+), ([\d.]+) s\)$/u.exec(header);
  return match ? { kind: 'exit', code: match[1]!.trim(), seconds: match[2]! } : failed;
}

export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function folderLabel(folder: string): string {
  const parts = folder.split(/[\\/]+/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || folder;
}

export function toolRow(name: string, input: string, result: ToolResult | null): ToolRowView {
  const verb = toolVerb(name);
  const args = record(input);
  const target = pick(args, TARGET_KEYS[name] ?? COMMON_KEYS);
  const view = { verb, name, icon: VERB_ICON[verb], target };
  if (!result) return { ...view, meta: null };
  if (verb === 'run') return { ...view, meta: runMeta(result, args?.['command']) };
  if (result.isError) return { ...view, meta: { kind: 'failed' } };
  if (verb === 'edit') return { ...view, meta: editMeta(name, args, result) };
  if (verb === 'helper') return { ...view, meta: { kind: 'returned' } };
  return { ...view, meta: null };
}

export function staggerOf(fresh: readonly boolean[]): Array<number | null> {
  let n = 0;
  return fresh.map(isFresh => (isFresh ? n++ : null));
}
