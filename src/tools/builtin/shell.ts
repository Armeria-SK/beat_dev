import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { AppConfig, Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { redactKeyEcho, redactOpenKey, redactSecrets } from '../../shared/redaction.ts';
import { approvalPaths, approvalPathsMore, type PreviewFile } from '../approvals.ts';
import { selfTouchMarkers } from '../hooks/code-guard.ts';
import { expandPath, isInside, placePath } from '../hooks/scope.ts';
import { checkShellCommand, type StatementFacts } from '../hooks/shell-guard.ts';
import { outboundOf, placesOf, pushesOf, type Outbound } from '../hooks/outbound.ts';
import { gitOutboundEnv, isolatedGit, ownerHooksPathSet } from '../hooks/outbound-env.ts';
import { productRunOf } from '../hooks/product-run.ts';
import { pushProtectOf } from '../hooks/push-protect.ts';
import { installTouchOf, protectedTouchOf } from '../hooks/protected-touch.ts';
import { selfTarget } from '../hooks/self-port.ts';
import { outboundText } from '../../shared/messages/outbound.ts';
import { pendingText } from '../../shared/messages/pending.ts';
import { parseRemotes, type Remote } from '../../projects/remotes.ts';
import type { ShellKind } from '../hooks/shell-lex.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../shell/git-env.ts';
import { findExecutable, resolveShell, runProcess, scrubEnv } from '../shell/runner.ts';
import type { PreCheck, ToolContext, ToolDef } from '../types.ts';

interface ShellInput { command: string; cwd?: string; timeoutSec?: number }

export function shellTranscript(command: string, header: string, body: readonly string[]): string {
  const echo = redactKeyEcho(`$ ${command}`);
  const rest = body.join('\n\n');
  return [echo.text, header, ...(body.length ? [echo.open ? redactOpenKey(rest) : rest] : [])].join('\n\n');
}

function resolveCwd(input: ShellInput, ctx: ToolContext): { cwd: string } | { problem: string } {
  const language = languageOf(ctx.config);
  if (ctx.project && !ctx.project.root) return { problem: guardText(language, 'shell.cwd_outside', { path: ctx.workspace }) };
  if (!input.cwd) return { cwd: ctx.workspace };
  const expanded = expandPath(input.cwd, ctx.workspace, process.env, language);
  if ('unresolved' in expanded) return { problem: guardText(language, 'shell.cwd_unresolved', { detail: expanded.unresolved }) };
  const placement = placePath(expanded.path, ctx.policy);
  if (placement.kind !== 'inside') return { problem: guardText(language, 'shell.cwd_outside', { path: expanded.path }) };
  if (!statSync(expanded.path, { throwIfNoEntry: false })?.isDirectory()) return { problem: guardText(language, 'shell.cwd_missing', { path: expanded.path }) };
  return { cwd: expanded.path };
}

const PREVIEW_CHARS = 8000;
const FINGERPRINT_LIMIT_BYTES = 1_048_576;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

// server.origins の host。Tailscale の URL なども beat に届くので、ループバックと同じに確かめる
function selfHostsOf(config: AppConfig): string[] {
  return config.server.origins.flatMap(origin => {
    try { return [new URL(origin).hostname]; } catch { return origin.trim() ? [origin.trim()] : []; }
  });
}

// 子プロセスの環境。git には、ホーム・システムの設定からコードを動かせる項目を落とした設定だけを読ませる（git-env.ts。実行のたびに新しい置き場所に作る）。
// 洗い出せない git（2.32 より古い）、または作業フォルダの中の git は、その版を調べるために動かさず、洗い出していないものとして扱う
export function droppedGitEnv(config: AppConfig): string[] {
  return config.tools.shell.envAllow.filter(name => /^git_/iu.test(name));
}

function childEnvFor(shell: AppConfig['tools']['shell'], cwd: string, powershell: boolean): { env: Record<string, string>; gitIsolated: boolean; gitExe?: string } {
  const base = Object.fromEntries(Object.entries(scrubEnv(shell.envAllow)).filter(([key]) => !/^git_/iu.test(key)));
  const gitExe = findExecutable('git', base, cwd, { powershell });
  if (gitExe && (isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe))) return { env: base, gitIsolated: false };
  return { env: base, gitIsolated: true, ...(gitExe ? { gitExe } : {}) };
}

