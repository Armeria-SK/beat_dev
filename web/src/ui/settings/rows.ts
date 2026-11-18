import type { PlainKey } from '../../i18n/index.ts';
import type { UiIconName } from '../icons.ts';

export type CategoryId = 'models' | 'skills' | 'background' | 'folders' | 'hooks' | 'browser' | 'mcp' | 'server' | 'persona' | 'appearance' | 'advanced';
export type GroupId = 'agent' | 'computer' | 'customize';

export interface Category {
  id: CategoryId;
  group: GroupId;
  icon: UiIconName;
  label: PlainKey;
  rows: readonly PlainKey[];
}

export const GROUP_LABEL: Record<GroupId, PlainKey> = { agent: 'ui.set.group.agent', computer: 'ui.set.group.computer', customize: 'ui.set.group.customize' };

export const CATEGORIES: readonly Category[] = [
  { id: 'models', group: 'agent', icon: 'cpu', label: 'ui.set.cat.models',
    rows: ['ui.set.models.providers', 'ui.set.models.models', 'ui.set.models.roles', 'ui.set.models.conversation', 'ui.set.models.judge', 'ui.set.models.fallback', 'ui.set.models.background', 'ui.set.models.scout', 'ui.set.models.check', 'ui.set.key.title'] },
  { id: 'skills', group: 'agent', icon: 'layers', label: 'ui.set.cat.skills',
    rows: ['ui.set.skills.grow', 'ui.set.skills.ask', 'ui.set.skills.registered', 'ui.set.skills.tools', 'ui.set.shell.title', 'ui.set.shell.enabled', 'ui.set.shell.kind', 'ui.set.shell.timeout', 'ui.set.shell.allow', 'ui.set.shell.ask', 'ui.set.shell.deny'] },
  { id: 'background', group: 'agent', icon: 'refresh', label: 'ui.set.cat.background',
    rows: ['ui.set.bg.on', 'ui.set.bg.perHour', 'ui.set.bg.parallel'] },
  { id: 'folders', group: 'computer', icon: 'folder', label: 'ui.set.cat.folders',
    rows: ['ui.set.folders.allowed', 'ui.set.folders.add', 'ui.set.folders.deny', 'ui.set.folders.outside'] },
  { id: 'hooks', group: 'computer', icon: 'hook', label: 'ui.set.cat.hooks',
    rows: ['ui.set.hooks.pre', 'ui.set.hooks.post', 'ui.set.hooks.add'] },
  { id: 'browser', group: 'computer', icon: 'window', label: 'ui.set.cat.browser',
    rows: ['ui.set.browser.use', 'ui.set.browser.sites', 'ui.set.browser.profile', 'ui.set.browser.show', 'ui.set.browser.channel', 'ui.set.browser.limits'] },
  { id: 'mcp', group: 'computer', icon: 'plug', label: 'ui.set.cat.mcp',
    rows: ['ui.set.mcp.connected', 'ui.set.mcp.add'] },
  { id: 'server', group: 'computer', icon: 'server', label: 'ui.set.cat.server',
    rows: ['ui.set.server.port', 'ui.set.server.origins', 'ui.set.server.logins', 'ui.set.server.restart'] },
  { id: 'persona', group: 'customize', icon: 'person', label: 'ui.set.cat.persona',
    rows: ['ui.set.persona.name', 'ui.set.persona.color', 'ui.set.persona.soul', 'ui.set.persona.user', 'ui.set.persona.replay'] },
  { id: 'appearance', group: 'customize', icon: 'palette', label: 'ui.set.cat.appearance',
    rows: ['ui.set.look.explain', 'ui.set.look.theme', 'ui.set.look.reduce'] },
  { id: 'advanced', group: 'customize', icon: 'sliders', label: 'ui.set.cat.advanced',
    rows: ['ui.set.adv.file', 'ui.set.adv.open', 'ui.set.adv.reset'] },
];

export const DEFAULT_CATEGORY: CategoryId = 'models';

export const isCategory = (value: unknown): value is CategoryId => CATEGORIES.some(c => c.id === value);

export const categoryById = (id: CategoryId): Category => CATEGORIES.find(c => c.id === id)!;

export function matchCategories(query: string, text: (key: PlainKey) => string): CategoryId[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATEGORIES.map(c => c.id);
  return CATEGORIES.filter(c => [c.label, ...c.rows].some(key => text(key).toLowerCase().includes(q))).map(c => c.id);
}
