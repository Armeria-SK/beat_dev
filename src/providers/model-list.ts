import type { ProviderConfig } from '../config/schema.ts';
import { checkBaseUrl, classifyFetchError, classifyHttpFailure, joinUrl, providerSecrets, readSnippet, requireApiKey, withTimeout } from './http.ts';
import { ProviderError, providerError, type Env, type FetchLike } from './types.ts';

export const MODEL_LIST_MAX = 500;
export const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024;
const MODEL_NAME_MAX = 200;
const ANTHROPIC_URL = 'https://api.anthropic.com';

export interface ModelList { models: string[]; truncated: boolean }

function target(provider: ProviderConfig, env: Env): { url: URL; headers: Record<string, string> } {
  const anthropic = provider.kind === 'anthropic';
  const keyed = anthropic ? { ...provider, apiKeyEnv: provider.apiKeyEnv ?? 'ANTHROPIC_API_KEY' } : provider;
  let base = ANTHROPIC_URL;
  if (!anthropic || provider.baseUrl !== undefined) {
    const checked = checkBaseUrl(provider.baseUrl ?? '', Boolean(keyed.apiKeyEnv));
    if ('problem' in checked) throw new ProviderError('provider_error', `providers.${provider.id}.baseUrl: ${checked.problem}`, { retryable: false });
    base = checked.url;
  }
  const key = requireApiKey(keyed, env);
  if (!anthropic) return { url: joinUrl(base, 'models'), headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } };
  const url = joinUrl(base, 'v1/models');
  url.searchParams.set('limit', '1000');
  return { url, headers: { Accept: 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } };
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MODEL_LIST_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw providerError('provider_error', 'models.too_large', {}, { retryable: false });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function listProviderModels(provider: ProviderConfig, env: Env, fetchImpl: FetchLike = fetch, timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<ModelList> {
  const { url, headers } = target(provider, env);
  const secrets = providerSecrets(provider, env);
  const never = new AbortController().signal;
  const { signal, timeout } = withTimeout(never, timeoutMs);
  let text: string;
  try {
    const response = await fetchImpl(url, { headers, signal, redirect: 'error' });
    if (!response.ok) throw classifyHttpFailure(response.status, await readSnippet(response, secrets), undefined, secrets);
    text = await readCapped(response);
  } catch (error) { throw classifyFetchError(error, never, timeout); }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw providerError('provider_error', 'models.unreadable', {}, { retryable: false }); }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw providerError('provider_error', 'models.unreadable', {}, { retryable: false });
  const names = [...new Set(data.map(entry => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= MODEL_NAME_MAX))];
  const more = (body as { has_more?: unknown }).has_more === true;
  return { models: names.slice(0, MODEL_LIST_MAX), truncated: more || names.length > MODEL_LIST_MAX };
}
