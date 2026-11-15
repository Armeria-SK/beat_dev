import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { boundFacts, destinationFacts, PUSH_UNCONFIRMED, pushFacts } from '../pending/snapshot.ts';
import type { ApprovalPath } from './approvals.ts';
import type { ToolContext } from './types.ts';

export interface JudgeKeyParts {
  tool: string;
  input: unknown;
  workspace: string;
  cwd: string;
  userRequest: string;
  tainted: boolean;
  taintSources: number;
  reasonKeys: readonly string[];
  askKinds: readonly string[];
  reasons: readonly string[];
  title: string;
  body: string;
  shownCwd: string | undefined;
  paths: readonly ApprovalPath[];
  trusted: readonly string[];
}

export interface InvolvedFiles {
  files: readonly string[];
  filesMore: boolean;
  pushes: ReadonlyArray<{ dir: string | null; parsed?: boolean }> | undefined;
  places: readonly string[] | undefined;
  dataDir: string;
}

export interface RememberedAllow { call: number; reason: string }

interface RunMemory { runId: string; calls: number; allowed: Map<string, RememberedAllow> }

export const REMEMBERED_MAX = 256;

const memories = new WeakMap<ToolContext, RunMemory>();

function memoryOf(ctx: ToolContext): RunMemory {
  const known = memories.get(ctx);
  if (known && known.runId === ctx.runId) return known;
  const fresh: RunMemory = { runId: ctx.runId, calls: 0, allowed: new Map() };
  memories.set(ctx, fresh);
  return fresh;
}

export function nextCallNumber(ctx: ToolContext): number {
  return ++memoryOf(ctx).calls;
}

export async function involvedSnapshot(cwd: string, involved: InvolvedFiles): Promise<string | undefined> {
  if (involved.filesMore) return undefined;
  const files = [...new Set(involved.files.map(f => resolve(cwd, f)))].sort();
  const facts = boundFacts(files);
  if (facts.some(f => f.more === true || f.unverifiable === true)) return undefined;
  const parts: unknown[] = [facts];
  if (involved.pushes?.length) {
    const pushed = await pushFacts(involved.pushes, involved.dataDir);
    if (pushed.fingerprint.startsWith(PUSH_UNCONFIRMED)) return undefined;
    parts.push(pushed.fingerprint);
  }
  if (involved.pushes?.length || involved.places?.length) parts.push(destinationFacts(cwd, (involved.places ?? []).map(p => resolve(cwd, p))));
  return JSON.stringify(parts);
}

export async function judgeCacheKey(ctx: ToolContext, parts: JudgeKeyParts, involved: InvolvedFiles): Promise<string | undefined> {
  let snapshot: string | undefined;
  try { snapshot = await involvedSnapshot(parts.cwd, involved); } catch { return undefined; }
  if (snapshot === undefined) return undefined;
  const fields: unknown[] = [
    ctx.runId, parts.tool, parts.input, parts.workspace, parts.cwd, parts.userRequest, parts.tainted, parts.taintSources,
    [...parts.reasonKeys].sort(), [...parts.askKinds].sort(), parts.reasons, parts.title, parts.body, parts.shownCwd ?? null, parts.paths, parts.trusted, snapshot,
  ];
  let text: string;
  try { text = JSON.stringify(fields); } catch { return undefined; }
  return createHash('sha256').update(text).digest('hex');
}

export function rememberedAllow(ctx: ToolContext, key: string): RememberedAllow | undefined {
  return memoryOf(ctx).allowed.get(key);
}

export function rememberAllow(ctx: ToolContext, key: string, allow: RememberedAllow): void {
  const memory = memoryOf(ctx);
  if (memory.allowed.has(key) || memory.allowed.size >= REMEMBERED_MAX) return;
  memory.allowed.set(key, allow);
}
