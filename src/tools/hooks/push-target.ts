import { resolve } from 'node:path';
import { remoteKey, type Remote } from '../../projects/remotes.ts';
import type { StatementFacts } from './shell-guard.ts';

export interface PushEnv {
  remotes?: readonly Remote[] | undefined;
  pushUrls(dir: string, remote: string): readonly string[] | undefined;
  pushRemote(dir: string): string | undefined;
}

export type PushProblem = { key: 'send.push_no_product' } | { key: 'send.push_options'; detail: string } | { key: 'send.push_target'; remote: string };

const TAKES_VALUE = new Set(['-o', '--push-option']);
const REDIRECTING = /^--(?:repo|receive-pack|exec)(?:=|$)/u;
const GIT_ENV_NAME = /^(?:env:)?git_/iu;

export function gitEnvIn(all: readonly StatementFacts[]): boolean {
  return all.some(st => st.env.some(n => GIT_ENV_NAME.test(n)) || st.words.some(w => /^\$env:git_/iu.test(w.text) || /^git_\w*=/iu.test(w.text)));
}

export function pushProblem(st: StatementFacts, subAt: number, all: readonly StatementFacts[], env: PushEnv): PushProblem | undefined {
  if (!env.remotes) return { key: 'send.push_no_product' };
  let dir = st.cwd;
  for (let i = 0; i < st.gitGlobal.length; i++) {
    const g = st.gitGlobal[i]!;
    if (g === '--no-pager') continue;
    if (g === '-C' && i + 1 < st.gitGlobal.length) {
      const w = st.words.find(x => x.text === st.gitGlobal[i + 1]);
      if (w?.dynamic || dir === null) return { key: 'send.push_options', detail: `-C ${st.gitGlobal[i + 1]}` };
      dir = resolve(dir, st.gitGlobal[++i]!);
      continue;
    }
    return { key: 'send.push_options', detail: g };
  }
  if (gitEnvIn(all)) return { key: 'send.push_options', detail: 'GIT_*' };
  if (dir === null) return { key: 'send.push_options', detail: 'cd' };
  let remote: string | undefined;
  const args = st.words.slice(subAt + 1);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w.dynamic) return { key: 'send.push_options', detail: w.text };
    if (REDIRECTING.test(w.text)) return { key: 'send.push_options', detail: w.text };
    if (TAKES_VALUE.has(w.text)) { i++; continue; }
    if (w.text.startsWith('-')) continue;
    remote = w.text;
    break;
  }
  const name = remote ?? env.pushRemote(dir);
  if (!name) return { key: 'send.push_target', remote: '' };
  if (/[:/\\]/u.test(name)) return { key: 'send.push_target', remote: name };
  const urls = env.pushUrls(dir, name);
  if (!urls?.length) return { key: 'send.push_target', remote: name };
  const recorded = new Set(env.remotes.flatMap(r => [r.url, ...(r.pushUrl ? [r.pushUrl] : [])]).map(remoteKey));
  return urls.every(u => recorded.has(remoteKey(u))) ? undefined : { key: 'send.push_target', remote: name };
}
