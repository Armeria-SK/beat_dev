import type { Conversation, Project } from '../api.ts';
import { groupConversations, mergeConversations, moreCount, noProductApi, sidebarOrder, waitingTotal } from './products.ts';
import { HOME, parseRoute, routeHash, routeProductId, settleRoute, type Route } from './routes.ts';

export interface ProductNavRow {
  project: Project;
  sessions: Conversation[];
  more: number;
  waiting: number;
}

export interface ProductNav { rows: ProductNavRow[]; none: Conversation[] }

export function productNav(
  projects: readonly Project[], conversations: readonly Conversation[], more: Readonly<Record<string, number>>, extra: ReadonlyMap<string, readonly Conversation[]>,
  rest: Readonly<Record<string, number>> = {},
): ProductNav {
  const groups = groupConversations(conversations, projects);
  const rows = sidebarOrder(projects).map(project => {
    const base = groups.byProduct.get(project.id) ?? [];
    const added = extra.get(project.id);
    const sessions = added ? mergeConversations(base, added.filter(c => c.project_id === project.id)) : base;
    return { project, sessions, more: moreCount(added ? rest : more, project.id), waiting: waitingTotal(project) };
  });
  return { rows, none: groups.none };
}

// 左の Memory の行き先: 製品の画面・製品の会話・その製品の Memory から開けば、その製品の記憶（beat 10-4a）。ほかは製品を選ぶ一覧
export function memoryHash(route: Route, conversations: readonly Conversation[]): string {
  const id = routeProductId(route) ?? (route.view === 'chat' ? conversations.find(c => c.id === route.id)?.project_id ?? null : route.view === 'memory' ? route.productId ?? null : null);
  return routeHash(id ? { view: 'memory', productId: id } : { view: 'memory' });
}

export const newSessionHash = (productId: string | undefined): string => routeHash(productId ? { view: 'productNew', id: productId } : HOME);

export function loadProjectList(fetchList: () => Promise<{ projects: Project[] }>): Promise<Project[] | null> {
  return fetchList().then(r => (Array.isArray(r.projects) ? r.projects : null), error => (noProductApi(error) ? [] : null)).catch(() => null);
}

export const PROJECT_RETRY_MS = [2_000, 5_000, 15_000, 60_000] as const;

export function projectLoads(
  fetchList: () => Promise<{ projects: Project[] }>, apply: (projects: Project[]) => void,
  later: (run: () => void, ms: number) => unknown = setTimeout, retryMs: readonly number[] = PROJECT_RETRY_MS,
  failing: (on: boolean) => void = () => undefined,
): { load: () => Promise<void>; supersede: () => void; start: () => () => void } {
  let generation = 0;
  let started = 0;
  let failures = 0;
  let closed = false;
  const load = (): Promise<void> => {
    if (closed) return Promise.resolve();
    const mine = ++generation;
    const turn = ++started;
    return loadProjectList(fetchList).then(list => {
      if (list === null) {
        if (turn !== started) return;
        const wait = retryMs[Math.min(failures, retryMs.length - 1)]!;
        failures += 1;
        failing(true);
        later(() => { if (turn === started) void load(); }, wait);
        return;
      }
      failures = 0;
      failing(false);
      if (mine === generation) apply(list);
    });
  };
  const stop = (): void => { closed = true; generation += 1; started += 1; failures = 0; };
  return { load, supersede: () => { generation += 1; }, start: () => { closed = false; return stop; } };
}

export function sendOptions(conversationId: string | null, productId: string | undefined, interrupt: boolean): { interrupt?: true; projectId?: string } {
  return { ...(interrupt ? { interrupt: true } : {}), ...(conversationId === null && productId ? { projectId: productId } : {}) };
}

export function productsMissing(route: Route, loaded: boolean, failing: boolean): boolean {
  const needs = route.view === 'product' || route.view === 'productNew' || route.view === 'productSettings' || (route.view === 'pending' && route.productId !== undefined);
  return needs && failing && !loaded;
}

export const awaitingProduct = (route: Route, product: Project | undefined): boolean => route.view === 'productNew' && product === undefined;

export function navigationHashes(nav = (globalThis as { navigation?: { entries?: () => ReadonlyArray<{ url?: string | null }> } }).navigation): string[] {
  return (nav?.entries?.() ?? []).map(entry => { const url = entry.url ?? ''; const at = url.indexOf('#'); return at < 0 ? '' : url.slice(at); });
}

export function settingsRunStart(start: number | null, hashes: readonly string[]): number | null {
  if (start === null) return null;
  let first = start;
  while (first > 0 && parseRoute(hashes[first - 1] ?? '').view === 'settings') first -= 1;
  return first;
}

export function settleLeave(route: Route, productIds: readonly string[] | null, env: { clearEdits: () => void; replace: (hash: string) => void }): boolean {
  if (settleRoute(route, productIds) === route) return false;
  env.clearEdits();
  env.replace(routeHash(HOME));
  return true;
}
