import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../shared/redaction.ts';
import { inspectRepo } from './hooks/git-repo.ts';
import type { Outbound } from './hooks/outbound.ts';
import { repoInside } from './hooks/product-run.ts';
import { toolPolicy, type HasPolicies } from './tool-policy.ts';
import { isInside, realish, windowsNames } from './hooks/scope.ts';
import type { StatementFacts } from './hooks/shell-guard.ts';
import type { AskKind, PreCheck, ToolContext, ToolDef } from './types.ts';

// J-5: the owner's "don't ask again in this product" rules. Shapes are built only by code from the pre-check (never from the model, the screen or a request body),
// rules are added only from the owner's Pending approve (routes-pending.ts) and removed from Settings (routes-rules.ts). No tool writes this table.

export const RULE_VERSION = 1;
export type RuleKind = 'judge' | 'send' | 'delete' | 'policy';

export interface ShellRuleShape {
  cmd?: string[];
  full?: true;
  send?: { program: string; origin: string };
  delete?: { words: string[]; paths: string[] };
  bind?: string;
  // The parsed words of the statement (quotes joined), for the held-value check: not part of any rule base
  words?: string[];
}

export interface RuleCandidate { kind: RuleKind; tool: string; base: string; keys: string[]; shown: string }
// What the shell pre-check knows beyond the statements: the script files the command runs, and a git runner to check where a repository lives
export interface ShapeEnv { scripts?: readonly string[] | undefined; ownHooksDir?: string | null | undefined; git?: ((dir: string, args: string[]) => string | undefined) | undefined; ownerHooks?: (() => boolean) | undefined; config?: HasPolicies | undefined }
export interface RuleHit { id: number; shown: string }
export interface RuleView { id: number; project_id: string; project_name: string | null; archived: boolean; kind: RuleKind; tool: string; shown: string; created_at: number; push?: true; outside?: true }

const SHOWN_MAX = 300;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PLAIN_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
// A two-word rule ("npm install …") only for (program, subcommand) pairs whose argument words never name a script or a place to run; every other command is remembered whole.
// Installs do run code (the packages' own install scripts, and the product's scripts, pinned by the bind below): the owner approves that kind of call for any plain package name
const TWO_WORD: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(['status', 'pull', 'fetch', 'switch', 'branch', 'log', 'diff', 'show', 'tag']),
  npm: new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'outdated', 'ls', 'list', 'view', 'info', 'why']),
  pnpm: new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'outdated', 'list', 'ls', 'audit', 'why']),
  yarn: new Set(['install', 'add', 'remove', 'upgrade', 'outdated', 'list', 'why', 'audit']),
  pip: new Set(['install', 'uninstall', 'list', 'show', 'freeze']), pip3: new Set(['install', 'uninstall', 'list', 'show', 'freeze']),
  uv: new Set(['add', 'remove', 'sync', 'lock']), poetry: new Set(['add', 'remove', 'install', 'lock', 'update', 'show']),
  cargo: new Set(['add', 'remove', 'fetch', 'update']), go: new Set(['build', 'vet', 'fmt', 'list', 'version']), docker: new Set(['ps', 'images']),
};
// Words a two-word rule may carry after a non-git subcommand: plain package names (no path, no scheme or host, no option value glued on), a scoped npm name, and a few flags that only choose where the
// dependency is recorded or how its version is written. Flags that switch a check or a step off (--ignore-scripts, --offline, --frozen-lockfile, --no-save …) are not here, so a rule learned with one never covers a call without it
const PKG_WORD = /^[A-Za-z0-9][A-Za-z0-9._@~^<>=!-]*$/u;
const SCOPED_PKG = /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._~^<>=!-]+)?$/u;
const SCOPED_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);
// A word that names a place rather than a plain name: a path (as product-run.ts reads it), a host or scheme (:), a home (~) or a forced refspec (+)
const placeLike = (text: string): boolean => /[\\/:+]/u.test(text) || text.startsWith('.') || text.startsWith('~') || text.startsWith('@');
const PKG_FLAGS: ReadonlySet<string> = new Set(['-D', '--save-dev', '-E', '--save-exact', '-S', '--save', '-O', '--save-optional', '-P', '--save-prod', '--legacy-peer-deps', '--dev', '-U', '--upgrade']);
// Two-word pairs that run the product's install scripts: their bind pins only the scripts object of package.json, since the install itself rewrites the rest of the file
const INSTALLS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up']),
  pnpm: new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'up']),
  yarn: new Set(['install', 'add', 'remove', 'upgrade']),
};
const BIND_LIMIT_BYTES = 1024 * 1024;
// git push is the only push shape: plain remote and branch names (no "+", no ":" refspec) and flags that neither force nor widen what is sent. Anything else gets no rule at all
// Flags a two-word git rule may carry; any other flag (--amend, -f, -d, --rebase, --prune, --output …) makes the rule the whole command
const GIT_FLAGS: ReadonlySet<string> = new Set(['-a', '-v', '-q', '-c', '--verbose', '--quiet', '--stat', '--oneline', '--short', '--cached', '--staged']);
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-m', '--message']);
const PUSH_WORD = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const PUSH_FLAGS: ReadonlySet<string> = new Set(['-u', '--set-upstream', '-v', '--verbose', '-q', '--quiet', '-n', '--dry-run']);
const PUSH_SHORT = /^-[uvqn]+$/u;
const DELETE_PROGRAMS: ReadonlySet<string> = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri']);
const Q1_TOOLS: ReadonlySet<string> = new Set(['task_create', 'task_update']);
// Calls the owner must see when no judge runs, kept out of rules altogether
const NEVER_KEYS: ReadonlySet<string> = new Set(['code.self_touch', 'shape.control_opaque', 'list.git_unreadable']);

