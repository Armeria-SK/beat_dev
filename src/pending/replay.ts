import { randomUUID } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { AppConfig } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { folderMissing, type ProjectStore } from '../projects/store.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import { isBrowserTool } from '../tools/browser/names.ts';
import { runCommandHook } from '../tools/hooks/command-hook.ts';
import { placePath, windowsNames } from '../tools/hooks/scope.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { effectivePolicy } from '../tools/tool-policy.ts';
import type { PreCheck, RunKind, ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { outboundOfCall } from '../tools/hooks/outbound.ts';
import { hookPaths } from '../tools/pipeline.ts';
import { identityOf } from '../projects/created.ts';
import { boundChanged, boundFacts, compareSnapshot, destinationFacts, PUSH_UNCONFIRMED, pushFacts, takeSnapshot, type Change } from './snapshot.ts';
import { newChecks, parkedOutbound, realCwd, type PendingRow, type PendingState, type PendingStatus, type PendingStore } from './store.ts';

export interface ReplayDeps {
  db: DatabaseSync;
  store: PendingStore;
  registry: ToolRegistry;
  config: () => AppConfig;
  paths: AppPaths;
  projects?: ProjectStore | undefined;
  conversationExists: (id: string) => boolean;
  conversationTainted?: ((id: string) => boolean) | undefined;
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
const WINDOWS = process.platform === 'win32';

const matches = (matcher: string, name: string): boolean => { try { return new RegExp(`^(?:${matcher})$`, 'u').test(name); } catch { return false; } };

export function parentOf(db: DatabaseSync, row: PendingRow): ToolContext['parent'] {
  if (row.run_kind !== 'agent') return undefined;
  const run = db.prepare('SELECT parent_run_id AS id FROM engine_runs WHERE id = ?').get(row.run_id) as { id: string | null } | undefined;
  const conversation = db.prepare('SELECT parent_run_id AS id, title FROM conversations WHERE id = ?').get(row.conversation_id) as { id: string | null; title: string | null } | undefined;
  const parentRunId = run?.id ?? conversation?.id ?? null;
  if (!parentRunId) return undefined;
  const parent = db.prepare('SELECT kind, conversation_id FROM engine_runs WHERE id = ?').get(parentRunId) as { kind: string; conversation_id: string | null } | undefined;
  if (!parent?.conversation_id || !(RUN_KINDS as readonly string[]).includes(parent.kind)) return undefined;
  const task = parent.kind === 'task'
    ? db.prepare('SELECT id FROM tasks WHERE conversation_id = ?').get(parent.conversation_id) as { id: string } | undefined
    : undefined;
  return { runId: parentRunId, conversationId: parent.conversation_id, kind: parent.kind as RunKind, title: conversation?.title ?? '', ...(task ? { taskId: task.id } : {}) };
}

interface HookFacts { check: PreCheck | undefined; tainted: boolean; productRoots: string[] }

async function hookRefusal(tool: ToolDef, args: unknown, ctx: ToolContext, facts: HookFacts): Promise<string | undefined> {
  let summaryCwd: string | undefined;
  try { summaryCwd = tool.summarize?.(args as never, 'en').cwd; } catch { summaryCwd = undefined; }
  const cwd = facts.check?.cwd ?? (summaryCwd ? resolve(ctx.workspace, summaryCwd) : ctx.workspace);
  for (const hook of ctx.config.tools.hooks.preToolUse) {
    if (hook.enabled === false || !matches(hook.matcher, tool.name)) continue;
    const result = await runCommandHook(hook, {
      hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args, cwd: WINDOWS ? windowsNames(cwd) : cwd, run_id: ctx.runId, conversation_id: ctx.conversationId,
      paths: hookPaths(tool, facts.check), tainted: facts.tainted, run_kind: ctx.kind, ...(ctx.project?.root ? { project_root: ctx.project.root } : {}), product_roots: facts.productRoots,
    }, ctx.signal, 'en');
    if (result.decision === 'deny') return result.reason || result.hook;
  }
  return undefined;
}

export async function replayAction(row: PendingRow, deps: ReplayDeps): Promise<ReplayOutcome> {
  const end = (status: ReplayOutcome['status'], output: string | undefined, extra: Partial<ReplayOutcome> = {}, result: { exitCode?: number | undefined; fullRef?: string | undefined } = {}): ReplayOutcome => {
    deps.store.finish(row.id, { status, output, ...result, ...(extra.fetched !== undefined ? { fetched: extra.fetched } : {}) });
    return { status, ...(output !== undefined ? { output } : {}), ...extra };
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
    const state = JSON.parse(row.state ?? '{}') as PendingState;
    if (state.cwdReal !== undefined && realCwd(row.cwd) !== state.cwdReal) return end('stale', pendingText('en', 'changed_cwd', { path: row.cwd }));
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
    if (placePath(resolve(row.cwd), policy).kind !== 'inside') return end('failed', pendingText('en', 'cwd_outside', { path: row.cwd }));
    const workspace = state.workspace ?? row.cwd;
    if (placePath(resolve(workspace), policy).kind !== 'inside') return end('failed', pendingText('en', 'cwd_outside', { path: workspace }));
    if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) return end('failed', pendingText('en', 'cwd_missing', { path: workspace }));
    const created = new Map((state.created ?? []).map(c => [c.path, c]));
    const stillCreated = (path: string): boolean => {
      const mark = created.get(path);
      if (!mark || identityOf(path) !== mark.id) return false;
      if (mark.inside === undefined) return true;
      const now = boundFacts([path])[0]!;
      return mark.more !== true && now.more !== true && now.hash === mark.inside;
    };
    const timeout = AbortSignal.timeout((config.tools.shell.maxTimeoutSec + EXTRA_SECONDS) * 1000);
    const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout;
    const runId = randomUUID();
    const conversationTainted = (): boolean => {
      if (row.tainted === 1) return true;
      try { return deps.conversationTainted?.(row.conversation_id) ?? false; } catch { return true; }
    };
    const parent = parentOf(deps.db, row);
    const ctx: ToolContext = {
      runId, conversationId: row.conversation_id, kind, signal, config, paths: deps.paths, policy, workspace,
      home: defaultWorkspace(buildPolicy(config, deps.paths, undefined, productRoots), deps.paths),
      ...(project ? { project } : {}),
      taint: row.tainted === 1 ? { tainted: true, sources: [pendingText('en', 'taint_parked')] } : { tainted: false, sources: [] },
      conversationTainted,
      isCreated: stillCreated,
      ...(row.task_id ? { task: { id: row.task_id, control: { outcome: 'none' as const } } } : {}),
      ...(parent ? { parent } : {}),
      log: deps.log ?? (() => undefined),
      services: deps.services?.(),
    };

    const recheck = async (): Promise<PreCheck | undefined> => {
      if (!tool.preCheck) return undefined;
      try {
        const checked = tool.preCheck(args as never, ctx);
        return checked instanceof Promise ? await checked : checked;
      } catch (error) { return { decision: 'deny', reasons: [pendingText('en', 'precheck_failed', { detail: (error as Error).message })] }; }
    };
    const forHook = await recheck();
    if (forHook?.decision === 'deny') return end('failed', pendingText('en', 'denied', { reasons: forHook.reasons.join('\n- ') }));
    const refused = await hookRefusal(tool, args, ctx, { check: forHook, tainted: conversationTainted(), productRoots });
    if (refused !== undefined) return end('failed', pendingText('en', 'hook_denied', { reason: refused }));
    let changes: Change[] = [];
    if (row.kind === 'delete') {
      const before = state.snapshot ?? { git: null, paths: [] };
      changes = compareSnapshot(before, await takeSnapshot(row.cwd, before.paths.map(p => p.path), deps.paths.data));
    }
    const pushedNow = state.pushes?.length ? (await pushFacts(state.pushes, deps.paths.data)).fingerprint : undefined;
    const again = await recheck();
    if (again?.decision === 'deny') return end('failed', pendingText('en', 'denied', { reasons: again.reasons.join('\n- ') }));
    if (again?.cwd !== undefined && resolve(again.cwd) !== resolve(row.cwd)) return end('stale', pendingText('en', 'changed_cwd', { path: again.cwd }));

    const mask = (text: string): string => (tool.redact ? tool.redact(text) : text);
    const outboundNow = outboundOfCall(tool, again, 'en');
    if (outboundNow?.kind === 'deny') return end('failed', pendingText('en', 'denied', { reasons: outboundNow.reason }));
    if (state.cwdReal !== undefined && realCwd(row.cwd) !== state.cwdReal) return end('stale', pendingText('en', 'changed_cwd', { path: row.cwd }));
    if ((again?.bind ?? null) !== row.bind) return end('stale', pendingText('en', 'changed_bind'));
    if (again) {
      const fresh = newChecks(state.recheck, again, mask);
      if (fresh.length) return end('stale', pendingText('en', 'changed_checks', { reasons: fresh.join('\n- ') }));
    }
    if (!state.outbound && (outboundNow?.kind === 'send' || outboundNow?.kind === 'delete')) {
      return end('stale', pendingText('en', 'changed_target', { before: 'none', now: JSON.stringify(parkedOutbound({ kind: outboundNow.kind, reason: outboundNow.reason, targets: outboundNow.targets }, mask)) }));
    }
    if (state.outbound) {
      const before = JSON.stringify(state.outbound);
      const now = outboundNow ? JSON.stringify(parkedOutbound({ kind: outboundNow.kind, reason: outboundNow.reason, targets: outboundNow.targets }, mask)) : 'none';
      if (now !== before) return end('stale', pendingText('en', 'changed_target', { before, now }));
    }
    if (state.destination !== undefined) {
      const now = destinationFacts(row.cwd, state.places ?? []);
      if (now !== state.destination) return end('stale', pendingText('en', 'changed_target', { before: state.destination.slice(0, 12), now: now.slice(0, 12) }));
    }
    if (state.filesMore) return end('stale', pendingText('en', 'files_unbound'));
    if (state.sent?.length) {
      const now = boundFacts(state.sent.map(f => f.path));
      const moved = state.sent.flatMap((was, i) => {
        const is = now[i]!;
        const mark = (fact: typeof was): string => (fact.exists ? `${fact.size ?? fact.type ?? ''} ${(fact.hash ?? '').slice(0, 12)}`.trim() : 'none');
        return boundChanged(was, is, again?.gitStaging === true) ? [pendingText('en', 'change_line', { what: was.path, before: mark(was), now: mark(is) })] : [];
      });
      if (moved.length) return end('stale', pendingText('en', 'changed_files', { changes: moved.join('\n') }));
    }
    if (changes.length) {
      const lines = changes.map(c => pendingText('en', 'change_line', { ...c })).join('\n');
      return end('stale', pendingText('en', 'changed_state', { changes: lines }), { changes });
    }
    if (state.pushed !== undefined && (state.pushed.startsWith(PUSH_UNCONFIRMED) || pushedNow?.startsWith(PUSH_UNCONFIRMED))) return end('stale', pendingText('en', 'push_unconfirmed'));
    if (state.pushed !== undefined && pushedNow !== state.pushed) return end('stale', pendingText('en', state.pushes?.every(p => p.parsed) ? 'changed_head' : 'changed_commits'));
    const pushCheck = state.pushes?.length && state.tips ? { tips: state.tips, required: state.pushes.some(p => p.parsed) } : undefined;

    const started = Date.now();
    let output: ToolOutput;
    try { output = await tool.execute(args as never, ctx, { approvedOnce: true, ...(again ? { check: again } : {}), ...(again?.bind !== undefined ? { bind: again.bind } : {}), ...(pushCheck ? { pushCheck } : {}) }); }
    catch (error) { output = { content: pendingText('en', 'exec_error', { detail: (error as Error).message }), isError: true }; }
    if (output.pushCheckUnavailable) return end('failed', pendingText('en', 'push_check_unavailable'));
    if (signal.aborted && deps.signal?.aborted) output = { content: `${output.content}\n\n${pendingText('en', 'cancelled_stop')}`, isError: true };
    const network = tool.effect === 'network' || (() => { try { return tool.networkCall?.(args as never) === true; } catch { return true; } })();
    const egress = again?.decision === 'ask' && again.askKinds?.includes('egress') === true;
    const fetched = (network && !(output.isError && output.noRemoteContent)) || again?.fetched === true || output.fetched === true || egress;
    const kept = deps.conversationExists(row.conversation_id);
    if (!kept && output.fullRef && resolve(output.fullRef).startsWith(resolve(join(deps.paths.data, 'tool_outputs')) + sep)) {
      try { rmSync(output.fullRef, { force: true }); } catch { }
    }
    const shownInput = kept ? JSON.stringify(redactJsonValue(args)).slice(0, 4000) : '';
    const preview = kept ? redactSecrets(output.content).slice(0, 2000) : null;
    deps.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, created_at)
      VALUES (?, ?, ?, ?, ?, 'allow', 'owner-pending', ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), row.run_id, kept ? row.conversation_id : null, row.tool, shownInput, `pending:${row.id}`, output.isError ? 0 : 1, Date.now() - started, preview, kept ? output.fullRef ?? null : null, started,
    );
    if (output.pushRefused) return end('failed', kept ? `${pendingText('en', 'push_unseen')}\n\n${output.content}` : pendingText('en', 'push_unseen'), { fetched }, kept ? { exitCode: output.exitCode, fullRef: output.fullRef } : { exitCode: output.exitCode });
    const ran = output.exitCode !== undefined || !output.isError;
    return end(ran ? 'ran' : 'failed', kept ? output.content : undefined, { fetched }, kept ? { exitCode: output.exitCode, fullRef: output.fullRef } : { exitCode: output.exitCode });
  } catch (error) {
    deps.log?.(`[ERROR] Failed to run pending item #${row.id}: ${(error as Error).message}`);
    return end('failed', pendingText('en', 'exec_error', { detail: (error as Error).message }));
  }
}
