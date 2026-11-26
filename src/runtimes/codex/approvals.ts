// Codex が聞いてきた承認の求め（id 付きのサーバーからの求め）を、beat の共通の出来事（RuntimeEvent の approval）にし、持ち主の答えを Codex への返事にする。
// beat はここで何も許さない・動かさない: 求めを出来事にして持ち主へ渡し、答えは「閉じた一覧」だけを返す。
// 返してよい答え: accept / acceptForSession / decline / cancel と、権限の求めへの「求められた分だけ・scope: turn」「何も足さない」だけ。
// 使う人の設定や決まりを書き換える答え（acceptWithExecpolicyAmendment・applyNetworkPolicyAmendment）と scope: session は、型の上でも作れない。
// 答えられない求め（質問・フォーム・動的な道具・トークンの更新など）は、beat が断りで答え、会話に行を残す（Codex を待たせたままにしない）。
import type { ApprovalDecision, RuntimeEvent } from '../types.ts';
import { asRecord, asString, CodexRefused } from './app-server.ts';
import {
  SERVER_REQUEST, type CommandApprovalAnswer, type CommandDecision, type ElicitationDeclineAnswer, type FileChangeApprovalAnswer, type JsonObject,
  type PermissionsApprovalAnswer, type RequestId, type UserInputEmptyAnswer,
} from './protocol.ts';

export type ApprovalKind = 'command' | 'writeStdin' | 'fileChange' | 'permissions';

export interface FileChangeSummary { path: string; kind: 'add' | 'delete' | 'update'; movePath?: string }

// RuntimeEvent の approval の input の形（承認の橋 AR-8a が読む）。tool は commandExecution / fileChange / permissions
export interface CommandApprovalInput {
  kind: 'command' | 'writeStdin';
  itemId: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  // ネットへのつなぎの許しを求めているとき（command は人が読む意味のある文とは限らない）
  network: { host: string; protocol: string } | null;
  // 表示のための推測（Codex 自身が「表示のため」と書いている）。道の検査には使わない
  actions: Array<{ type: string; command: string }>;
}
export interface FileChangeApprovalInput {
  itemId: string;
  reason: string | null;
  grantRoot: string | null;
  // 直前の item/started の変更の一覧。突き合わせられなかったら null（道が分からないので、写せずに持ち主へ）
  changes: FileChangeSummary[] | null;
}
export interface PermissionApprovalInput { itemId: string; cwd: string | null; reason: string | null; permissions: { network: JsonObject | null; fileSystem: JsonObject | null } }

export interface PendingApproval { requestId: string; rpcId: RequestId; kind: ApprovalKind; requested: JsonObject | undefined }

export interface RefusedRequest {
  reply: { result: unknown } | { error: { code: number; message: string } };
  // 会話に残す行（道具の始めと終わりの 1 組。isError）。無ければ記録だけ
  row: { name: string; message: string } | undefined;
}

export type Classified = { approval: Extract<RuntimeEvent, { type: 'approval' }> } | { refused: RefusedRequest };

const MAX_ITEMS = 200;
const MAX_CHANGES = 500;
const MAX_ACTIONS = 20;
export const NOT_SUPPORTED = -32601;
const INVALID_PARAMS = -32602;

export const requestIdFor = (id: RequestId): string => (typeof id === 'number' ? `codex-n${id}` : `codex-s${id}`);

const text = (value: unknown): string | null => asString(value) ?? null;

// 閉じた一覧（ApprovalDecision の全部をここで写す。足りなければ tsc が落ちる）
const COMMAND_DECISION: Record<ApprovalDecision, CommandDecision> = { accept: 'accept', accept_for_reply: 'acceptForSession', decline: 'decline', cancel: 'cancel' };

function knownDecision(decision: unknown): ApprovalDecision {
  if (typeof decision !== 'string' || !Object.hasOwn(COMMAND_DECISION, decision)) throw new CodexRefused('protocol', 'That is not an answer beat can give to Codex');
  return decision as ApprovalDecision;
}

// 求められた分だけ（network.enabled と fileSystem をそのまま写す）。ほかは足さない
function grantedFrom(requested: JsonObject | undefined): PermissionsApprovalAnswer['permissions'] {
  const network = asRecord(requested?.network);
  const fileSystem = asRecord(requested?.fileSystem);
  const enabled = network?.enabled;
  return {
    ...(network && (typeof enabled === 'boolean' || enabled === null) ? { network: { enabled } } : {}),
    ...(fileSystem ? { fileSystem } : {}),
  };
}

export function answerFor(kind: ApprovalKind, decision: ApprovalDecision, requested: JsonObject | undefined): CommandApprovalAnswer | FileChangeApprovalAnswer | PermissionsApprovalAnswer {
  const known = knownDecision(decision);
  if (kind === 'permissions') {
    // 持ち主が許したときだけ、求められた分を、この 1 回の番だけ。断る・止めるときは何も足さない。session は返さない
    return { permissions: known === 'accept' || known === 'accept_for_reply' ? grantedFrom(requested) : {}, scope: 'turn' };
  }
  return { decision: COMMAND_DECISION[known] };
}

function refusal(method: string, reply: RefusedRequest['reply'], row = true): RefusedRequest {
  return { reply, row: row ? { name: method, message: `beat cannot answer this request from Codex (${method}), so it was declined` } : undefined };
}

const SILENT_ERRORS: ReadonlySet<string> = new Set(['account/chatgptAuthTokens/refresh', 'attestation/generate']);

