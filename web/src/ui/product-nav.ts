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

export function loadProjectList(fetchList: () => Promise<{ projects: Project[] }>): Promise<Project[] | null> {
  return fetchList().then(r => (Array.isArray(r.projects) ? r.projects : null), error => (noProductApi(error) ? [] : null)).catch(() => null);
}

export function projectLoads(fetchList: () => Promise<{ projects: Project[] }>, apply: (projects: Project[]) => void): { load: () => Promise<void>; supersede: () => void } {
  let generation = 0;
  return {
    load: () => {
      const mine = ++generation;
      return loadProjectList(fetchList).then(list => { if (list !== null && mine === generation) apply(list); });
    },
    supersede: () => { generation += 1; },
  };
}

export function settleLeave(route: Route, productIds: readonly string[] | null, env: { clearEdits: () => void; replace: (hash: string) => void }): boolean {
  if (settleRoute(route, productIds) === route) return false;
  env.clearEdits();
  env.replace(routeHash(HOME));
  return true;
}
