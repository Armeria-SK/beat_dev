import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../src/config/schema.ts';
import { sdkConnect } from '../src/mcp/connect.ts';
import type { McpLink } from '../src/mcp/manager.ts';

// AU-5b-1: SDK を使った本物の接続。stdio は、試験用の MCP サーバー（tests/fixtures/mcp-echo-server.mjs）を子として起こして確かめる

const FIXTURE = new URL('./fixtures/mcp-echo-server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');

function stdio(): McpServerConfig {
  return { id: 'echo', transport: 'stdio', enabled: true, localOk: false, tools: {}, command: [process.execPath, FIXTURE], env: {}, headers: {} };
}

async function open(t: { after: (fn: () => void) => void }, env: Record<string, string> = {}, onClose: (reason?: string) => void = () => undefined): Promise<McpLink> {
  const link = await sdkConnect({ server: stdio(), env, headers: {}, onClose });
  t.after(() => { void link.close(); });
  return link;
}

test('T-38: 本物の stdio で、道具の一覧と呼び出しが通る', async t => {
  const link = await open(t);
  const tools = await link.list();
  assert.deepEqual(tools.map(x => x.name).sort(), ['crash', 'echo', 'env_names']);
  const result = await link.caller.callTool({ name: 'echo', arguments: { text: 'こんにちは' } }, { timeout: 10000 }) as { content: Array<{ text: string }> };
  assert.equal(result.content[0]!.text, 'こんにちは');
});

test('T-39: 子の環境変数は、持ち主が指したものと最小の既定だけ。アプリのほかの秘密は渡らない', async t => {
  process.env.BEAT_TEST_SECRET_FOR_MCP = 'leak-me';
  t.after(() => { delete process.env.BEAT_TEST_SECRET_FOR_MCP; });
  const link = await open(t, { MY_TOKEN: 'tok-1' });
  const result = await link.caller.callTool({ name: 'env_names', arguments: {} }, { timeout: 10000 }) as { content: Array<{ text: string }> };
  const names = result.content[0]!.text.split(',');
  assert.ok(names.includes('MY_TOKEN'));
  assert.ok(!names.includes('BEAT_TEST_SECRET_FOR_MCP'));
});

test('T-40: 子が落ちると onClose が呼ばれる。こちらから閉じたときは呼ばれない', async t => {
  let closed = 0;
  const link = await open(t, {}, () => { closed++; });
  await link.caller.callTool({ name: 'crash', arguments: {} }, { timeout: 10000 }).catch(() => undefined);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(closed, 1);
  let closed2 = 0;
  const other = await sdkConnect({ server: stdio(), env: {}, headers: {}, onClose: () => { closed2++; } });
  await other.close();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(closed2, 0);
});

test('T-41: 存在しないプログラムは、つなぐのに失敗する（投げる）', async () => {
  const server = { ...stdio(), command: ['definitely-not-a-program-xyz'] };
  await assert.rejects(sdkConnect({ server, env: {}, headers: {}, onClose: () => undefined }));
});
async function httpServer(t: { after: (fn: () => void) => void }, redirect = false) {
  const seen: Array<string | undefined> = [];
  const http = createServer((req, res) => {
    if (redirect) { res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }); res.end(); return; }
    seen.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', async () => {
      const server = new Server({ name: 'h', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object', properties: {} } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as never); // 状態を持たない（セッションなし）モード
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.close(); http.closeAllConnections(); });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return { url, seen };
}

test('T-36: 本物の http（Streamable HTTP）で、一覧と呼び出しが通り、持ち主が指した見出しが付く', async t => {
  const { url, seen } = await httpServer(t);
  const server: McpServerConfig = { id: 'h', transport: 'http', enabled: true, localOk: true, tools: {}, url, env: {}, headers: {} };
  const link = await sdkConnect({ server, env: {}, headers: { Authorization: 'Bearer abc' }, onClose: () => undefined });
  t.after(() => { void link.close(); });
  assert.deepEqual((await link.list()).map(x => x.name), ['ping']);
  const result = await link.caller.callTool({ name: 'ping', arguments: {} }, { timeout: 10000 }) as { content: Array<{ text: string }> };
  assert.equal(result.content[0]!.text, 'pong');
  assert.ok(seen.length > 0 && seen.every(h => h === 'Bearer abc'));
});

test('T-36b: http のリダイレクトは追わない（見出しを別の宛先に持って行かない）', async t => {
  const { url } = await httpServer(t, true);
  const server: McpServerConfig = { id: 'h', transport: 'http', enabled: true, localOk: true, tools: {}, url, env: {}, headers: {} };
  await assert.rejects(sdkConnect({ server, env: {}, headers: { Authorization: 'Bearer abc' }, onClose: () => undefined }));
});