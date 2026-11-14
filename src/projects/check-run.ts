import type { AppConfig, Language } from '../config/schema.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, resolveShell, runProcess, scrubEnv } from '../tools/shell/runner.ts';
import { checkCommandOf, folderMissing, type ProjectStore } from './store.ts';

export const CHECK_TIMEOUT_MS = 30 * 60_000;
export const CHECK_FAIL_LIMIT = 3;
const HEAD_BYTES = 65_536;
const TAIL_BYTES = 16_384;
const TAIL_CHARS = 1500;
const EVENT_TAIL_CHARS = 500;
export const CHECK_OPTIONS = ['Retry', 'Leave it'] as const;
export const CHECK_KEEP = 1;

export interface ProductCheck { command: string; root: string }

export type CheckResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'failed' | 'timeout' | 'spawn'; exitCode: number | null; tail: string; durationMs: number }
  | { ok: false; reason: 'aborted' };

export function productCheck(projects: ProjectStore | undefined, projectId: string | null): ProductCheck | 'invalid' | undefined {
  if (!projectId) return undefined;
  const row = projects?.get(projectId);
  if (!row) return undefined;
  let command: string | null;
  try { command = checkCommandOf(row.check_command); } catch { return 'invalid'; }
  if (!command) return undefined;
  return folderMissing(row) ? 'invalid' : { command, root: row.root };
}

const tailOf = (text: string): string => {
  const clean = redactSecrets(text).trimEnd();
  return clean.length > TAIL_CHARS ? `…${clean.slice(-TAIL_CHARS)}` : clean;
};

export function checkEnv(config: AppConfig, cwd: string, dataDir: string): { env: Record<string, string>; cleanup: () => void } {
  const settings = config.tools.shell;
  const shell = resolveShell(settings.shell);
  const base = Object.fromEntries(Object.entries(scrubEnv(settings.envAllow)).filter(([key]) => !/^git_/iu.test(key)));
  const gitExe = findExecutable('git', base, cwd, { powershell: shell.name === 'powershell' || shell.name === 'pwsh' });
  if (gitExe && (isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe))) return { env: base, cleanup: () => undefined };
  const gitRun = prepareGitRun({ dataDir, env: base, ...(gitExe ? { gitExe } : {}) });
  return { env: { ...base, ...gitRun.env }, cleanup: gitRun.cleanup };
}

export async function runProductCheck(check: ProductCheck, options: { config: AppConfig; dataDir: string; signal: AbortSignal; timeoutMs?: number }): Promise<CheckResult> {
  const shell = resolveShell(options.config.tools.shell.shell);
  const { env, cleanup } = checkEnv(options.config, check.root, options.dataDir);
  let result;
  try {
    result = await runProcess(shell.file, shell.args(check.command), {
      cwd: check.root, env, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS, signal: options.signal, maxBytes: HEAD_BYTES, tailBytes: TAIL_BYTES, settleOnExit: true,
      ...(shell.stdin ? { input: shell.stdin(check.command) } : {}),
    });
  } finally { cleanup(); }
  if (result.aborted) return { ok: false, reason: 'aborted' };
  if (!result.spawnError && !result.timedOut && result.exitCode === 0) return { ok: true, durationMs: result.durationMs };
  const out = result.stdoutTail ?? result.stdout;
  const err = result.stderrTail ?? result.stderr;
  const parts = [out.trim() ? tailOf(out) : '', err.trim() ? `[stderr]\n${tailOf(err)}` : '', result.spawnError ? redactSecrets(result.spawnError) : ''].filter(Boolean);
  return { ok: false, reason: result.spawnError ? 'spawn' : result.timedOut ? 'timeout' : 'failed', exitCode: result.exitCode, tail: parts.join('\n'), durationMs: result.durationMs };
}

const OWNER_POLL_MS = 1000;

