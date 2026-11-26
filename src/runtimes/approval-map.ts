// 外の実行役（Claude Code・Codex）が聞いてきた承認の求めを、beat の検査の形に写し、モデルを呼ばない守りだけを当てる（beat auth-runtime AR-8a）。
// 結果は 2 つだけ: 守りに当たったので持ち主に聞かずに断る（理由は閉じた一覧）／それ以外はすべて持ち主に聞く（札の中身つき）。
// ここは何も動かさず・何も書かない。beat の道具の道（pipeline・files・shell）には触れず、同じ部品（placePath・writeApprovalKind・runProtectFiles・checkShellCommand・selfTarget）を直接使う。
import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AppConfig, BuiltinHookConfig, RuntimeKind } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { languageOf } from '../shared/language.ts';
import { guardText, type GuardMessageKey } from '../shared/messages/guard.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { buildPolicy } from '../tools/policy.ts';
import type { HookPayload } from '../tools/hooks/command-hook.ts';
import { runProtectFiles } from '../tools/hooks/protect-files.ts';
import { expandPath, isInside, placePath, realish, writeApprovalKind, type ProtectedKind, type ScopePolicy } from '../tools/hooks/scope.ts';
import { selfTarget } from '../tools/hooks/self-port.ts';
import { checkShellCommand, type ShellVerdict } from '../tools/hooks/shell-guard.ts';
import { isToolConfigPath } from '../tools/hooks/tool-config.ts';
import type { CommandApprovalInput, FileChangeApprovalInput, PermissionApprovalInput } from './codex/approvals.ts';

// 持ち主に聞かずに断る理由（閉じた一覧。画面の文・試験はこの一覧から作る）
export const REFUSALS = ['secret', 'outside_write', 'readonly_root', 'link_write', 'protect_files', 'outside_cwd', 'self_target'] as const;
export type RefusalCode = (typeof REFUSALS)[number];

export interface MapContext {
  kind: RuntimeKind;
  config: AppConfig;
  paths: AppPaths;
  // 製品のフォルダ（実行役の作業フォルダ）
  root: string;
  productRoots: readonly string[];
  runId: string;
  conversationId: string;
}

// 札に出す中身（伏せるのは Pending の側）
export interface Card { title: string; body: string | null; cwd: string | null; extra: string | null }

export type Mapped =
  | { decision: 'refuse'; code: RefusalCode; detail: string }
  // checked: beat が守りを当てた（写せた）か。reply: 「この返事が終わるまで聞かない」を持ち主に出してよい形か（実行役がそれを持っているかは、呼ぶ側が別に確かめる）
  | { decision: 'ask'; card: Card; checks: string[]; checked: boolean; reply: boolean };

export const BODY_MAX = 8000;
export const EXTRA_MAX = 4000;
const TITLE_MAX = 300;

