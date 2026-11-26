// 外の実行役（Claude Code・Codex）が 1 回の返事のあいだに変えたファイルを、実行役の言うことを信じずに、beat が git の状態の前後から自分で割り出す（beat auth-runtime AR-9）。
// 前: 返事を始める前に、git の「書きかけ」の一覧と、その中身の指紋（sha256。守るファイルは大きさと時刻だけ）・HEAD・.git の設定とフックの指紋を取る。
// 後: 返事が終わったあとにもう一度取り、前と比べる。HEAD が動いていたら、2 つのコミットの差も足す（実行役がコミットしたあとのファイルも拾うため）。
// ここは beat の道具（file_changes・tool_calls）の道ではない: 元に戻す・やり直すの対象にせず、file_changes の表には書かず、kv に実行ごとの一覧だけを持つ。製品の .git には何も書かない。
// 道の扱いは Changes の欄（diff.ts）と同じ部品を使い、それより緩めない: 製品のフォルダの外・リンクやジャンクションの先・守っているファイルの中身は読まない。
import { createHash } from 'node:crypto';
import { readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, BuiltinHookConfig, RuntimeKind } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import { withGit } from '../mesh/folders.ts';
import type { AppPaths } from '../paths.ts';
import { parseNameStatus } from '../projects/diff-flags.ts';
import { gitFolder } from '../projects/work-folder.ts';
import { languageOf } from '../shared/language.ts';
import { plainLine } from '../shared/plain-text.ts';
import type { HookPayload } from '../tools/hooks/command-hook.ts';
import { runProtectFiles } from '../tools/hooks/protect-files.ts';
import { isSecretPath, placePath, writeApprovalKind, type ScopePolicy } from '../tools/hooks/scope.ts';
import { buildPolicy } from '../tools/policy.ts';
import { hiddenPath, MAX_FILES, readUpTo, safeRel, walkCurrent } from './diff.ts';
import { GIT_ALERT_PARTS, gitChanges, readGitPrint, submoduleHead, type GitPrint } from './git-print.ts';
import { KEEP_MAX_BYTES } from './record.ts';

// 画面と記録に出す印。protected: 守っているファイル（秘密の名前・beat のデータ・持ち主の守る一覧）。unsafe: 安全に扱えないパス。link: リンク・ジャンクション・別名を通る（たどらない）。
// outside: 製品のフォルダの外へ出る。guarded: beat のファイルの道具が書く前に持ち主に聞く場所（CLAUDE.md・AGENTS.md など）
export type RunMark = 'protected' | 'unsafe' | 'link' | 'outside' | 'guarded';
// 前後の差を出せた（ok）か、出せなかった理由。no_git: 製品が git でない。git_unusable: git を安全に動かせない。too_many: 返事の前に書きかけが多すぎる。too_many_after: 返事のあとに書きかけが多すぎる（実行役が増やした）。
// timeout・failed: 時間切れ・git の失敗。unknown: 実行役がまだ動いているかもしれないので、返事のあとの状態を取っていない
export type RunChangeState = 'ok' | 'no_git' | 'git_unusable' | 'too_many' | 'too_many_after' | 'timeout' | 'failed' | 'unknown';
export type RunOutcome = 'ok' | 'failed' | 'stopped';

export interface RuntimeChangeFile { path: string; status: 'added' | 'modified' | 'deleted'; marks: RunMark[] }

export interface RuntimeRunChanges {
  v: 1;
  runId: string;
  conversationId: string;
  projectId: string;
  runtime: string;
  kind: RuntimeKind | null;
  at: number;
  outcome: RunOutcome;
  state: RunChangeState;
  files: RuntimeChangeFile[];
  more: number;
  // 前も後も書きかけで、中身を比べられなかった（リンク・別名・安全に扱えないパス）ファイルの数。変えたとも変えていないとも言えない
  unchecked: number;
  // この返事のあいだに変わった git の状態（head・branch・refs・stash・config・hooks・worktrees・git）。config・hooks は後でコマンドを動かせる所
  git: string[];
  // 守りに当たる変更（protected・unsafe・link・outside の印、または git の config・hooks・modules・exclude・index・link の変化）があったか。返事の前が取れたのに後が取れなかったとき（unseen）も立てる
  alert: boolean;
  // 返事の前は取れたのに、後が取れなかった（または取らなかった）ので、変えたファイルの一覧が無い。前が取れなかったときは立てない（状態に理由が出る）
  unseen: boolean;
}

