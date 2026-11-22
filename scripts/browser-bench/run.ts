import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../../src/config/store.ts';
import { APP_ROOT } from '../../src/paths.ts';
import { collect } from './collect.ts';

// ブラウザの確かめの物差しを 1 回流す（plans/beat/steps/browser-rethink/PLAN.md の P0）。
// 使い捨てのデータ <base>/<name>/data と製品 <base>/<name>/product を作り、beat を起動して決まった頼みを 1 つ送り、
// 実行が終わったら数を <base>/<name>/result.json に書いて beat を止める。流す人として承認待ち・質問には答えない。

const USAGE = 'usage: node scripts/browser-bench/run.ts --base <folder under <workspace>/tmp> --name <run name> [--port 4787] [--model claude-sonnet-5-5] [--minutes 45]';
const HERE = join(APP_ROOT, 'scripts', 'browser-bench');
const APP_PORT = 3456;
const RESERVED_PORTS = new Set([4777, 4797]);
const POLL_MS = 5000;
const QUIET_POLLS = 3;
// 前の回の最後のモデルの呼び出しからこれだけ空ける（Anthropic のキャッシュは 5 分で切れる。毎回キャッシュの冷えた状態から始める）
export const COLD_GAP_MS = 6 * 60_000;
const LAST_CALL_FILE = '.bench-last-call';