function summarize(changes: unknown): FileChangeSummary[] | undefined {
  if (!Array.isArray(changes)) return undefined;
  const out: FileChangeSummary[] = [];
  for (const change of changes.slice(0, MAX_CHANGES)) {
    const record = asRecord(change);
    const path = asString(record?.path);
    const kind = asRecord(record?.kind);
    const type = asString(kind?.type);
    if (path === undefined || (type !== 'add' && type !== 'delete' && type !== 'update')) return undefined;
    const movePath = asString(kind?.move_path);
    out.push({ path, kind: type, ...(movePath !== undefined ? { movePath } : {}) });
  }
  return changes.length > MAX_CHANGES ? undefined : out;
}

export class ApprovalTable {
  readonly #changes = new Map<string, FileChangeSummary[]>();
  readonly #pending = new Map<string, PendingApproval>();

  // 1 回の返事のあいだ、変更の項目 → 変える道の表を持つ（承認の求めの中には道が無いため）
  rememberChanges(itemId: string, changes: unknown): void {
    const summary = summarize(changes);
    if (summary === undefined) { this.#changes.delete(itemId); return; }
    if (!this.#changes.has(itemId) && this.#changes.size >= MAX_ITEMS) this.#changes.delete(this.#changes.keys().next().value as string);
    this.#changes.set(itemId, summary);
  }

  get size(): number { return this.#pending.size; }
  has(requestId: string): boolean { return this.#pending.has(requestId); }

  classify(id: RequestId, method: string, params: unknown): Classified {
    const p = asRecord(params);
    const itemId = asString(p?.itemId);
    const bad = (): Classified => ({ refused: refusal(method, { error: { code: INVALID_PARAMS, message: 'beat could not read this request' } }) });
    const requestId = requestIdFor(id);
    switch (method) {
      case SERVER_REQUEST.command: {
        // kind が無い版は command だけだった。humanCommand など知らない種類は答えず断る
        const kind = asString(p?.kind) ?? 'command';
        if (!p || itemId === undefined) return bad();
        if (kind !== 'command' && kind !== 'writeStdin') return { refused: refusal(method, { result: { decision: 'decline' } satisfies CommandApprovalAnswer }) };
        const network = asRecord(p.networkApprovalContext);
        const actions = (Array.isArray(p.commandActions) ? p.commandActions : []).slice(0, MAX_ACTIONS).flatMap(action => {
          const record = asRecord(action);
          return record && asString(record.type) !== undefined ? [{ type: asString(record.type) as string, command: asString(record.command) ?? '' }] : [];
        });
        const input: CommandApprovalInput = {
          kind, itemId, command: text(p.command), cwd: text(p.cwd), reason: text(p.reason), actions,
          network: network ? { host: asString(network.host) ?? '', protocol: asString(network.protocol) ?? '' } : null,
        };
        return this.#park(requestId, id, kind, undefined, 'commandExecution', input);
      }
      case SERVER_REQUEST.fileChange: {
        if (!p || itemId === undefined) return bad();
        const input: FileChangeApprovalInput = { itemId, reason: text(p.reason), grantRoot: text(p.grantRoot), changes: this.#changes.get(itemId) ?? null };
        return this.#park(requestId, id, 'fileChange', undefined, 'fileChange', input);
      }
      case SERVER_REQUEST.permissions: {
        const permissions = asRecord(p?.permissions);
        if (!p || itemId === undefined || !permissions) return { refused: refusal(method, { result: { permissions: {}, scope: 'turn' } satisfies PermissionsApprovalAnswer }) };
        const input: PermissionApprovalInput = { itemId, cwd: text(p.cwd), reason: text(p.reason), permissions: { network: asRecord(permissions.network) ?? null, fileSystem: asRecord(permissions.fileSystem) ?? null } };
        return this.#park(requestId, id, 'permissions', permissions, 'permissions', input);
      }
      case SERVER_REQUEST.userInput:
        // 質問は beat では答えない（答えは空。Codex は答えなしで続ける）
        return { refused: refusal('requestUserInput', { result: { answers: {} } satisfies UserInputEmptyAnswer }) };
      case SERVER_REQUEST.elicitation:
        return { refused: refusal('elicitation', { result: { action: 'decline', content: null, _meta: null } satisfies ElicitationDeclineAnswer }) };
      default:
        // 動的な道具（item/tool/call）・トークンの更新・知らない求め: 何も渡さず、決まった形のエラーで返す
        return { refused: refusal(method, { error: { code: NOT_SUPPORTED, message: 'beat does not handle this request' } }, !SILENT_ERRORS.has(method)) };
    }
  }

  #park(requestId: string, rpcId: RequestId, kind: ApprovalKind, requested: JsonObject | undefined, tool: string, input: unknown): Classified {
    this.#pending.set(requestId, { requestId, rpcId, kind, requested });
    return { approval: { type: 'approval', requestId, tool, input } };
  }

  // 持ち主の答えを Codex への返事にして、待ちから外す。知らない・もう答えた求めは断る（2 回めの答えは受け付けない）
  answer(requestId: string, decision: ApprovalDecision): { rpcId: RequestId; result: unknown } {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new CodexRefused('protocol', 'That request is not waiting for an answer (it was answered, or Codex already closed it)');
    const result = answerFor(pending.kind, decision, pending.requested);
    this.#pending.delete(requestId);
    return { rpcId: pending.rpcId, result };
  }

  // 止めるとき・閉じるとき: 待っている求めを、全部 cancel（何も足さない）で閉じる
  cancelAll(): Array<{ rpcId: RequestId; result: unknown }> {
    const out = [...this.#pending.values()].map(pending => ({ rpcId: pending.rpcId, result: answerFor(pending.kind, 'cancel', pending.requested) }));
    this.#pending.clear();
    return out;
  }

  // Codex が自分で片付けた（serverRequest/resolved）。もう答えられない
  resolved(id: RequestId): void {
    this.#pending.delete(requestIdFor(id));
  }
}
