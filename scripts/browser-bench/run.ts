import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultConfig } from '../../src/config/store.ts';
import { APP_ROOT } from '../../src/paths.ts';
import { collect } from './collect.ts';

// ブラウザの確かめの物差しを 1 回流す（plans/beat/steps/browser-rethink/PLAN.md の P0）。
// 使い捨てのデータ <base>/<name>/data と製品 <base>/<name>/product を作り、beat を起動して決まった頼みを 1 つ送り、
// 実行が終わったら数を <base>/<name>/result.json に書いて beat を止める。流す人として承認待ち・質問には答えない。

const USAGE = 'usage: node scripts/browser-bench/run.ts --base <folder> --name <run name> [--port 4787] [--model claude-sonnet-5-5] [--minutes 45]';
const HERE = join(APP_ROOT, 'scripts', 'browser-bench');
const POLL_MS = 5000;
const QUIET_POLLS = 3;

export function benchPrompt(): string {
  const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
  const found = /<!-- prompt -->\r?\n```text\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/prompt -->/u.exec(readme);
  if (!found) throw new Error('README.md has no prompt block');
  return found[1]!.trim();
}

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
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost.invalid', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'app');
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function api(origin: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function portOpen(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: 'string' }, name: { type: 'string' }, port: { type: 'string', default: '4787' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, minutes: { type: 'string', default: '45' } } });
  const port = Number(values.port);
  if (!values.base || !values.name || !/^[a-z0-9-]{1,40}$/u.test(values.name) || !Number.isInteger(port) || port === 4777) throw new Error(USAGE);
  const root = resolve(values.base, values.name);
  if (existsSync(root)) throw new Error(`${root} already exists; every run needs a fresh folder`);
  const dataDir = join(root, 'data');
  const product = join(root, 'product');
  mkdirSync(dataDir, { recursive: true });
  writeConfig(dataDir, port, values.model);
  makeProduct(product);
  const prompt = benchPrompt();

  const log = openSync(join(root, 'beat.log'), 'a');
  const beat = spawn(process.execPath, ['src/main.ts', '--data-dir', dataDir], { cwd: APP_ROOT, stdio: ['ignore', log, log] });
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let outcome = 'finished';
  let conversationId = '';
  try {
    for (;;) {
      if (beat.exitCode !== null) throw new Error('beat exited during startup (see beat.log)');
      try { if ((await api(origin, 'GET', '/api/projects')).status === 200) break; } catch { /* まだ起動中 */ }
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
    const deadline = Date.now() + Number(values.minutes) * 60_000;
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
  const result = {
    name: values.name, outcome, minutes: Math.round((Date.now() - started) / 6000) / 10, model: values.model,
    beatStopped: !(await portOpen(port)), appStopped: !(await portOpen(3456)),
    ...(conversationId ? collect(join(dataDir, 'beat.db'), conversationId, join(product, '.bench', 'events.jsonl')) : {}),
  };
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
