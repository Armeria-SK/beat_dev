export type RunsTab = 'run' | 'tools' | 'reviews';
export type SkillTarget = { kind: 'skill' | 'draft'; name: string };

export type Route =
  | { view: 'new' }
  | { view: 'chat'; id: string }
  | { view: 'overview' } | { view: 'kanban' } | { view: 'schedule' } | { view: 'notifications' }
  | { view: 'memory'; productId?: string } | { view: 'archived' }
  | { view: 'task'; id: string }
  | { view: 'product'; id: string } | { view: 'productNew'; id: string } | { view: 'productSettings'; id: string }
  | { view: 'newProduct' }
  | { view: 'pending'; productId?: string }
  | { view: 'questions'; productId?: string }
  | { view: 'skills'; target?: SkillTarget }
  | { view: 'runs'; tab?: RunsTab }
  | { view: 'settings'; section?: string };

export type View = Route['view'];

export const HOME: Route = { view: 'new' };

const PLAIN = ['overview', 'kanban', 'schedule', 'notifications', 'archived'] as const;

const LEGACY: Record<string, Route> = {
  tasks: { view: 'kanban' }, today: { view: 'overview' }, review: { view: 'skills' }, curiosity: { view: 'kanban' },
};

export const PRODUCT_ID = /^[A-Za-z0-9_-]{6,64}$/u;

function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/u, '').split(/[?#]/u)[0]!.split('/');
  const [head = '', a, b] = parts;
  if (head === 'c' && a) return { view: 'chat', id: decode(a) };
  if (head === 'tasks' && a) return { view: 'task', id: decode(a) };
  if (head === 'p') {
    if (!a || !PRODUCT_ID.test(a)) return HOME;
    return { view: b === 'new' ? 'productNew' : b === 'settings' ? 'productSettings' : 'product', id: a };
  }
  if (head === 'pending') return a && PRODUCT_ID.test(a) ? { view: 'pending', productId: a } : { view: 'pending' };
  if (head === 'memory') return a && PRODUCT_ID.test(a) ? { view: 'memory', productId: a } : { view: 'memory' };
  if (head === 'questions') return a && PRODUCT_ID.test(a) ? { view: 'questions', productId: a } : { view: 'questions' };
  if (head === 'products') return a === 'new' ? { view: 'newProduct' } : HOME;
  if ((PLAIN as readonly string[]).includes(head)) return { view: head as typeof PLAIN[number] };
  if (head === 'skills') {
    if (a === 'draft' && b) return { view: 'skills', target: { kind: 'draft', name: decode(b) } };
    return a ? { view: 'skills', target: { kind: 'skill', name: decode(a) } } : { view: 'skills' };
  }
  if (head === 'runs') return a === 'run' || a === 'tools' || a === 'reviews' ? { view: 'runs', tab: a } : { view: 'runs' };
  if (head === 'settings') return a ? { view: 'settings', section: decode(a) } : { view: 'settings' };
  return Object.hasOwn(LEGACY, head) ? LEGACY[head]! : HOME;
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case 'new': return '#/';
    case 'chat': return `#/c/${encodeURIComponent(route.id)}`;
    case 'task': return `#/tasks/${encodeURIComponent(route.id)}`;
    case 'product': return `#/p/${route.id}`;
    case 'productNew': return `#/p/${route.id}/new`;
    case 'productSettings': return `#/p/${route.id}/settings`;
    case 'newProduct': return '#/products/new';
    case 'pending': return route.productId ? `#/pending/${route.productId}` : '#/pending';
    case 'questions': return route.productId ? `#/questions/${route.productId}` : '#/questions';
    case 'memory': return route.productId ? `#/memory/${route.productId}` : '#/memory';
    case 'skills': return route.target ? `#/skills/${route.target.kind === 'draft' ? 'draft/' : ''}${encodeURIComponent(route.target.name)}` : '#/skills';
    case 'runs': return route.tab ? `#/runs/${route.tab}` : '#/runs';
    case 'settings': return route.section ? `#/settings/${encodeURIComponent(route.section)}` : '#/settings';
    default: return `#/${route.view}`;
  }
}

export function routeBehind(route: Route, previous: Route | null): Route {
  return route.view === 'settings' ? previous ?? HOME : route;
}

export function latch(run: () => void): { fire: () => void; reset: () => void } {
  let fired = false;
  return {
    fire: () => { if (fired) return; fired = true; run(); },
    reset: () => { fired = false; },
  };
}

export const CLOSE_FALLBACK_MS = 300;

export interface CloseEnv {
  hasBehind: () => boolean;
  behindHash: () => string;
  depth: () => number | null;
  back: (by: number) => void;
  replace: (hash: string) => void;
  currentHash: () => string;
  generation: () => number;
  later: (run: () => void, ms: number) => void;
}

export const settingsDepth = (start: number | null, now: number | null): number | null => (start === null || now === null || now < start ? null : now - start + 1);

export function settingsCloser(env: CloseEnv): { fire: () => void; reset: () => void } {
  return latch(() => {
    if (!env.hasBehind()) { env.replace('#/'); return; }
    const before = env.generation();
    env.back(env.depth() ?? 1);
    env.later(() => {
      if (env.generation() === before && parseRoute(env.currentHash()).view === 'settings') env.replace(env.behindHash());
    }, CLOSE_FALLBACK_MS);
  });
}

export const isConversation = (route: Route): boolean => route.view === 'new' || route.view === 'chat';

export function routeProductId(route: Route): string | null {
  return route.view === 'product' || route.view === 'productNew' || route.view === 'productSettings' ? route.id : null;
}

export function settleRoute(route: Route, productIds: readonly string[] | null): Route {
  const id = routeProductId(route);
  return id !== null && productIds !== null && !productIds.includes(id) ? HOME : route;
}
