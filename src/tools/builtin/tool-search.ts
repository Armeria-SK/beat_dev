import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { neutralizeFence } from '../../shared/fence.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { ToolRegistry } from '../registry.ts';
import type { ToolDef } from '../types.ts';
import { isBrowserTool } from '../browser/names.ts';

const MAX_EXACT = 10;
const MAX_MATCHES = 3;
const MIN_TERM = 3;
const SUMMARY_MAX = 100;
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those', 'what', 'which', 'when', 'where', 'how', 'who',
  'make', 'use', 'using', 'can', 'you', 'please', 'some', 'any', 'new', 'get', 'set', 'tool', 'tools', 'about', 'want', 'need', 'let',
  'would', 'could', 'should', 'have', 'has', 'are', 'was', 'were', 'will', 'your', 'mine', 'its', 'all', 'not', 'but', 'out', 'one',
]);

export const DEFERRED_HEADER = 'Tools you can load (name and a short summary). To use one you have not loaded yet, first call tool_search with its name, then call it:';

const inBrowserGroup = (t: ToolDef): boolean => !t.mcp && isBrowserTool(t.name);

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const rawOf = (query: string): string => query.toLowerCase().replace(/^\s*select:/u, '');
export const namesOf = (query: string): string[] => rawOf(query).split(/[\s,]+/u).filter(Boolean);

export function matchTools(tools: readonly ToolDef[], query: string, ready: ReadonlySet<string> = new Set()): ToolDef[] {
  const raw = rawOf(query);
  const names = namesOf(query);
  const exact = tools.filter(t => names.includes(t.name));
  if (exact.length) return exact.slice(0, MAX_EXACT);
  if (names.some(name => ready.has(name))) return [];
  const terms = [...new Set(wordsOf(raw))].filter(term => term.length >= MIN_TERM && !STOP_WORDS.has(term));
  const scored = tools
    .map(t => {
      const name = new Set(wordsOf(t.name));
      const description = t.mcp ? new Set<string>() : new Set(wordsOf(t.description));
      return { t, score: terms.reduce((sum, term) => sum + (name.has(term) ? (t.mcp ? 0.5 : 2) : 0) + (description.has(term) ? 1 : 0), 0) };
    })
    .filter(m => m.score > 0);
  const top = Math.max(0, ...scored.map(m => m.score));
  return scored.filter(m => m.score === top).slice(0, MAX_MATCHES).map(m => m.t);
}

const summaryOf = (text: string): string => {
  const first = text.split(/(?<=\.)\s/u)[0] ?? text;
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 3)}...` : first;
};

export function deferredSection(tools: readonly ToolDef[], config: AppConfig): string {
  if (!tools.length) return '';
  const language = languageOf(config);
  const byName = new Map(tools.map(t => [t.name, t]));
  return [
    DEFERRED_HEADER,
    ...ToolRegistry.specs(tools, config).map(spec => {
      const mcp = byName.get(spec.name)?.mcp;
      return `- ${spec.name}: ${mcp ? toolText(language, 'tool_search.mcp_line', { server: mcp.server }) : summaryOf(spec.description)}`;
    }),
  ].join('\n');
}

export const toolSearch: ToolDef<{ query: string }> = {
  name: 'tool_search',
  description: 'Load tools from the "Tools you can load" list in the system prompt. Pass one or more of its names (or a few words for what you need). Returns their full description and input shape, and they can be called for the rest of this run.',
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  planOk: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.deferred?.sent.has('tool_search')) return { content: toolText(language, 'tool_search.unavailable'), isError: true };
    const list = ctx.deferred.list();
    const listedNames = new Set(list.map(t => t.name));
    const ready = (ctx.reachable?.() ?? []).filter(t => !listedNames.has(t.name)).map(t => t.name);
    const matched = matchTools(list, input.query, new Set(ready));
    const found = matched.some(inBrowserGroup) ? [...matched, ...list.filter(t => inBrowserGroup(t) && !matched.includes(t))] : matched;
    if (!found.length) {
      const asked = namesOf(input.query).filter(name => ready.includes(name));
      return { content: asked.length ? toolText(language, 'tool_search.ready', { names: asked.join(', ') }) : toolText(language, 'tool_search.none') };
    }
    ctx.deferred.load(found.map(t => t.name));
    const byName = new Map(found.map(t => [t.name, t]));
    const specs = ToolRegistry.specs(found, ctx.config, { fixProduct: ctx.project ? ctx.services?.projects?.get(ctx.project.id)?.scout_mode === 'fix' : false });
    return {
      content: [toolText(language, 'tool_search.loaded', { count: specs.length }), ...specs.map(spec => {
        const body = `${spec.description}\nInput: ${JSON.stringify(spec.inputSchema)}`;
        const mcp = byName.get(spec.name)?.mcp;
        return mcp ? `\n## ${spec.name}\n${toolText(language, 'mcp.external', { server: mcp.server })}\n<<<\n${neutralizeFence(body)}\n>>>` : `\n## ${spec.name}\n${body}`;
      })].join('\n'),
    };
  },
};
