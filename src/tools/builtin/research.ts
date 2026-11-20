import { Type } from '@sinclair/typebox';
import { normalizeUrl, pageKey } from '../../research/evidence.ts';
import { checkLabel, ResearchError } from '../../research/labels.ts';
import { ResearchStore, type FeatureEvidence } from '../../research/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { researchText } from '../../shared/messages/research.ts';
import type { ToolDef } from '../types.ts';

const QUOTE = Type.String({ minLength: 1, maxLength: 300 });
const FIELDS = ['license', 'updated', 'language'] as const;
const SOURCES: ReadonlySet<string> = new Set(['similar', 'library']);

interface ResearchRecordInput {
  kind: 'similar' | 'feature' | 'library' | 'candidate';
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
  description: 'Record one row of the research. candidate (only when the request asks for candidates): name and the url of the page from a search result; nothing else. similar / library: name, the url of the page you opened with web_fetch in this run, and license, updated, language: for each, copy the whole sentence from that page word for word (such as "Released under the MIT License", not just "MIT"); a short quote or one not found on the page is kept as unknown. feature: name, and evidence: for each similar product that has it, the url of its row and the whole sentence from that page that names the feature, copied word for word. Names are one short plain line.',
  input: Type.Object({
    kind: Type.Union([Type.Literal('similar'), Type.Literal('feature'), Type.Literal('library'), Type.Literal('candidate')]),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    detail: Type.Optional(Type.String({ maxLength: 500 })),
    license: Type.Optional(QUOTE),
    updated: Type.Optional(QUOTE),
    language: Type.Optional(QUOTE),
    evidence: Type.Optional(Type.Array(Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }), quote: QUOTE }, { additionalProperties: false }), { maxItems: 8 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  researchOnly: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const db = ctx.services?.db;
    const research = db ? new ResearchStore(db) : undefined;
    const run = research?.runningFor(ctx.runId);
    const pages = ctx.research?.pages;
    if (!research || !run || !pages || ctx.research?.researchId !== run.id) return { content: researchText(language, 'not_running'), isError: true };
    try {
      const session = ctx.research;
      if (input.kind === 'candidate') {
        if (!session?.takesCandidates) return { content: researchText(language, 'candidate_only_first'), isError: true };
        const name = checkLabel('similar', input.name);
        const url = input.url === undefined ? null : normalizeUrl(input.url);
        if (url === null) return { content: researchText(language, input.url === undefined ? 'url_required' : 'url_invalid'), isError: true };
        if (!session.saw(url)) return { content: researchText(language, 'url_not_seen', { url: url.slice(0, 200) }), isError: true };
        if (session.candidates.some(c => pageKey(c.url) === pageKey(url) || c.name.normalize('NFKC').toLowerCase() === name.toLowerCase())) return { content: researchText(language, 'duplicate', { what: name }), isError: true };
        if (session.candidates.length >= session.limits.candidates) return { content: researchText(language, 'too_many', { max: session.limits.candidates, kind: 'candidate' }), isError: true };
        session.candidates.push({ name, url });
        return { content: researchText(language, 'candidate_recorded', { n: session.candidates.length }) };
      }
      if (session?.takesCandidates) return { content: researchText(language, 'candidates_part'), isError: true };
      if (input.kind === 'feature') {
        const similar = new Map(research.items(run.id).filter(i => i.kind === 'similar').map(i => [i.url, i.id]));
        const evidence: FeatureEvidence[] = [];
        let notRow = 0;
        let notOnPage = 0;
        for (const e of input.evidence ?? []) {
          const url = normalizeUrl(e.url);
          const id = url === null ? undefined : similar.get(url);
          if (url === null || id === undefined) notRow++;
          else if (!pages.quoted(url, e.quote)) notOnPage++;
          else evidence.push({ similar: id, url, quote: e.quote });
        }
        const { row, merged } = research.addFeature(run.id, { label: input.name, detail: input.detail, evidence });
        const head = merged ? researchText(language, 'merged', { id: row.id, count: (JSON.parse(row.products) as number[]).length }) : researchText(language, 'recorded_all', { id: row.id });
        const dropped = notRow + notOnPage ? ` ${researchText(language, 'evidence_dropped', { dropped: notRow + notOnPage, given: (input.evidence ?? []).length, not_row: notRow, not_on_page: notOnPage })}` : '';
        return { content: head + dropped };
      }
      // やり方の問いはコードだけが作る（モデルの choice は断る）
      if (!SOURCES.has(input.kind)) return { content: researchText(language, 'kind_phase', { kind: String(input.kind) }), isError: true };
      if (input.url === undefined) return { content: researchText(language, 'url_required'), isError: true };
      if (normalizeUrl(input.url) === null) return { content: researchText(language, 'url_invalid'), isError: true };
      if (!pages.has(input.url)) return { content: researchText(language, 'url_not_opened', { url: input.url.slice(0, 200) }), isError: true };
      const url = input.url;
      const kept = Object.fromEntries(FIELDS.flatMap(field => ((field === 'language' ? pages.wholeQuoted(url, input[field]) : pages.quoted(url, input[field])) ? [[field, input[field]!]] : [])));
      const row = research.addSource(run.id, { kind: input.kind, name: input.name, url, detail: input.detail, ...kept, evidence: kept });
      const unknown = FIELDS.filter(field => !(field in kept));
      return { content: unknown.length ? researchText(language, 'recorded', { id: row.id, unknown: unknown.join(', ') }) : researchText(language, 'recorded_all', { id: row.id }) };
    } catch (error) {
      if (error instanceof ResearchError) return { content: errorText(error, language), isError: true };
      throw error;
    }
  },
};
