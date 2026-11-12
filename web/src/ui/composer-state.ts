import type { PermissionMode } from '../../../src/shared/permission-mode.ts';
import type { ModelView, PendingMessage } from '../api.ts';
import { SLASH_COMMANDS } from '../chat-logic.ts';

export const MAX_ATTACHMENTS = 5;
export const ATTACH_ACCEPT = '.txt,.md,.csv,.json,.yaml,.yml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/pdf,image/png,image/jpeg,image/gif,image/webp';

export const MODE_LABEL = { normal: 'ui.composer.modeAsk', auto: 'ui.composer.modeAuto', plan: 'ui.composer.modePlan' } as const satisfies Record<PermissionMode, string>;

export type Placeholder = 'noModel' | 'busy' | 'plan' | 'reply' | 'message';
export const PLACEHOLDER = {
  noModel: 'ui.composer.noModel', busy: 'ui.composer.busy', plan: 'ui.composer.plan', reply: 'ui.composer.reply', message: 'ui.composer.message',
} as const satisfies Record<Placeholder, string>;

export interface ComposerInput {
  hasConversation: boolean;
  running: boolean;
  mode: PermissionMode;
  chatModels: number | null;
  text: string;
  attachments: number;
  uploading: boolean;
  sending: boolean;
}

export interface ComposerView {
  placeholder: Placeholder;
  disabled: boolean;
  actions: 'send' | 'busy';
  canSubmit: boolean;
  canAttach: boolean;
}

export function composerView(i: ComposerInput): ComposerView {
  const noModel = i.chatModels === 0;
  const placeholder: Placeholder = noModel ? 'noModel' : i.running ? 'busy' : i.mode === 'plan' ? 'plan' : i.hasConversation ? 'reply' : 'message';
  const filled = i.text.trim() !== '' || i.attachments > 0;
  const free = !noModel && !i.uploading && !i.sending;
  return { placeholder, disabled: noModel, actions: i.running ? 'busy' : 'send', canSubmit: free && filled, canAttach: free && i.attachments < MAX_ATTACHMENTS };
}

export type SubmitKind = 'send' | 'queue' | 'force';

export function enterAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }, running: boolean): SubmitKind | null {
  if (e.key !== 'Enter' || e.shiftKey || e.composing) return null;
  if (!running) return 'send';
  return e.ctrlKey || e.metaKey ? 'force' : 'queue';
}

const usable = (m: ModelView): boolean => m.probe?.status === 'ok';

export function modelInEffect(models: readonly ModelView[], chatOrder: readonly string[], modelId: string | null): ModelView | undefined {
  if (modelId) return models.find(m => m.id === modelId);
  const ordered = chatOrder.map(id => models.find(m => m.id === id)).filter((m): m is ModelView => m !== undefined);
  return ordered.find(usable) ?? ordered[0];
}

export const depthOptions = (model: ModelView | undefined): string[] => [...(model?.efforts ?? [])];

export const modelName = (model: ModelView): string => model.model || model.label || model.id;

export interface ModelOption { id: string | null; name: string | null; hint: string; checked: boolean; disabled: boolean }

export function modelOptions(models: readonly ModelView[], modelId: string | null): ModelOption[] {
  return [
    { id: null, name: null, hint: '', checked: modelId === null, disabled: false },
    ...models.map(m => ({ id: m.id, name: modelName(m), hint: m.label === modelName(m) ? '' : m.label, checked: m.id === modelId, disabled: !usable(m) && m.id !== modelId })),
  ];
}

export const UI_SLASH = [
  { name: 'new', desc: 'ui.slash.new' },
  { name: 'plan', desc: 'ui.slash.plan' },
  { name: 'task', desc: 'ui.slash.task' },
  { name: 'tasks', desc: 'ui.slash.tasks' },
  { name: 'skills', desc: 'ui.slash.skills' },
  { name: 'log', desc: 'ui.slash.log' },
  { name: 'memory', desc: 'ui.slash.memory' },
  { name: 'stop', desc: 'ui.slash.stop' },
  { name: 'rename', desc: 'ui.slash.rename' },
  { name: 'archive', desc: 'ui.slash.archive' },
  { name: 'summary', desc: 'ui.slash.summary' },
] as const satisfies ReadonlyArray<{ name: (typeof SLASH_COMMANDS)[number]['name'] | 'plan'; desc: string }>;

export type UiSlash = (typeof UI_SLASH)[number];
export type UiSlashName = UiSlash['name'];

export interface SlashContext { hasConversation: boolean; running: boolean; hasSummary: boolean; archived: boolean }

export function slashAvailable(ctx: SlashContext): UiSlash[] {
  return UI_SLASH.filter(c => {
    switch (c.name) {
      case 'stop': return ctx.running;
      case 'rename': return ctx.hasConversation;
      case 'archive': return ctx.hasConversation && !ctx.archived;
      case 'summary': return ctx.hasConversation && ctx.hasSummary;
      default: return true;
    }
  });
}

export function slashItems(input: string, ctx: SlashContext, forced = false): UiSlash[] {
  const all = slashAvailable(ctx);
  if (!input.startsWith('/')) return forced ? all : [];
  const query = input.slice(1).toLowerCase();
  return all.filter(c => c.name.startsWith(query));
}

export const replaceTargets = (pending: readonly PendingMessage[]): PendingMessage[] => pending.filter(p => !p.interrupt);

export const queuedLine = (p: Pick<PendingMessage, 'text' | 'attachments'>): string => p.text.replace(/\s+/gu, ' ').trim() || p.attachments.map(a => a.name).join(', ');

export const attachRoom = (attached: number, incoming: number): number => Math.max(0, Math.min(incoming, MAX_ATTACHMENTS - attached));
