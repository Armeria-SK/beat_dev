import type { PermissionMode } from '../../../src/shared/permission-mode.ts';
import type { ModelView, PendingMessage, UploadView } from '../api.ts';
import { isRenameWithoutTitle, renameTitleOf, SLASH_COMMANDS } from '../chat-logic.ts';

export const MAX_ATTACHMENTS = 5;
export const ATTACH_ACCEPT = '.txt,.md,.csv,.json,.yaml,.yml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/pdf,image/png,image/jpeg,image/gif,image/webp';

export const MODE_LABEL = { auto: 'ui.composer.modeNormal', plan: 'ui.composer.modePlan' } as const satisfies Record<PermissionMode, string>;
export const MODE_HINT = { auto: 'mode.autoDesc', plan: 'mode.planDesc' } as const satisfies Record<PermissionMode, string>;
// 外の実行役の会話では、モードの意味が違う（beat の道具の絞りではなく、実行役を起こす許可の厳しさ）ので、説明も別にする
export const RUNTIME_MODE_HINT = { auto: 'mode.runtimeAutoDesc', plan: 'mode.runtimePlanDesc' } as const satisfies Record<PermissionMode, string>;
export const modeHint = (mode: PermissionMode, byRuntime: boolean) => (byRuntime ? RUNTIME_MODE_HINT : MODE_HINT)[mode];

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

// 外の実行役のモデルが、最後の確かめで「使えない」と分かっているか（ログアウト・入っていない・切った・使えない注意）。確かめていない・分からないは使えるものとして数える（再起動で確かめが消えても、会話を止めない）
const RUNTIME_DOWN = new Set(['provider.probe.runtime_login', 'provider.probe.runtime_missing', 'provider.probe.runtime_off', 'provider.probe.runtime_blocked', 'provider.probe.no_runtime']);
export const runtimeDown = (m: Pick<ModelView, 'runtime' | 'probe'>): boolean => Boolean(m.runtime) && RUNTIME_DOWN.has(m.probe?.messageCode ?? '');
export const chatModelCount = (models: readonly ModelView[]): number => models.filter(m => m.inChat && !runtimeDown(m)).length;

export function composerView(i: ComposerInput): ComposerView {
  const noModel = i.chatModels === 0;
  const placeholder: Placeholder = noModel ? 'noModel' : i.running ? 'busy' : i.mode === 'plan' && (i.hasConversation || !i.planless) ? 'plan' : i.hasConversation ? 'reply' : i.product ? 'build' : 'message';
  const filled = i.text.trim() !== '' || i.attachments > 0;
  const free = !noModel && !i.uploading && !i.sending;
  return { placeholder, disabled: noModel, actions: i.running ? 'busy' : 'send', canSubmit: free && filled, canAttach: free && i.attachments < MAX_ATTACHMENTS };
}

export const firstMode = (product: { has_plan?: boolean } | undefined): PermissionMode => (product?.has_plan === false ? 'plan' : 'auto');

export type SubmitKind = 'send' | 'queue' | 'force';

export function enterAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }, running: boolean): SubmitKind | null {
  if (e.key !== 'Enter' || e.shiftKey || e.composing) return null;
  if (!running) return 'send';
  return e.ctrlKey || e.metaKey ? 'force' : 'queue';
}

export function escStops(e: { key: string; composing: boolean }, running: boolean, menuOpen: boolean): boolean {
  return e.key === 'Escape' && !e.composing && running && !menuOpen;
}

const usable = (m: ModelView): boolean => m.probe?.status === 'ok';

export function modelInEffect(models: readonly ModelView[], chatOrder: readonly string[], modelId: string | null, use: RuntimeUse): ModelView | undefined {
  if (modelId) return models.find(m => m.id === modelId);
  const ordered = chatOrder.map(id => models.find(m => m.id === id)).filter((m): m is ModelView => m !== undefined);
  const firstSend = use.bound === null && use.allowed;
  if (firstSend && ordered[0]?.runtime) return ordered[0];
  return (firstSend ? ordered.filter(m => !m.runtime) : ordered).find(usable) ?? ordered[0];
}

export const depthOptions = (model: ModelView | undefined): string[] => [...(model?.efforts ?? [])];

export const modelName = (model: ModelView): string => model.model || model.label || model.id;

export interface ModelOption { id: string | null; name: string | null; hint: string; checked: boolean; disabled: boolean; runtime: string | null }

