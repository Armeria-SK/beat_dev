export interface LegacyKey {
  path: string;
  removedIn: string;
}

export const LEGACY_KEYS: readonly LegacyKey[] = [
  { path: 'models[].toolMode', removedIn: 'beat 0-1' },
  { path: 'language', removedIn: 'beat 0-2a-3' },
  { path: 'tools.maxIterations', removedIn: 'beat 0-3b' },
  { path: 'tools.web.searxngUrl', removedIn: 'beat 0-4b' },
  { path: 'tools.shell.approvalTimeoutSec', removedIn: 'beat 4-3b-1' },
  { path: 'tools.taintEscalation', removedIn: 'beat 4-3b-2' },
  { path: 'mcp.servers[].localOk', removedIn: 'beat 4-1' },
  { path: 'worker.remindAfterHours', removedIn: 'beat 5-2b-s' },
  { path: 'models[].maxTools', removedIn: 'beat no-maxtools' },
  { path: 'memory.reviewAfterToolCalls', removedIn: 'beat 10-1' },
  { path: 'worker.autonomy', removedIn: 'beat 7-4' },
  { path: 'worker.idleMinutes', removedIn: 'beat 7-4' },
  { path: 'worker.selfTasksNeedApproval', removedIn: 'beat 7-4' },
  { path: 'worker.quietStart', removedIn: 'beat 7-4' },
  { path: 'worker.quietEnd', removedIn: 'beat 7-4' },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dropPath(target: Record<string, unknown>, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  if (head.endsWith('[]')) {
    const list = target[head.slice(0, -2)];
    if (!Array.isArray(list)) return false;
    let dropped = false;
    for (const item of list) if (isObject(item) && dropPath(item, rest)) dropped = true;
    return dropped;
  }
  if (!rest.length) {
    if (!Object.hasOwn(target, head)) return false;
    delete target[head];
    return true;
  }
  const next = target[head];
  return isObject(next) ? dropPath(next, rest) : false;
}

const OLD_OLLAMA_URL = 'http://127.0.0.1:11434';

function rewriteOllama(config: Record<string, unknown>): string[] {
  const providers = config.providers;
  if (!Array.isArray(providers)) return [];
  const rewritten: string[] = [];
  for (const provider of providers) {
    if (!isObject(provider) || provider.kind !== 'ollama') continue;
    provider.kind = 'openai_compatible';
    if (provider.baseUrl === undefined || typeof provider.baseUrl === 'string') {
      const base = (provider.baseUrl ?? OLD_OLLAMA_URL).trim().replace(/\/+$/u, '');
      provider.baseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
    }
    if (provider.server === undefined) provider.server = 'generic';
    rewritten.push(`providers.${String(provider.id)}.kind "ollama" → "openai_compatible" (${String(provider.baseUrl)})`);
  }
  return rewritten;
}

function rewriteSearxng(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!isObject(tools) || !isObject(tools.web) || tools.web.search !== 'searxng') return [];
  tools.web.search = 'duckduckgo';
  return ['tools.web.search "searxng" → "duckduckgo"'];
}

function rewriteModelLimits(config: Record<string, unknown>): string[] {
  const models = config.models;
  if (!Array.isArray(models)) return [];
  const rewritten: string[] = [];
  for (const model of models) {
    if (!isObject(model) || !Object.hasOwn(model, 'minContext')) continue;
    if (Object.hasOwn(model, 'maxOutputTokens')) rewritten.push(`models.${String(model.id)}.maxOutputTokens ${String(model.maxOutputTokens)} → auto`);
    rewritten.push(`models.${String(model.id)}.minContext ${String(model.minContext)} → removed`);
    delete model.maxOutputTokens;
    delete model.minContext;
  }
  return rewritten;
}

export function dropLegacy(raw: unknown): { config: unknown; dropped: string[]; rewritten: string[] } {
  if (!isObject(raw)) return { config: raw, dropped: [], rewritten: [] };
  const config = structuredClone(raw);
  const dropped = LEGACY_KEYS.filter(key => dropPath(config, key.path.split('.'))).map(key => key.path);
  const rewritten = [...rewriteOllama(config), ...rewriteSearxng(config), ...rewriteModelLimits(config)];
  return dropped.length || rewritten.length ? { config, dropped, rewritten } : { config: raw, dropped, rewritten };
}
