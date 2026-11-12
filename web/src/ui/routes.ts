export type RunsTab = 'tools' | 'reviews';
export type SkillTarget = { kind: 'skill' | 'draft'; name: string };

export type Route =
  | { view: 'new' }
  | { view: 'chat'; id: string }
  | { view: 'overview' } | { view: 'kanban' } | { view: 'schedule' } | { view: 'notifications' }
  | { view: 'memory' } | { view: 'archived' }
  | { view: 'task'; id: string }
  | { view: 'skills'; target?: SkillTarget }
  | { view: 'runs'; tab?: RunsTab }
  | { view: 'settings'; section?: string };

export type View = Route['view'];

export const HOME: Route = { view: 'new' };

const PLAIN = ['overview', 'kanban', 'schedule', 'notifications', 'memory', 'archived'] as const;

const LEGACY: Record<string, Route> = {
  tasks: { view: 'kanban' }, today: { view: 'overview' }, review: { view: 'skills' }, curiosity: { view: 'kanban' },
};

function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/u, '').split(/[?#]/u)[0]!.split('/');
  const [head = '', a, b] = parts;
  if (head === 'c' && a) return { view: 'chat', id: decode(a) };
  if (head === 'tasks' && a) return { view: 'task', id: decode(a) };
  if ((PLAIN as readonly string[]).includes(head)) return { view: head as typeof PLAIN[number] };
  if (head === 'skills') {
    if (a === 'draft' && b) return { view: 'skills', target: { kind: 'draft', name: decode(b) } };
    return a ? { view: 'skills', target: { kind: 'skill', name: decode(a) } } : { view: 'skills' };
  }
  if (head === 'runs') return a === 'tools' || a === 'reviews' ? { view: 'runs', tab: a } : { view: 'runs' };
  if (head === 'settings') return a ? { view: 'settings', section: decode(a) } : { view: 'settings' };
  return Object.hasOwn(LEGACY, head) ? LEGACY[head]! : HOME;
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case 'new': return '#/';
    case 'chat': return `#/c/${encodeURIComponent(route.id)}`;
    case 'task': return `#/tasks/${encodeURIComponent(route.id)}`;
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

export const isConversation =(route: Route): boolean => route.view === 'new' || route.view === 'chat';
