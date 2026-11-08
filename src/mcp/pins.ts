// MCP の道具の「確かめた形」の固定。サーバーは後から説明や入力の形を書き換えられる（ラグプル）ので、
// 持ち主が最初に確かめた形を kv に覚えておき、違っていたら道具を止める（受け入れるまで使わない）。
// 見るのは、モデルに渡る説明（整えたもの）・入力の形・サーバーの destructiveHint（扱いが厳しくなる向きに効く申告）
import { createHash } from 'node:crypto';
import type { KV } from '../db/kv.ts';
import { cleanDescription, type McpRemoteTool } from './tool.ts';

export interface McpShape {
  description: string;
  // 並びを正した JSON（キーの順だけの違いで changed にしない）
  schema: string;
  destructive: boolean;
}

export type McpPinState = 'new' | 'same' | 'changed';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function shapeOf(remote: McpRemoteTool): McpShape {
  return {
    description: cleanDescription(remote.description),
    schema: JSON.stringify(canonical(remote.inputSchema ?? null)),
    destructive: remote.annotations?.destructiveHint === true,
  };
}

export function shapeSignature(shape: McpShape): string {
  return createHash('sha256').update(JSON.stringify([shape.description, shape.schema, shape.destructive])).digest('hex');
}

// サーバーの id は [a-z0-9] だけ（':' を含まない）ので、「mcp:pin:<id>:」の前方一致は、前方が同じ別のサーバーに当たらない
const prefix = (server: string): string => `mcp:pin:${server}:`;

export class McpPins {
  readonly #kv: KV;
  constructor(kv: KV) { this.#kv = kv; }

  previous(server: string, tool: string): McpShape | undefined {
    const stored = this.#kv.getJson<McpShape>(`${prefix(server)}${tool}`);
    if (!stored || typeof stored.description !== 'string' || typeof stored.schema !== 'string') return undefined;
    return { description: stored.description, schema: stored.schema, destructive: stored.destructive === true };
  }

  check(server: string, tool: string, remote: McpRemoteTool): McpPinState {
    const before = this.previous(server, tool);
    if (!before) return 'new';
    return shapeSignature(before) === shapeSignature(shapeOf(remote)) ? 'same' : 'changed';
  }

  pin(server: string, tool: string, remote: McpRemoteTool): void {
    this.#kv.setJson(`${prefix(server)}${tool}`, shapeOf(remote));
  }

  forget(server: string): void { this.#kv.deletePrefix(prefix(server)); }
}