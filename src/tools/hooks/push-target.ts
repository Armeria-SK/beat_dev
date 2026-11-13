import { resolve } from 'node:path';
import { remoteKey, type Remote } from '../../projects/remotes.ts';
import type { StatementFacts } from './shell-guard.ts';

export interface PushEnv {
  remotes?: readonly Remote[] | undefined;
  pushUrls(dir: string, remote: string): readonly string[] | undefined;
  pushRemote(dir: string): string | undefined;
}

export type PushProblem =
  | { key: 'send.push_no_product' }
  | { key: 'send.push_options'; detail: string }
  | { key: 'send.after_change'; detail: string }
  | { key: 'send.push_target'; remote: string };

const TAKES_VALUE = new Set(['-o', '--push-option']);
const REDIRECTING = ['--repo', '--receive-pack', '--exec'];
const HARMLESS_ENV = /^(?:LC_\w+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|TERM|COLUMNS|LINES)$/u;
const ENV_PROGRAMS = new Set(['source', '.', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'setx', 'set-variable', 'sv', 'new-variable', 'nv']);
const ENV_ITEM_PROGRAMS = new Set(['set-item', 'si', 'set-content', 'sc', 'new-item', 'ni', 'add-content', 'ac', 'copy-item', 'cp', 'cpi', 'move-item', 'mi', 'rename-item', 'rni', 'remove-item', 'ri']);
const GIT_READ_CONFIG = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch', 'get', 'list']);

export const longOption = (word: string, name: string): boolean => {
  if (!word.startsWith('--')) return false;
  const base = word.split('=')[0]!;
  return base === name || (base.length >= 5 && name.startsWith(base));
};

const unsafeEnv = (names: readonly string[]): string | undefined => names.find(n => !HARMLESS_ENV.test(n.replace(/^env:/iu, '')));

export function changesGit(st: StatementFacts): string | undefined {
  const env = unsafeEnv(st.env);
  if (env) return env;
  const p = st.program;
  const words = st.words.map(w => w.text);
  if (ENV_PROGRAMS.has(p)) return p;
  if (p === 'printf' && words.includes('-v')) return 'printf -v';
  if (ENV_ITEM_PROGRAMS.has(p) && words.some(w => /^env:/iu.test(w) || /[\\/]?env:[\\/]?/iu.test(w))) return `${p} env:`;
  const shape = st.shapes.find(s => /^(?:static|method):|^dot_source$/u.test(s));
  if (shape) return shape;
  if (st.writes.some(w => /(?:^|[\\/])\.git(?:[\\/]|$)/u.test(w))) return '.git';
  if (p === 'git') {
    const rest = words.slice(st.gitGlobal.length + 1);
    if (rest[0] === 'config' && !rest.some(a => GIT_READ_CONFIG.has(a))) return 'git config';
    if (rest[0] === 'remote' && rest.slice(1).some(a => !a.startsWith('-'))) return 'git remote';
  }
  return undefined;
}

export function pushProblem(st: StatementFacts, subAt: number, before: readonly StatementFacts[], env: PushEnv): PushProblem | undefined {
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
  const own = unsafeEnv(st.env);
  if (own) return { key: 'send.push_options', detail: own };
  for (const prev of before) {
    const change = changesGit(prev);
    if (change) return { key: 'send.after_change', detail: change };
  }
  if (dir === null) return { key: 'send.push_options', detail: 'cd' };
  let remote: string | undefined;
  const args = st.words.slice(subAt + 1);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w.dynamic) return { key: 'send.push_options', detail: w.text };
    if (REDIRECTING.some(n => longOption(w.text, n))) return { key: 'send.push_options', detail: w.text };
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