interface Peeked { preview: PreviewFile; fingerprint: string; content?: string }

// 確かめの札で見せるファイルを読む。指紋は、承認のあとで中身が変わったかを調べるためのもの
function peek(file: string, language: Language): Peeked {
  const unreadable = (fingerprint: string): Peeked => ({ preview: { path: file, text: guardText(language, 'code.preview_unreadable'), truncated: false }, fingerprint });
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { preview: { path: file, text: guardText(language, 'code.preview_missing'), truncated: false }, fingerprint: `${file}\0missing` };
  if (!stat.isFile() || stat.size > FINGERPRINT_LIMIT_BYTES) return unreadable(`${file}\0${stat.isFile() ? 'big' : 'dir'}\0${stat.size}\0${stat.mtimeMs}`);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return unreadable(`${file}\0unreadable`); }
  const fingerprint = `${file}\0${sha256(bytes)}`;
  if (bytes.subarray(0, 8000).includes(0)) return unreadable(fingerprint);
  const content = bytes.toString('utf8');
  return { preview: { path: file, text: redactSecrets(content.slice(0, PREVIEW_CHARS)), truncated: content.length > PREVIEW_CHARS }, fingerprint, content };
}

function hookFingerprints(dir: string | null | undefined, language: Language): string[] {
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return [`${dir}\0unreadable`]; }
  return names.filter(name => !name.endsWith('.sample')).sort().map(name => peek(join(dir, name), language).fingerprint);
}

const GIT_STAGING = new Set(['add', 'commit']);

function gitStagingOnly(statements: readonly StatementFacts[]): boolean {
  return statements.length > 0 && statements.every(st => {
    const sub = st.words[st.gitGlobal.length + 1];
    return st.program === 'git' && st.words[0]?.text === 'git' && !st.programDynamic && !st.programOdd && !st.inner && !st.piped && !st.redirected
      && !st.env.length && !st.gitGlobal.length && !st.shapes.length && !st.reasonKeys.some(key => key.startsWith('shape.') || key.startsWith('code.'))
      && sub !== undefined && GIT_STAGING.has(sub.text) && !st.words.some(w => w.dynamic);
  });
}

function remotesOf(ctx: ToolContext): Remote[] | undefined {
  if (!ctx.project) return undefined;
  try { return parseRemotes(ctx.services?.projects?.get(ctx.project.id)?.remotes); } catch { return []; }
}

function shellOutbound(command: string, statements: readonly StatementFacts[], ctx: ToolContext, env: Record<string, string>, gitExe: string | undefined, language: Language, created: Set<string>): Outbound | undefined {
  if (!statements.length) return { kind: 'send', reason: outboundText(language, 'send.unknown_command', { cmd: command.trim().slice(0, 80) }), targets: [] };
  const outEnv = gitOutboundEnv({
    productRoot: ctx.project?.root, remotes: remotesOf(ctx), dataDir: ctx.paths.data, env, gitExe: gitExe ?? '', language,
    isCreated: path => {
      let yes = false;
      try { yes = ctx.isCreated?.(path) === true; } catch { yes = false; }
      if (yes) created.add(path);
      return yes;
    },
  });
  try { return outboundOf({ tool: 'shell', statements }, outEnv); } catch (error) {
    return { kind: 'send', reason: outboundText(language, 'send.unknown_command', { cmd: `${command.trim().slice(0, 60)} (${(error as Error).message.slice(0, 60)})` }), targets: [] };
  }
}