export function checkSignal(stop: AbortSignal, stillRunning: () => boolean): { signal: AbortSignal; dispose: () => void } {
  const own = new AbortController();
  const fromStop = () => own.abort(stop.reason);
  const poll = setInterval(() => {
    let running = false;
    try { running = stillRunning(); } catch { running = false; }
    if (!running) own.abort(new Error('task no longer running'));
  }, OWNER_POLL_MS);
  poll.unref?.();
  if (stop.aborted) fromStop(); else stop.addEventListener('abort', fromStop, { once: true });
  return { signal: own.signal, dispose: () => { clearInterval(poll); stop.removeEventListener('abort', fromStop); } };
}

type Failed = Extract<CheckResult, { reason: 'failed' | 'timeout' | 'spawn' }>;

interface CheckText {
  childrenLeft: (count: number) => string;
  yieldReason: (count: number) => string;
  passed: (command: string) => string;
  stopped: string;
  outcome: (failed: Failed) => string;
  failed: (command: string, failed: Failed, attempt: number) => string;
  gaveUp: (command: string, failed: Failed) => string;
  reason: (failed: Failed) => string;
  event: (failed: Failed, attempt: number) => string;
  invalid: string;
  already: string;
  selfDone: string;
  doneChildren: (count: number) => string;
  doneCheck: string;
  question: (title: string) => string;
  why: (last: string | null) => string;
}

export const CHECK_TEXT: Record<Language, CheckText> = {
  en: {
    childrenLeft: count => `${count} task(s) you made from this task are not finished yet, so this task is not complete. beat resumes this task after they finish (tasks set to start later hold it until they have run).`,
    yieldReason: count => `Waiting for ${count} task(s) it made to finish`,
    passed: command => `The product's check command passed: ${redactSecrets(command)}`,
    stopped: 'The check command was stopped, so the task is not complete.',
    outcome: failed => (failed.reason === 'timeout' ? `it ran past ${CHECK_TIMEOUT_MS / 60_000} minutes and was stopped` : failed.reason === 'spawn' ? 'it could not be started' : `exit code ${failed.exitCode ?? '—'}`),
    failed: (command, failed, attempt) => [
      `The product's check command failed (${CHECK_TEXT.en.outcome(failed)}), so the task is not complete. Fix the cause and call task_complete again (failure ${attempt} of ${CHECK_FAIL_LIMIT} in a row).`,
      `Command: ${redactSecrets(command)}`,
      ...(failed.tail ? [`Output (end):\n${failed.tail}`] : []),
    ].join('\n'),
    gaveUp: (command, failed) => [
      `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row (${CHECK_TEXT.en.outcome(failed)}). The task is closed as failed and the owner is asked in Questions.`,
      `Command: ${redactSecrets(command)}`,
      ...(failed.tail ? [`Output (end):\n${failed.tail}`] : []),
    ].join('\n'),
    reason: failed => `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row (${CHECK_TEXT.en.outcome(failed)})`,
    event: (failed, attempt) => [`Check command failed (failure ${attempt} of ${CHECK_FAIL_LIMIT} in a row): ${CHECK_TEXT.en.outcome(failed)}`, failed.tail.length > EVENT_TAIL_CHARS ? `…${failed.tail.slice(-EVENT_TAIL_CHARS)}` : failed.tail].filter(Boolean).join('\n'),
    invalid: "The product's check command cannot run (the command in the project settings is not valid, or the product folder is missing), so the task cannot be completed. Ask the owner to fix it in the project settings.",
    already: 'This run has already recorded how the task ends. End this run here (do no further work).',
    selfDone: 'Use task_complete to finish the task you are working on; task_update cannot mark it done.',
    doneChildren: count => `${count} task(s) made from this task are not finished yet, so it cannot be marked done.`,
    doneCheck: "This task's product has a check command, so only task_complete in the task's own run (which runs the check) or the owner can mark it done.",
    question: title => `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row for "${title}". Run the task again?`,
    why: last => (last ? `Last failure: ${last}` : 'The check command printed nothing.'),
  },
};
