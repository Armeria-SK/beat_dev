// 試験用の MCP サーバー（stdio）。道具: echo（文字を返す）、env_names（子の環境変数の名前の一覧）、crash（落ちる）。
// 環境変数 ECHO_DESC があれば、echo の説明がそれになる（説明が後から変わる場合の試験用）
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: process.env.ECHO_DESC ?? '文字をそのまま返す', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'env_names', description: '環境変数の名前の一覧を返す', inputSchema: { type: 'object', properties: {} } },
    { name: 'crash', description: '落ちる', inputSchema: { type: 'object', properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (name === 'echo') return { content: [{ type: 'text', text: String(args?.text ?? '') }] };
  if (name === 'env_names') return { content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] };
  if (name === 'crash') process.exit(1);
  return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
});

await server.connect(new StdioServerTransport());