export function benchPrompt(): string {
  const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
  const found = /<!-- prompt -->\r?\n```text\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/prompt -->/u.exec(readme);
  if (!found) throw new Error('README.md has no prompt block');
  return found[1]!.trim();
}

// 使い捨てのフォルダを置いてよい所: 作業場所（.claude と tmp を持つ、いちばん近い上のフォルダ）の tmp の下。worktrees の下は除く。見つからなければ製品の tmp の下
export function allowedBaseRoot(): string {
  for (let at = APP_ROOT; ; at = dirname(at)) {
    if (existsSync(join(at, '.claude')) && existsSync(join(at, 'tmp'))) return join(at, 'tmp');
    if (dirname(at) === at) return join(APP_ROOT, 'tmp');
  }
}

const inside = (child: string, parent: string): boolean => { const r = relative(parent, child); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
const existingAncestor = (path: string): string => { let at = path; while (!existsSync(at)) at = dirname(at); return realpathSync(at); };

export function checkBase(base: string): string | undefined {
  const root = allowedBaseRoot();
  const full = resolve(base);
  if (!inside(full, root) || inside(full, join(root, 'worktrees')) || full === join(root, 'worktrees')) return `--base must be under ${root} (not under its worktrees folder)`;
  const real = existingAncestor(full);
  if (real !== realpathSync(root) && !inside(real, realpathSync(root))) return `--base resolves outside ${root} through a link`;
  return undefined;
}

// そのポートで何かが待ち受けているか（TCP でつないでみる。127.0.0.1 と ::1）
export function listening(port: number): Promise<boolean> {
  const probe = (host: string) => new Promise<boolean>(done => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => { socket.destroy(); done(open); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv() });

function writeConfig(dataDir: string, port: number, model: string): void {
  const config = defaultConfig();
  config.server.port = port;
  config.providers = [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 }];
  config.models = [{ id: 'bench', provider: 'anthropic', model, vision: true }];
  config.routing.chat = ['bench'];
  config.routing.background = ['bench'];
  config.tools.browser.enabled = true;
  config.tools.browser.headless = true;
  config.tools.browser.sites = [];
  config.tools.hooks = { preToolUse: [], postToolUse: [] };
  config.tools.policies = {};
  config.worker.curiosityPerDay = 0;
  config.memory.review = false;
  config.scout = { cloudRunsPerHour: 0 };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function makeProduct(dir: string): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(HERE, 'app.mjs'), join(dir, 'app.mjs'));
  writeFileSync(join(dir, '.gitignore'), '.bench/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost.invalid', 'commit', '-q', '-m', 'app']]) {
    const r = git(dir, ...args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function api(origin: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function lastCallEnd(dbPath: string): number | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare('SELECT MAX(started_at + duration_ms) AS t FROM model_calls').get() as { t: number | null }).t ?? undefined; } finally { db.close(); }
}

export interface RunArgs { base: string; name: string; port: number; minutes: number; model: string }

// 引数の確かめ（何も起動せず、ファイルにも触らない。試験はこれを直接呼ぶ）
export function parseRunArgs(args: readonly string[]): RunArgs {
  const { values } = parseArgs({ args: [...args], options: { base: { type: 'string' }, name: { type: 'string' }, port: { type: 'string', default: '4787' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, minutes: { type: 'string', default: '45' } } });
  const port = Number(values.port);
  const minutes = Number(values.minutes);
  if (!values.base || !values.name || !/^[a-z0-9-]{1,40}$/u.test(values.name)) throw new Error(USAGE);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port)) throw new Error(`--port must be 1024-65535 and not ${[...RESERVED_PORTS].join(' / ')}`);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new Error('--minutes must be a number from 1 to 180');
  const baseProblem = checkBase(values.base);
  if (baseProblem) throw new Error(baseProblem);
  return { base: resolve(values.base), name: values.name, port, minutes, model: values.model };
}

export async function busyPort(ports: readonly number[]): Promise<number | undefined> {
  for (const p of ports) if (await listening(p)) return p;
  return undefined;
}

const refuseBusy = async (port: number): Promise<void> => {
  const busy = await busyPort([port, APP_PORT]);
  if (busy !== undefined) throw new Error(`port ${busy} is already in use; stop whatever listens there before a bench run`);
};

async function main(): Promise<number> {
  const values = parseRunArgs(process.argv.slice(2));
  const { port, minutes } = values;
  await refuseBusy(port);
  const base = values.base;
  const root = join(base, values.name);
  if (existsSync(root)) throw new Error(`${root} already exists; every run needs a fresh folder`);

  // キャッシュを冷やす: 前の回の最後の呼び出しから COLD_GAP_MS 空ける
  const lastFile = join(base, LAST_CALL_FILE);
  const last = existsSync(lastFile) ? Number(readFileSync(lastFile, 'utf8')) : NaN;
  const wait = Number.isFinite(last) ? last + COLD_GAP_MS - Date.now() : 0;
  if (wait > 0) { process.stdout.write(`waiting ${Math.ceil(wait / 1000)} s so the cache is cold\n`); await sleep(wait); }
  const sincePrevious = Number.isFinite(last) ? Math.round((Date.now() - last) / 1000) : null;
  // 待っているあいだにほかが起動していないか、作る直前にもう一度確かめる
  await refuseBusy(port);

  const dataDir = join(root, 'data');
  const product = join(root, 'product');
  mkdirSync(dataDir, { recursive: true });
  writeConfig(dataDir, port, values.model);
  makeProduct(product);
  const prompt = benchPrompt();
  const head = git(APP_ROOT, 'rev-parse', 'HEAD').stdout.trim();
  const dirty = git(APP_ROOT, 'status', '--porcelain').stdout.trim() !== '';

  const logPath = join(root, 'beat.log');
  const log = openSync(logPath, 'a');
  const beat = spawn(process.execPath, ['src/main.ts', '--data-dir', dataDir], { cwd: APP_ROOT, stdio: ['ignore', log, log] });
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let outcome = 'finished';
  let conversationId = '';
  try {
    for (;;) {
      if (beat.exitCode !== null) throw new Error('beat exited during startup (see beat.log)');
      // 答えたのがこの beat であること: 自分の起動の記録に「beat started: <origin>/」が出てから口を確かめる
      const ours = readFileSync(logPath, 'utf8').includes(`beat started: ${origin}/`);
      try { if (ours && (await api(origin, 'GET', '/api/projects')).status === 200) break; } catch { /* まだ起動中 */ }
      if (Date.now() - started > 120_000) throw new Error('beat did not start within 2 minutes');
      await sleep(1000);
    }
    const created = await api(origin, 'POST', '/api/projects', { root: product, name: 'bench' });
    if (created.status !== 201) throw new Error(`project: ${created.status} ${JSON.stringify(created.json)}`);
    const projectId = (created.json.project as { id: string }).id;
    conversationId = randomUUID();
    const sent = await api(origin, 'POST', `/api/conversations/${conversationId}/messages`, { text: prompt, projectId, permissionMode: 'auto' });
    if (sent.status !== 202) throw new Error(`send: ${sent.status} ${JSON.stringify(sent.json)}`);
    process.stdout.write(`sent to ${conversationId}\n`);
    const deadline = Date.now() + minutes * 60_000;
    let quiet = 0;
    for (;;) {
      await sleep(POLL_MS);
      const state = await api(origin, 'GET', `/api/conversations/${conversationId}/messages`);
      quiet = state.json.activeRun === null ? quiet + 1 : 0;
      if (quiet >= QUIET_POLLS) break;
      if (Date.now() > deadline) { outcome = 'timeout'; break; }
    }
    const waiting = await api(origin, 'GET', '/api/pending');
    writeFileSync(join(root, 'pending.json'), `${JSON.stringify(waiting.json, null, 2)}\n`);
  } catch (error) {
    outcome = `error: ${(error as Error).message}`;
  } finally {
    beat.kill();
    await sleep(3000);
  }
  const dbPath = join(dataDir, 'beat.db');
  const end = lastCallEnd(dbPath);
  if (end !== undefined) writeFileSync(lastFile, String(end));
  const beatStopped = !(await listening(port));
  const appStopped = !(await listening(APP_PORT));
  const result = {
    name: values.name, outcome, minutes: Math.round((Date.now() - started) / 6000) / 10, model: values.model,
    beatHead: head, beatDirty: dirty, promptSha256: createHash('sha256').update(prompt).digest('hex'),
    secondsSincePreviousRun: sincePrevious, beatStopped, appStopped,
    ...(conversationId ? collect(dbPath, conversationId, join(product, '.bench', 'events.jsonl')) : {}),
  };
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!beatStopped || !appStopped) { process.stderr.write(`still listening after the run: ${[!beatStopped && port, !appStopped && APP_PORT].filter(Boolean).join(', ')}\n`); return 1; }
  return outcome === 'finished' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code), error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