// 外の実行役の会話の決まり: bound はこの会話が結ばれている実行役（無ければ null）、allowed は実行役のモデルを選べる会話か（まだ発言が無く、製品の会話）。
// 結ばれた会話はその実行役のモデルだけ、結ばれていなければ allowed のときだけ実行役のモデルを出す（提供元のモデルへも、別の実行役へも替えられない）
export interface RuntimeUse { bound: string | null; allowed: boolean }
export const NO_RUNTIME: RuntimeUse = { bound: null, allowed: false };

export function runtimeShown(models: readonly ModelView[], use: RuntimeUse): ModelView[] {
  if (use.bound !== null) return models.filter(m => m.runtime === use.bound);
  return models.filter(m => !m.runtime || use.allowed);
}

export const runtimeInEffect = (use: RuntimeUse, current: ModelView | undefined): boolean => use.bound !== null || (use.allowed && Boolean(current?.runtime));

export function modelOptions(models: readonly ModelView[], modelId: string | null, use: RuntimeUse = NO_RUNTIME): ModelOption[] {
  return [
    { id: null, name: null, hint: '', checked: modelId === null, disabled: false, runtime: null },
    ...runtimeShown(models, use).map(m => ({ id: m.id, name: modelName(m), hint: m.label === modelName(m) ? '' : m.label, checked: m.id === modelId, disabled: !usable(m) && m.id !== modelId, runtime: m.runtime ?? null })),
  ];
}

export const UI_SLASH = [
  { name: 'new', desc: 'ui.slash.new' },
  { name: 'plan', desc: 'ui.slash.plan' },
  { name: 'build', desc: 'ui.slash.build' },
  { name: 'task', desc: 'ui.slash.task' },
  { name: 'tasks', desc: 'ui.slash.tasks' },
  { name: 'propose', desc: 'ui.slash.propose' },
  { name: 'skills', desc: 'ui.slash.skills' },
  { name: 'log', desc: 'ui.slash.log' },
  { name: 'memory', desc: 'ui.slash.memory' },
  { name: 'stop', desc: 'ui.slash.stop' },
  { name: 'rename', desc: 'ui.slash.rename' },
  { name: 'archive', desc: 'ui.slash.archive' },
  { name: 'summary', desc: 'ui.slash.summary' },
] as const satisfies ReadonlyArray<{ name: (typeof SLASH_COMMANDS)[number]['name'] | 'plan' | 'build' | 'propose'; desc: string }>;

export type UiSlash = (typeof UI_SLASH)[number];
export type UiSlashName = UiSlash['name'];

export interface SlashContext { hasConversation: boolean; running: boolean; hasSummary: boolean; archived: boolean; product?: boolean; scout?: boolean }

export function slashAvailable(ctx: SlashContext): UiSlash[] {
  return UI_SLASH.filter(c => {
    switch (c.name) {
      case 'stop': return ctx.running;
      case 'rename': return ctx.hasConversation;
      case 'archive': return ctx.hasConversation && !ctx.archived;
      case 'summary': return ctx.hasConversation && ctx.hasSummary;
      case 'build': return ctx.product === true;
      case 'propose': return ctx.scout === true;
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

export interface DraftClaim { live: () => boolean; release: () => void }

export interface DraftStore {
  get: (key: string) => string;
  set: (key: string, text: string) => void;
  files: (key: string) => UploadView[];
  setFiles: (key: string, files: UploadView[]) => void;
  forget: (key: string) => void;
  claim: (key: string) => DraftClaim;
}

export function createDrafts(): DraftStore {
  const kept = new Map<string, string>();
  const attached = new Map<string, UploadView[]>();
  const claims = new Map<string, Set<{ live: boolean }>>();
  return {
    get: key => kept.get(key) ?? '',
    set: (key, text) => { if (text) kept.set(key, text); else kept.delete(key); },
    files: key => attached.get(key) ?? [],
    setFiles: (key, files) => { if (files.length) attached.set(key, files); else attached.delete(key); },
    forget: key => {
      kept.delete(key);
      attached.delete(key);
      for (const claim of claims.get(key) ?? []) claim.live = false;
      claims.delete(key);
    },
    claim: key => {
      const mine = { live: true };
      const held = claims.get(key) ?? new Set<{ live: boolean }>();
      held.add(mine);
      claims.set(key, held);
      return {
        live: () => mine.live,
        release: () => { const now = claims.get(key); now?.delete(mine); if (now?.size === 0) claims.delete(key); },
      };
    },
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
