import { join } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import { languageOf } from '../shared/language.ts';
import type { AppPaths } from '../paths.ts';
import { isInside, resolveConfigPath, type ScopePolicy } from './hooks/scope.ts';

export function buildPolicy(config: AppConfig, paths: AppPaths, project?: { root: string }): ScopePolicy {
  const configured = config.tools.roots.map(r => ({ path: resolveConfigPath(r.path, paths.data), mode: r.mode }));
  const readOnly = project && configured.some(r => r.mode === 'read' && sameFolder(r.path, project.root));
  const roots = project && !readOnly ? [...configured, { path: project.root, mode: 'write' as const }] : configured;
  const instructions = project ? ['AGENTS.md', 'CLAUDE.md'].map(name => join(project.root, name)) : [];
  const protectedPaths = [
    paths.database, `${paths.database}-wal`, `${paths.database}-shm`, paths.config, `${paths.config}.bak`, paths.backups,
    paths.env, join(paths.data, 'tool_outputs'), paths.browserProfile, paths.projects,
  ].map(p => resolveConfigPath(p, paths.data));
  const deny = [...config.tools.deny.map(p => resolveConfigPath(p, paths.data)), ...protectedPaths];
  // 人格とプロフィールは、Clive が書き換えるときに承認を求める（提案として見せる）。スキルのフォルダも同じ:
  // 新しい名前のスキルは、ここに置いただけでは使われない（正規の道は skill_draft → 画面の承認で登録）。登録済みの名前は、書き直したものがそのまま使われる
  const skillsDir = resolveConfigPath(join(paths.workspace, 'skills'), paths.data);
  const askOnWrite = [...['SOUL.md', 'USER.md'].map(name => resolveConfigPath(join(paths.workspace, name), paths.data)), skillsDir, ...instructions];
  return { roots, deny, askOnWrite, skillsDir, ...(instructions.length ? { instructions } : {}), language: languageOf(config) };
}

const sameFolder = (a: string, b: string): boolean => isInside(a, b) && isInside(b, a);

export function defaultWorkspace(policy: ScopePolicy, paths: AppPaths): string {
  return policy.roots.find(r => r.mode === 'write')?.path ?? paths.workspace;
}