export const MAX_DIRTY = 2000;
const READ_BUDGET = 64 * 1024 * 1024;
const WATCH_TIMEOUT_MS = 20_000;
const ALERT_MARKS: ReadonlySet<RunMark> = new Set<RunMark>(['protected', 'unsafe', 'link', 'outside']);

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// ---- 守り（Changes の欄・beat のファイルの道具と同じ部品） ----

export interface Verdict { marks: RunMark[]; readable: boolean }

export interface Guard {
  readonly realRoot: string;
  inspect(rel: string): Verdict;
}

export function makeGuard(config: AppConfig, paths: AppPaths, realRoot: string, runId = '', conversationId = ''): Guard {
  const policy: ScopePolicy = buildPolicy(config, paths, { root: realRoot });
  const language = languageOf(config);
  const hooks = config.tools.hooks.preToolUse.filter((hook): hook is BuiltinHookConfig => 'builtin' in hook);
  const cache = new Map<string, Verdict>();
  // 持ち主の守るファイルの一覧（protect-files）に当たるか。実行役の承認の求めの守り（approval-map）と同じ見方
  const protectedByOwner = (abs: string): boolean => {
    if (!hooks.length) return false;
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse', tool_name: 'file_write', tool_input: {}, cwd: realRoot, run_id: runId, conversation_id: conversationId,
      paths: [{ path: abs, write: true }], project_root: realRoot, product_roots: [realRoot],
    };
    try { return hooks.some(hook => runProtectFiles(hook, payload, language).decision !== undefined); } catch { return true; }
  };
  const inspect = (rel: string): Verdict => {
    const known = cache.get(rel);
    if (known) return known;
    const marks = new Set<RunMark>();
    let readable = true;
    if (!safeRel(rel)) { marks.add('unsafe'); readable = false; }
    else {
      const abs = join(realRoot, ...rel.split('/'));
      if (hiddenPath(realRoot, rel, policy.deny)) { marks.add('protected'); readable = false; }
      let placed: ReturnType<typeof placePath> | undefined;
      try { placed = placePath(abs, policy); } catch { placed = undefined; }
      if (placed === undefined || placed.kind === 'deny') { marks.add('protected'); readable = false; }
      else if (placed.kind === 'outside') { marks.add('outside'); readable = false; }
      if (protectedByOwner(abs)) { marks.add('protected'); readable = false; }
      let kind: ReturnType<typeof writeApprovalKind>;
      try { kind = writeApprovalKind(abs, policy); } catch { kind = undefined; }
      if (kind !== undefined) marks.add('guarded');
    }
    const verdict: Verdict = { marks: [...marks], readable };
    cache.set(rel, verdict);
    return verdict;
  };
  return { realRoot, inspect };
}

// ---- 指紋 ----

// present: そのとき在ったか。id: 中身の指紋（null = 比べられない）。link: リンク・別名を通っていた
export interface Print { present: boolean; id: string | null; link?: true }

export interface ReadBudget { left: number }

const linkId = (at: string): string => { try { return `link:${sha(readlinkSync(at))}`; } catch { return 'link:unreadable'; } };

// 1 つのパスの指紋。中身を読むのは、守りに当たらない・5MB 以下・予算が残っているふつうのファイルだけ。それ以外のファイルは大きさ・更新と変更の時刻・ファイルの番号（時刻を戻して同じ大きさで書き換えても、変更の時刻と番号は戻せない）。リンクは先を読まずリンクの文字だけ
export function fingerprint(realRoot: string, rel: string, readable: boolean, budget: ReadBudget, read: typeof readUpTo = readUpTo): Print {
  const walked = walkCurrent(realRoot, rel);
  if (walked.kind === 'absent') return { present: false, id: '-' };
  if (walked.kind === 'unknown') {
    if (walked.why === 'link') return { present: true, id: linkId(walked.at), link: true };
    if (walked.why === 'alias') return { present: true, id: null, link: true };
    return { present: true, id: null };
  }
  const stat = `stat:${walked.size}:${walked.mtimeMs}:${walked.ctimeMs}:${walked.ino}`;
  if (!readable || walked.size > KEEP_MAX_BYTES || walked.size > budget.left) return { present: true, id: stat };
  const bytes = read(walked.path, walked.size);
  if (!Buffer.isBuffer(bytes)) return { present: true, id: stat };
  budget.left -= bytes.length;
  return { present: true, id: `sha:${sha(bytes)}` };
}

// ---- 取る ----

