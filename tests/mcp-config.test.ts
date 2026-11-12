import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, defaultConfig, parseConfig } from '../src/config/store.ts';
import { builtinTools } from '../src/app.ts';
import { mcpToolName, normalizeToolName } from '../src/mcp/names.ts';

const stdio = (over: Record<string, unknown> = {}) => ({ id: 'gh', transport: 'stdio', command: ['node', 'server.mjs'], ...over });
const http = (over: Record<string, unknown> = {}) => ({ id: 'web', transport: 'http', url: 'https://mcp.example.com/mcp', ...over });
const withMcp = (mcp: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(defaultConfig())), ...rest, mcp });
function problems(raw: unknown): string {
  try { parseConfig(raw); } catch (error) { if (error instanceof ConfigError) return error.problems.join('\n'); throw error; }
  return '';
}

test('T-20b 設定に mcp が無ければ、サーバーなし・既定の歯止めになる', () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, unknown>;
  delete raw.mcp;
  const config = parseConfig(raw);
  assert.deepEqual(config.mcp.servers, []);
  assert.deepEqual(config.mcp.limits, { maxServers: 4, maxToolsPerServer: 32, callTimeoutMs: 60_000, connectTimeoutMs: 15_000, restartsPerHour: 3, resultMaxChars: 15_000 });
});

test('サーバーの既定: 有効・手元のモデルには渡さない・道具なし・env / headers なし', () => {
  const config = parseConfig(withMcp({ servers: [stdio(), http()] }));
  const [a, b] = config.mcp.servers;
  assert.equal(a!.enabled, true);
  assert.equal(a!.localOk, false);
  assert.deepEqual(a!.tools, {});
  assert.deepEqual((a as { env: unknown }).env, {});
  assert.deepEqual((b as { headers: unknown }).headers, {});
});

test('道具は書けば有効（false でなければ on）。申告（effect・sends・removes）が書ける', () => {
  const config = parseConfig(withMcp({ servers: [stdio({ tools: { get_issue: {}, send: { enabled: false, effect: 'write', sends: true, removes: false } } })] }));
  const tools = config.mcp.servers[0]!.tools;
  assert.notEqual(tools.get_issue!.enabled, false);
  assert.deepEqual(tools.send, { enabled: false, effect: 'write', sends: true, removes: false });
});

