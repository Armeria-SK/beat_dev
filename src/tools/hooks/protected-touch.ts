import { isAbsolute, resolve } from 'node:path';
import type { ProtectedKind, ScopePolicy } from './scope.ts';
import { guardedRootOf, writeApprovalKind } from './scope.ts';
import type { StatementFacts } from './shell-facts.ts';

export type TouchKey = 'guard.touch_git' | 'guard.touch_persona' | 'guard.touch_skill' | 'guard.touch_instructions';

const KEYS: Record<ProtectedKind, TouchKey> = { git: 'guard.touch_git', persona: 'guard.touch_persona', skill: 'guard.touch_skill', instructions: 'guard.touch_instructions' };

const READ_ONLY = new Set([
  'cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls',
  'ls', 'dir', 'get-childitem', 'gci', 'test-path', 'stat', 'file', 'diff', 'cmp', 'sha256sum', 'md5sum', 'get-filehash', 'get-item', 'gi', 'resolve-path',
  'measure-object', 'echo', 'write-output', 'write-host', 'printf', 'cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir', 'pwd', 'get-location',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'grep', 'add', 'commit']);

const tokensOf = (st: StatementFacts): string[] => splitTokens([...st.words.filter(w => !w.dynamic).map(w => w.text), ...st.code]);

const flatten = (list: readonly StatementFacts[]): StatementFacts[] => list.flatMap(st => [st, ...flatten(st.inner ?? st.unknownInner ?? [])]);
// 文が動きうるすべての作業フォルダ
const basesOf = (st: StatementFacts, fallbackCwd: string): string[] => [...new Set([...(st.cwds ?? []), st.cwd ?? fallbackCwd])];

function readOnly(st: StatementFacts): boolean {
  if (st.writes.length > 0 || (st.inner?.length ?? st.unknownInner?.length ?? 0) > 0 || st.code.length > 0) return false;
  const name = st.program.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
  if (name === 'git') return !st.gitGlobal.some(w => /^-c|^--config-env/u.test(w)) && READ_ONLY_GIT.has(st.words[st.gitGlobal.length + 1]?.text ?? '');
  return READ_ONLY.has(name);
}

function splitTokens(texts: string[]): string[] {
  return texts.flatMap(text => text.split(/[\s"'(),;`{}[\]|<>]+/u)).flatMap(token => token.split('=')).filter(token => token !== '' && !token.includes('://'));
}

export function protectedTouchOf(command: string, statements: readonly StatementFacts[], policy: ScopePolicy, fallbackCwd: string): { key: TouchKey; path: string } | undefined {
  const all = flatten(statements);
  const opaque = all.some(st => st.program === '' || st.programOdd || st.shapes.length > 0);
  const groups: Array<[string, string[]]> = all.filter(st => !readOnly(st)).flatMap(st => basesOf(st, fallbackCwd).map(base => [base, tokensOf(st)] as [string, string[]]));
  if (opaque) groups.push([fallbackCwd, splitTokens([command])]);
  for (const [base, tokens] of groups) {
    for (const token of tokens) {
      const path = isAbsolute(token) ? token : resolve(base, token);
      const kind = writeApprovalKind(path, policy);
      if (kind) return { key: KEYS[kind], path };
    }
  }
  return undefined;
}

export function installTouchOf(statements: readonly StatementFacts[], policy: ScopePolicy, fallbackCwd: string, texts: readonly string[] = []): string | undefined {
  const groups: Array<[string, string[]]> = [...flatten(statements).flatMap(st => basesOf(st, fallbackCwd).map(base => [base, splitTokens(st.code)] as [string, string[]])), [fallbackCwd, splitTokens([...texts])]];
  for (const [base, tokens] of groups) {
    for (const token of tokens) {
      const path = isAbsolute(token) ? token : resolve(base, token);
      if (guardedRootOf(path, policy)) return path;
    }
  }
  return undefined;
}
