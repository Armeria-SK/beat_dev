import type { Conversation, Project } from '../api.ts';
import { groupConversations, latestConversation, mergeConversations, moreCount, noProductApi, sidebarOrder, waitingTotal } from './products.ts';
import { HOME, routeHash, settleRoute, type Route } from './routes.ts';

export interface ProductNavRow {
  project: Project;
  sessions: Conversation[];
  more: number;
  nameHref: string;
  waiting: number;
}

export interface ProductNav { rows: ProductNavRow[]; none: Conversation[] }

export function productNav(
  projects: readonly Project[], conversations: readonly Conversation[], more: Readonly<Record<string, number>>, extra: ReadonlyMap<string, readonly Conversation[]>,
): ProductNav {
  const groups = groupConversations(conversations, projects);
  const rows = sidebarOrder(projects).map(project => {
    const base = groups.byProduct.get(project.id) ?? [];
    const added = extra.get(project.id);
    const sessions = added ? mergeConversations(base, added.filter(c => c.project_id === project.id)) : base;
    const latest = latestConversation(sessions, project.id);
    return {
      project, sessions, more: added ? 0 : moreCount(more, project.id), waiting: waitingTotal(project),
      nameHref: latest ? routeHash({ view: 'chat', id: latest.id }) : routeHash({ view: 'productNew', id: project.id }),
    };
  });
  return { rows, none: groups.none };
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
): { load: () => Promise<void>; supersede: () => void } {
  let generation = 0;
  let started = 0;
  let failures = 0;
  const load = (): Promise<void> => {
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
  return { load, supersede: () => { generation += 1; } };
}

export function sendOptions(conversationId: string | null, productId: string | undefined, interrupt: boolean): { interrupt?: true; projectId?: string } {
  return { ...(interrupt ? { interrupt: true } : {}), ...(conversationId === null && productId ? { projectId: productId } : {}) };
}

export function productsMissing(route: Route, loaded: boolean, failing: boolean): boolean {
  const needs = route.view === 'product' || route.view === 'productNew' || route.view === 'productSettings' || (route.view === 'pending' && route.productId !== undefined);
  return needs && failing && !loaded;
}

export const awaitingProduct = (route: Route, product: Project | undefined): boolean => route.view === 'productNew' && product === undefined;

export function settleLeave(route: Route, productIds: readonly string[] | null, env: { clearEdits: () => void; replace: (hash: string) => void }): boolean {
  if (settleRoute(route, productIds) === route) return false;
  env.clearEdits();
  env.replace(routeHash(HOME));
  return true;
}