// curl only: wget and Invoke-WebRequest follow redirects unless told not to, and those calls carry list.redirect, which never gets a rule
const CURL_FLAGS: ReadonlySet<string> = new Set(['-s', '-S', '-f', '-i', '-v', '-G', '--silent', '--show-error', '--fail', '--fail-with-body', '--include', '--verbose', '--get', '--compressed', '-k', '--insecure']);
const CURL_VALUES: ReadonlySet<string> = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-H', '--header', '-X', '--request', '-A', '--user-agent']);

export function ruleBlocked(tool: string, ctx: Pick<ToolContext, 'kind'>): boolean {
  return Q1_TOOLS.has(tool) && ctx.kind !== 'chat';
}

function singleStatement(statements: readonly StatementFacts[], productRoot: string | undefined): StatementFacts | undefined {
  if (statements.length !== 1 || !productRoot) return undefined;
  const st = statements[0]!;
  if (st.inner !== undefined || st.unknownInner || st.piped || st.redirected || st.code.length || st.codeDynamic || st.stdin || st.env.length || st.shapes.length) return undefined;
  if (st.programDynamic || st.programOdd || st.gitGlobal.length || !st.program) return undefined;
  const first = st.words[0]?.text ?? '';
  if (!PLAIN_PROGRAM.test(first) || first.toLowerCase() !== st.program) return undefined;
  if (st.words.some(w => w.dynamic || w.glob)) return undefined;
  if (st.cwd === null || (st.cwds ?? [st.cwd]).some(c => c !== st.cwd)) return undefined;
  let inside = false;
  try { inside = isInside(productRoot, st.cwd) && isInside(realish(productRoot), realish(st.cwd)); } catch { inside = false; }
  return inside ? st : undefined;
}

// The positional words of a two-word git call, or undefined when a flag is outside the list or a word names a place
function gitPositionals(rest: readonly string[]): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w.startsWith('--message=')) continue;
    if (!w.startsWith('-')) { if (placeLike(w)) return undefined; out.push(w); continue; }
    if (GIT_VALUE_FLAGS.has(w) || /^-[avq]*m$/u.test(w)) { i++; continue; }
    if (!GIT_FLAGS.has(w) && !/^-[avq]+$/u.test(w)) return undefined;
  }
  return out;
}

// git fetch / pull resolve their first word as allowlist-git.ts' push does: a name that is not a configured remote is read by git as a folder, and a remote whose url is a folder
// on this PC starts that folder's git. Either way (and with no word while such a remote exists) the rule is the whole command, never "git fetch …"
const FETCHES: ReadonlySet<string> = new Set(['fetch', 'pull']);
function remotePlain(cwd: string | null, remote: string | undefined): boolean {
  if (cwd === null) return false;
  const repo = inspectRepo(cwd);
  if (!repo.found || repo.unreadable) return false;
  if (remote === undefined) return repo.localRemotes.length === 0;
  return repo.remotes.includes(remote) && !repo.localRemotes.includes(remote);
}

