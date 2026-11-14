import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { normalizeQuote } from '../projects/acceptance.ts';
import { normalizeUrl, pageKey, quoteHasName } from './evidence.ts';
import { checkLabel, ResearchError, type LabelKind } from './labels.ts';

export type ResearchPhase = 'products' | 'libraries';
export type ResearchMode = 'batch' | 'one_by_one';
export type ResearchStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'confirmed';
export type ResearchEnd = 'done' | 'failed' | 'cancelled' | 'skipped';
export type ItemKind = Exclude<LabelKind, 'option'>;

export const ITEM_LIMITS: Record<ItemKind, number> = { similar: 8, feature: 40, choice: 6, library: 20 };
const PHASE_KINDS: Record<ResearchPhase, readonly ItemKind[]> = { products: ['similar', 'feature'], libraries: ['choice', 'library'] };
const STANDARD_PRODUCTS = 2;

export interface ResearchRunRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  run_id: string | null;
  phase: ResearchPhase;
  mode: ResearchMode;
  status: ResearchStatus;
  shown_hash: string | null;
  confirmed_at: number | null;
  created_at: number;
  finished_at: number | null;
  limits: string;
}

export interface ResearchItemRow {
  id: number;
  research_id: string;
  kind: ItemKind;
  name_or_label: string;
  detail: string | null;
  url: string | null;
  license: string | null;
  updated: string | null;
  language: string | null;
  evidence: string;
  products: string;
  options: string | null;
  default_checked: number;
  default_reason: 'owner_said' | 'standard' | null;
  decision: string | null;
  reason: string | null;
  recommended: number | null;
  answer_kind: 'kept' | 'changed' | null;
}

export interface FeatureEvidence { similar: number; url: string; quote: string }

export interface SourceItem {
  kind: 'similar' | 'library';
  name: string;
  url: string;
  detail?: string | null | undefined;
  license?: string | null | undefined;
  updated?: string | null | undefined;
  language?: string | null | undefined;
  evidence: Record<string, string>;
}

export interface FeatureItem { label: string; detail?: string | null | undefined; evidence: readonly FeatureEvidence[] }

export interface ChoiceItem { label: string; detail?: string | null | undefined; options: readonly string[]; recommended?: number | null | undefined }

export interface ResearchStart {
  projectId: string;
  conversationId?: string | null | undefined;
  runId?: string | null | undefined;
  phase: ResearchPhase;
  mode: ResearchMode;
  limits?: Record<string, number> | undefined;
}

export class ResearchStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  start(input: ResearchStart): ResearchRunRow {
    const id = randomUUID();
    this.#db.prepare("INSERT INTO research_runs (id, project_id, conversation_id, run_id, phase, mode, status, created_at, limits) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)")
      .run(id, input.projectId, input.conversationId ?? null, input.runId ?? null, input.phase, input.mode, this.#now(), JSON.stringify(input.limits ?? {}));
    return this.get(id)!;
  }

  get(id: string): ResearchRunRow | undefined {
    const row = this.#db.prepare('SELECT * FROM research_runs WHERE id = ?').get(id);
    return row ? { ...row } as unknown as ResearchRunRow : undefined;
  }

  runningFor(runId: string): ResearchRunRow | undefined {
    const row = this.#db.prepare("SELECT * FROM research_runs WHERE run_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(runId);
    return row ? { ...row } as unknown as ResearchRunRow : undefined;
  }

  attachRun(id: string, runId: string): void {
    const changed = this.#db.prepare("UPDATE research_runs SET run_id = ? WHERE id = ? AND status = 'running'").run(runId, id).changes;
    if (Number(changed) !== 1) throw this.#ended(id);
  }

  finish(id: string, status: ResearchEnd): void {
    const changed = this.#db.prepare("UPDATE research_runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(status, this.#now(), id).changes;
    if (Number(changed) !== 1) throw this.#ended(id);
  }

