// MCP の道具の登録名の決まり（node の部品を使わない。設定の検査・管理 API・道具の定義が同じに使う）。
// 登録名は mcp_<サーバー id>_<道具の名前を正規化したもの>。正規化は、小文字にして [a-z0-9] 以外を _ に置き換える。
// 内蔵の道具は mcp_ で始まらない（tests/mcp-names.test.ts が固定する）ので、MCP の道具が内蔵の道具と名前をぶつけることは無い
export const MCP_NAME_PREFIX = 'mcp_';
export const MCP_NAME_MAX = 64;

export function normalizeToolName(tool: string): string {
  return tool.toLowerCase().replace(/[^a-z0-9]/gu, '_');
}

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_NAME_PREFIX}${serverId}_${normalizeToolName(tool)}`;
}