function gitPlain(st: StatementFacts, sub: string, rest: readonly string[]): boolean {
  const positionals = gitPositionals(rest);
  if (!positionals) return false;
  return !FETCHES.has(sub) || remotePlain(st.cwd, positionals[0]);
}

function pushShaped(rest: readonly string[]): boolean {
  return rest.every(w => w.startsWith('-') ? PUSH_FLAGS.has(w) || PUSH_SHORT.test(w) : PUSH_WORD.test(w));
}

function commandBase(st: StatementFacts): { cmd: string[]; full?: true } | undefined {
  const words = st.words.map(w => w.text);
  const next = words[1];
  const rest = words.slice(2);
  if (st.program === 'git' && next?.toLowerCase() === 'push') return next === 'push' && pushShaped(rest) ? { cmd: ['git', 'push'] } : undefined;
  const pair = next !== undefined && TWO_WORD[st.program]?.has(next) === true;
  const plain = st.program === 'git' ? pair && gitPlain(st, next, rest) : rest.every(w => w.startsWith('-') ? PKG_FLAGS.has(w) : PKG_WORD.test(w) || (SCOPED_PROGRAMS.has(st.program) && SCOPED_PKG.test(w)));
  return pair && plain ? { cmd: [st.program, next] } : { cmd: [st.program, ...words.slice(1)], full: true };
}