  failRunning(): number {
    return Number(this.#db.prepare("UPDATE research_runs SET status = 'failed', finished_at = ? WHERE status = 'running'").run(this.#now()).changes);
  }

  items(researchId: string): ResearchItemRow[] {
    return this.#db.prepare('SELECT * FROM research_items WHERE research_id = ? ORDER BY id').all(researchId).map(r => ({ ...r }) as unknown as ResearchItemRow);
  }

  addSource(researchId: string, item: SourceItem): ResearchItemRow {
    return transaction(this.#db, () => {
      const name = checkLabel(item.kind, item.name);
      const items = this.#open(researchId, item.kind);
      const url = normalizeUrl(item.url);
      if (url === null) throw new ResearchError('url_invalid');
      if (items.some(i => i.kind === item.kind && (pageKey(i.url ?? '') === pageKey(url) || normalizeQuote(i.name_or_label) === normalizeQuote(name)))) throw new ResearchError('duplicate', { what: name });
      const id = this.#db.prepare('INSERT INTO research_items (research_id, kind, name_or_label, detail, url, license, updated, language, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(researchId, item.kind, name, item.detail ?? null, url, item.license ?? null, item.updated ?? null, item.language ?? null, JSON.stringify({ ...item.evidence, url })).lastInsertRowid;
      return this.#item(Number(id));
    });
  }

  addFeature(researchId: string, item: FeatureItem): { row: ResearchItemRow; merged: boolean } {
    return transaction(this.#db, () => {
      const label = checkLabel('feature', item.label);
      const items = this.#open(researchId, 'feature', normalizeQuote(label));
      const similar = new Map(items.filter(i => i.kind === 'similar').map(i => [i.id, i]));
      const fresh = item.evidence.filter(e => {
        const source = similar.get(e.similar);
        return source !== undefined && source.url === normalizeUrl(e.url);
      });
      const existing = items.find(i => i.kind === 'feature' && normalizeQuote(i.name_or_label) === normalizeQuote(label));
      const evidence = [...(existing ? JSON.parse(existing.evidence) as FeatureEvidence[] : []), ...fresh];
      const products = [...new Set(evidence.map(e => e.similar))].sort((a, b) => a - b);
      const urls = new Set(evidence.filter(e => quoteHasName(e.quote, label)).map(e => pageKey(similar.get(e.similar)?.url ?? '')).filter(u => u !== null));
      const standard = urls.size >= STANDARD_PRODUCTS;
      if (existing) {
        this.#db.prepare("UPDATE research_items SET evidence = ?, products = ?, default_checked = ?, default_reason = ? WHERE id = ?")
          .run(JSON.stringify(evidence), JSON.stringify(products), standard ? 1 : 0, standard ? 'standard' : null, existing.id);
        return { row: this.#item(existing.id), merged: true };
      }
      const id = this.#db.prepare('INSERT INTO research_items (research_id, kind, name_or_label, detail, evidence, products, default_checked, default_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(researchId, 'feature', label, item.detail ?? null, JSON.stringify(evidence), JSON.stringify(products), standard ? 1 : 0, standard ? 'standard' : null).lastInsertRowid;
      return { row: this.#item(Number(id)), merged: false };
    });
  }

  addChoice(researchId: string, item: ChoiceItem): ResearchItemRow {
    return transaction(this.#db, () => {
      const label = checkLabel('choice', item.label);
      const options = item.options.map(o => checkLabel('option', o));
      this.#open(researchId, 'choice');
      if (options.length < 2 || options.length > 4) throw new ResearchError('options_count');
      const recommended = item.recommended !== undefined && item.recommended !== null && item.recommended >= 0 && item.recommended < options.length ? item.recommended : null;
      const id = this.#db.prepare('INSERT INTO research_items (research_id, kind, name_or_label, detail, options, recommended) VALUES (?, ?, ?, ?, ?, ?)')
        .run(researchId, 'choice', label, item.detail ?? null, JSON.stringify(options), recommended).lastInsertRowid;
      return this.#item(Number(id));
    });
  }

  #open(researchId: string, kind: ItemKind, mergeKey?: string): ResearchItemRow[] {
    const run = this.get(researchId);
    if (!run) throw new ResearchError('not_found', { id: researchId });
    if (run.status !== 'running') throw new ResearchError('finished', { id: researchId });
    if (!PHASE_KINDS[run.phase].includes(kind)) throw new ResearchError('kind_phase', { kind });
    const items = this.items(researchId);
    const same = items.filter(i => i.kind === kind);
    const merges = mergeKey !== undefined && same.some(i => normalizeQuote(i.name_or_label) === mergeKey);
    if (!merges && same.length >= ITEM_LIMITS[kind]) throw new ResearchError('too_many', { max: ITEM_LIMITS[kind], kind });
    return items;
  }

  #item(id: number): ResearchItemRow {
    return { ...this.#db.prepare('SELECT * FROM research_items WHERE id = ?').get(id) } as unknown as ResearchItemRow;
  }

  #ended(id: string): ResearchError {
    return this.get(id) ? new ResearchError('finished', { id }) : new ResearchError('not_found', { id });
  }
}
