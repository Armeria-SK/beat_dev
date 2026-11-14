import type { Language } from '../config/schema.ts';
import { estimateTextTokens, prefixLength } from '../engine/tokens.ts';
import { neutralizeFence } from '../shared/fence.ts';
import { toolText } from '../shared/messages/tools.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { AcceptanceDoc, AcceptanceSource } from '../projects/acceptance.ts';
import { MeshError, scrubText } from './files.ts';

export interface MeshText { rel: string; lines: string[]; mtime: number; fetched: boolean }

const LINE_MAX = 300;
const QUERY_TERMS = 10;
const EXTERNAL = /src: external\\?\]/u;
const PRIORITY = ['STATE.md', 'MAP.md', 'DECISIONS.md'];

const HEADING_MAX = 60;

const fold = (text: string): string => text.normalize('NFKC').toLowerCase();
const safe = (text: string): string => neutralizeFence(redactSecrets(text).replace(/\r/gu, ' '));
const label = (text: string): string => scrubText(redactSecrets(text), HEADING_MAX).replaceAll('"', "'");
const one = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim();
const aiText = (value: unknown): string => one(String(value ?? '').replaceAll('|', '/'));

export function meshBudget(available: number | undefined, outputTokens: number | undefined): number {
  const share = Math.min(4000, Math.max(800, Math.floor((available ?? 0) * 0.1)));
  return Math.min(share, outputTokens ?? Infinity);
}

function sourceText(source: AcceptanceSource | undefined): string {
  const s = (source ?? {}) as Record<string, unknown>;
  if (s.kind === 'owner_words') return `owner_words "${one(s.quote)}"`;
  if (s.kind === 'owner_choice') return `owner_choice: question "${one(s.question)}" answer "${one(s.answer)}"`;
  return one(s.kind) || 'unknown';
}

export function acceptanceLines(doc: AcceptanceDoc): string[] {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const notDoing = Array.isArray(doc.notDoing) ? doc.notDoing : [];
  const version = Number(doc.version) > 0 ? `v${Number(doc.version)}` : 'draft';
  return [
    `# acceptance.json (${version}${doc.language ? `, language ${one(doc.language)}` : ''})`,
    '## Acceptance items',
    ...items.map(item => {
      const check = (item.check ?? {}) as Record<string, unknown>;
      const removed = item.removedIn ? ` [removed in v${one(item.removedIn)}]` : '';
      return `${one(item.id)} [${one(item.state)}]${removed} source: ${sourceText(item.source)} | check: ${one(check.kind)}${check.kind === 'command' ? `: ${one(check.command)}` : ''} | result: ${aiText(item.result)}`;
    }),
    '## Not doing',
    ...notDoing.map(item => `${one(item.id)} source: ${sourceText(item.source)} | text: ${aiText(item.text)}`),
  ];
}

const framed = (language: Language, body: string[], after: string[] = []): string => [toolText(language, 'mesh.external'), '<<<', ...body, '>>>', ...after].join('\n');

export function searchMesh(texts: readonly MeshText[], query: string, budget: number, language: Language): { content: string; fetched: boolean } {
  const terms = [...new Set(fold(query).split(/\s+/u).filter(Boolean))].slice(0, QUERY_TERMS);
  if (!terms.length) throw new MeshError('mesh.empty_query');
  const rank = (rel: string) => { const at = PRIORITY.indexOf(rel); return at >= 0 ? at : rel.startsWith('memory/') ? PRIORITY.length : PRIORITY.length + 1; };
  const hits: Array<{ text: MeshText; line: number; heading: string; value: string; count: number; bonus: number }> = [];
  for (const text of texts) {
    const named = terms.some(term => fold(text.rel).includes(term));
    let heading = '';
    text.lines.forEach((value, index) => {
      if (value.startsWith('#')) heading = value.trim();
      const folded = fold(value);
      const count = terms.filter(term => folded.includes(term)).length;
      if (count) hits.push({ text, line: index + 1, heading: value.startsWith('#') ? '' : heading, value, count, bonus: (value.startsWith('#') ? 1 : 0) + (named ? 1 : 0) });
    });
  }
  if (!hits.length) return { content: toolText(language, 'mesh.no_hits', { files: texts.length }), fetched: false };
  hits.sort((a, b) => b.count - a.count || b.bonus - a.bonus || b.text.mtime - a.text.mtime || rank(a.text.rel) - rank(b.text.rel) || a.text.rel.localeCompare(b.text.rel) || a.line - b.line);
  const head = toolText(language, 'mesh.hits', { count: hits.length, files: new Set(hits.map(hit => hit.text.rel)).size });
  const shown: string[] = [];
  let fetched = false;
  const reserve = estimateTextTokens(framed(language, [head], [toolText(language, 'mesh.more_hits', { count: hits.length })]));
  let used = reserve;
  for (const hit of hits) {
    const heading = hit.heading ? Array.from(safe(hit.heading)).slice(0, HEADING_MAX).join('') : '';
    const line = `${hit.text.rel}:${hit.line}${heading ? ` [${heading}]` : ''} ${Array.from(safe(hit.value.trim())).slice(0, LINE_MAX).join('')}`;
    const cost = estimateTextTokens(line) + 1;
    if (used + cost > budget) break;
    used += cost;
    shown.push(line);
    if (hit.text.fetched || EXTERNAL.test(hit.value)) fetched = true;
  }
  const rest = hits.length - shown.length;
  return { content: framed(language, [head, ...shown], rest ? [toolText(language, 'mesh.more_hits', { count: rest })] : []), fetched };
}

export function readMesh(text: MeshText, input: { section?: string | undefined; offset?: number | undefined }, budget: number, language: Language): { content: string; fetched: boolean } {
  let lines = text.lines;
  let section: string | undefined;
  if (input.section !== undefined) {
    const headings = lines.flatMap((line, index) => (/^#+\s/u.test(line) ? [{ index, level: /^#+/u.exec(line)![0].length, title: line.replace(/^#+\s*/u, '').trim() }] : []));
    const asked = label(input.section.replace(/^#+\s*/u, '').trim());
    const wanted = fold(asked);
    const titles = headings.map(h => ({ h, title: fold(label(h.title)) }));
    const found = (titles.find(x => x.title === wanted) ?? titles.find(x => x.title.includes(wanted)))?.h;
    if (!found || !wanted) throw new MeshError('mesh.no_section', { section: label(input.section), path: text.rel, sections: headings.map(h => label(h.title)).join(', ') || '-' }, text.fetched);
    const end = headings.find(h => h.index > found.index && h.level <= found.level)?.index ?? lines.length;
    lines = lines.slice(found.index, end);
    section = asked;
  }
  const whole = safe(lines.join('\n').replace(/\n+$/u, ''));
  const total = whole.length;
  const offset = input.offset ?? 0;
  if (offset > 0 && offset >= total) throw new MeshError('mesh.past_end', { path: text.rel, total }, text.fetched);
  const rest = whole.slice(offset);
  const note = (next: number) => section === undefined
    ? toolText(language, 'mesh.continues', { path: text.rel, offset: next, total })
    : toolText(language, 'mesh.continues_section', { path: text.rel, section, offset: next, total });
  const room = budget - estimateTextTokens(framed(language, [], [note(total)]));
  const shown = Math.max(1, prefixLength(rest, Infinity, room));
  const part = rest.slice(0, shown);
  const fetched = text.fetched || lines.some(line => EXTERNAL.test(line));
  return { content: framed(language, [part], shown < rest.length ? [note(offset + shown)] : []), fetched };
}
