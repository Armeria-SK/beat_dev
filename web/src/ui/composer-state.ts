import type { PermissionMode } from '../../../src/shared/permission-mode.ts';
import type { ModelView, PendingMessage } from '../api.ts';
import { isRenameWithoutTitle, renameTitleOf, SLASH_COMMANDS } from '../chat-logic.ts';

export const MAX_ATTACHMENTS = 5;
export const ATTACH_ACCEPT = '.txt,.md,.csv,.json,.yaml,.yml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/pdf,image/png,image/jpeg,image/gif,image/webp';

export const MODE_LABEL = { normal: 'ui.composer.modeAsk', auto: 'ui.composer.modeAuto', plan: 'ui.composer.modePlan' } as const satisfies Record<PermissionMode, string>;
export const MODE_HINT = { normal: 'mode.normalDesc', auto: 'mode.autoDesc', plan: 'mode.planDesc' } as const satisfies Record<PermissionMode, string>;

export type Placeholder = 'noModel' | 'busy' | 'plan' | 'reply' | 'message' | 'build';
export const PLACEHOLDER = {
  noModel: 'ui.composer.noModel', busy: 'ui.composer.busy', plan: 'ui.composer.plan', reply: 'ui.composer.reply', message: 'ui.composer.message', build: 'ui.product.placeholder',
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
  product?: boolean;
  planless?: boolean;
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
  const placeholder: Placeholder = noModel ? 'noModel' : i.running ? 'busy' : i.mode === 'plan' && (i.hasConversation || !i.planless) ? 'plan' : i.hasConversation ? 'reply' : i.product ? 'build' : 'message';
  const filled = i.text.trim() !== '' || i.attachments > 0;
  const free = !noModel && !i.uploading && !i.sending;
  return { placeholder, disabled: noModel, actions: i.running ? 'busy' : 'send', canSubmit: free && filled, canAttach: free && i.attachments < MAX_ATTACHMENTS };
}

export const firstMode = (product: { has_plan?: boolean } | undefined): PermissionMode => (product?.has_plan === false ? 'plan' : 'normal');

export type SubmitKind = 'send' | 'queue' | 'force';

export function enterAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }, running: boolean): SubmitKind | null {
  if (e.key !== 'Enter' || e.shiftKey || e.composing) return null;
  if (!running) return 'send';
  return e.ctrlKey || e.metaKey ? 'force' : 'queue';
}

export function escStops(e: { key: string; composing: boolean }, running: boolean, menuOpen: boolean): boolean {
  return e.key === 'Escape' && !e.composing && running && !menuOpen;
}

export interface ProceedInput {
  mode: PermissionMode; hasConversation: boolean; running: boolean; sending: boolean; approvals: number;
  last: { role: string; text: string } | undefined;
}

export function showProceed(i: ProceedInput): boolean {
  return i.mode === 'plan' && i.hasConversation && !i.running && !i.sending && i.approvals === 0 && i.last?.role === 'assistant' && i.last.text.trim() !== '';
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

export function bareCommand(text: string): UiSlash | null {
  const match = /^\/([a-z]+)$/u.exec(text.trim().toLowerCase());
  return match ? UI_SLASH.find(c => c.name === match[1]) ?? null : null;
}

export const NEW_DRAFT = 'new';

export interface DraftStore { get: (key: string) => string; set: (key: string, text: string) => void }

export function createDrafts(): DraftStore {
  const kept = new Map<string, string>();
  return {
    get: key => kept.get(key) ?? '',
    set: (key, text) => { if (text) kept.set(key, text); else kept.delete(key); },
  };
}

export const composerDrafts = createDrafts();

export function queueRow(pending: readonly PendingMessage[]): { shown: PendingMessage; more: number } | null {
  const shown = pending.at(-1);
  return shown ? { shown, more: pending.length - 1 } : null;
}

export const replaceTargets = (pending: readonly PendingMessage[]): PendingMessage[] => pending.filter(p => !p.interrupt);

export const cancelClearsInterrupt = (pending: readonly PendingMessage[], pendingId: string): boolean => pending.some(p => p.id === pendingId && p.interrupt);

export interface SubmitInput {
  kind: SubmitKind;
  text: string;
  attachmentIds: string[];
  conversationId: string | null;
  target: string;
  running: boolean;
  pending: readonly PendingMessage[];
}

export interface SubmitDeps {
  rename: (id: string, title: string) => Promise<unknown>;
  cancelPending: (id: string, pendingId: string) => Promise<unknown>;
  send: (target: string, text: string, attachmentIds: string[], interrupt: boolean) => Promise<{ queued?: boolean | undefined; effortReset?: boolean | undefined }>;
  isGone: (error: unknown) => boolean;
  clearNotices: (target: string) => void;
  interrupt: (target: string, on: boolean) => void;
}

export type SubmitOutcome =
  | { kind: 'ignored'; why?: 'rename_unsent' }
  | { kind: 'renamed' }
  | { kind: 'sent'; queued: boolean; replaced: PendingMessage | null; effortReset: boolean }
  | { kind: 'failed'; error: unknown; replaced: PendingMessage | null };

export async function submitMessage(i: SubmitInput, d: SubmitDeps): Promise<SubmitOutcome> {
  if (isRenameWithoutTitle(i.text)) return { kind: 'ignored' };
  const title = renameTitleOf(i.text);
  const force = i.kind === 'force' && i.running;
  let replaced: PendingMessage | null = null;
  try {
    if (title) {
      if (!i.conversationId) return { kind: 'ignored', why: 'rename_unsent' };
      await d.rename(i.conversationId, title);
      return { kind: 'renamed' };
    }
    if (i.kind === 'queue' && i.conversationId) {
      for (const old of replaceTargets(i.pending)) {
        try { await d.cancelPending(i.conversationId, old.id); replaced = old; } catch (error) { if (!d.isGone(error)) throw error; }
      }
    }
    d.clearNotices(i.target);
    if (force) d.interrupt(i.target, true);
    const sent = await d.send(i.target, i.text, i.attachmentIds, force);
    if (force && !sent.queued) d.interrupt(i.target, false);
    return { kind: 'sent', queued: Boolean(sent.queued), replaced, effortReset: Boolean(sent.effortReset) };
  } catch (error) {
    if (force) d.interrupt(i.target, false);
    return { kind: 'failed', error, replaced };
  }
}

export const queuedLine = (p: Pick<PendingMessage, 'text' | 'attachments'>): string => p.text.replace(/\s+/gu, ' ').trim() || p.attachments.map(a => a.name).join(', ');

export const toastLift = (viewportHeight: number, composerTop: number): number => Math.max(0, Math.round(viewportHeight - composerTop));

export const attachRoom = (attached: number, incoming: number): number => Math.max(0, Math.min(incoming, MAX_ATTACHMENTS - attached));

export const attachLeftOut = (attached: number, incoming: number): number => incoming - attachRoom(attached, incoming);
