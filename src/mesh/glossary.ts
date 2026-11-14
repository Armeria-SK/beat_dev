import { cleanLine, marker, MeshWriteError, refuseSecret, upsertLine, type ParsedRows, type RowAuthor } from './map.ts';

export const GLOSSARY_FILE = 'GLOSSARY.md';
export const GLOSSARY_ROWS_MAX = 30;
export const GLOSSARY_LINE_MAX = 200;

export interface GlossaryRow { term: string; target: string; by: RowAuthor; external: boolean }

const HEAD = ['# GLOSSARY', '', 'Names the owner uses, and what they point to. Written with mesh_glossary_set.', ''];
const ROW = /^- (.+?) → (\S+)(?: \[by (conversation|task|child)(, src: external)?\])?$/u;

export const termKey = (term: string): string => term.normalize('NFKC').toLowerCase();

export function parseGlossary(content: string): ParsedRows<GlossaryRow> {
  const lines = content.split(/\r?\n/u);
  const rows: GlossaryRow[] = [];
  const at: number[] = [];
  let unreadable = 0;
  lines.forEach((line, index) => {
    if (!line.startsWith('- ')) return;
    const m = ROW.exec(line);
    if (!m) { unreadable++; return; }
    rows.push({ term: m[1]!, target: m[2]!, by: (m[3] as RowAuthor | undefined) ?? 'owner', external: m[4] !== undefined });
    at.push(index);
  });
  return { rows, lines, at, unreadable };
}

export const glossaryContent = (row: Pick<GlossaryRow, 'term' | 'target'>): string => `- ${row.term} → ${row.target}`;

export function cleanTerm(raw: string): string {
  const term = cleanLine(raw);
  if (!term) throw new MeshWriteError('glossary_term_empty');
  if (term.includes('→')) throw new MeshWriteError('glossary_term_arrow');
  refuseSecret(term, 'term');
  return term;
}

export function upsertGlossary(existing: string | undefined, row: GlossaryRow): { content: string; added: boolean } {
  const parsed = parseGlossary(existing ?? '');
  const index = parsed.rows.findIndex(r => termKey(r.term) === termKey(row.term));
  if (index < 0 && parsed.rows.length >= GLOSSARY_ROWS_MAX) throw new MeshWriteError('glossary_full', { max: GLOSSARY_ROWS_MAX });
  return { content: upsertLine(existing, HEAD, parsed, index, `${glossaryContent(row)}${marker(row.by, null, row.external)}`), added: index < 0 };
}