export function shellPreCheck(input: ShellInput, ctx: ToolContext): PreCheck {
  const language = languageOf(ctx.config);
  if (!ctx.config.tools.shell.enabled) return { decision: 'deny', reasons: [guardText(language, 'shell.disabled')] };
  const cwd = resolveCwd(input, ctx);
  if ('problem' in cwd) return { decision: 'deny', reasons: [cwd.problem] };
  const shell = ctx.config.tools.shell;
  const spec = resolveShell(shell.shell);
  const powershell = spec.name === 'powershell' || spec.name === 'pwsh';
  const { env: childEnv, gitIsolated, gitExe } = childEnvFor(shell, cwd.cwd, powershell);
  const checked = checkShellCommand(input.command, cwd.cwd, {
    policy: ctx.policy, outsideRoots: ctx.config.tools.outsideRoots, allow: shell.allow, ask: shell.ask, deny: shell.deny, language,
    selfHosts: selfHostsOf(ctx.config), shell: spec.name as ShellKind, windows: process.platform === 'win32', dataDir: ctx.paths.data,
    gitIsolated,
    which: name => findExecutable(name, childEnv, cwd.cwd, { powershell }),
  });
  const touch = checked.decision === 'deny' ? undefined : protectedTouchOf(input.command, checked.statements, ctx.policy, cwd.cwd);
  const verdict = touch && !checked.reasonKeys.includes(touch.key) ? { ...checked, decision: 'ask' as const, reasons: [...checked.reasons, guardText(language, touch.key, { path: touch.path })], reasonKeys: [...checked.reasonKeys, touch.key], askKinds: [...new Set([...checked.askKinds, 'code' as const])] } : checked;
  const self = verdict.decision === 'deny' ? undefined : selfTarget(input.command, ctx.config.server);
  if (self !== undefined) return { decision: 'deny', reasons: [guardText(language, 'guard.self_port', { target: self })], reasonKeys: ['guard.self_port'] };
  const details = verdict.paths.map(p => guardText(language, 'shell.detail', {
    input: p.input, path: p.path ?? guardText(language, 'shell.unresolved_path'),
    place: guardText(language, p.placement.kind === 'inside' ? (p.placement.mode === 'write' ? 'shell.place.write' : 'shell.place.read')
      : p.placement.kind === 'outside' ? 'shell.place.outside' : p.placement.kind === 'deny' ? 'shell.place.deny' : 'shell.place.unknown'),
  }));
  const paths = approvalPaths(verdict.paths);
  const pathsMore = approvalPathsMore(verdict.paths);
  const created = new Set<string>();
  const outbound = verdict.decision === 'deny' ? undefined : shellOutbound(input.command, verdict.statements, ctx, childEnv, gitExe, language, created);
  const places = placesOf(verdict.statements, cwd.cwd);
  const pushes = pushesOf(verdict.statements, verdict.reasonKeys);
  const readPaths = [...new Set(verdict.paths.flatMap(p => (p.path ? [p.path] : [])))];
  const run = ctx.project?.root && verdict.decision === 'ask' ? productRunOf({
    root: ctx.project.root, verdict,
    which: (name, dir) => findExecutable(name, childEnv, dir, { powershell }),
    git: gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project.root }) : () => undefined,
    ownerHooks: () => !gitExe || ownerHooksPathSet(gitExe, ctx.paths.data),
  }) : undefined;
  const pushed = verdict.decision === 'ask' ? pushProtectOf({
    config: ctx.config, statements: verdict.statements, projectRoot: ctx.project?.root ?? undefined, productRoots: [], tainted: ctx.taint.tainted || ctx.conversationTainted?.() === true,
    git: gitExe ? isolatedGit({ dataDir: ctx.paths.data, env: childEnv, gitExe, productRoot: ctx.project?.root ?? undefined }) : () => undefined,
  }) : undefined;
  const runFacts = pushed ? { ownerReason: 'files' in pushed ? pendingText('en', 'owner_protected_push', { files: pushed.files.join('; ') }) : pendingText('en', 'owner_push_unchecked') }
    : run && 'run' in run ? { productRun: run.run } : run && 'secret' in run ? { ownerReason: pendingText('en', 'owner_secret_commit', { path: run.secret }) }
    : run && 'secretMessage' in run ? { ownerReason: pendingText('en', 'owner_secret_message') } : {};
  const effects = { writes: verdict.writes, cwd: cwd.cwd, readPaths, ...(outbound ? { outbound } : {}), ...(places.length ? { places } : {}), ...(pushes.length ? { pushes } : {}), ...(gitStagingOnly(verdict.statements) ? { gitStaging: true as const } : {}), ...(created.size ? { created: [...created].sort() } : {}) };
  const codeTouch = verdict.decision === 'deny' ? undefined : installTouchOf(verdict.statements, ctx.policy, cwd.cwd);
  if (codeTouch && !verdict.onceOnly) return { decision: 'ask', reasons: [guardText(language, 'code.self_touch', { markers: codeTouch }), ...verdict.reasons], reasonKeys: ['code.self_touch', ...verdict.reasonKeys], details, paths, pathsMore, askKinds: [...new Set([...verdict.askKinds, 'code' as const])], ...(verdict.fetched ? { fetched: true } : {}), ...effects };
  if (!verdict.onceOnly || verdict.decision === 'deny') return { decision: verdict.decision, reasons: verdict.reasons, reasonKeys: verdict.reasonKeys, details, paths, pathsMore, ...(verdict.decision === 'ask' ? { askKinds: verdict.askKinds } : {}), ...(verdict.fetched ? { fetched: true } : {}), ...effects, ...runFacts };
  const peeked = verdict.scripts.map(file => peek(file, language));
  const peekTouch = codeTouch ?? installTouchOf([], ctx.policy, cwd.cwd, peeked.flatMap(p => p.content ?? []));
  const markers = [...selfTouchMarkers([input.command, ...peeked.flatMap(p => p.content ?? [])].join('\n'), selfHostsOf(ctx.config)), ...(peekTouch ? [peekTouch] : [])];
  const base = verdict.limits ? [...verdict.reasons, guardText(language, 'code.limits')] : verdict.reasons;
  const reasons = markers.length ? [guardText(language, 'code.self_touch', { markers: markers.join(', ') }), ...base] : base;
  const reasonKeys = [...(markers.length ? ['code.self_touch'] : []), ...verdict.reasonKeys];
  return {
    decision: verdict.decision, reasons, reasonKeys, details, paths, pathsMore, askKinds: verdict.askKinds, ...(verdict.ownHooksDir ? { ownHooksDir: verdict.ownHooksDir } : {}), ...(verdict.fetched ? { fetched: true } : {}), ...effects,
    ...(markers.length && 'productRun' in runFacts ? {} : runFacts),
    preview: peeked.map(p => p.preview), bind: sha256([...peeked.map(p => p.fingerprint), ...hookFingerprints(verdict.ownHooksDir, language)].join('\n')),
  };
}