function originOf(text: string): string | undefined {
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, '');
  if (!host) return undefined;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${host}:${port}`;
}

function sendBase(st: StatementFacts): { program: string; origin: string } | undefined {
  if (st.program !== 'curl' || st.urls.length !== 1 || st.urls[0]!.dynamic) return undefined;
  const url = st.urls[0]!.text;
  const positional: string[] = [];
  const words = st.words.map(w => w.text);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (!w.startsWith('-')) { positional.push(w); continue; }
    if (CURL_FLAGS.has(w)) continue;
    if (/^-[A-Za-z]{2,}$/u.test(w) && [...w.slice(1)].every(letter => CURL_FLAGS.has(`-${letter}`))) continue;
    const eq = w.indexOf('=');
    if (w.startsWith('--') && eq > 0 && CURL_VALUES.has(w.slice(0, eq))) continue;
    if (CURL_VALUES.has(w)) {
      if (words[i + 1] === undefined) return undefined;
      i++;
      continue;
    }
    return undefined;
  }
  if (positional.length !== 1 || positional[0] !== url) return undefined;
  const origin = originOf(url);
  return origin ? { program: st.program, origin } : undefined;
}

// A recursive switch: --recursive, a short bundle with r (-r, -rf, -Rv), a prefix of PowerShell's -Recurse, or cmd's /s
function recursive(word: string): boolean {
  const lower = word.toLowerCase();
  return lower === '--recursive' || lower === '/s' || /^-[a-z]{1,4}$/iu.test(word) && /r/iu.test(word) || (lower.length >= 2 && '-recurse'.startsWith(lower));
}

// Only plain files: a folder (or a link, which can later point anywhere) is never remembered, and neither is a recursive delete
function plainFile(path: string): boolean {
  try { return !lstatSync(path).isSymbolicLink() && statSync(path).isFile(); } catch { return false; }
}

function deleteBase(st: StatementFacts): { words: string[]; paths: string[] } | undefined {
  const isGitRm = st.program === 'git' && st.words[1]?.text === 'rm';
  if (!DELETE_PROGRAMS.has(st.program) && !isGitRm) return undefined;
  if (!st.targets.length || st.targets.some(t => !t.path || t.wild || !plainFile(t.path))) return undefined;
  if (st.words.slice(1).some(w => recursive(w.text))) return undefined;
  const paths: string[] = [];
  for (const t of st.targets) {
    try { paths.push(windowsNames(realish(t.path!))); } catch { return undefined; }
  }
  return { words: st.words.map(w => w.text), paths: [...new Set(paths)].sort() };
}

// Built by shell.ts' pre-check (the only place holding the parsed statements). Anything outside "one plain statement inside the product" gets no shape
function inProduct(root: string, path: string): boolean {
  try { return isInside(root, path) && isInside(realish(root), realish(path)); } catch { return false; }
}

// git rules only for a repository that lives inside the product with no hooks path of the owner's: elsewhere beat's own commit checks (secret files, secret messages) do not run, so the judge must stay
function gitInside(st: StatementFacts, root: string, env: ShapeEnv): boolean {
  if (!env.git || !env.ownerHooks || st.cwd === null) return false;
  try { return env.ownerHooks() === false && repoInside(st.cwd, root, env.git); } catch { return false; }
}

export function shellRuleShape(statements: readonly StatementFacts[], productRoot: string | undefined, outbound: Outbound | undefined, env: ShapeEnv = {}): ShellRuleShape | undefined {
  const st = singleStatement(statements, productRoot);
  if (!st || !productRoot) return undefined;
  if ((env.scripts ?? []).some(file => !inProduct(productRoot, file))) return undefined;
  if (st.program === 'git' && !gitInside(st, productRoot, env)) return undefined;
  const keys = outbound?.keys ?? [];
  const command = outbound ? undefined : commandBase(st);
  const send = outbound?.kind === 'send' && keys.length === 1 && keys[0] === 'send.data' ? sendBase(st) : undefined;
  const removal = outbound?.kind === 'delete' && keys.length === 1 && keys[0] === 'delete.files' ? deleteBase(st) : undefined;
  if (!command && !send && !removal) return undefined;
  const bind = command && !command.full ? installBind(command.cmd, env) : undefined;
  return { ...(command ? { cmd: command.cmd, ...(command.full ? { full: true as const } : {}) } : {}), ...(send ? { send } : {}), ...(removal ? { delete: removal } : {}), ...(bind ? { bind } : {}), words: st.words.map(w => w.text) };
}

// The bind of a two-word install rule: the scripts object of each package.json the pre-check previewed (the install rewrites its dependencies), any other file whole.
// No bind of its own when the command's git hooks are also pinned, or a file is too big, odd or unreadable: the pre-check's bind (whole files) then stays
function installBind(cmd: readonly string[], env: ShapeEnv): string | undefined {
  if (!INSTALLS[cmd[0]!]?.has(cmd[1]!) || env.ownHooksDir || !env.scripts?.length) return undefined;
  const parts: string[] = [];
  for (const file of env.scripts) {
    let bytes: Buffer;
    try {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st) { parts.push(`${file}\0missing`); continue; }
      if (!st.isFile() || st.size > BIND_LIMIT_BYTES) return undefined;
      bytes = readFileSync(file);
    } catch { return undefined; }
    if (basename(file).toLowerCase() !== 'package.json') { parts.push(`${file}\0${createHash('sha256').update(bytes).digest('hex')}`); continue; }
    let scripts: unknown;
    try { scripts = (JSON.parse(bytes.toString('utf8')) as { scripts?: unknown }).scripts; } catch { return undefined; }
    parts.push(`${file}\0scripts\0${createHash('sha256').update(stable(scripts ?? null)).digest('hex')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function ruleShapeField(decision: string, statements: readonly StatementFacts[], productRoot: string | undefined, outbound: Outbound | undefined, env: ShapeEnv = {}): { ruleShape?: ShellRuleShape } {
  // Only where a rule can be offered: the call is asked, or shell_run itself is set to Ask (a shape for every allowed command would cost git calls for nothing)
  if (decision === 'deny' || (decision !== 'ask' && !(env.config && toolPolicy(env.config, 'shell_run') === 'ask'))) return {};
  const ruleShape = shellRuleShape(statements, productRoot, outbound, env);
  return ruleShape ? { ruleShape } : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const baseKeyOf = (kind: RuleKind, tool: string, base: string): string => createHash('sha256').update(`${kind}\0${tool}\0${base}`).digest('hex');

export function cleanShown(text: string): string {
  return redactSecrets(text.replace(CONTROL, ' ')).replace(/ {2,}/gu, ' ').trim().slice(0, SHOWN_MAX);
}

export interface CandidateInput {
  tool: Pick<ToolDef, 'name' | 'mcp' | 'submits'>;
  args: unknown;
  ctx: Pick<ToolContext, 'kind' | 'parent' | 'project' | 'scout' | 'fix' | 'research'>;
  parkKind: string;
  check: PreCheck | undefined;
  outbound: Outbound | undefined;
  askKinds: Iterable<AskKind>;
  policyAsk: boolean;
}

// Every path the pre-check names (read or written), through links, must be inside the product the run belongs to. Words the pre-check does not read as paths (a git remote name,
// which git may resolve to a folder) are not covered here: commandBase makes those calls whole-command rules instead
function pathsInside(check: PreCheck | undefined, root: string | undefined): boolean {
  if (!check) return true;
  const list = [...(check.paths ?? []).map(p => p.path), ...(check.writes ?? []), ...(check.readPaths ?? [])];
  if (!list.length) return !check.pathsMore;
  if (!root || check.pathsMore) return false;
  try {
    const real = realish(root);
    return list.every(path => path !== undefined && isInside(root, path) && isInside(real, realish(path)));
  } catch { return false; }
}

function keysOf(input: CandidateInput): string[] {
  const out = new Set<string>([...(input.check?.reasonKeys ?? []), ...(input.outbound?.keys ?? [])]);
  for (const kind of input.askKinds) out.add(kind === 'policy' ? 'policy.tool' : `ask:${kind}`);
  if (input.policyAsk) out.add('policy.tool');
  return [...out].sort();
}

function urlArg(args: unknown): string | undefined {
  return typeof args === 'object' && args !== null && typeof (args as { url?: unknown }).url === 'string' ? (args as { url: string }).url : undefined;
}

// The one shape a call has for its Pending kind, or none. Used both to offer the choice when parking and to look a rule up, so the two can never disagree
export function ruleCandidate(input: CandidateInput): RuleCandidate | undefined {
  const { tool, ctx, check, outbound } = input;
  if (!ctx.project?.id || ctx.kind === 'review' || ctx.scout === true || ctx.fix === true || ctx.research !== undefined || ruleBlocked(tool.name, ctx)) return undefined;
  const keys = keysOf(input);
  if (keys.some(k => NEVER_KEYS.has(k)) || !pathsInside(check, ctx.project.root)) return undefined;
  const shape = tool.name === 'shell_run' ? check?.ruleShape : undefined;
  const make = (kind: RuleKind, base: Record<string, unknown>, shown: string): RuleCandidate => ({ kind, tool: tool.name, base: stable({ v: RULE_VERSION, ...base }), keys, shown: cleanShown(shown) });
  const command = (kind: RuleKind): RuleCandidate | undefined => shape?.cmd
    ? make(kind, { cmd: shape.cmd, full: shape.full === true, ...(check?.bind ? { bind: shape.bind ?? check.bind } : {}) }, shape.full ? `Run exactly: ${shape.cmd.join(' ')}` : `Run: ${shape.cmd.join(' ')} …`)
    : undefined;
  switch (input.parkKind) {
    case 'judge': case 'judge_failed':
      if (tool.name === 'shell_run') return command('judge');
      return tool.mcp ? make('judge', { name: tool.name }, `Use tool ${tool.name}`) : undefined;
    case 'policy':
      if (tool.name === 'shell_run') return command('policy');
      return make('policy', { name: tool.name }, `Use tool ${tool.name}`);
    case 'send': {
      // list.header: a spoof-type header (Host, X-Forwarded-Host …) can move where the call lands, so an origin rule learned with one would cover any header later
      if (outbound?.kind !== 'send' || keys.includes('list.redirect') || keys.includes('list.url_glob') || keys.includes('list.header')) return undefined;
      if (tool.name === 'shell_run') return shape?.send ? make('send', { program: shape.send.program, origin: shape.send.origin }, `${shape.send.program} sends data to ${shape.send.origin}`) : undefined;
      if (tool.name === 'browser_open') {
        const origin = originOf(urlArg(input.args) ?? '');
        return origin ? make('send', { origin }, `Open pages on ${origin} in the browser`) : undefined;
      }
      const only = outbound.keys?.length === 1 && outbound.keys[0] === 'send.tool';
      return tool.mcp && tool.submits !== true && only ? make('send', { name: tool.name }, `Send with tool ${tool.name}`) : undefined;
    }
    case 'delete':
      if (tool.name !== 'shell_run' || outbound?.kind !== 'delete' || !shape?.delete) return undefined;
      return make('delete', { words: shape.delete.words, paths: shape.delete.paths }, `Delete exactly: ${shape.delete.words.join(' ')} (${shape.delete.paths.join(', ')})`);
    default: return undefined;
  }
}

export function matchRule(db: DatabaseSync, projectId: string, candidate: RuleCandidate): RuleHit | undefined {
  const rows = db.prepare('SELECT id, base, keys, shown FROM approval_rules WHERE project_id = ? AND kind = ? AND base_key = ? AND tool = ? ORDER BY id')
    .all(projectId, candidate.kind, baseKeyOf(candidate.kind, candidate.tool, candidate.base), candidate.tool) as Array<{ id: number; base: string; keys: string; shown: string }>;
  for (const row of rows) {
    if (row.base !== candidate.base) continue;
    let allowed: unknown;
    try { allowed = JSON.parse(row.keys); } catch { continue; }
    if (!Array.isArray(allowed)) continue;
    const set = new Set(allowed.filter((k): k is string => typeof k === 'string'));
    if (candidate.keys.every(k => set.has(k))) return { id: Number(row.id), shown: row.shown };
  }
  return undefined;
}

export function storedCandidate(value: unknown): RuleCandidate | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!['judge', 'send', 'delete', 'policy'].includes(v.kind as string) || typeof v.tool !== 'string' || typeof v.base !== 'string' || typeof v.shown !== 'string') return undefined;
  if (!Array.isArray(v.keys) || v.keys.some(k => typeof k !== 'string')) return undefined;
  return { kind: v.kind as RuleKind, tool: v.tool, base: v.base, keys: [...new Set(v.keys as string[])].sort(), shown: cleanShown(v.shown) };
}

