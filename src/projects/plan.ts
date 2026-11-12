import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KV } from '../db/kv.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { planText, type PlanMessageKey } from '../shared/messages/plans.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { projectDir } from './store.ts';

export const PLAN_FILE = 'plan.md';
export const PLAN_MAX_CHARS = 64_000;
export const PLAN_BACKUPS = 20;
const BACKUP_NAME = /^plan-\d+-[0-9a-f]+\.md$/u;

export type PlanAuthor = 'ai' | 'owner';

export interface PlanMeta { hash: string; updatedAt: number; by: PlanAuthor; tainted: boolean; conversationId: string | null; runId: string | null }

export interface PlanView { content: string | null; hash: string | null; updated_at: number | null; updated_by: PlanAuthor | 'outside' | null; tainted: boolean }

export interface PlanIo { writeFileSync?: (path: string, data: string) => void; renameSync?: (from: string, to: string) => void }

export class PlanError extends LocalizedError<PlanMessageKey> {
  constructor(code: PlanMessageKey, params?: MessageParams) { super(planText, code, params); }
}

export const planHash = (content: string): string => createHash('sha256').update(content).digest('hex');

export function cleanPlan(raw: string): string {
  const content = stripHidden(raw);
  if (content.length > PLAN_MAX_CHARS) throw new PlanError('too_long', { max: PLAN_MAX_CHARS });
  if (sanitizeModelInputText(content).redaction_count > 0) throw new PlanError('secret');
  return content;
}

export class PlanStore {
  readonly #kv: KV;
  readonly #dirs: { projects: string; backups: string };
  readonly #now: () => number;
  readonly #write: (path: string, data: string) => void;
  readonly #rename: (from: string, to: string) => void;

  constructor(kv: KV, dirs: { projects: string; backups: string }, now: () => number = Date.now, io: PlanIo = {}) {
    this.#kv = kv;
    this.#dirs = dirs;
    this.#now = now;
    this.#write = io.writeFileSync ?? ((path, data) => writeFileSync(path, data));
    this.#rename = io.renameSync ?? renameSync;
  }

  #file(projectId: string): string { return join(projectDir(this.#dirs.projects, projectId), PLAN_FILE); }

  read(projectId: string): string | undefined {
    const file = this.#file(projectId);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  has(projectId: string): boolean {
    try { return existsSync(this.#file(projectId)); } catch { return false; }
  }

  meta(projectId: string): PlanMeta | undefined { return this.#kv.getJson<PlanMeta>(`plan:${projectId}`); }

  view(projectId: string): PlanView {
    const content = this.read(projectId);
    if (content === undefined) return { content: null, hash: null, updated_at: null, updated_by: null, tainted: false };
    const hash = planHash(content);
    const meta = this.meta(projectId);
    if (meta?.hash === hash) return { content, hash, updated_at: meta.updatedAt, updated_by: meta.by, tainted: meta.tainted === true };
    return { content, hash, updated_at: Math.floor(statSync(this.#file(projectId)).mtimeMs), updated_by: 'outside', tainted: false };
  }

  write(projectId: string, raw: string, by: Omit<PlanMeta, 'hash' | 'updatedAt'>, baseHash?: string | null): PlanView & { content: string; hash: string } {
    const content = cleanPlan(raw);
    const file = this.#file(projectId);
    mkdirSync(join(file, '..'), { recursive: true });
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (baseHash !== undefined && (previous === undefined ? null : planHash(previous)) !== baseHash) throw new PlanError('changed');
    const now = this.#now();
    if (previous !== undefined) this.#backup(projectId, previous, now);
    const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      this.#write(temp, content);
      this.#rename(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    const meta: PlanMeta = { hash: planHash(content), updatedAt: now, ...by };
    this.#kv.setJson(`plan:${projectId}`, meta);
    return { content, hash: meta.hash, updated_at: now, updated_by: by.by, tainted: by.tainted };
  }

  #backup(projectId: string, content: string, now: number): void {
    const dir = join(this.#dirs.backups, 'mesh', projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `plan-${String(now).padStart(15, '0')}-${randomBytes(3).toString('hex')}.md`), content);
    const kept = readdirSync(dir).filter(name => BACKUP_NAME.test(name)).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - PLAN_BACKUPS))) rmSync(join(dir, name), { force: true });
  }
}