export const shellRun: ToolDef<ShellInput> = {
  name: 'shell_run',
  description: [
    'Run one shell command (PowerShell on Windows, bash on Linux). cwd must be inside an allowed folder (if omitted, the working folder).',
    'Do not use cd to move outside the allowed folders; set cwd instead. Sending data out, installing packages and operations that touch anything outside the allowed folders need the user\'s approval.',
    'Destructive operations and reading secrets cannot be run.',
    'Walking a large folder such as node_modules or .git with -Recurse or the like is slow (over 20 seconds for 15,000 files), and the result is too long to fit in the context. Exclude such folders, or narrow the scope with -Name, -Filter or -Depth.',
    'On Windows, PowerShell runs in constrained mode, so do not use .NET type syntax ([Math]::, [IO.File]::, [pscustomobject]), New-Object or Add-Type; write it with cmdlets and string methods.',
    'PowerShell cmdlets also resolve * ? [ ] in a quoted path as wildcards. To point at a file whose name contains [ ], use -LiteralPath.',
    'In Windows PowerShell, cmdlets that write, create, copy, move, rename or delete files (Set-Content, Out-File, Copy-Item, Move-Item, New-Item, Remove-Item and so on) and redirection (>) need the user\'s confirmation every time, even when the path is fixed. To write a file, use the file_write / file_edit tools, not the shell. Piping the result of Get-ChildItem -Filter into Select-String or Get-Content also needs confirmation every time (use -Include or Select-String -Path).',
    'Forms of curl or wget that save to a file (curl with -o or -O; wget in any form other than -O -) need the user\'s confirmation every time, even when the destination is fixed. When a curl URL contains { } [ ], add -g (without it, curl expands them, so confirmation is needed).',
  ].join(' '),
  input: Type.Object({
    command: Type.String({ minLength: 1, maxLength: 8000 }),
    cwd: Type.Optional(Type.String({ maxLength: 1024 })),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }, { additionalProperties: false }),
  effect: 'exec',
  allowedIn: ['chat', 'task', 'agent'],
  preCheck: shellPreCheck,
  summarize: (input, language) => ({ title: toolText(language, 'summary.shell'), body: input.command, ...(input.cwd ? { cwd: input.cwd } : {}) }),
  async execute(input, ctx, info) {
    const cwd = resolveCwd(input, ctx);
    if ('problem' in cwd) return { content: cwd.problem, isError: true };
    const language = languageOf(ctx.config);
    const settings = ctx.config.tools.shell;
    const shell = resolveShell(settings.shell);
    const timeoutSec = Math.min(input.timeoutSec ?? settings.timeoutSec, settings.maxTimeoutSec);
    const child = childEnvFor(settings, cwd.cwd, shell.name === 'powershell' || shell.name === 'pwsh');
    const ownerHooks = info?.approvedOnce === true ? info.check?.ownHooksDir : undefined;
    const pushCheck = info?.pushCheck;
    const prePush = pushCheck ? { prePush: { tips: pushCheck.tips, node: process.execPath, ...(ownerHooks ? { ownerHooks } : {}) } } : {};
    const gitRun = child.gitIsolated ? prepareGitRun({ dataDir: ctx.paths.data, env: child.env, ...(ownerHooks ? { ownerHooks } : {}), ...prePush, ...(child.gitExe ? { gitExe: child.gitExe } : {}) }) : undefined;
    if (pushCheck?.required && gitRun?.prePushReady !== true) {
      gitRun?.cleanup();
      return { content: '', isError: true, pushCheckUnavailable: true };
    }
    let result;
    let pushRefused = false;
    try {
      result = await runProcess(shell.file, shell.args(input.command), {
        cwd: cwd.cwd, env: { ...child.env, ...gitRun?.env }, timeoutMs: timeoutSec * 1000, signal: ctx.signal,
        maxBytes: settings.outputCapBytes, fullOutputDir: join(ctx.paths.data, 'tool_outputs'), outputId: `shell-${randomUUID()}`,
        ...(shell.stdin ? { input: shell.stdin(input.command) } : {}),
      });
      pushRefused = gitRun?.refused?.() === true;
    } finally { gitRun?.cleanup(); }
    if (result.spawnError) return { content: toolText(language, 'shell.spawn_failed', { shell: shell.name, detail: result.spawnError }), isError: true };
    const header = toolText(language, 'shell.header', { shell: shell.name, cwd: cwd.cwd, code: result.exitCode ?? '—', seconds: (result.durationMs / 1000).toFixed(1) });
    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.truncated) parts.push(toolText(language, 'shell.truncated', { total: result.totalBytes.toLocaleString('en-US'), cap: settings.outputCapBytes.toLocaleString('en-US'), tail: result.fullOutputPath ? toolText(language, 'shell.truncated_tail', { path: result.fullOutputPath }) : '' }));
    if (result.timedOut) parts.push(toolText(language, 'shell.timeout', { seconds: timeoutSec }));
    if (result.aborted) parts.push(toolText(language, 'shell.aborted'));
    return {
      content: shellTranscript(input.command, header, parts),
      isError: result.timedOut || result.aborted || result.exitCode !== 0,
      ...(result.fullOutputPath ? { fullRef: result.fullOutputPath } : {}),
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(pushRefused ? { pushRefused } : {}),
    };
  },
};
