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

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? st.unknownInner ?? [])]);

const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

function pushSources(st: StatementFacts): string[] | undefined {
  const words = st.words.slice(st.gitGlobal.length + 2);
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.dynamic) return undefined;
    if (w.text === '--') { positional.push(...words.slice(i + 1).map(x => x.text)); if (words.slice(i + 1).some(x => x.dynamic)) return undefined; break; }
    if (w.text.startsWith('-')) { if (PUSH_VALUE_FLAGS.has(w.text)) i++; continue; }
    positional.push(w.text);
  }
  return positional.slice(1).filter((spec, i, all) => !(spec === 'tag' && i + 1 < all.length)).map(spec => spec.replace(/^\+/u, '').split(':')[0]!).filter(source => source !== '');
}

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
    const stashes = input.git(top, ['stash', 'list', '--format=%H']);
    if (stashes === undefined) return { unchecked: true };
    const sources = pushSources(st);
    if (sources === undefined) return { unchecked: true };
    const revisions: string[] = [];
    for (const source of sources) {
      const commit = input.git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${source}^{commit}`])?.trim();
      if (!commit || !/^[0-9a-f]{40,64}$/u.test(commit)) return { unchecked: true };
      revisions.push(commit);
    }
    const changed = input.git(top, ['log', '--format=', '--name-only', '-z', '--no-renames', '-m', 'HEAD', ...(st.words.some(w => w.text.length >= 3 && '--mirror'.startsWith(w.text)) ? [] : ['--exclude=refs/prefetch/*', '--exclude=refs/original/*', '--exclude=refs/beat/snapshots/*']), '--all', ...stashes.split(/\s+/u).filter(Boolean), ...revisions, '--not', '--remotes']);
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
