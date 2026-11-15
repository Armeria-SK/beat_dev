import { dirname, join } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import { languageOf } from '../shared/language.ts';
import type { AppPaths } from '../paths.ts';
import { isInside, resolveConfigPath, type ScopePolicy } from './hooks/scope.ts';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export function buildPolicy(config: AppConfig, paths: AppPaths, project?: { root: string }, productRoots: readonly string[] | (() => readonly string[]) = []): ScopePolicy {
  const configured = config.tools.roots.map(r => ({ path: resolveConfigPath(r.path, paths.data), mode: r.mode }));
  const readOnly = project && configured.some(r => r.mode === 'read' && sameFolder(r.path, project.root));
  const roots = project && !readOnly ? [...configured, { path: project.root, mode: 'write' as const }] : configured;
  const listed = (): readonly string[] => {
    if (typeof productRoots !== 'function') return productRoots;
    try { return productRoots(); } catch { return []; }
  };
  const seen = new Set<string>(project ? [project.root] : []);
  const instructionsNow = (): string[] => {
    for (const root of listed()) seen.add(root);
    return [...seen].flatMap(root => INSTRUCTION_FILES.map(name => join(root, name)));
  };
  const instructions = instructionsNow();
  const protectedPaths = [
    paths.database, `${paths.database}-wal`, `${paths.database}-shm`, paths.config, `${paths.config}.bak`, paths.backups,
    paths.env, join(paths.data, 'tool_outputs'), join(paths.data, 'git-run'), join(paths.data, 'snapshots'), paths.browserProfile, paths.projects,
  ].map(p => resolveConfigPath(p, paths.data));
  const deny = [...config.tools.deny.map(p => resolveConfigPath(p, paths.data)), ...protectedPaths];
  // 人格とプロフィールは、beat が書き換えるときに承認を求める（提案として見せる）。スキルのフォルダも同じ:
  // 新しい名前のスキルは、ここに置いただけでは使われない（正規の道は skill_draft → 画面の承認で登録）。登録済みの名前は、書き直したものがそのまま使われる
  const skillsDir = resolveConfigPath(join(paths.workspace, 'skills'), paths.data);
  const guarded = installGuard(paths);
  const fixed = [...['SOUL.md', 'USER.md'].map(name => resolveConfigPath(join(paths.workspace, name), paths.data)), skillsDir];
  if (typeof productRoots !== 'function') return { roots, deny, guarded, askOnWrite: [...fixed, ...instructions], skillsDir, ...(instructions.length ? { instructions } : {}), language: languageOf(config) };
  return {
    roots, deny, guarded, skillsDir, language: languageOf(config),
    get askOnWrite() { return [...fixed, ...instructionsNow()]; },
    get instructions() { return instructionsNow(); },
  };
}

function installGuard(paths: AppPaths): { roots: string[]; keep: string[] } {
  const appRoot = dirname(paths.templates);
  return { roots: [...new Set([appRoot, resolveConfigPath(appRoot, paths.data)])], keep: [...new Set([paths.data, resolveConfigPath(paths.data, paths.data)])] };
}

export function dataHoldsInstall(paths: AppPaths): boolean {
  const appRoot = dirname(paths.templates);
  const roots = [appRoot, resolveConfigPath(appRoot, paths.data)];
  return [paths.data, resolveConfigPath(paths.data, paths.data)].some(data => roots.some(root => isInside(data, root)));
}

const sameFolder = (a: string, b: string): boolean => isInside(a, b) && isInside(b, a);

export function defaultWorkspace(policy: ScopePolicy, paths: AppPaths): string {
  return policy.roots.find(r => r.mode === 'write')?.path ?? paths.workspace;
}