const FILE_KEYS: Record<ProtectedKind, GuardMessageKey> = { persona: 'file.persona', skill: 'file.skill', git: 'file.git', instructions: 'file.instructions' };

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// 札に出す文: 向きを変える文字・見えない文字・制御文字（改行と字下げ以外）を消し、長ければ切る
function visible(value: string, max: number): string {
  const clean = stripHidden(value.replace(/\r\n?/gu, '\n')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ');
  if (clean.length <= max) return clean;
  const lead = clean.slice(0, max);
  const last = lead.charCodeAt(lead.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? lead.slice(0, -1) : lead}\n[${clean.length - max} more characters not shown]`;
}
const oneLine = (value: string, max: number = TITLE_MAX): string => visible(value, max).replace(/\s+/gu, ' ').trim();

function json(value: unknown, max: number): string {
  try { return visible(JSON.stringify(value, null, 2) ?? 'null', max); } catch { return '[the input could not be read]'; }
}

interface Refusal { refuse: { code: RefusalCode; detail: string } }
interface Allowed { reasons: string[]; once: boolean }

class Checker {
  readonly ctx: MapContext;
  readonly policy: ScopePolicy;
  readonly language: ReturnType<typeof languageOf>;
  readonly hooks: BuiltinHookConfig[];

  constructor(ctx: MapContext) {
    this.ctx = ctx;
    this.policy = buildPolicy(ctx.config, ctx.paths, { root: ctx.root }, ctx.productRoots);
    this.language = languageOf(ctx.config);
    this.hooks = ctx.config.tools.hooks.preToolUse.filter((hook): hook is BuiltinHookConfig => 'builtin' in hook);
  }

  shown(abs: string): string {
    const rel = relative(this.ctx.root, abs);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
  }

  // 書く先 1 つへの守り。files.ts の checkFilePath（書く側）と同じ部品を、同じ順に当てる。断る場合は理由の種類つき、断らない場合は札に添える理由
  write(abs: string): Refusal | Allowed {
    const placement = placePath(abs, this.policy);
    if (placement.kind === 'deny') return { refuse: { code: 'secret', detail: placement.reason } };
    if (placement.kind === 'outside') return { refuse: { code: 'outside_write', detail: abs } };
    if (placement.mode === 'read') return { refuse: { code: 'readonly_root', detail: placement.root } };
    // 行き先の分からない（先の無い）リンクも断る（pipeline の existsSync を通すと、先の無いリンクを見落とす）
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true) return { refuse: { code: 'link_write', detail: abs } };
    const protectedHit = this.protectFiles([abs], 'file_write', {});
    if (protectedHit !== undefined) return { refuse: { code: 'protect_files', detail: protectedHit } };
    const reasons: string[] = [];
    const kind = writeApprovalKind(abs, this.policy);
    if (kind) reasons.push(guardText(this.language, FILE_KEYS[kind]));
    if (isToolConfigPath(abs)) reasons.push(guardText(this.language, 'file.tool_config'));
    return { reasons, once: reasons.length > 0 };
  }

  // 持ち主の守るファイルの一覧（protect-files）に当たるか。pipeline では「聞く」だが、実行役の求めでは聞かずに断る（一覧は持ち主が「ここは触らせない」と決めたもの）
  protectFiles(writes: readonly string[], tool: 'file_write' | 'shell_run', toolInput: unknown): string | undefined {
    if (!this.hooks.length || !writes.length) return undefined;
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: this.ctx.root, run_id: this.ctx.runId, conversation_id: this.ctx.conversationId,
      paths: writes.map(path => ({ path, write: true })), project_root: this.ctx.root, product_roots: [...this.ctx.productRoots],
    };
    for (const hook of this.hooks) {
      const result = runProtectFiles(hook, payload, this.language);
      if (result.decision !== undefined) return result.reason;
    }
    return undefined;
  }

  // 実行役の道は beat が展開しない。そのままの形と、beat の展開（~・環境変数）を通した形の両方に守りを当てる
  candidates(input: string): { paths: string[]; unresolved: string | undefined } {
    const literal = resolve(this.ctx.root, input);
    const expanded = expandPath(input, this.ctx.root, process.env, this.language);
    if ('unresolved' in expanded) return { paths: [literal], unresolved: expanded.unresolved };
    return { paths: expanded.path === literal ? [literal] : [literal, expanded.path], unresolved: undefined };
  }
}

const isRefusal = (value: Refusal | Allowed): value is Refusal => 'refuse' in value;
const refuse = (code: RefusalCode, detail: string): Mapped => ({ decision: 'refuse', code, detail });

const dedupe = (lines: readonly string[]): string[] => [...new Set(lines)];

function ask(card: Card, checks: readonly string[], checked: boolean, reply: boolean): Mapped {
  return { decision: 'ask', card, checks: dedupe(checks), checked, reply: checked && reply };
}

function unchecked(title: string, value: unknown, why: string): Mapped {
  return ask({ title: oneLine(title), body: json(value, BODY_MAX), cwd: null, extra: null }, [why], false, false);
}

const UNREADABLE = 'beat could not read this request, so it did not check it itself';
const UNKNOWN_TOOL = 'beat does not check this kind of request itself';

// ---- Claude Code ----

const FILE_WRITE_TOOLS: Readonly<Record<string, { field: string; verb: string }>> = {
  Write: { field: 'file_path', verb: 'Write' },
  Edit: { field: 'file_path', verb: 'Edit' },
  NotebookEdit: { field: 'notebook_path', verb: 'Edit notebook' },
};
const FILE_READ_TOOLS: Readonly<Record<string, { field: string; verb: string }>> = {
  Read: { field: 'file_path', verb: 'Read' },
  Glob: { field: 'path', verb: 'List files in' },
  Grep: { field: 'path', verb: 'Search in' },
};

function claudeWriteCard(tool: string, shown: string, input: Record<string, unknown>, field: string, verb: string): Card {
  const title = oneLine(`${verb} ${shown}`);
  if (tool === 'Write') return { title, body: visible(text(input.content) ?? '', BODY_MAX), cwd: null, extra: null };
  if (tool === 'Edit') {
    const lines = [`--- old\n${text(input.old_string) ?? ''}`, `--- new\n${typeof input.new_string === 'string' ? input.new_string : ''}`];
    const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== field && key !== 'old_string' && key !== 'new_string'));
    return { title, body: visible(lines.join('\n'), BODY_MAX), cwd: null, extra: Object.keys(rest).length ? json(rest, EXTRA_MAX) : null };
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== field));
  return { title, body: json(rest, BODY_MAX), cwd: null, extra: null };
}

function claudeFileWrite(checker: Checker, tool: string, input: Record<string, unknown>): Mapped {
  const { field, verb } = FILE_WRITE_TOOLS[tool]!;
  const given = text(input[field]);
  if (given === undefined) return unchecked(tool, input, UNREADABLE);
  const { paths, unresolved } = checker.candidates(given);
  const checks: string[] = unresolved !== undefined ? [`${unresolved}, so beat could not tell where this lands`] : [];
  let once = false;
  for (const abs of paths) {
    const result = checker.write(abs);
    if (isRefusal(result)) return refuse(result.refuse.code, result.refuse.detail);
    checks.push(...result.reasons);
    once ||= result.once;
  }
  return ask(claudeWriteCard(tool, checker.shown(paths[0]!), input, field, verb), checks, true, !once && unresolved === undefined);
}

function claudeFileRead(checker: Checker, tool: string, input: Record<string, unknown>): Mapped {
  const { field, verb } = FILE_READ_TOOLS[tool]!;
  const given = text(input[field]);
  if (given === undefined && tool === 'Read') return unchecked(tool, input, UNREADABLE);
  const { paths, unresolved } = checker.candidates(given ?? '.');
  const checks: string[] = unresolved !== undefined ? [`${unresolved}, so beat could not tell what this reads`] : [];
  for (const abs of paths) {
    const placement = placePath(abs, checker.policy);
    if (placement.kind === 'deny') return refuse('secret', placement.reason);
    if (placement.kind === 'outside') checks.push(guardText(checker.language, 'guard.touches_outside', { path: abs }));
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== field));
  const card: Card = { title: oneLine(`${verb} ${checker.shown(paths[0]!)}`), body: Object.keys(rest).length ? json(rest, BODY_MAX) : null, cwd: null, extra: null };
  return ask(card, checks, true, unresolved === undefined);
}

function claudeShell(checker: Checker, tool: 'Bash' | 'PowerShell', input: Record<string, unknown>): Mapped {
  const command = text(input.command);
  if (command === undefined) return unchecked(tool, input, UNREADABLE);
  const { ctx } = checker;
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'command'));
  const card: Card = { title: tool === 'Bash' ? 'Run a command (Bash)' : 'Run a command (PowerShell)', body: visible(command, BODY_MAX), cwd: ctx.root, extra: Object.keys(rest).length ? json(rest, EXTRA_MAX) : null };
  let verdict: ShellVerdict;
  try {
    verdict = checkShellCommand(command, ctx.root, {
      policy: checker.policy, outsideRoots: 'ask', deny: ctx.config.tools.shell.deny, language: checker.language,
      selfHosts: selfHostsOf(ctx.config), shell: tool === 'Bash' ? 'bash' : 'powershell', windows: process.platform === 'win32', dataDir: ctx.paths.data,
    });
  } catch {
    return ask(card, [UNREADABLE], false, false);
  }
  const denied = verdict.paths.find(p => p.placement.kind === 'deny');
  if (denied && denied.placement.kind === 'deny') return refuse('secret', denied.placement.reason);
  const denyAt = verdict.reasonKeys.indexOf('scope.deny');
  if (denyAt >= 0) return refuse('secret', verdict.reasons[denyAt] ?? command);
  const checks: string[] = [...verdict.reasons];
  for (const abs of dedupe(verdict.writes)) {
    const result = checker.write(abs);
    if (isRefusal(result)) return refuse(result.refuse.code, result.refuse.detail);
    checks.push(...result.reasons);
  }
  const self = selfTarget(command, ctx.config.server);
  if (self !== undefined) return refuse('self_target', self);
  return ask(card, checks, true, verdict.decision !== 'deny' && !verdict.onceOnly);
}

function claudeCode(checker: Checker, tool: string, raw: unknown): Mapped {
  if (!plain(raw)) return unchecked(tool, raw ?? null, UNREADABLE);
  if (tool === 'Bash' || tool === 'PowerShell') return claudeShell(checker, tool, raw);
  if (Object.hasOwn(FILE_WRITE_TOOLS, tool)) return claudeFileWrite(checker, tool, raw);
  if (Object.hasOwn(FILE_READ_TOOLS, tool)) return claudeFileRead(checker, tool, raw);
  return unchecked(tool, raw, UNKNOWN_TOOL);
}

// server.origins の host。Tailscale の URL なども beat に届くので、ループバックと同じに確かめる（shell.ts と同じ読み方）
function selfHostsOf(config: AppConfig): string[] {
  return config.server.origins.flatMap(origin => {
    try { return [new URL(origin).hostname]; } catch { return origin.trim() ? [origin.trim()] : []; }
  });
}

// ---- Codex ----

const CHANGE_VERB = { add: 'add', delete: 'delete', update: 'update' } as const;

function codexCommand(checker: Checker, input: CommandApprovalInput): Mapped {
  const { ctx } = checker;
  const label = input.kind === 'writeStdin' ? 'Send input to a running command (Codex)' : 'Run a command (Codex)';
  const extraLines = [input.reason ? `Reason given: ${input.reason}` : undefined, ...(input.actions.length ? [`Codex's guess at what it does: ${input.actions.map(a => `${a.type} ${a.command}`.trim()).join('; ')}`] : [])].filter((v): v is string => v !== undefined);
  const card: Card = { title: label, body: input.command === null ? null : visible(input.command, BODY_MAX), cwd: input.cwd, extra: extraLines.length ? visible(extraLines.join('\n'), EXTRA_MAX) : null };
  if (input.network) {
    return ask({ ...card, title: oneLine(`Allow network access to ${input.network.host || 'a host'}${input.network.protocol ? ` (${input.network.protocol})` : ''} (Codex)`) }, [UNKNOWN_TOOL], false, false);
  }
  if (input.kind === 'writeStdin') return ask(card, [UNKNOWN_TOOL], false, false);
  if (input.cwd === null) return ask(card, [UNREADABLE], false, false);
  const cwd = resolve(ctx.root, input.cwd);
  if (!isInside(realish(ctx.root), realish(cwd))) return refuse('outside_cwd', cwd);
  if (input.command !== null) {
    const self = selfTarget(input.command, ctx.config.server);
    if (self !== undefined) return refuse('self_target', self);
  }
  return ask(card, [], true, true);
}

function codexFiles(checker: Checker, input: FileChangeApprovalInput): Mapped {
  const extraLines = [input.reason ? `Reason given: ${input.reason}` : undefined, input.grantRoot ? `Codex also asks to write anywhere under ${input.grantRoot} for the rest of the reply` : undefined].filter((v): v is string => v !== undefined);
  const extra = extraLines.length ? visible(extraLines.join('\n'), EXTRA_MAX) : null;
  if (input.changes === null) return ask({ title: 'Change files (Codex)', body: null, cwd: null, extra }, [UNREADABLE], false, false);
  const checks: string[] = [];
  const lines: string[] = [];
  let once = false;
  const targets = input.changes.flatMap(change => [{ path: change.path, line: `${CHANGE_VERB[change.kind]} ${change.path}${change.movePath ? ` -> ${change.movePath}` : ''}` }, ...(change.movePath ? [{ path: change.movePath, line: '' }] : [])]);
  for (const target of targets) {
    if (target.line) lines.push(target.line);
    for (const abs of checker.candidates(target.path).paths) {
      const result = checker.write(abs);
      if (isRefusal(result)) return refuse(result.refuse.code, result.refuse.detail);
      checks.push(...result.reasons);
      once ||= result.once;
    }
  }
  if (input.grantRoot !== null) {
    const abs = resolve(checker.ctx.root, input.grantRoot);
    const placement = placePath(abs, checker.policy);
    if (placement.kind === 'deny') return refuse('secret', placement.reason);
    if (placement.kind === 'outside') return refuse('outside_write', abs);
    if (placement.mode === 'read') return refuse('readonly_root', placement.root);
  }
  return ask({ title: 'Change files (Codex)', body: visible(lines.join('\n'), BODY_MAX), cwd: null, extra }, checks, true, !once && input.grantRoot === null);
}

function codexPermissions(input: PermissionApprovalInput): Mapped {
  const card: Card = {
    title: 'Widen permissions for this turn (Codex)', body: json(input.permissions, BODY_MAX), cwd: input.cwd,
    extra: input.reason ? visible(`Reason given: ${input.reason}`, EXTRA_MAX) : null,
  };
  return ask(card, [UNKNOWN_TOOL], false, false);
}

function codex(checker: Checker, tool: string, raw: unknown): Mapped {
  if (!plain(raw)) return unchecked(tool, raw ?? null, UNREADABLE);
  if (tool === 'commandExecution') return codexCommand(checker, raw as unknown as CommandApprovalInput);
  if (tool === 'fileChange') return codexFiles(checker, raw as unknown as FileChangeApprovalInput);
  if (tool === 'permissions') return codexPermissions(raw as unknown as PermissionApprovalInput);
  return unchecked(tool, raw, UNKNOWN_TOOL);
}

// 求め 1 つを写して守りを当てる。写せないものは断らず、持ち主に聞く（checked: false）。読み損ねの例外も持ち主に回す
export function mapApproval(ctx: MapContext, event: { tool: string; input: unknown }): Mapped {
  const tool = oneLine(event.tool, 80) || 'tool';
  try {
    const checker = new Checker(ctx);
    return ctx.kind === 'claude-code' ? claudeCode(checker, tool, event.input) : codex(checker, tool, event.input);
  } catch {
    return unchecked(tool, null, UNREADABLE);
  }
}