// Only called from the owner's approve route, inside its transaction
export function addRule(db: DatabaseSync, input: { projectId: string; candidate: RuleCandidate; fromPending: number; now: number }): number {
  const { candidate } = input;
  const existing = matchRule(db, input.projectId, candidate);
  if (existing) return existing.id;
  const row = db.prepare('INSERT INTO approval_rules (project_id, kind, tool, base, base_key, keys, shown, from_pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id').get(
    input.projectId, candidate.kind, candidate.tool, candidate.base, baseKeyOf(candidate.kind, candidate.tool, candidate.base), JSON.stringify(candidate.keys), candidate.shown, input.fromPending, input.now,
  ) as { id: number };
  return Number(row.id);
}

// A git push rule: it also skips the pre-push look at what is sent (4-2d), so the screen says so where the rule is offered and listed
export function pushRule(candidate: Pick<RuleCandidate, 'tool' | 'base'>): boolean {
  if (candidate.tool !== 'shell_run') return false;
  try {
    const base = JSON.parse(candidate.base) as { cmd?: unknown; full?: unknown };
    return Array.isArray(base.cmd) && base.cmd[0] === 'git' && base.cmd[1] === 'push' && base.full !== true;
  } catch { return false; }
}

// AP-1 (Q1, Q6): rules apply after a run read outside text too, so the screen says so where a send, delete or push rule is offered and listed
export function outsideRule(candidate: Pick<RuleCandidate, 'kind' | 'tool' | 'base'>): boolean {
  return candidate.kind === 'send' || candidate.kind === 'delete' || pushRule(candidate);
}

export function listRules(db: DatabaseSync): RuleView[] {
  const rows = db.prepare(`SELECT r.id, r.project_id, p.name AS project_name, p.archived_at, r.kind, r.tool, r.base, r.shown, r.created_at
    FROM approval_rules r LEFT JOIN projects p ON p.id = r.project_id ORDER BY p.name, r.id`).all() as Array<Omit<RuleView, 'archived' | 'push' | 'outside'> & { archived_at: number | null; base: string }>;
  return rows.map(({ archived_at, base, ...r }) => ({
    ...r, id: Number(r.id), created_at: Number(r.created_at), archived: archived_at !== null && archived_at !== undefined,
    ...(pushRule({ tool: r.tool, base }) ? { push: true as const } : {}), ...(outsideRule({ kind: r.kind, tool: r.tool, base }) ? { outside: true as const } : {}),
  }));
}

export function removeRule(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM approval_rules WHERE id = ?').run(id).changes) === 1;
}
