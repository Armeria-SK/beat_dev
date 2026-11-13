import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { AppConfig } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { folderMissing, type ProjectStore } from '../projects/store.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import { isBrowserTool } from '../tools/browser/names.ts';
import { buildPolicy } from '../tools/policy.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { effectivePolicy } from '../tools/tool-policy.ts';
import type { PreCheck, RunKind, ToolContext, ToolOutput } from '../tools/types.ts';
import { compareSnapshot, takeSnapshot, type Change } from './snapshot.ts';
import type { PendingRow, PendingState, PendingStatus, PendingStore } from './store.ts';

export interface ReplayDeps {
  db: DatabaseSync;
  store: PendingStore;
  registry: ToolRegistry;
  config: () => AppConfig;
  paths: AppPaths;
  projects?: ProjectStore | undefined;
  conversationExists: (id: string) => boolean;
  services?: (() => ToolContext['services']) | undefined;
  signal?: AbortSignal | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface ReplayOutcome {
  status: Exclude<PendingStatus, 'waiting' | 'running' | 'rejected'>;
  output?: string;
  changes?: Change[];
  fetched?: boolean;
}

const RUN_KINDS: readonly RunKind[] = ['chat', 'task', 'review', 'agent'];
const EXTRA_SECONDS = 60;

export async function replayAction(row: PendingRow, deps: ReplayDeps): Promise<ReplayOutcome> {
  const end = (status: ReplayOutcome['status'], output: string, extra: Partial<ReplayOutcome> = {}, result: { exitCode?: number | undefined; fullRef?: string | undefined } = {}): ReplayOutcome => {
    deps.store.finish(row.id, { status, output, ...result });
    return { status, output, ...extra };
  };
  try {
    const config = deps.config();
    if (!deps.conversationExists(row.conversation_id)) return end('cancelled', pendingText('en', 'cancelled_conversation'));
    let project: { id: string; root: string } | undefined;
    if (row.project_id) {
      const found = deps.projects?.get(row.project_id);
      if (!found || found.archived_at !== null) return end('cancelled', pendingText('en', 'cancelled_project'));
      if (folderMissing(found)) return end('failed', pendingText('en', 'project_missing'));
      project = { id: found.id, root: found.root };
    }
    if (!row.cwd || !statSync(row.cwd, { throwIfNoEntry: false })?.isDirectory()) return end('failed', pendingText('en', 'cwd_missing', { path: row.cwd ?? '' }));
    const kind = (RUN_KINDS as readonly string[]).includes(row.run_kind) ? row.run_kind as RunKind : 'task';
    const tool = deps.registry.get(row.tool);
    if (!tool || tool.replayable === false || !tool.allowedIn.includes(kind)) return end('failed', pendingText('en', 'tool_missing', { tool: row.tool }));
    if (effectivePolicy(tool.name, config, config) === 'block') return end('failed', pendingText('en', 'tool_blocked', { tool: row.tool }));
    if (isBrowserTool(tool.name) && !config.tools.browser.enabled) return end('failed', pendingText('en', 'browser_off'));
    let args: unknown;
    try { args = JSON.parse(row.input); } catch { return end('failed', pendingText('en', 'bad_input')); }
    if (!Value.Check(tool.input, args)) return end('failed', pendingText('en', 'bad_input'));

    const productRoots = [...(deps.projects?.list() ?? []), ...(deps.projects?.list({ archived: true }) ?? [])].map(p => p.root);
    const policy = buildPolicy(config, deps.paths, project, productRoots);
    const timeout = AbortSignal.timeout((config.tools.shell.maxTimeoutSec + EXTRA_SECONDS) * 1000);
    const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout;
    const runId = randomUUID();
    const ctx: ToolContext = {
      runId, conversationId: row.conversation_id, kind, signal, config, paths: deps.paths, policy, workspace: row.cwd,
      ...(project ? { project } : {}),
      taint: { tainted: false, sources: [] },
      log: deps.log ?? (() => undefined),
      services: deps.services?.(),
    };

    let again: PreCheck | undefined;
    if (tool.preCheck) {
      try { again = await tool.preCheck(args as never, ctx); }
      catch (error) { again = { decision: 'deny', reasons: [pendingText('en', 'precheck_failed', { detail: (error as Error).message })] }; }
      if (again.decision === 'deny') return end('failed', pendingText('en', 'denied', { reasons: again.reasons.join('\n- ') }));
      if ((again.bind ?? null) !== row.bind) return end('stale', pendingText('en', 'changed_bind'));
    } else if (row.bind !== null) return end('stale', pendingText('en', 'changed_bind'));

    if (row.kind === 'delete') {
      const state = JSON.parse(row.state ?? '{}') as PendingState;
      const before = state.snapshot ?? { git: null, paths: [] };
      const changes = compareSnapshot(before, takeSnapshot(row.cwd, before.paths.map(p => p.path), deps.paths.data));
      if (changes.length) {
        const lines = changes.map(c => pendingText('en', 'change_line', { ...c })).join('\n');
        return end('stale', pendingText('en', 'changed_state', { changes: lines }), { changes });
      }
    }

    const started = Date.now();
    let output: ToolOutput;
    try { output = await tool.execute(args as never, ctx, { approvedOnce: true, ...(again ? { check: again } : {}), ...(again?.bind !== undefined ? { bind: again.bind } : {}) }); }
    catch (error) { output = { content: pendingText('en', 'exec_error', { detail: (error as Error).message }), isError: true }; }
    if (signal.aborted && deps.signal?.aborted) output = { content: `${output.content}\n\n${pendingText('en', 'cancelled_stop')}`, isError: true };
    const network = tool.effect === 'network' || (() => { try { return tool.networkCall?.(args as never) === true; } catch { return true; } })();
    const fetched = (network && !(output.isError && output.noRemoteContent)) || again?.fetched === true || output.fetched === true;
    const shownInput = JSON.stringify(redactJsonValue(args)).slice(0, 4000);
    const preview = redactSecrets(output.content);
    deps.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, created_at)
      VALUES (?, ?, ?, ?, ?, 'allow', 'owner-pending', ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), row.run_id, row.conversation_id, row.tool, shownInput, `pending:${row.id}`, output.isError ? 0 : 1, Date.now() - started, preview.slice(0, 2000), output.fullRef ?? null, started,
    );
    const ran = output.exitCode !== undefined || !output.isError;
    return end(ran ? 'ran' : 'failed', output.content, { fetched }, { exitCode: output.exitCode, fullRef: output.fullRef });
  } catch (error) {
    deps.log?.(`[ERROR] Failed to run pending item #${row.id}: ${(error as Error).message}`);
    return end('failed', pendingText('en', 'exec_error', { detail: (error as Error).message }));
  }
}