test('T-03 断るもの: id の重複・id の形・上限超え・絶対でない cwd・危ない url・知らない項目', () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['id の重複', { servers: [stdio(), stdio()] }, /is duplicated/u],
    ['id が大文字', { servers: [stdio({ id: 'GH' })] }, /lowercase/u],
    ['id が長い', { servers: [stdio({ id: 'a'.repeat(17) })] }, /up to 16 characters/u],
    ['maxServers を越える', { servers: [stdio({ id: 'a' }), stdio({ id: 'b' })], limits: { maxServers: 1 } }, /Up to 1 MCP servers are allowed/u],
    ['相対の cwd', { servers: [stdio({ cwd: 'relative/dir' })] }, /absolute path/u],
    ['http の外部', { servers: [http({ url: 'http://example.com' })] }, /https/u],
    ['stdio に url', { servers: [stdio({ url: 'https://example.com' })] }, /url/u],
    ['http に command', { servers: [http({ command: ['node'] })] }, /command/u],
    ['http に url が無い', { servers: [{ id: 'web', transport: 'http' }] }, /url/u],
    ['stdio に command が無い', { servers: [{ id: 'gh', transport: 'stdio' }] }, /command/u],
    ['transport が違う', { servers: [stdio({ transport: 'ws' })] }, /stdio \/ http/u],
    ['url に認証情報', { servers: [http({ url: 'https://user:pass@example.com' })] }, /https/u],
    ['知らない項目', { servers: [stdio({ shell: true })] }, /./u],
    ['command が空', { servers: [stdio({ command: [] })] }, /./u],
    ['道具の名前に空白', { servers: [stdio({ tools: { 'bad name': {} } })] }, /Tool name "/u],
    ['env の名前に = や空白', { servers: [stdio({ env: { 'A=B': 'X_TOKEN' } })] }, /Environment variable name "/u],
    ['見出しの名前に改行', { servers: [http({ headers: { 'X\r\nEvil': 'X_TOKEN' } })] }, /Header name "/u],
    ['道具の名前が constructor', { servers: [stdio({ tools: { constructor: {} } })] }, /Tool name "/u],
    ['env が鍵の名前でない変数を指す', { servers: [stdio({ env: { A: 'DATABASE_URL' } })] }, /KEY, TOKEN, SECRET/u],
    ['headers が鍵の名前でない変数を指す', { servers: [http({ headers: { Authorization: 'HOME_DIR' } })] }, /KEY, TOKEN, SECRET/u],
  ];
  for (const [name, mcp, pattern] of bad) assert.match(problems(withMcp(mcp)), pattern, name);
});

test('loopback の http と https は通る', () => {
  parseConfig(withMcp({ servers: [http({ url: 'http://127.0.0.1:8123/mcp' }), http({ id: 'sec', url: 'https://mcp.example.com/mcp' })] }));
});

test('T-03b limits: 範囲の外は丸めずに断る', () => {
  for (const limits of [{ maxServers: 9 }, { maxServers: 0 }, { maxToolsPerServer: 65 }, { callTimeoutMs: 4999 }, { callTimeoutMs: 300_001 }, { connectTimeoutMs: 1999 }, { restartsPerHour: 11 }, { resultMaxChars: 999 }, { resultMaxChars: 50_001 }]) {
    assert.notEqual(problems(withMcp({ limits })), '', JSON.stringify(limits));
  }
  parseConfig(withMcp({ limits: { maxServers: 8, maxToolsPerServer: 64, callTimeoutMs: 300_000, connectTimeoutMs: 60_000, restartsPerHour: 0, resultMaxChars: 50_000 } }));
});

test('T-21 道具の数の上限と、登録名の重複・64 文字超えは設定の誤りになる', () => {
  const entries = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, {}]));
  assert.match(problems(withMcp({ servers: [stdio({ tools: entries(3) })], limits: { maxToolsPerServer: 2 } })), /Up to 2 tools are allowed per server/u);
  assert.match(problems(withMcp({ servers: [stdio({ tools: { 'Get-Issue': {}, 'get_issue': {} } })] })), /same registered name/u);
  assert.match(problems(withMcp({ servers: [stdio({ tools: { ['x'.repeat(60)]: {} } })] })), /longer than 64 characters/u);
  parseConfig(withMcp({ servers: [stdio({ tools: { ['x'.repeat(40)]: {} } })] }));
});

test('T-21 正規化の規則と、内蔵の道具に mcp_ で始まるものが無いこと', () => {
  assert.equal(normalizeToolName('Get-Issue'), 'get_issue');
  assert.equal(mcpToolName('gh', 'Get-Issue'), 'mcp_gh_get_issue');
  assert.equal(mcpToolName('gh', 'a.b/c'), 'mcp_gh_a_b_c');
  assert.deepEqual(builtinTools().map(t => t.name).filter(n => n.startsWith('mcp_')), []);
});

test('T-31 env・headers の参照が、プロバイダの鍵・通知の欄・ほかの MCP の欄と重なる設定は断る', () => {
  const channel = { id: 'phone', kind: 'webhook', urlEnv: 'BEAT_NOTIFY_PHONE_URL_SECRET' };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['プロバイダの鍵（env）', { servers: [stdio({ env: { KEY: 'ANTHROPIC_API_KEY' } })] }, {}],
    ['プロバイダの鍵（headers）', { servers: [http({ headers: { Authorization: 'ANTHROPIC_API_KEY' } })] }, {}],
    ['通知の欄', { servers: [stdio({ env: { KEY: 'BEAT_NOTIFY_PHONE_URL_SECRET' } })] }, { notify: { channels: [channel] } }],
    ['同じサーバーの別の欄', { servers: [stdio({ env: { A: 'SHARED_TOKEN', B: 'SHARED_TOKEN' } })] }, {}],
    ['別のサーバー', { servers: [stdio({ env: { A: 'SHARED_TOKEN' } }), stdio({ id: 'two', env: { A: 'SHARED_TOKEN' } })] }, {}],
  ];
  for (const [name, mcp, rest] of cases) {
    const raw = withMcp(mcp, rest);
    assert.match(problems(raw), /Environment variable "/u, name);
  }
  parseConfig(withMcp({ servers: [stdio({ env: { A: 'ONE_TOKEN' } }), http({ headers: { Authorization: 'TWO_TOKEN' } })] }));
});