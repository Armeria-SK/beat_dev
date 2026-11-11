export interface LegacyKey {
  path: string;
  removedIn: string;
}

export const LEGACY_KEYS: readonly LegacyKey[] = [
  { path: 'models[].toolMode', removedIn: 'beat 0-1' },
  { path: 'language', removedIn: 'beat 0-2a-3' },
  { path: 'tools.maxIterations', removedIn: 'beat 0-3b' },
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

export function dropLegacy(raw: unknown): { config: unknown; dropped: string[]; rewritten: string[] } {
  if (!isObject(raw)) return { config: raw, dropped: [], rewritten: [] };
  const config = structuredClone(raw);
  const dropped = LEGACY_KEYS.filter(key => dropPath(config, key.path.split('.'))).map(key => key.path);
  const rewritten = rewriteOllama(config);
  return dropped.length || rewritten.length ? { config, dropped, rewritten } : { config: raw, dropped, rewritten };
}
