import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { KV } from '../db/kv.ts';
import { CONVERSATION_PLANS, conversationDraftFile, conversationPlanFile, isPlanConversation, PLAN_FILE, planConversationOf, planHash, type PlanMeta } from './plan.ts';
import { PROJECT_ID, projectDir } from './store.ts';

const ACCEPTANCE_FILE = 'acceptance.json';
const TEMP = /\.tmp-[0-9a-f]+$/u;

export interface AdoptIo {
  renameSync?: (from: string, to: string) => void;
  copyFileSync?: (from: string, to: string) => void;
}

export interface AdoptRecord { conversationId: string; hash: string | null; draftHash: string | null }

export interface AdoptResult { projectId: string; conversationId: string | null; plan: 'moved' | 'kept' | 'conflict' | 'none'; draft: 'moved' | 'kept' | 'conflict' | 'none' }

const recordKey = (projectId: string) => `plan-adopt:${projectId}`;

function regularFile(file: string): boolean | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  return stat.isFile() && stat.nlink === 1;
}

function legacyDraft(kv: KV, file: string, projectId: string): boolean {
  if (regularFile(file) !== true) return false;
  if (kv.db.prepare('SELECT 1 FROM acceptance_versions WHERE project_id = ? LIMIT 1').get(projectId)) return false;
  try { return (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version === 0; } catch { return false; }
}

function chooseConversation(kv: KV, projectId: string): string | null {
  const meta = kv.getJson<PlanMeta>(`plan:${projectId}`);
  const written = planConversationOf(kv.db, meta?.conversationId, projectId);
  if (written) return written;
  for (const tool of ['plan_write', 'acceptance_write']) {
    const row = kv.db.prepare(`SELECT t.conversation_id AS id FROM tool_calls t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.tool = ? AND t.ok = 1 AND c.project_id = ? AND c.kind = 'chat' AND c.parent_run_id IS NULL ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`).get(tool, projectId) as { id: string } | undefined;
    if (row && isPlanConversation(kv.db, projectId, row.id) && planConversationOf(kv.db, row.id, projectId)) return row.id;
  }
  const newest = kv.db.prepare(`SELECT id FROM conversations WHERE project_id = ? AND kind = 'chat' AND parent_run_id IS NULL ORDER BY last_message_at DESC, created_at DESC, rowid DESC LIMIT 1`).get(projectId) as { id: string } | undefined;
  return newest && planConversationOf(kv.db, newest.id, projectId) ? newest.id : null;
}

function copyVerified(from: string, to: string, io: Required<AdoptIo>): void {
  const temp = `${to}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    io.copyFileSync(from, temp);
    if (!readFileSync(temp).equals(readFileSync(from))) throw new Error('the copy differs from the original');
    if (regularFile(to) !== undefined) throw new Error('the destination appeared meanwhile');
    io.renameSync(temp, to);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (!readFileSync(to).equals(readFileSync(from))) throw new Error('the copied file differs from the original');
}

function stamp(now: number): string { return `${String(now).padStart(15, '0')}-${randomBytes(3).toString('hex')}`; }

export function adoptLegacyPlans(deps: { kv: KV; projectsDir: string; backupsDir: string; log: (line: string) => void; now?: () => number; io?: AdoptIo }): AdoptResult[] {
  const io: Required<AdoptIo> = { renameSync: deps.io?.renameSync ?? renameSync, copyFileSync: deps.io?.copyFileSync ?? copyFileSync };
  const now = deps.now ?? Date.now;
  let names: string[];
  try { names = readdirSync(deps.projectsDir); } catch { return []; }
  const results: AdoptResult[] = [];
  for (const projectId of names.filter(name => PROJECT_ID.test(name)).sort()) {
    try {
      const result = adoptOne(deps.kv, projectId, deps.projectsDir, deps.backupsDir, io, now, deps.log);
      if (result) results.push(result);
    } catch (error) {
      deps.log(`[WARN] Could not move the plan of product ${projectId} to its conversation: ${(error as Error).message}. It stays where it is and is tried again at the next start`);
    }
  }
  return results;
}

function adoptOne(kv: KV, projectId: string, projectsDir: string, backupsDir: string, io: Required<AdoptIo>, now: () => number, log: (line: string) => void): AdoptResult | undefined {
  const dir = projectDir(projectsDir, projectId);
  const plans = join(dir, CONVERSATION_PLANS);
  try { for (const name of readdirSync(plans).filter(n => TEMP.test(n))) rmSync(join(plans, name), { force: true }); } catch { }
  const legacyPlan = join(dir, PLAN_FILE);
  const legacyAcceptance = join(dir, ACCEPTANCE_FILE);
  const planState = regularFile(legacyPlan);
  if (planState === false) {
    log(`[WARN] plan.md of product ${projectId} is not a regular file, so it was not moved to a conversation`);
    return undefined;
  }
  const hasPlan = planState === true;
  const hasDraft = legacyDraft(kv, legacyAcceptance, projectId);
  if (!hasPlan && !hasDraft) {
    if (kv.get(`plan:${projectId}`) !== undefined) kv.delete(`plan:${projectId}`);
    if (kv.get(recordKey(projectId)) !== undefined) kv.delete(recordKey(projectId));
    return undefined;
  }
  const recorded = kv.getJson<AdoptRecord>(recordKey(projectId));
  let conversationId = recorded && typeof recorded.conversationId === 'string' && isPlanConversation(kv.db, projectId, recorded.conversationId) && planConversationOf(kv.db, recorded.conversationId, projectId) ? recorded.conversationId : null;
  if (!conversationId) {
    conversationId = chooseConversation(kv, projectId);
    if (!conversationId) return { projectId, conversationId: null, plan: hasPlan ? 'kept' : 'none', draft: hasDraft ? 'kept' : 'none' };
    kv.setJson(recordKey(projectId), { conversationId, hash: hasPlan ? planHash(readFileSync(legacyPlan, 'utf8')) : null, draftHash: hasDraft ? planHash(readFileSync(legacyAcceptance, 'utf8')) : null } satisfies AdoptRecord);
  }
  const backups = join(backupsDir, 'mesh', projectId);
  const move = (from: string, to: string, label: string): boolean => {
    mkdirSync(backups, { recursive: true });
    try { io.renameSync(from, to); return true; } catch (error) {
      log(`[WARN] Could not move the old ${label} of product ${projectId} to the backups (${(error as Error).message}). It stays in the product folder and is tried again at the next start`);
      return false;
    }
  };
  const adopt = (from: string, to: string, backupName: string, label: string): { outcome: 'moved' | 'kept' | 'conflict'; copied: boolean } => {
    mkdirSync(join(to, '..'), { recursive: true });
    const there = regularFile(to);
    if (there === false) throw new Error(`the ${label} of conversation ${conversationId} is not a regular file`);
    let copied = false;
    let outcome: 'moved' | 'conflict' = 'moved';
    if (there === undefined) { copyVerified(from, to, io); copied = true; }
    else if (!readFileSync(to).equals(readFileSync(from))) {
      outcome = 'conflict';
      log(`[WARN] Conversation ${conversationId} of product ${projectId} already has its own ${label}, so the old one was not copied over it. The old one is kept in the backups`);
    } else copied = true;
    return { outcome: move(from, join(backups, backupName), label) ? outcome : 'kept', copied };
  };
  let plan: AdoptResult['plan'] = 'none';
  if (hasPlan) {
    const { outcome, copied } = adopt(legacyPlan, conversationPlanFile(projectsDir, projectId, conversationId), `plan-legacy-${stamp(now())}.md`, 'plan');
    const meta = kv.getJson<PlanMeta>(`plan:${projectId}`);
    const key = `plan:${projectId}:${conversationId}`;
    if (copied && meta && kv.get(key) === undefined) kv.setJson(key, meta);
    if (outcome !== 'kept') kv.delete(`plan:${projectId}`);
    plan = outcome;
  } else if (kv.get(`plan:${projectId}`) !== undefined) kv.delete(`plan:${projectId}`);
  let draft: AdoptResult['draft'] = 'none';
  if (hasDraft) draft = adopt(legacyAcceptance, conversationDraftFile(projectsDir, projectId, conversationId), `acceptance-legacy-${stamp(now())}.json`, 'draft acceptance list').outcome;
  if (plan !== 'kept' && draft !== 'kept') kv.delete(recordKey(projectId));
  log(`[INFO] Moved the plan of product ${projectId} to conversation ${conversationId} (plan: ${plan}, draft acceptance list: ${draft})`);
  return { projectId, conversationId, plan, draft };
}
