// ブラウザの道具の名前は browser_ で始まる（browser_open / browser_read / ...）。MCP の道具は mcp_ で始まるので重ならない。
// ToolDef に印を持たせず、名前で見分ける（#toolsFor・baseTokens・パイプラインの無効の拒否が同じ関数を使う）
export const isBrowserTool = (name: string): boolean => name.startsWith('browser_');
