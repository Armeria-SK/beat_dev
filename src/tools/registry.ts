import type { AppConfig } from '../config/schema.ts';
import type { ToolSpec } from '../engine/types.ts';
import type { RunKind, ToolDef } from './types.ts';

export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'shell_run', 'web_search', 'web_fetch', 'skill_view', 'history_search',
  'task_complete', 'task_checkpoint', 'question_add', 'plan_write', 'acceptance_write', 'acceptance_change', 'mesh_search', 'mesh_read', 'tool_search',
]);

export const isCore = (tool: Pick<ToolDef, 'name' | 'mcp'>): boolean => tool.mcp === undefined && CORE_TOOLS.has(tool.name);

export interface RunOptions { exclude?: (tool: ToolDef) => boolean }

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();
  // 後から足したり外したりする道具の組（MCP サーバーごと。キーはサーバーの id）。内蔵の道具（#tools）は、組より前に並ぶ
  #groups = new Map<string, Map<string, ToolDef>>();

  register(tool: ToolDef): this {
    if (this.#has(tool.name)) throw new Error(`Tool ${tool.name} is duplicated`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  #has(name: string): boolean {
    if (this.#tools.has(name)) return true;
    for (const group of this.#groups.values()) if (group.has(name)) return true;
    return false;
  }

  // 組の道具を丸ごと置き換える（前の同じ組の道具は外れる）。ほかの道具と名前がぶつかるなら、何も変えずに投げる
  setGroup(group: string, tools: readonly ToolDef[]): void {
    const seen = new Set<string>();
    for (const tool of tools) {
      const own = this.#groups.get(group)?.has(tool.name) === true;
      if ((!own && this.#has(tool.name)) || seen.has(tool.name)) throw new Error(`Tool ${tool.name} is duplicated`);
      seen.add(tool.name);
    }
    this.#groups.delete(group);
    this.#groups.set(group, new Map(tools.map(t => [t.name, t])));
  }

  removeGroup(group: string): void { this.#groups.delete(group); }

  get(name: string): ToolDef | undefined {
    const own = this.#tools.get(name);
    if (own) return own;
    for (const group of this.#groups.values()) { const tool = group.get(name); if (tool) return tool; }
    return undefined;
  }
  names(): string[] { return this.list().map(t => t.name); }
  // 登録されている道具すべて（どの種類の実行で使えるかによらず）。内蔵の道具が先
  list(): ToolDef[] { return [...this.#tools.values(), ...[...this.#groups.values()].flatMap(g => [...g.values()])]; }

  forRun(kind: RunKind, options: RunOptions = {}): ToolDef[] {
    return this.list().filter(t => t.allowedIn.includes(kind) && !options.exclude?.(t));
  }

  static specs(tools: readonly ToolDef[], config?: AppConfig): ToolSpec[] {
    return tools.map(t => ({ name: t.name, description: (config && t.describe?.(config)) ?? t.description, inputSchema: t.input as unknown as Record<string, unknown> }));
  }
}