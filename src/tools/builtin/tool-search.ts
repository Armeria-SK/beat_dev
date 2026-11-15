import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { ToolRegistry } from '../registry.ts';
import type { ToolDef } from '../types.ts';

const MAX_EXACT = 10;
const MAX_MATCHES = 5;
const SUMMARY_MAX = 100;

export function matchTools(tools: readonly ToolDef[], query: string): ToolDef[] {
  const terms = query.toLowerCase().replace(/^\s*select:/u, '').split(/[\s,]+/u).filter(Boolean);
  const exact = tools.filter(t => terms.includes(t.name));
  if (exact.length) return exact.slice(0, MAX_EXACT);
  return tools
    .map(t => ({ t, score: terms.reduce((sum, term) => sum + (t.name.includes(term) ? 2 : 0) + (t.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map(m => m.t);
}

const summaryOf = (text: string): string => {
  const first = text.split(/(?<=\.)\s/u)[0] ?? text;
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 3)}...` : first;
};

export function deferredSection(tools: readonly ToolDef[], config: AppConfig): string {
  if (!tools.length) return '';
  return [
    'Deferred tools (only names are shown here). To use one, first call tool_search with its name; it then stays loaded for the rest of this run:',
    ...ToolRegistry.specs(tools, config).map(spec => `- ${spec.name}: ${summaryOf(spec.description)}`),
  ].join('\n');
}

export const toolSearch: ToolDef<{ query: string }> = {
  name: 'tool_search',
  description: 'Load deferred tools. Pass one or more names from the "Deferred tools" list in the system prompt (or words for what you need). Returns their full description and input shape, and they can be called for the rest of this run.',
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  planOk: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.deferred) return { content: toolText(language, 'tool_search.unavailable'), isError: true };
    const found = matchTools(ctx.deferred.list(), input.query);
    if (!found.length) return { content: toolText(language, 'tool_search.none') };
    ctx.deferred.load(found.map(t => t.name));
    const specs = ToolRegistry.specs(found, ctx.config);
    return { content: [toolText(language, 'tool_search.loaded', { count: specs.length }), ...specs.map(spec => `\n## ${spec.name}\n${spec.description}\nInput: ${JSON.stringify(spec.inputSchema)}`)].join('\n') };
  },
};
