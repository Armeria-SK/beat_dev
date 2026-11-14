import { Type } from '@sinclair/typebox';
import { normalizeUrl, pagesOf } from '../../research/evidence.ts';
import { ResearchError } from '../../research/labels.ts';
import { ResearchStore, type FeatureEvidence } from '../../research/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { researchText } from '../../shared/messages/research.ts';
import type { ToolDef } from '../types.ts';

const QUOTE = Type.String({ minLength: 1, maxLength: 300 });
const FIELDS = ['license', 'updated', 'language'] as const;

interface ResearchRecordInput {
  kind: 'similar' | 'feature' | 'library';
  name: string;
  url?: string;
  detail?: string;
  license?: string;
  updated?: string;
  language?: string;
  evidence?: Array<{ url: string; quote: string }>;
}

export const researchRecord: ToolDef<ResearchRecordInput> = {
  name: 'research_record',
  description: 'Record one row of the research. similar / library: name, the url of the page you opened with web_fetch in this run, and license, updated, language copied word for word from that page (a value not found on the page is kept as unknown). feature: name, and evidence: for each similar product that has it, the url of its row and a sentence copied word for word from that page. Names are one short plain line.',
  input: Type.Object({
    kind: Type.Union([Type.Literal('similar'), Type.Literal('feature'), Type.Literal('library')]),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    detail: Type.Optional(Type.String({ maxLength: 500 })),
    license: Type.Optional(QUOTE),
    updated: Type.Optional(QUOTE),
    language: Type.Optional(QUOTE),
    evidence: Type.Optional(Type.Array(Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }), quote: QUOTE }, { additionalProperties: false }), { maxItems: 8 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const db = ctx.services?.db;
    const research = db ? new ResearchStore(db) : undefined;
    const run = research?.runningFor(ctx.runId);
    const pages = pagesOf(ctx.runId);
    if (!research || !run || !pages) return { content: researchText(language, 'not_running'), isError: true };
    try {
      if (input.kind === 'feature') {
        const similar = new Map(research.items(run.id).filter(i => i.kind === 'similar').map(i => [i.url, i.id]));
        const evidence: FeatureEvidence[] = [];
        for (const e of input.evidence ?? []) {
          const url = normalizeUrl(e.url);
          const id = url === null ? undefined : similar.get(url);
          if (url !== null && id !== undefined && pages.quoted(url, e.quote)) evidence.push({ similar: id, url, quote: e.quote });
        }
        const { row, merged } = research.addFeature(run.id, { label: input.name, detail: input.detail, evidence });
        if (merged) return { content: researchText(language, 'merged', { id: row.id, count: (JSON.parse(row.products) as number[]).length }) };
        return { content: researchText(language, 'recorded_all', { id: row.id }) };
      }
      if (input.url === undefined) return { content: researchText(language, 'url_required'), isError: true };
      if (normalizeUrl(input.url) === null) return { content: researchText(language, 'url_invalid'), isError: true };
      if (!pages.has(input.url)) return { content: researchText(language, 'url_not_opened', { url: input.url.slice(0, 200) }), isError: true };
      const url = input.url;
      const kept = Object.fromEntries(FIELDS.flatMap(field => (pages.quoted(url, input[field]) ? [[field, input[field]!]] : [])));
      const row = research.addSource(run.id, { kind: input.kind, name: input.name, url, detail: input.detail, ...kept, evidence: kept });
      const unknown = FIELDS.filter(field => !(field in kept));
      return { content: unknown.length ? researchText(language, 'recorded', { id: row.id, unknown: unknown.join(', ') }) : researchText(language, 'recorded_all', { id: row.id }) };
    } catch (error) {
      if (error instanceof ResearchError) return { content: errorText(error, language), isError: true };
      throw error;
    }
  },
};
