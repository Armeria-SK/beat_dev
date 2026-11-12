import type { Conversation, Project } from '../api.ts';

export const NO_PRODUCT = 'none';
export const ALL_PRODUCTS = 'all';

export type ProductFilter = string;

export const productKey = (projectId: string | null | undefined): string => projectId || NO_PRODUCT;

export const waitingTotal = (project: Project): number => project.waiting.proposals + project.waiting.questions + project.waiting.pending;

export const productOf = (projects: readonly Project[], id: string | null | undefined): Project | undefined =>
  (id ? projects.find(p => p.id === id) : undefined);

const byCreated = (a: Project, b: Project): number => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sidebarOrder(projects: readonly Project[]): Project[] {
  return projects.filter(p => p.archived_at === null).sort(byCreated);
}

export function overviewOrder(projects: readonly Project[]): Project[] {
  return projects.filter(p => p.archived_at === null).sort((a, b) =>
    waitingTotal(b) - waitingTotal(a) || (b.last_activity_at ?? -Infinity) - (a.last_activity_at ?? -Infinity) || byCreated(a, b));
}

export interface ConversationGroups { none: Conversation[]; byProduct: Map<string, Conversation[]> }

export function groupConversations(conversations: readonly Conversation[], projects: readonly Project[]): ConversationGroups {
  const groups: ConversationGroups = { none: [], byProduct: new Map(projects.map(p => [p.id, []])) };
  for (const c of conversations) {
    if (!c.project_id) { groups.none.push(c); continue; }
    const list = groups.byProduct.get(c.project_id);
    if (list) list.push(c); else groups.byProduct.set(c.project_id, [c]);
  }
  return groups;
}

export function latestConversation(conversations: readonly Conversation[], projectId: string | null): Conversation | undefined {
  let latest: Conversation | undefined;
  for (const c of conversations) {
    if (productKey(c.project_id) === productKey(projectId) && (!latest || c.last_message_at > latest.last_message_at)) latest = c;
  }
  return latest;
}

export const moreCount = (more: Readonly<Record<string, number>> | undefined, projectId: string | null): number => {
  const n = more && Object.hasOwn(more, productKey(projectId)) ? more[productKey(projectId)] : 0;
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
};

export function mergeConversations(base: readonly Conversation[], extra: readonly Conversation[]): Conversation[] {
  const seen = new Set(base.map(c => c.id));
  return [...base, ...extra.filter(c => !seen.has(c.id))].sort((a, b) => b.last_message_at - a.last_message_at);
}

export interface ProductOption { key: ProductFilter; name: string | null; waiting: number }

export function filterOptions(projects: readonly Project[]): ProductOption[] {
  return [
    { key: ALL_PRODUCTS, name: null, waiting: 0 },
    ...sidebarOrder(projects).map(p => ({ key: p.id, name: p.name, waiting: waitingTotal(p) })),
    { key: NO_PRODUCT, name: null, waiting: 0 },
  ];
}

export const matchesFilter = (projectId: string | null | undefined, filter: ProductFilter): boolean =>
  filter === ALL_PRODUCTS || productKey(projectId) === filter;

export const filterQuery = (filter: ProductFilter): string | undefined => (filter === ALL_PRODUCTS ? undefined : filter);

export const noProductApi = (error: unknown): boolean => (error as { status?: unknown } | null)?.status === 404;

export function throttled(run: () => void, ms: number, later: (fn: () => void, ms: number) => unknown = setTimeout): () => void {
  let waiting = false;
  let again = false;
  const fire = (): void => {
    waiting = true;
    again = false;
    run();
    later(() => { waiting = false; if (again) fire(); }, ms);
  };
  return () => { if (waiting) again = true; else fire(); };
}
