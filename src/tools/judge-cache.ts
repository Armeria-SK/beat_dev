import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import { boundFacts, destinationFacts, PUSH_UNCONFIRMED, pushFacts } from '../pending/snapshot.ts';
import type { ClassifierInput } from './auto-approve.ts';
import { isRemotePath } from './hooks/remote-path.ts';
import type { ToolContext } from './types.ts';

export interface JudgeKeyParts {
  judgeInput: ClassifierInput;
  input: unknown;
  workspace: string;
  cwd: string;
  taintSources: number;
  reasonKeys: readonly string[];
  askKinds: readonly string[];
  bind: string | null;
  judge: unknown;
}

export interface InvolvedFiles {
  files: readonly string[];
  filesMore: boolean;
  pushes: ReadonlyArray<{ dir: string | null; parsed?: boolean }> | undefined;
  places: readonly string[] | undefined;
  dataDir: string;
}

export interface RememberedAllow { call: number; reason: string; snapshot: string }

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

export function judgeIdentity(config: Pick<AppConfig, 'routing' | 'models'>): unknown {
  const named = config.routing.judge ?? [];
  return named.map(id => { const model = config.models.find(m => m.id === id); return [id, model?.provider ?? null, model?.model ?? null]; });
}

const onRemoteDrive = (path: string): boolean => {
  if (isRemotePath(path)) return true;
  try { return isRemotePath(realpathSync.native(path)); } catch { return false; }
};

export async function involvedSnapshot(cwd: string, involved: InvolvedFiles, signal?: AbortSignal): Promise<string | undefined> {
  if (involved.filesMore || onRemoteDrive(cwd)) return undefined;
  const files = [...new Set(involved.files.map(f => resolve(cwd, f)))].sort();
  const facts = boundFacts(files);
  if (facts.some(f => f.more === true || f.unverifiable === true || (f.real !== undefined && isRemotePath(f.real)))) return undefined;
  const parts: unknown[] = [facts];
  if (involved.pushes?.length) {
    const pushed = await pushFacts(involved.pushes, involved.dataDir, undefined, signal);
    if (pushed.fingerprint.startsWith(PUSH_UNCONFIRMED) || signal?.aborted) return undefined;
    parts.push(pushed.fingerprint);
  }
  if (involved.pushes?.length || involved.places?.length) parts.push(destinationFacts(cwd, (involved.places ?? []).map(p => resolve(cwd, p))));
  return JSON.stringify(parts);
}

export function judgeCacheKey(ctx: ToolContext, parts: JudgeKeyParts): string | undefined {
  const fields: unknown[] = [
    ctx.runId, parts.judgeInput, parts.input, parts.workspace, parts.cwd, parts.taintSources,
    [...parts.reasonKeys].sort(), [...parts.askKinds].sort(), parts.bind, parts.judge,
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
  if (!memory.allowed.has(key) && memory.allowed.size >= REMEMBERED_MAX) return;
  memory.allowed.set(key, allow);
}
