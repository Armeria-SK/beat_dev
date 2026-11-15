import { lineDelta } from '../../../src/shared/line-delta.ts';
import { isSensitiveName, redactSecrets } from '../../../src/shared/redaction.ts';
import { en } from '../i18n/en.ts';
import { t, type PlainKey } from '../i18n/index.ts';
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
  'mesh_read', 'mesh_search',
]);
type Args = Record<string, unknown>;
const str = (args: Args, key: string): string => (typeof args[key] === 'string' ? args[key].trim() : '');
const count = (args: Args, key: string): number => (Array.isArray(args[key]) ? args[key].length : 0);
const scoped = (query: string, scope: string): string => (query && scope ? `"${query}" in ${scope}` : query);
const idOf = (value: unknown): string => ((typeof value === 'string' && value.trim() !== '') || typeof value === 'number' ? `#${String(value).trim()}` : '');
const tabOf = (args: Args, none: string): string => (str(args, 'tab') ? t('ui.toolTarget.tab', str(args, 'tab')) : none);

function doing(args: Args): string {
  const items = Array.isArray(args['items']) ? args['items'] as unknown[] : [];
  const item = items.find((i): i is Args => i !== null && typeof i === 'object' && (i as Args)['status'] === 'in_progress');
  return item ? str(item, 'text') : '';
}

const TARGETS: Readonly<Record<string, (args: Args) => string>> = {
  shell_run: a => str(a, 'command'),
  agent_run: a => str(a, 'title') || str(a, 'task'),
  file_list: a => str(a, 'path') || t('ui.toolTarget.folder'),
  file_search: a => scoped(str(a, 'text') || str(a, 'name'), str(a, 'path')) || str(a, 'path') || t('ui.toolTarget.folder'),
  web_search: a => str(a, 'query'),
  web_fetch: a => str(a, 'url'),
  mesh_read: a => [str(a, 'file'), str(a, 'section')].filter(Boolean).join(' › '),
  mesh_search: a => scoped(str(a, 'query'), str(a, 'file')),
  plan_write: () => 'plan.md',
  acceptance_write: a => t('ui.toolTarget.items', count(a, 'items')),
  acceptance_change: a => t('ui.toolTarget.changes', count(a, 'changes')),
  checklist_write: a => doing(a) || t('ui.toolTarget.steps', count(a, 'items')),
  task_update: a => idOf(a['id']),
  memory_forget: a => idOf(a['id']),
  curiosity_update: a => idOf(a['id']),
  history_read: a => idOf(a['conversation_id']),
  calculate: a => str(a, 'expression'),
  question_add: a => str(a, 'question'),
  task_complete: a => str(a, 'summary'),
  task_checkpoint: a => str(a, 'next_action'),
  deviation_add: a => str(a, 'what'),
  task_list: a => t(a['include_finished'] === true ? 'ui.toolTarget.allTasks' : 'ui.toolTarget.openTasks'),
  curiosity_list: a => t(a['include_closed'] === true ? 'ui.toolTarget.allItems' : 'ui.toolTarget.openItems'),
  question_list: () => t('ui.toolTarget.product'),
  date_calc: a => [str(a, 'op'), str(a, 'date') || str(a, 'datetime'), str(a, 'to') || str(a, 'to_timezone')].filter(Boolean).join(' '),
  browser_read: a => tabOf(a, t('ui.toolTarget.page')),
  browser_screenshot: a => tabOf(a, t('ui.toolTarget.page')),
  browser_close: a => tabOf(a, t('ui.toolTarget.allTabs')),
  browser_click: a => str(a, 'ref'),
  browser_type: a => str(a, 'ref'),
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

function pick(name: string, args: Args | null): string {
  if (!args) return '';
  const own = Object.hasOwn(TARGETS, name) ? TARGETS[name]!(args) : '';
  if (own) return oneLine(own);
  const keys = [...COMMON_KEYS, ...Object.keys(args).filter(key => !isSensitiveName(key))];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return '';
}

export function toolLabel(name: string): string {
  const key = `ui.toolLabel.${name}`;
  if (Object.hasOwn(en, key)) return t(key as PlainKey);
  return name.replace(/^mcp__/u, '').split('__').map(part => part.replace(/[_-]+/gu, ' ').trim()).filter(Boolean).join(' · ') || name;
}

export function toolVerb(name: string): ToolVerb {
  if (EDIT.has(name)) return 'edit';
  if (name === 'shell_run') return 'run';
  if (SEARCH.has(name)) return 'search';
  if (name === 'agent_run') return 'helper';
  return 'tool';
}

const num = (text: string): number => Number(text.replace(/,/gu, ''));

export const emptyOutput = (text: string): boolean => /^\s*(?:\[E-\d+\]\s*)?$/u.test(text);

function editMeta(name: string, args: Record<string, unknown> | null, result: ToolResult): ToolMeta {
  if (name === 'file_write') {
    const counted = /; \+([\d,]+) -([\d,]+) lines\)(?:\s*\n\[E-\d+\])?\s*$/u.exec(result.text);
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

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

function storedEcho(text: string, command: string): string | undefined {
  if (!text.startsWith('$ ') || PRIVATE_KEY_BEGIN.test(command)) return undefined;
  const lines = text.split('\n');
  const count = command.split('\n').length;
  return lines.length > count ? `${lines.slice(0, count).join('\n')}\n` : undefined;
}

function runMeta(result: ToolResult, command: unknown): ToolMeta {
  const failed: ToolMeta = result.isError ? { kind: 'failed' } : null;
  if (typeof command !== 'string') return failed;
  const exact = [command, ...(PRIVATE_KEY_BEGIN.test(command) ? [] : [redactSecrets(command)])].map(c => `$ ${c}\n`).find(e => result.text.startsWith(e));
  const echo = exact ?? storedEcho(result.text, command);
  if (!echo) return failed;
  const header = result.text.slice(echo.length).replace(/^\n/u, '').split('\n', 1)[0]!;
  const match = /^\(.*, exit code: ([^,()]+), ([\d.]+) s\)$/u.exec(header);
  if (!match) return failed;
  const code = match[1]!.trim();
  if (!exact && (code === '0') !== !result.isError) return failed;
  return { kind: 'exit', code, seconds: match[2]! };
}

export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function toolRow(name: string, input: string, result: ToolResult | null): ToolRowView {
  const verb = toolVerb(name);
  const args = record(input);
  const target = pick(name, args);
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
