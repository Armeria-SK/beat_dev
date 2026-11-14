import type { AppConfig, Language } from '../config/schema.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { resolveShell, runProcess, scrubEnv } from '../tools/shell/runner.ts';
import { checkCommandOf, folderMissing, type ProjectStore } from './store.ts';

export const CHECK_TIMEOUT_MS = 30 * 60_000;
export const CHECK_FAIL_LIMIT = 3;
const OUTPUT_CAP_BYTES = 4 * 1_048_576;
const TAIL_CHARS = 1500;
const EVENT_TAIL_CHARS = 500;
export const CHECK_OPTIONS = ['Retry', 'Leave it'] as const;
export const CHECK_KEEP = 1;

export interface ProductCheck { command: string; root: string }

export type CheckResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'failed' | 'timeout' | 'spawn'; exitCode: number | null; tail: string; durationMs: number }
  | { ok: false; reason: 'aborted' };

export function productCheck(projects: ProjectStore | undefined, projectId: string | null): ProductCheck | undefined {
  if (!projectId) return undefined;
  const row = projects?.get(projectId);
  if (!row || folderMissing(row)) return undefined;
  let command: string | null;
  try { command = checkCommandOf(row.check_command); } catch { return undefined; }
  return command ? { command, root: row.root } : undefined;
}

const tailOf = (text: string): string => {
  const clean = redactSecrets(text).trimEnd();
  return clean.length > TAIL_CHARS ? `…${clean.slice(-TAIL_CHARS)}` : clean;
};

export async function runProductCheck(check: ProductCheck, options: { config: AppConfig; signal: AbortSignal; timeoutMs?: number }): Promise<CheckResult> {
  const settings = options.config.tools.shell;
  const shell = resolveShell(settings.shell);
  const env = Object.fromEntries(Object.entries(scrubEnv(settings.envAllow)).filter(([key]) => !/^git_/iu.test(key)));
  const result = await runProcess(shell.file, shell.args(check.command), {
    cwd: check.root, env, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS, signal: options.signal, maxBytes: OUTPUT_CAP_BYTES,
    ...(shell.stdin ? { input: shell.stdin(check.command) } : {}),
  });
  if (result.aborted) return { ok: false, reason: 'aborted' };
  if (!result.spawnError && !result.timedOut && result.exitCode === 0) return { ok: true, durationMs: result.durationMs };
  const parts = [result.stdout.trim() ? tailOf(result.stdout) : '', result.stderr.trim() ? `[stderr]\n${tailOf(result.stderr)}` : '', result.spawnError ? redactSecrets(result.spawnError) : ''].filter(Boolean);
  return { ok: false, reason: result.spawnError ? 'spawn' : result.timedOut ? 'timeout' : 'failed', exitCode: result.exitCode, tail: parts.join('\n'), durationMs: result.durationMs };
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
  event: (failed: Failed) => string;
  question: (title: string) => string;
  why: (last: string | null) => string;
}

export const CHECK_TEXT: Record<Language, CheckText> = {
  en: {
    childrenLeft: count => `${count} task(s) you made from this task are not finished yet, so this task is not complete. beat resumes this task after they finish (tasks set to start later hold it until they have run).`,
    yieldReason: count => `Waiting for ${count} task(s) it made to finish`,
    passed: command => `The product's check command passed: ${command}`,
    stopped: 'The check command was stopped, so the task is not complete.',
    outcome: failed => (failed.reason === 'timeout' ? `it ran past ${CHECK_TIMEOUT_MS / 60_000} minutes and was stopped` : failed.reason === 'spawn' ? 'it could not be started' : `exit code ${failed.exitCode ?? '—'}`),
    failed: (command, failed, attempt) => [
      `The product's check command failed (${CHECK_TEXT.en.outcome(failed)}), so the task is not complete. Fix the cause and call task_complete again (failure ${attempt} of ${CHECK_FAIL_LIMIT} in a row).`,
      `Command: ${command}`,
      ...(failed.tail ? [`Output (end):\n${failed.tail}`] : []),
    ].join('\n'),
    gaveUp: (command, failed) => [
      `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row (${CHECK_TEXT.en.outcome(failed)}). The task is closed as failed and the owner is asked in Questions.`,
      `Command: ${command}`,
      ...(failed.tail ? [`Output (end):\n${failed.tail}`] : []),
    ].join('\n'),
    reason: failed => `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row (${CHECK_TEXT.en.outcome(failed)})`,
    event: failed => [CHECK_TEXT.en.outcome(failed), failed.tail.length > EVENT_TAIL_CHARS ? `…${failed.tail.slice(-EVENT_TAIL_CHARS)}` : failed.tail].filter(Boolean).join('\n'),
    question: title => `The product's check command failed ${CHECK_FAIL_LIMIT} times in a row for "${title}". Run the task again?`,
    why: last => (last ? `Last failure: ${last}` : 'The check command printed nothing.'),
  },
};
