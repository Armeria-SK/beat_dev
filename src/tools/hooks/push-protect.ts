import { resolve } from 'node:path';
import type { AppConfig, BuiltinHookConfig } from '../../config/schema.ts';
import { PROTECT_FILES, runProtectFiles } from './protect-files.ts';
import type { StatementFacts } from './shell-facts.ts';

export interface PushProtectInput {
  config: AppConfig;
  statements: readonly StatementFacts[];
  git: (dir: string, args: string[]) => string | undefined;
  projectRoot?: string | undefined;
  productRoots: readonly string[];
  tainted: boolean;
}

export type PushProtect = { files: string[] } | { unchecked: true } | undefined;

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? [])]);

export function pushProtectOf(input: PushProtectInput): PushProtect {
  const hooks = input.config.tools.hooks.preToolUse.filter((h): h is BuiltinHookConfig => 'builtin' in h && h.builtin === PROTECT_FILES && h.enabled !== false);
  if (!hooks.length) return undefined;
  const pushes = flatten(input.statements).filter(st => st.program === 'git' && st.words[st.gitGlobal.length + 1]?.text === 'push');
  if (!pushes.length) return undefined;
  const files: string[] = [];
  for (const st of pushes) {
    if (st.gitGlobal.length > 0 || st.cwd === null || st.programDynamic) return { unchecked: true };
    const top = input.git(st.cwd, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top) return { unchecked: true };
    const changed = input.git(top, ['log', '--format=', '--name-only', '-z', '--no-renames', 'HEAD', '--not', '--remotes']);
    if (changed === undefined) return { unchecked: true };
    const paths = [...new Set(changed.split(/\0|\r?\n/u).map(name => name.trim()).filter(Boolean))].map(name => ({ path: resolve(top, name), write: true }));
    if (!paths.length) continue;
    for (const hook of hooks) {
      const result = runProtectFiles(hook, {
        hook_event_name: 'PreToolUse', tool_name: 'shell_run', tool_input: {}, cwd: top, run_id: '', conversation_id: '', paths, tainted: input.tainted,
        ...(input.projectRoot ? { project_root: input.projectRoot } : {}), product_roots: [...input.productRoots, top],
      });
      if (result.decision === 'ask') files.push(result.reason);
    }
  }
  return files.length ? { files } : undefined;
}