interface Dirty { code: string; print: Print }
// nested: 中に別の .git があるフォルダ（git は中を見ない）。gitlinks: サブモジュールの指紋（索引のコミットと、中の今の HEAD）。
// flagged: skip-worktree・assume-unchanged の印が付いている追跡中のファイルの指紋（git status は変更を出さないので、書きかけの一覧に無いまま変わりうる）
export interface Snapshot {
  head: string | null;
  dirty: Map<string, Dirty>;
  later: Map<string, Print>;
  headDiff: Map<string, string>;
  nested: ReadonlySet<string>;
  gitlinks: ReadonlyMap<string, string>;
  flagged: ReadonlyMap<string, Print>;
}
type Captured = { ok: true; snapshot: Snapshot } | { ok: false; state: Exclude<RunChangeState, 'ok' | 'unknown' | 'too_many_after'> };

function parseStatus(raw: string): { entries: Map<string, string>; nested: Set<string> } {
  const entries = new Map<string, string>();
  const nested = new Set<string>();
  for (const part of raw.split('\0')) {
    if (part.length < 4 || part[2] !== ' ') continue;
    const code = part.slice(0, 2);
    if (code === '!!') continue;
    const path = part.slice(3);
    if (path.endsWith('/')) nested.add(path);
    else entries.set(path, code);
  }
  return { entries, nested };
}

const GITLINK_CAP = 200;
// git ls-files -s -z の行（<mode> <oid> <stage>\t<path>）のうち、サブモジュール（モード 160000）だけ
function parseGitlinks(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split('\0')) {
    const match = /^160000 ([0-9a-f]+) \d\t(.+)$/su.exec(line);
    if (match && out.size < GITLINK_CAP) out.set(match[2]!, match[1]!);
  }
  return out;
}

const FLAG_CAP = 200;
// git ls-files -v -z の行（<印> <path>）のうち、印が小文字（assume-unchanged）か S（skip-worktree）のもの。多いときは先の FLAG_CAP 個だけ
function parseFlagged(raw: string): string[] {
  const out: string[] = [];
  for (const entry of raw.split('\0')) {
    if (out.length >= FLAG_CAP) break;
    if (/^[a-zS] /u.test(entry)) out.push(entry.slice(2));
  }
  return out;
}

const timed = async <T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); })]); } finally { clearTimeout(timer); }
};
const yieldNow = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
const TICK = 64;

// 無視されているファイル（.gitignore）は git の書きかけの一覧に出ないが、.env のような秘密の名前は多くが無視されている。そこだけは別に探して、守るファイルの変更を見落とさない（'!!' の印で書きかけに足す）。
// ほかの無視されるファイル（ビルドの出力など）は見ない。フォルダごと無視されているものは、中を見ない
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

