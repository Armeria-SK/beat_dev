import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { plainLine } from '../../shared/plain-text.ts';
import type { JobRead, JobView } from '../shell/background.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

export const BACKGROUND_SETTLE_SEC = 2;
export const BACKGROUND_OUTPUT_CHARS = 12_000;
const COMMAND_CHARS = 200;

export function jobState(view: JobView, language: Language): string {
  const base = view.spawnError !== undefined ? toolText(language, 'bg.state_spawn_failed', { detail: view.spawnError })
    : view.state === 'running' ? toolText(language, 'bg.state_running')
      : view.state === 'stopped' ? toolText(language, view.stoppedBy === 'model' ? 'bg.state_stopped_model' : view.stoppedBy === 'owner' ? 'bg.state_stopped_owner' : 'bg.state_stopped_system')
        : toolText(language, 'bg.state_exited', { code: view.exitCode ?? '—' });
  return view.orphaned ? `${base} ${toolText(language, 'bg.orphaned')}` : base;
}

export const commandLine = (command: string): string => plainLine(command, COMMAND_CHARS);

export function newest(text: string, max = BACKGROUND_OUTPUT_CHARS): { text: string; skipped: number } {
  if (text.length <= max) return { text, skipped: 0 };
  let kept = text.slice(-max);
  const nl = kept.indexOf('\n');
  if (nl >= 0 && nl < kept.length - 1) kept = kept.slice(nl + 1);
  return { text: kept, skipped: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(kept, 'utf8') };
}

export function jobLines(views: readonly JobView[], language: Language): string {
  return views.map(view => toolText(language, 'shell.bg_line', { id: view.id, command: commandLine(view.command) })).join('\n');
}

export function readText(read: JobRead, language: Language, lead?: string): string {
  const cut = newest(read.text);
  const skipped = read.skipped + cut.skipped;
  const body = cut.text.trimEnd();
  return [
    ...(lead ? [lead] : []),
    toolText(language, 'bg.header', { id: read.id, state: jobState(read, language), cwd: read.cwd, command: read.command }),
    ...(skipped > 0 ? [toolText(language, 'bg.skipped', { bytes: skipped.toLocaleString('en-US') })] : []),
    body ? body : toolText(language, 'bg.no_new_output'),
  ].join('\n\n');
}

export function backgroundSection(views: readonly JobView[], language: Language): string {
  if (!views.length) return '';
  const ordered = [...views].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.startedAt - b.startedAt);
  return [toolText(language, 'bg.section_title'), ...ordered.map(view => toolText(language, 'bg.section_line', {
    id: view.id, state: jobState(view, language), unread: view.unread ? toolText(language, 'bg.section_unread') : '', command: commandLine(view.command), cwd: view.cwd,
  }))].join('\n');
}

const unavailable = (ctx: ToolContext): ToolOutput => ({ content: toolText(languageOf(ctx.config), 'shell.bg_unavailable'), isError: true });
const unknown = (id: string, ctx: ToolContext): ToolOutput => ({ content: toolText(languageOf(ctx.config), 'bg.unknown', { id }), isError: true });
const marked = (read: JobRead): Partial<ToolOutput> => (read.fetched ? { fetched: true } : {});

const ID = Type.String({ minLength: 1, maxLength: 32, description: 'The id that shell_run returned for the background command, such as bg-3' });

export const shellOutput: ToolDef<{ id: string; waitSec?: number }> = {
  name: 'shell_output',
  description: [
    'Read the new output of a background command (started with shell_run and background: true) in this conversation: what came after your last read, and whether it is still running.',
    'waitSec (0-600, default 0) first waits until the command ends or that many seconds pass, whichever comes first.',
    'Output arrives line by line: a line that is still being written appears once it ends. When there is more new output than fits, the newest part is returned and the size of what was skipped is noted.',
  ].join(' '),
  input: Type.Object({
    id: ID,
    waitSec: Type.Optional(Type.Integer({ minimum: 0, maximum: 600 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  projectOnly: true,
  async execute(input, ctx) {
    const jobs = ctx.services?.background;
    if (!jobs) return unavailable(ctx);
    if ((input.waitSec ?? 0) > 0 && await jobs.wait(input.id, ctx.conversationId, input.waitSec ?? 0, ctx.signal) === undefined) return unknown(input.id, ctx);
    const read = jobs.read(input.id, ctx.conversationId);
    if (!read) return unknown(input.id, ctx);
    return { content: readText(read, languageOf(ctx.config)), ...marked(read) };
  },
};

export const shellStop: ToolDef<{ id: string }> = {
  name: 'shell_stop',
  description: 'Stop a background command of this conversation (and every process it started), and return its last output. Stop a background command as soon as you no longer need it.',
  input: Type.Object({ id: ID }, { additionalProperties: false }),
  effect: 'exec',
  allowedIn: ['chat', 'task', 'agent'],
  projectOnly: true,
  summarize: (input, language) => ({ title: toolText(language, 'summary.shell_stop'), body: input.id }),
  async execute(input, ctx) {
    const jobs = ctx.services?.background;
    if (!jobs) return unavailable(ctx);
    const before = jobs.list({ conversationId: ctx.conversationId }).find(view => view.id === input.id);
    if (!before) return unknown(input.id, ctx);
    await jobs.stop(input.id, 'model', ctx.conversationId);
    const read = jobs.read(input.id, ctx.conversationId);
    if (!read) return unknown(input.id, ctx);
    const language = languageOf(ctx.config);
    const lead = toolText(language, before.state === 'running' ? 'bg.stopped' : 'bg.already_ended', { id: input.id });
    return { content: readText(read, language, lead), ...marked(read) };
  },
};
