import type { ModelView, ProviderKeyState } from '../../api.ts';
import type { Config } from '../../settings/model.ts';

export type Reach = 'ok' | 'warn' | 'danger';

const REACH_OF: Record<string, Reach> = {
  ok: 'ok', too_small: 'ok', exceeds_model: 'ok', unknown: 'ok',
  unreachable: 'warn',
  no_api_key: 'danger', not_found: 'danger', error: 'danger',
};

export type ModelReach = Reach | 'small';

export function modelReach(status: string): ModelReach {
  return status === 'too_small' ? 'small' : REACH_OF[status] ?? 'danger';
}

export function providerReach(providerId: string, models: readonly ModelView[]): Reach | null {
  const seen = models.filter(m => m.provider === providerId && m.probe).map(m => REACH_OF[m.probe!.status] ?? 'danger');
  if (seen.length === 0) return null;
  if (seen.includes('ok')) return 'ok';
  return seen.includes('danger') ? 'danger' : 'warn';
}

export function lastChecked(providerId: string, models: readonly ModelView[]): number | null {
  const times = models.filter(m => m.provider === providerId && m.probe).map(m => m.probe!.checkedAt);
  return times.length ? Math.max(...times) : null;
}

export type KeyLine = 'set' | 'os' | 'none' | 'loading' | 'failed' | 'unsafe';

export function keyLine(state: ProviderKeyState | 'failed' | null, unsafe: boolean): KeyLine {
  if (unsafe) return 'unsafe';
  if (state === null) return 'loading';
  if (state === 'failed') return 'failed';
  if (!state.set) return 'none';
  return state.source === 'os' ? 'os' : 'set';
}

export interface Roles { conversation: string | null; judge: string; fallback: string[]; background: string[] }

export function rolesOf(config: Config): Roles {
  const chat = Array.isArray(config.routing?.chat) ? config.routing.chat as string[] : [];
  const background = Array.isArray(config.routing?.background) ? config.routing.background as string[] : [];
  const judge = Array.isArray(config.routing?.judge) ? config.routing.judge as string[] : [];
  return { conversation: chat[0] ?? null, judge: judge[0] ?? '', fallback: chat.slice(1), background: [...background] };
}

export function setJudge(config: Config, id: string): Config {
  const routing = { ...config.routing };
  const tail = Array.isArray(routing.judge) ? (routing.judge as string[]).slice(1).filter(x => x !== id) : [];
  if (id) routing.judge = [id, ...tail]; else delete routing.judge;
  return { ...config, routing };
}

export function setConversation(config: Config, id: string): Config {
  const chat = (config.routing.chat as string[]).filter(x => x !== id);
  return { ...config, routing: { ...config.routing, chat: [id, ...chat] } };
}

export function setFallback(config: Config, ids: readonly string[]): Config {
  const head = (config.routing.chat as string[])[0];
  const rest = ids.filter(x => x !== head);
  return { ...config, routing: { ...config.routing, chat: head === undefined ? rest : [head, ...rest] } };
}

export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
