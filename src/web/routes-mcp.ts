import type { App } from '../app.ts';
import { MCP_ENV_NAME_PATTERN, MCP_HEADER_NAME_PATTERN, MCP_ID_PATTERN, MCP_TOOL_KEY_PATTERN, type AppConfig, type McpServerConfig, type McpToolEntry } from '../config/schema.ts';
import { removeEnvValue } from '../env-file.ts';
import { isAutoMcpEnv, mcpEnvName, type McpSecretKind } from '../shared/secret-slots.ts';
import { envApply, envProblem } from './env-apply.ts';
import { problem, readJson, requireObject, type Router, sendJson } from './http.ts';

// 外の MCP サーバーの管理（画面専用。モデルの道具には足さない）。秘密（子に渡す環境変数・HTTP の見出し）は .env にだけ書き、応答・ログ・設定・DB・SSE のどこにも出さない（返すのは「入っているか」だけ）。
// 環境変数の名前はサーバーが決める（クライアントからは受け取らない）。ほかの書き込みと同じ Host・Origin・Sec-Fetch-Site の確かめを通った要求だけが届く。
// 設定と .env を変えるところは、await を挟まずに「検査 → .env → 設定の反映」と進める

const SECRET_KINDS = ['env', 'header'] as const;
const EFFECTS = ['read', 'write', 'network'] as const;

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw problem(400, 'invalid_field', 'invalid_body', { field });
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw problem(400, 'invalid_field', 'invalid_body', { field });
  return value;
}

function command(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(v => typeof v !== 'string')) throw problem(400, 'invalid_field', 'invalid_body', { field: 'command' });
  return value as string[];
}