// git の今の状態を取る。since: 前の HEAD（動いていたら 2 つのコミットの差を足す。null は前に HEAD が無かった＝今あるコミットの全ファイルが足された）。also: 前に書きかけだったパス（今は書きかけでなくても、今の指紋を取る）。
// 指紋を取る繰り返しは、一定の数ごとに手を空け、時間切れ（limitMs）を過ぎたら止める（同じ処理の中で回り続けて、時間切れの印が出ないのを避ける）
export async function captureSnapshot(guard: Guard, dataDir: string, options: { since?: string | null | undefined; also?: Iterable<string>; limitMs?: number } = {}): Promise<Captured> {
  const { realRoot } = guard;
  const deadline = Date.now() + (options.limitMs ?? WATCH_TIMEOUT_MS);
  const listed = await withGit(realRoot, dataDir, async git => {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.toString('utf8').trim() ?? '';
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']);
    if (!status) return 'failed' as const;
    const { entries, nested } = parseStatus(status.toString('utf8'));
    if (entries.size > MAX_DIRTY) return 'too_many' as const;
    const ignored = await git(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory']);
    if (!ignored) return 'failed' as const;
    for (const path of ignored.toString('utf8').split('\0')) if (path && !path.endsWith('/') && isSecretPath(path) && !entries.has(path)) entries.set(path, '!!');
    if (entries.size > MAX_DIRTY) return 'too_many' as const;
    const staged = await git(['ls-files', '-s', '-z']);
    if (!staged) return 'failed' as const;
    const tagged = await git(['ls-files', '-v', '-z']);
    if (!tagged) return 'failed' as const;
    const headDiff = new Map<string, string>();
    if (options.since !== undefined && OID.test(head) && head !== options.since) {
      const diff = options.since === null
        ? await git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', head])
        : await git(['diff', '--name-status', '-z', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', options.since, head, '--']);
      if (!diff) return 'failed' as const;
      if (options.since === null) for (const path of diff.toString('utf8').split('\0')) { if (path) headDiff.set(path, 'A'); }
      else for (const entry of parseNameStatus(diff.toString('utf8'))) if (entry.path) headDiff.set(entry.path, entry.status);
    }
    return { head: OID.test(head) ? head : null, entries, nested, headDiff, gitlinks: parseGitlinks(staged.toString('utf8')), flagged: parseFlagged(tagged.toString('utf8')) };
  });
  if (listed === undefined) return { ok: false, state: gitFolder(realRoot) ? 'git_unusable' : 'no_git' };
  if (listed === 'failed' || listed === 'too_many') return { ok: false, state: listed };
  const budget: ReadBudget = { left: READ_BUDGET };
  const dirty = new Map<string, Dirty>();
  let count = 0;
  const late = async (): Promise<boolean> => {
    if (++count % TICK !== 0) return false;
    await yieldNow();
    return Date.now() >= deadline;
  };
  for (const [path, code] of [...listed.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (await late()) return { ok: false, state: 'timeout' };
    dirty.set(path, { code, print: fingerprint(realRoot, path, guard.inspect(path).readable, budget) });
  }
  const later = new Map<string, Print>();
  for (const path of options.also ?? []) {
    if (await late()) return { ok: false, state: 'timeout' };
    if (!dirty.has(path)) later.set(path, fingerprint(realRoot, path, guard.inspect(path).readable, budget));
  }
  const flagged = new Map<string, Print>();
  for (const path of listed.flagged) {
    if (await late()) return { ok: false, state: 'timeout' };
    if (!dirty.has(path) && !later.has(path)) flagged.set(path, fingerprint(realRoot, path, guard.inspect(path).readable, budget));
  }
  const gitlinks = new Map<string, string>();
  for (const [path, oid] of listed.gitlinks) {
    if (await late()) return { ok: false, state: 'timeout' };
    gitlinks.set(path, `${oid}:${submoduleHead(realRoot, path)}`);
  }
  return { ok: true, snapshot: { head: listed.head, dirty, later, headDiff: listed.headDiff, nested: listed.nested, gitlinks, flagged } };
}

// ---- 比べる ----

export interface Compared { files: RuntimeChangeFile[]; more: number; unchecked: number; alert: boolean }

const statusOf = (before: boolean, after: boolean): RuntimeChangeFile['status'] => (!before && after ? 'added' : before && !after ? 'deleted' : 'modified');
const codeStatus = (code: string): RuntimeChangeFile['status'] => (code === '??' || code === '!!' || code[0] === 'A' || code[1] === 'A' ? 'added' : code.includes('D') ? 'deleted' : 'modified');
const diffStatus = (letter: string): RuntimeChangeFile['status'] => (letter === 'A' || letter === 'C' ? 'added' : letter === 'D' ? 'deleted' : 'modified');

// 守りに当たるか確かめる（guard.inspect）数の上限。これを超える変更は、名前だけで分かる守りに近いもの（秘密の名前・安全でないパス）を先に確かめ、残りは確かめずに unchecked に数える
export const INSPECT_MAX = 1000;
const nameFirst = (path: string): number => (isSecretPath(path) || !safeRel(path) ? 0 : 1);

export function compareSnapshots(guard: Guard, before: Snapshot, after: Snapshot): Compared {
  const paths = new Set<string>([...before.dirty.keys(), ...before.flagged.keys(), ...after.dirty.keys(), ...after.headDiff.keys()]);
  const changed: Array<{ path: string; status: RuntimeChangeFile['status']; link: boolean }> = [];
  let unchecked = 0;
  for (const path of paths) {
    const flagged = before.flagged.get(path);
    const was = before.dirty.get(path) ?? (flagged ? { code: '  ', print: flagged } : undefined);
    const is = after.dirty.get(path);
    if (was) {
      const now = is?.print ?? after.later.get(path) ?? after.flagged.get(path);
      if (!now) continue;
      if (was.print.id === null || now.id === null) {
        if (was.print.present !== now.present) changed.push({ path, status: statusOf(was.print.present, now.present), link: Boolean(was.print.link || now.link) });
        else unchecked += 1;
        continue;
      }
      if (was.print.id === now.id) continue;
      changed.push({ path, status: statusOf(was.print.present, now.present), link: Boolean(was.print.link || now.link) });
    } else if (is) {
      changed.push({ path, status: codeStatus(is.code), link: Boolean(is.print.link) });
    } else {
      changed.push({ path, status: diffStatus(after.headDiff.get(path) ?? 'M'), link: false });
    }
  }
  // 中に別の .git があるフォルダ・サブモジュールは、中を見ない。現れた・消えた・指す先が変わったことだけ、確かめられないものとして数える
  for (const path of new Set([...before.nested, ...after.nested])) if (before.nested.has(path) !== after.nested.has(path)) unchecked += 1;
  for (const path of new Set([...before.gitlinks.keys(), ...after.gitlinks.keys()])) if (before.gitlinks.get(path) !== after.gitlinks.get(path)) unchecked += 1;
  // 切ったときは、切った分に守りの印が付くかどうか分からないので、必ず守りの印（alert）にする（黙って切らない）
  let inspected = changed;
  const cut = changed.length > INSPECT_MAX;
  if (cut) {
    const first = (entry: { path: string; link: boolean }): number => (entry.link ? 0 : nameFirst(entry.path));
    inspected = [...changed].sort((a, b) => first(a) - first(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, INSPECT_MAX);
    unchecked += changed.length - inspected.length;
  }
  const named = inspected.map(entry => {
    const verdict = guard.inspect(entry.path);
    const shown = plainLine(entry.path, 300);
    const marks = new Set<RunMark>(verdict.marks);
    if (entry.link) marks.add('link');
    if (shown !== entry.path) marks.add('unsafe');
    return { path: shown, raw: entry.path, status: entry.status, marks: [...marks] };
  });
  const marked = (m: { marks: RunMark[] }): number => (m.marks.length ? 0 : 1);
  named.sort((a, b) => marked(a) - marked(b) || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
  const files = named.slice(0, MAX_FILES).map(({ path, status, marks }) => ({ path, status, marks }));
  const alert = cut || named.some(entry => entry.marks.some(mark => ALERT_MARKS.has(mark)));
  return { files, more: Math.max(0, named.length - MAX_FILES), unchecked, alert };
}

// ---- 1 回の返事を見張る ----

export interface RunWatch {
  guard: Guard;
  dataDir: string;
  before: Captured;
  // .git の設定・フック・HEAD などの指紋（書きかけの一覧が取れなくても、ファイルで読める分は比べる）
  git: GitPrint | undefined;
}

export interface WatchInput { config: AppConfig; paths: AppPaths; root: string; runId: string; conversationId: string }

const gitPrint = async (root: string, dataDir: string): Promise<GitPrint | undefined> => {
  try {
    const got = await timed(readGitPrint(root, dataDir), WATCH_TIMEOUT_MS);
    return got === 'timeout' ? undefined : got;
  } catch { return undefined; }
};

// 返事を始める前に取る。落ちず、遅くなりすぎない（時間切れ・git の失敗は「前が取れなかった」として覚え、返事は止めない）
export async function beginWatch(input: WatchInput): Promise<RunWatch> {
  let real: string;
  try { real = realpathSync.native(input.root); } catch { real = input.root; }
  const guard = makeGuard(input.config, input.paths, real, input.runId, input.conversationId);
  const dataDir = input.paths.data;
  let before: Captured;
  try {
    const got = await timed(captureSnapshot(guard, dataDir), WATCH_TIMEOUT_MS);
    before = got === 'timeout' ? { ok: false, state: 'timeout' } : got;
  } catch { before = { ok: false, state: 'failed' }; }
  return { guard, dataDir, before, git: await gitPrint(real, dataDir) };
}

export type Ended = Omit<RuntimeRunChanges, 'v' | 'runId' | 'conversationId' | 'projectId' | 'runtime' | 'kind' | 'at' | 'outcome'>;

// 返事が終わって実行役を閉じたあとに取り、前と比べる。落ちない。ファイルの差が出せなくても、.git の設定・フックなどの変化は伝える。
// 前が取れたのに後が取れなかった（too_many_after・timeout・failed・git_unusable）、または実行役がまだ動いているかもしれない（stillRunning）ときは、一覧が無いことを守りの印（alert・unseen）にする
export async function endWatch(watch: RunWatch, options: { stillRunning?: boolean } = {}): Promise<Ended> {
  const after = await gitPrint(watch.guard.realRoot, watch.dataDir);
  const git = watch.git && after ? gitChanges(watch.git, after) : watch.git && !after ? ['git'] : [];
  const gitAlert = git.some(part => GIT_ALERT_PARTS.has(part));
  const nothing = (state: RunChangeState): Ended => ({ state, files: [], more: 0, unchecked: 0, git, alert: gitAlert, unseen: false });
  const unseen = (state: RunChangeState): Ended => ({ state, files: [], more: 0, unchecked: 0, git, alert: true, unseen: true });
  if (!watch.before.ok) return nothing(watch.before.state);
  if (options.stillRunning) return unseen('unknown');
  const before = watch.before.snapshot;
  try {
    const got = await timed(captureSnapshot(watch.guard, watch.dataDir, { since: before.head, also: [...before.dirty.keys(), ...before.flagged.keys()] }), WATCH_TIMEOUT_MS);
    if (got === 'timeout') return unseen('timeout');
    if (!got.ok) return unseen(got.state === 'too_many' ? 'too_many_after' : got.state);
    const compared = compareSnapshots(watch.guard, before, got.snapshot);
    return { state: 'ok', files: compared.files, more: compared.more, unchecked: compared.unchecked, git, alert: compared.alert || gitAlert, unseen: false };
  } catch { return unseen('failed'); }
}

// ---- kv に実行ごとに持つ（移行は足さない。キーの終わりが会話の ID なので、会話を消すと db/erase.ts が一緒に消す） ----

const PREFIX = 'runtime-changes:';
export const RUN_KEEP = 20;
export const RUN_SHOWN = 10;
const keyOf = (runId: string, conversationId: string): string => `${PREFIX}${runId}:${conversationId}`;

const STATES: ReadonlySet<string> = new Set(['ok', 'no_git', 'git_unusable', 'too_many', 'too_many_after', 'timeout', 'failed', 'unknown']);
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'failed', 'stopped']);
const MARKS: ReadonlySet<string> = new Set(['protected', 'unsafe', 'link', 'outside', 'guarded']);
const STATUSES: ReadonlySet<string> = new Set(['added', 'modified', 'deleted']);

// 読み出した値は信じず、形を確かめて、知っている項目だけを返す
function revive(raw: string): RuntimeRunChanges | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 500;
  const count = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  if (r.v !== 1 || !text(r.runId) || !text(r.conversationId) || !text(r.projectId) || !text(r.runtime) || typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  if (typeof r.state !== 'string' || !STATES.has(r.state) || typeof r.outcome !== 'string' || !OUTCOMES.has(r.outcome)) return undefined;
  const files = (Array.isArray(r.files) ? r.files : []).flatMap((entry: unknown): RuntimeChangeFile[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const f = entry as Record<string, unknown>;
    if (typeof f.path !== 'string' || typeof f.status !== 'string' || !STATUSES.has(f.status)) return [];
    const marks = (Array.isArray(f.marks) ? f.marks : []).filter((m): m is RunMark => typeof m === 'string' && MARKS.has(m));
    return [{ path: f.path.slice(0, 300), status: f.status as RuntimeChangeFile['status'], marks }];
  }).slice(0, MAX_FILES);
  return {
    v: 1, runId: r.runId, conversationId: r.conversationId, projectId: r.projectId, runtime: r.runtime, kind: r.kind === 'claude-code' || r.kind === 'codex' ? r.kind : null,
    at: r.at, outcome: r.outcome as RunOutcome, state: r.state as RunChangeState, files, more: count(r.more), unchecked: count(r.unchecked),
    git: (Array.isArray(r.git) ? r.git : []).filter((p): p is string => typeof p === 'string').slice(0, 10).map(p => p.slice(0, 20)), alert: r.alert === true, unseen: r.unseen === true,
  };
}

function projectRows(kv: KV, projectId: string): RuntimeRunChanges[] {
  const rows = kv.db.prepare('SELECT value FROM kv WHERE key >= ? AND key < ?').all(PREFIX, `${PREFIX.slice(0, -1)};`) as Array<{ value: string }>;
  return rows.flatMap(row => { const run = revive(row.value); return run && run.projectId === projectId ? [run] : []; }).sort((a, b) => b.at - a.at);
}

export function saveRunChanges(kv: KV, run: RuntimeRunChanges): void {
  kv.setJson(keyOf(run.runId, run.conversationId), run);
  for (const old of projectRows(kv, run.projectId).slice(RUN_KEEP)) kv.delete(keyOf(old.runId, old.conversationId));
}

export function listRunChanges(kv: KV, projectId: string, conversationId?: string): RuntimeRunChanges[] {
  try {
    return projectRows(kv, projectId).filter(run => conversationId === undefined || run.conversationId === conversationId).slice(0, RUN_SHOWN);
  } catch { return []; }
}
