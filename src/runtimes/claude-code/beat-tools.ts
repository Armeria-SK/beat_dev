// beat 自身の計画の道具（plan_write・acceptance_write・acceptance_change）を、Claude Code に MCP の道具として見せる（AR-9b）。
// SDK の createSdkMcpServer で作る、beat の中で動く（子のプロセスにならない）サーバー。道具の中身は beat の道具の登録の側（RuntimeRequest.planTools.call）が動かし、ここは引数を渡して結果の文を返すだけ。
// 承認の求め（canUseTool）に来たときに beat 自身の道具だと見分ける印は、SDK が付ける mcpServer.source が 'sdk'（beat が登録した、中で動くサーバー）のときだけ。名前や接頭辞だけでは見分けない（設定にある同名のサーバーに化けられないように）。
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { BeatPlanTools } from '../types.ts';

// MCP のサーバー名。道具の名前は mcp__<サーバー名>__<道具>
export const BEAT_SERVER = 'beat';

export const beatToolName = (name: string): string => `mcp__${BEAT_SERVER}__${name}`;

// beat の道具の入力（src/tools/builtin/plan.ts・acceptance.ts の TypeBox）と同じ形を、SDK が要る zod で書いた写し。正本は beat の道具の側で、渡った入力は道具の側でもう一度 TypeBox で確かめる。
// ここは、モデルに見せる引数の形と、Claude Code の側で先に弾く形（足りない欄・型違い）のためだけにある
type Z = typeof import('zod').z;

const shapes = (z: Z) => {
  const source = z.enum(['owner_words', 'owner_choice', 'ai_added']);
  const sourced = { source, quote: z.string().optional(), question: z.string().optional(), answer: z.string().optional() };
  return {
    plan_write: { content: z.string().min(1), language: z.string().optional() },
    acceptance_write: {
      items: z.array(z.object({ result: z.string().min(1), ...sourced, check: z.enum(['command', 'look', 'read']), command: z.string().optional() })),
      notDoing: z.array(z.object({ text: z.string().min(1), ...sourced })).optional(),
    },
    acceptance_change: {
      changes: z.array(z.object({ op: z.string(), id: z.string().optional(), result: z.string().optional(), quote: z.string().optional(), check: z.string().optional(), command: z.string().optional() })),
      language: z.string().optional(),
    },
  } as const;
};

export const BEAT_TOOL_NAMES = ['plan_write', 'acceptance_write', 'acceptance_change'] as const;
export type BeatToolName = (typeof BEAT_TOOL_NAMES)[number];

// 渡された道具のうち、ここに形がある名前だけを出す（知らない名前は出さない）
export async function buildBeatServer(tools: BeatPlanTools): Promise<McpSdkServerConfigWithInstance> {
  const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
  const all = shapes(z);
  const defs = tools.specs.flatMap((spec): SdkMcpToolDefinition[] => {
    const name = spec.name as BeatToolName;
    if (!Object.hasOwn(all, name)) return [];
    return [tool(name, spec.description, all[name], async (args: unknown) => {
      const result = await tools.call(name, args);
      return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true as const } : {}) };
    }, { alwaysLoad: true }) as unknown as SdkMcpToolDefinition];
  });
  return createSdkMcpServer({ name: BEAT_SERVER, version: '1.0.0', tools: defs, alwaysLoad: true });
}