export function registerMcpRoutes(router: Router, app: App): void {
  const { fromOs, checked, applyWithEnv, secretValue } = envApply(app);
  const log = (error: unknown): void => { app.log(`[WARN] MCP: ${error instanceof Error ? error.message : String(error)}`); };

  const slot = (kind: McpSecretKind, name: string, variable: string) => ({
    kind, name, set: Boolean(app.env[variable]?.trim()), ...(fromOs(variable) ? { source: 'os' as const } : {}),
  });
  const view = () => {
    const config = app.config();
    const servers = app.mcp.status().map(status => {
      const server = config.mcp.servers.find(s => s.id === status.id);
      const secrets = server ? [
        ...Object.entries(server.env).map(([name, variable]) => slot('env', name, variable)),
        ...Object.entries(server.headers).map(([name, variable]) => slot('header', name, variable)),
      ] : [];
      return { ...status, secrets };
    });
    return { servers, limits: config.mcp.limits };
  };
  const serverOf = (id: string): { config: AppConfig; server: McpServerConfig } => {
    const config = app.config();
    const server = config.mcp.servers.find(s => s.id === id);
    if (!server) throw problem(404, 'not_found', 'mcp_server_missing', { params: { id } });
    return { config, server };
  };
  const replace = (config: AppConfig, server: McpServerConfig): AppConfig => checked({
    ...config, mcp: { ...config.mcp, servers: config.mcp.servers.map(s => (s.id === server.id ? server : s)) },
  });
  const fieldOf = (server: McpServerConfig, kind: McpSecretKind): Record<string, string> => (kind === 'env' ? server.env : server.headers);
  const kindOf = (server: McpServerConfig, raw: string | undefined): McpSecretKind => {
    if (raw !== 'env' && raw !== 'header') throw problem(404, 'not_found', 'mcp_secret_kind');
    if ((raw === 'env') !== (server.transport === 'stdio')) throw problem(409, 'conflict', 'mcp_secret_kind');
    return raw;
  };
  const secretName = (kind: McpSecretKind, name: string | undefined): string => {
    const pattern = new RegExp(kind === 'env' ? MCP_ENV_NAME_PATTERN : MCP_HEADER_NAME_PATTERN, 'u');
    if (name === undefined || !pattern.test(name)) throw problem(400, 'invalid_field', 'mcp_bad_secret_name', { field: 'name' });
    return name;
  };
  // 反映のあと、自動で付けた名前で、ほかの欄から指されていない秘密だけを .env から消す（持ち主が自分で書いた名前は残す。OS 由来の値は消せない）
  const stillUsed = (config: AppConfig, name: string): boolean => config.mcp.servers.some(s => Object.values(s.env).includes(name) || Object.values(s.headers).includes(name))
    || config.notify.channels.some(c => c.urlEnv === name || c.tokenEnv === name) || config.providers.some(p => p.apiKeyEnv === name);
  const release = (config: AppConfig, variable: string, label: string): { set: boolean; source?: 'os' } => {
    if (stillUsed(config, variable)) return { set: true };
    const osValue = fromOs(variable);
    try { removeEnvValue(app.paths.env, variable); if (!osValue) delete app.env[variable]; }
    catch { app.log(`[WARN] MCP サーバー「${label}」の秘密（${variable}）を .env から消せませんでした。.env を直接開いて消してください`); }
    return osValue ? { set: true, source: 'os' } : { set: false };
  };
  const reconnect = (id: string): void => { void app.mcp.restart(id).catch(log); };

  router.add('GET', '/api/mcp', ({ res }) => sendJson(res, 200, view()));

  router.add('POST', '/api/mcp/servers', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const id = body.id;
    if (typeof id !== 'string' || !new RegExp(MCP_ID_PATTERN, 'u').test(id)) throw problem(400, 'invalid_field', 'mcp_bad_id', { field: 'id' });
    const transport = body.transport;
    if (transport !== 'stdio' && transport !== 'http') throw problem(400, 'invalid_field', 'invalid_body', { field: 'transport' });
    // 追加は enabled:true・道具は空（クライアントの enabled・tools・env・headers は受け取らない）
    const server: McpServerConfig = { id, transport, enabled: true, localOk: false, tools: {}, env: {}, headers: {} };
    if (body.command !== undefined) server.command = command(body.command);
    if (body.cwd !== undefined) server.cwd = text(body.cwd, 'cwd');
    if (body.url !== undefined) server.url = text(body.url, 'url');
    const secrets = body.secrets === undefined ? {} : requireObject(body.secrets);
    const changes = new Map<string, string | undefined>();
    for (const [kind, key] of [['env', 'env'], ['header', 'headers']] as const) {
      const given = secrets[key] === undefined ? {} : requireObject(secrets[key]);
      if (Object.keys(given).length > 0 && (kind === 'env') !== (transport === 'stdio')) throw problem(400, 'invalid_field', 'mcp_secret_kind', { field: `secrets.${key}` });
      for (const [name, raw] of Object.entries(given)) {
        secretName(kind, name);
        const variable = mcpEnvName(id, kind, name);
        changes.set(variable, secretValue(raw, `secrets.${key}.${name}`));
        fieldOf(server, kind)[name] = variable;
      }
    }
    // ここから反映し終えるまで await を挟まない
    const config = app.config();
    if (config.mcp.servers.some(s => s.id === id)) throw problem(409, 'conflict', 'mcp_server_exists', { params: { id } });
    if (config.mcp.servers.length >= config.mcp.limits.maxServers) throw problem(409, 'conflict', 'mcp_server_limit', { params: { max: config.mcp.limits.maxServers } });
    const next = checked({ ...config, mcp: { ...config.mcp, servers: [...config.mcp.servers, server] } });
    await applyWithEnv(next, changes);
    sendJson(res, 201, view());
  });

  router.add('PATCH', '/api/mcp/servers/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const { config, server } = serverOf(params[0]!);
    const next: McpServerConfig = { ...server };
    for (const [key, value] of Object.entries(body)) {
      if (key === 'enabled') next.enabled = bool(value, key);
      else if (key === 'localOk') next.localOk = bool(value, key);
      else if (key === 'command') next.command = command(value);
      else if (key === 'cwd') { if (value === null) delete next.cwd; else next.cwd = text(value, key); }
      else if (key === 'url') next.url = text(value, key);
      else throw problem(400, 'invalid_field', 'invalid_body', { field: key });
    }
    await applyWithEnv(replace(config, next), new Map());
    sendJson(res, 200, view());
  });

  router.add('DELETE', '/api/mcp/servers/:id', async ({ res, params }) => {
    const { config, server } = serverOf(params[0]!);
    const next = checked({ ...config, mcp: { ...config.mcp, servers: config.mcp.servers.filter(s => s.id !== server.id) } });
    await applyWithEnv(next, new Map());
    for (const kind of SECRET_KINDS) {
      for (const [name, variable] of Object.entries(fieldOf(server, kind))) {
        if (isAutoMcpEnv(server.id, kind, name, variable)) release(next, variable, server.id);
      }
    }
    app.kv.deletePrefix(`mcp:pin:${server.id}:`);
    sendJson(res, 200, view());
  });

  router.add('PUT', '/api/mcp/servers/:id/secrets/:kind/:name', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const { config, server } = serverOf(params[0]!);
    const kind = kindOf(server, params[1]);
    const name = secretName(kind, params[2]);
    const value = secretValue(body.value, 'value');
    // 環境変数の名前は、クライアントから受け取らない（body の name・env などは無視する）
    const existing = fieldOf(server, kind)[name];
    const variable = existing ?? mcpEnvName(server.id, kind, name);
    if (existing !== undefined && !isAutoMcpEnv(server.id, kind, name, existing)) throw problem(409, 'conflict', 'notify_env_manual', { params: { env: existing } });
    let next = config;
    if (existing === undefined) {
      next = replace(config, kind === 'env' ? { ...server, env: { ...server.env, [name]: variable } } : { ...server, headers: { ...server.headers, [name]: variable } });
    }
    await applyWithEnv(next, new Map([[variable, value]]));
    // 参照を足したときは、設定の反映がつなぎ直す。値だけを変えたときは、ここでつなぎ直す
    if (existing !== undefined) reconnect(server.id);
    sendJson(res, 200, { set: true });
  });

  router.add('DELETE', '/api/mcp/servers/:id/secrets/:kind/:name', async ({ res, params }) => {
    const { config, server } = serverOf(params[0]!);
    const kind = kindOf(server, params[1]);
    const name = secretName(kind, params[2]);
    const variable = fieldOf(server, kind)[name];
    if (variable === undefined) { sendJson(res, 200, { set: false }); return; }
    const rest = { ...fieldOf(server, kind) };
    delete rest[name];
    const next = replace(config, kind === 'env' ? { ...server, env: rest } : { ...server, headers: rest });
    await applyWithEnv(next, new Map());
    let state: { set: boolean; source?: 'os' } = { set: false };
    if (isAutoMcpEnv(server.id, kind, name, variable)) {
      try { state = release(next, variable, server.id); } catch (error) { envProblem(error); }
    }
    sendJson(res, 200, state);
  });

  router.add('PATCH', '/api/mcp/servers/:id/tools/:tool', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const { config, server } = serverOf(params[0]!);
    const tool = params[1]!;
    if (!new RegExp(MCP_TOOL_KEY_PATTERN, 'u').test(tool)) throw problem(400, 'invalid_field', 'mcp_bad_tool', { field: 'tool' });
    const entry: McpToolEntry = { ...(Object.hasOwn(server.tools, tool) ? server.tools[tool] : {}) };
    for (const [key, value] of Object.entries(body)) {
      if (key === 'enabled') entry.enabled = bool(value, key);
      else if (key === 'effect') {
        if (value === null) delete entry.effect;
        else if (EFFECTS.includes(value as typeof EFFECTS[number])) entry.effect = value as typeof EFFECTS[number];
        else throw problem(400, 'invalid_field', 'invalid_body', { field: key });
      } else if (key === 'sends' || key === 'removes') {
        if (value === null) delete entry[key]; else entry[key] = bool(value, key);
      } else throw problem(400, 'invalid_field', 'invalid_body', { field: key });
    }
    await applyWithEnv(replace(config, { ...server, tools: { ...server.tools, [tool]: entry } }), new Map());
    sendJson(res, 200, view());
  });

  router.add('POST', '/api/mcp/servers/:id/restart', ({ res, params }) => {
    const { server } = serverOf(params[0]!);
    reconnect(server.id);
    sendJson(res, 200, view());
  });

  router.add('POST', '/api/mcp/servers/:id/tools/:tool/accept', ({ res, params }) => {
    const { server } = serverOf(params[0]!);
    if (!app.mcp.accept(server.id, params[1]!)) throw problem(404, 'not_found', 'mcp_tool_missing', { params: { id: server.id, tool: params[1]! } });
    sendJson(res, 200, view());
  });

  router.add('GET', '/api/mcp/servers/:id/tools/:tool/diff', ({ res, params }) => {
    const { server } = serverOf(params[0]!);
    const diff = app.mcp.diff(server.id, params[1]!);
    if (!diff) throw problem(404, 'not_found', 'mcp_tool_missing', { params: { id: server.id, tool: params[1]! } });
    sendJson(res, 200, diff);
  });
}