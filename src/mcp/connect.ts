// SDK（@modelcontextprotocol/sdk）を使った本物の接続。stdio は子のプロセスを起こし、http は Streamable HTTP でつなぐ。
// - stdio: シェルを通さない（command[0] と残りの引数）。環境変数は SDK の最小の既定（PATH など）＋ 持ち主が指した値だけ。
// - http: 見出しは持ち主が指した値。リダイレクトは、POST では追わない（redirect:'error'）。SDK 1.32.2 は GET（SSE を開く）だけ redirect を 'manual' に直し、同じ origin 内は追う（別の origin へは追わないので、見出しは別の宛先へ出ない）。OAuth は使わない。
// - Client の capabilities は空（サーバーからの sampling / elicitation / roots の要求は受けない）。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpConnectInput, McpLink } from './manager.ts';
import type { McpRemoteTool } from './tool.ts';

const STDERR_KEEP = 8192;
const LIST_PAGES_MAX = 8;

export async function sdkConnect(input: McpConnectInput): Promise<McpLink> {
  const { server } = input;
  const client = new Client({ name: 'beat', version: '0.1.0' }, { capabilities: {} });
  let stderr = '';
  let closedByUs = false;
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (server.transport === 'stdio') {
    const [command, ...args] = server.command ?? [];
    if (!command) throw new Error('command is empty');
    const stdioTransport = new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...input.env }, ...(server.cwd ? { cwd: server.cwd } : {}), stderr: 'pipe' });
    stdioTransport.stderr?.on('data', (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-STDERR_KEEP); });
    transport = stdioTransport;
  } else {
    if (!server.url) throw new Error('url is empty');
    transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: input.headers, redirect: 'error' } });
  }
  client.onclose = () => { if (!closedByUs) input.onClose(); };
  client.onerror = () => undefined;
  try {
    await client.connect(transport);
  } catch (error) {
    closedByUs = true;
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    caller: { callTool: (params, options) => client.callTool(params as { name: string; arguments?: Record<string, unknown> }, undefined, options) },
    async list(): Promise<McpRemoteTool[]> {
      const tools: McpRemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(result.tools as McpRemoteTool[]));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async close(): Promise<void> { closedByUs = true; await client.close(); },
    stderr: () => stderr,
  };
}