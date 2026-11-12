// Throwaway preview server for screen checks (plans/beat/steps/p1-ui.md,"試しのサーバー").
// node scripts/preview-server.ts — takes no arguments. Port 4797, data under <product>/tmp/p1-preview only.
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import { App } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { ToolCall } from '../src/engine/types.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { providerError, type ModelRequest, type ProviderAdapter, type StreamEvent } from '../src/providers/types.ts';
import { isSensitiveName } from '../src/shared/redaction.ts';
import { BrowserFailure } from '../src/tools/browser/driver.ts';
import { createWebServer } from '../src/web/server.ts';

const HOST = '127.0.0.1';
const PORT = 4797;
const ROOT = join(APP_ROOT, 'tmp', 'p1-preview');
const DATA = join(ROOT, 'data');
const WORK = join(ROOT, 'work');
const OUTSIDE = join(ROOT, 'outside');
const ENV_FILE = join(ROOT, '.env');
const DIST = join(ROOT, 'dist');
const RESET = [DATA, WORK, OUTSIDE, ENV_FILE, `${ENV_FILE}.bak`];

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

function stop(reason: string): never {
  process.stderr.write(`Preview server refused to start: ${reason}\n`);
  process.exit(1);
}

function checkRoot(): void {
  if (relative(APP_ROOT, ROOT) !== join('tmp', 'p1-preview')) stop(`the preview folder is not <product>${sep}tmp${sep}p1-preview: ${ROOT}`);
  for (const dir of [join(APP_ROOT, 'tmp'), ROOT, DIST]) {
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) stop(`${dir} is a link or a file, not a folder`);
  }
}

function reset(target: string): void {
  const rel = relative(ROOT, target);
  if (!RESET.includes(target) || !rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) stop(`will not delete ${target}: it is not a direct child of ${ROOT}`);
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) stop(`will not delete ${target}: it is a link`);
  rmSync(target, { recursive: true, force: true });
}

function scrubSecrets(): string[] {
  const removed = Object.keys(process.env).filter(name => isSensitiveName(name) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(name));
  for (const name of removed) delete process.env[name];
  return removed;
}

function words(text: string): AsyncGenerator<StreamEvent> {
  return (async function* () {
    for (const part of text.match(/.{1,6}/gsu) ?? []) yield { type: 'text', delta: part };
    yield { type: 'done', stop: 'end_turn' };
  })();
}

function slowWords(signal: AbortSignal): AsyncGenerator<StreamEvent> {
  return (async function* () {
    for (let i = 1; i <= 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (signal.aborted) throw providerError('cancelled', 'cancelled', {}, { retryable: false });
      yield { type: 'text', delta: `step ${i} ` };
    }
    yield { type: 'done', stop: 'end_turn' };
  })();
}

function call(name: string, args: Record<string, unknown>): AsyncGenerator<StreamEvent> {
  const toolCall: ToolCall = { id: `call_${Date.now().toString(36)}`, name, arguments: args };
  return (async function* () {
    yield { type: 'tool_call', call: toolCall };
    yield { type: 'done', stop: 'tool_use' };
  })();
}

const HELP = [
  'This is the preview model. It answers from a fixed script:',
  '',
  '- `/demo write` writes a note inside the preview work folder',
  '- `/demo read` reads it back',
  '- `/demo run` runs `node -e` and prints 42 (it asks for approval first)',
  '- `/demo outside` tries to write outside the allowed folder (it is refused)',
  '- `/demo image` replies with a remote image link (it must not load)',
  '- `/demo edit` and `/demo overwrite` change the note (after `/demo write`)',
  '- `/demo list` and `/demo long-list` write a checklist',
  '- `/demo helper` hands a small job to a helper',
  '- `/demo skill` drafts a skill (registered at once when Ask before registering is off)',
  '- `/demo fail` fails on every model',
  '- `/demo slow` writes for 15 seconds (to try Queue, Force and Stop)',
].join('\n');

function script(request: ModelRequest): AsyncGenerator<StreamEvent> {
  const last = request.messages.at(-1);
  if (last?.role === 'tool') return words(`Done. The tool said:\n\n\`\`\`\n${last.content.slice(0, 400)}\n\`\`\``);
  if (request.tools.some(tool => tool.name === 'task_complete')) return call('task_complete', { summary: 'Finished by the preview model.' });
  const said = [...request.messages].reverse().find(m => m.role === 'user')?.content ?? '';
  if (said.includes('/demo slow')) return slowWords(request.signal);
  if (said.includes('/demo write')) return call('file_write', { path: join(WORK, 'notes.md'), content: '# Notes\n\nWritten by the preview model.\n' });
  if (said.includes('/demo read')) return call('file_read', { path: join(WORK, 'notes.md') });
  if (said.includes('/demo run')) return call('shell_run', { command: 'node -e "console.log(6*7)"', cwd: WORK });
  if (said.includes('/demo outside')) return call('file_write', { path: join(OUTSIDE, 'x.txt'), content: 'This write should have been refused.\n' });
  if (said.includes('/demo image')) return words('Here is a picture:\n\n![A chart](https://example.com/a.png)\n');
  if (said.includes('/demo edit')) return call('file_edit', { path: join(WORK, 'notes.md'), old: 'Written by the preview model.', new: 'Edited by the preview model.\nWith a second line.' });
  if (said.includes('/demo overwrite')) return call('file_write', { path: join(WORK, 'notes.md'), content: '# Notes\n\nOne line now.\n' });
  if (said.includes('/demo long-list')) return call('checklist_write', { items: Array.from({ length: 10 }, (_, i) => ({ text: `Step ${i + 1}`, status: i < 6 ? 'done' : i === 6 ? 'in_progress' : 'pending' })) });
  if (said.includes('/demo list')) return call('checklist_write', { items: [{ text: 'Read the note', status: 'done' }, { text: 'Change one line', status: 'in_progress' }, { text: 'Read it back', status: 'pending' }] });
  if (said.includes('/demo helper')) return call('agent_run', { task: 'Say hello from the helper.', title: 'Say hello', tools: ['file_read'] });
  if (said.includes('/demo skill')) return call('skill_draft', { name: 'preview-skill', description: 'A skill the preview model wrote', body: '1. Read the note.\n2. Say what it says.', reason: 'To try Ask before registering.' });
  if (said.includes('/demo fail')) return (async function* (): AsyncGenerator<StreamEvent> { throw providerError('timeout', 'timeout', {}, { retryable: false }); })();
  return words(HELP);
}

function fakeAdapter(provider: ProviderAdapter['provider']): ProviderAdapter {
  return {
    provider,
    stream: script,
    probe: async (model, required) => ({
      modelId: model.id, server: 'preview', required, declared: model.contextLength, effective: model.contextLength ?? 65536,
      status: model.id === 'preview-small' ? 'too_small' : 'ok', message: model.id === 'preview-small' ? 'Too small on purpose' : 'preview', checkedAt: Date.now(),
    }),
  };
}

function seed(app: App): void {
  const tasks = app.tasks;
  const now = Date.now();
  tasks.create({ title: 'Tidy the release notes', body: 'Proposed by the preview seed.', origin: 'self', propose: true, actor: 'preview' });
  const waiting = tasks.create({ title: 'Pick a name for the export file', body: 'Needs an answer.', origin: 'user', runAt: now + 86_400_000, actor: 'preview' });
  tasks.setWaiting(waiting.id, 'question', 'Should the file be called report.csv or export.csv?');
  tasks.create({ title: 'Check the weekly backup', origin: 'user', runAt: now + 3 * 3_600_000, actor: 'preview' });
  tasks.create({ title: 'Morning summary', origin: 'user', cron: '0 9 * * *', timezone: 'Asia/Tokyo', actor: 'preview' });
  const paused = tasks.create({ title: 'Friday review', origin: 'user', cron: '0 18 * * FRI', timezone: 'Asia/Tokyo', actor: 'preview' });
  tasks.finish(paused.id, 'cancelled', null, 'preview');
  const done = tasks.create({ title: 'Rename the draft folder', origin: 'user', runAt: now + 86_400_000, actor: 'preview' });
  tasks.finish(done.id, 'done', 'Renamed.', 'preview');
  const failed = tasks.create({ title: 'Fetch the price list', origin: 'user', runAt: now + 86_400_000, actor: 'preview' });
  tasks.finish(failed.id, 'failed', 'The page did not answer.', 'preview');
  const cancelled = tasks.create({ title: 'Old idea', origin: 'user', runAt: now + 86_400_000, actor: 'preview' });
  tasks.finish(cancelled.id, 'cancelled', null, 'preview');
  tasks.create({ title: 'Sort the downloads folder', body: 'Old installers pile up there. I can list what is safe to remove.', origin: 'self', propose: true, actor: 'preview' });
  tasks.create({ title: 'Draft the weekly report', body: 'A second proposal, to try Reject with a reason.', origin: 'self', propose: true, actor: 'preview' });
  for (let i = 1; i <= 45; i++) {
    const old = tasks.create({ title: `Archived chore ${i}`, origin: 'user', runAt: now + 86_400_000, actor: 'preview' });
    tasks.finish(old.id, i % 9 === 0 ? 'failed' : 'done', i % 9 === 0 ? 'Did not finish.' : 'Finished.', 'preview');
  }
  app.notifications.notify({ kind: 'task_done', title: 'Task finished', body: 'Rename the draft folder', link: `#/tasks/${done.id}` });
  app.notifications.notify({ kind: 'task_waiting', title: 'Waiting for you', body: 'Pick a name for the export file', link: `#/tasks/${waiting.id}` });
  app.notifications.notify({ kind: 'task_failed', title: 'Task failed', body: 'Fetch the price list', link: `#/tasks/${failed.id}` });
  app.notifications.notify({ kind: 'info', title: 'Preview data loaded', body: 'Everything here is made up.' });
  seedLibrary(app);
}

function seedLibrary(app: App): void {
  const name = app.memory.save({ book: 'user', content: 'Prefers short pull requests, one change per branch.', actor: 'review' });
  app.memory.update(name.memory.id, 'Prefers short pull requests: one change per branch, under about 200 lines.', 'user');
  app.memory.save({ book: 'user', content: 'Works in Asia/Tokyo and reads replies in the morning.', actor: 'user', origin: 'user' });
  const note = app.memory.save({ book: 'notes', content: 'The release notes live in docs/CHANGELOG.md.', actor: 'clive' });
  app.memory.update(note.memory.id, 'The release notes live in docs/CHANGELOG.md; keep the newest entry on top.', 'review');

  const skills = app.skills;
  skills.write({ name: 'dev-server', description: 'Start the dev server and open the page', body: '1. Run `npm run dev`.\n2. Wait for the port.' }, 'owner', 'you');
  skills.write({ name: 'dev-server', description: 'Start the dev server and open the page', body: '1. Run `npm run dev`.\n2. Wait for the port.\n3. Open the page.' }, 'approved', 'beat');
  skills.write({ name: 'dev-server', description: 'Start the dev server, wait for the port, open the page', body: '1. Run `npm run dev`.\n2. Wait for the port to answer.\n3. Open the page in the browser.' }, 'owner', 'you');
  skills.write({ name: 'small-pull-request', description: 'Branch, commit, push, open', body: '- One change per branch.\n- Run the tests first.' }, 'owner', 'you');
  skills.write({ name: 'flaky-test-triage', description: 'Run a failing test five times before calling it flaky', body: '1. Run the test five times.\n2. Note how often it fails.' }, 'approved', 'beat-auto');
  mkdirSync(join(skills.dir, 'found-on-disk'), { recursive: true });
  writeFileSync(join(skills.dir, 'found-on-disk', 'SKILL.md'), '---\nname: found-on-disk\ndescription: "A skill folder that nobody registered"\n---\n\nSteps written outside beat.\n');
  skills.draft({ name: 'release-checklist', description: 'Steps before tagging a release', body: '1. Update the changelog.\n2. Run the tests.\n3. Tag the release.', reason: 'Used the same steps twice this week.' });
  skills.draft({ name: 'small-pull-request', description: 'Branch, commit, push, open', body: '- One change per branch.\n- Keep it under 200 lines.\n- Run the tests first.', reason: 'The owner asked for smaller pull requests.' });

  const conversations = app.conversations;
  for (const [title, count] of [['Shape the upload queue', 6], ['Try a drag-and-drop zone', 3]] as const) {
    const c = conversations.create({ title });
    for (let i = 0; i < count; i++) conversations.append(c.id, i % 2 === 0 ? { role: 'user', content: `Message ${i + 1}` } : { role: 'assistant', content: `Reply ${i + 1}` });
    conversations.archive(c.id);
  }
  const live = conversations.create({ title: 'Plan the export' });
  conversations.append(live.id, { role: 'user', content: 'Plan the export file.' });
  const run = (id: string, finish: Parameters<App['runs']['finish']>[1]) => { app.runs.start(id, 'chat', live.id); app.runs.finish(id, finish); };
  run('preview-run-ok', { ok: true, modelId: 'preview-a', attempts: 1, usage: { inputTokens: 18_200, outputTokens: 640 } });
  run('preview-run-fallback', { ok: true, modelId: 'preview-b', attempts: 2, usage: { inputTokens: 4_100, outputTokens: 120 }, flags: ['fallback'] });
  run('preview-run-failed', { ok: false, modelId: 'preview-a', attempts: 1, errorKind: 'timeout', errorMessage: 'The model did not answer in time.' });
  run('preview-run-stopped', { ok: false, modelId: 'preview-a', attempts: 1, errorKind: 'cancelled', errorMessage: 'Stopped by you.' });
  app.reviews.enqueue('manual', `preview:${live.id}`, { conversationId: live.id });
}

function refuseServerApply(server: ReturnType<typeof createWebServer>['server']): void {
  const handlers = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  if (handlers.length !== 1) stop(`expected one request handler, found ${handlers.length}`);
  const original = handlers[0]!;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && path.replace(/\/+$/u, '') === '/api/server/apply') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden', reason: 'preview_server' }));
      return;
    }
    original(req, res);
  });
}

async function start(): Promise<void> {
  if (process.argv.length > 2) stop('it takes no arguments (the port and the data folder are fixed)');
  checkRoot();
  for (const target of RESET) reset(target);
  for (const dir of [DATA, WORK, OUTSIDE]) mkdirSync(dir, { recursive: true });
  const removed = scrubSecrets();

  const paths = resolvePaths(DATA);
  paths.env = ENV_FILE;
  paths.webDist = DIST;

  const config = defaultConfig();
  config.server = { host: HOST, port: PORT, origins: [], tailscaleLogins: [] };
  config.providers = [...config.providers, { id: 'preview', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'PREVIEW_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [
    { id: 'preview-a', label: 'Preview A', provider: 'preview', model: 'preview-a', contextLength: 65536, minContext: 4096, maxOutputTokens: 2048, vision: false, efforts: ['low', 'medium', 'high'] },
    { id: 'preview-b', label: 'Preview B', provider: 'preview', model: 'preview-b', contextLength: 32768, minContext: 4096, maxOutputTokens: 2048, vision: false },
    { id: 'preview-small', label: 'Preview small', provider: 'preview', model: 'preview-small', contextLength: 4096, minContext: 4096, maxOutputTokens: 2048, vision: false },
  ];
  config.routing = { chat: ['preview-a', 'preview-b'], background: ['preview-a'], retriesPerModel: 0 };
  config.tools.roots = [{ path: WORK, mode: 'write' }];
  config.tools.deny = [...config.tools.deny, join(APP_ROOT, 'data'), join(APP_ROOT, '.env')];
  config.worker.autonomy = false;
  config.tools.agent = { ...config.tools.agent, enabled: true };
  writeFileSync(paths.config, JSON.stringify(config, null, 2));

  const app = new App({
    paths, log, env: {},
    adapterOverride: fakeAdapter,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === 'http://127.0.0.1:1/v1/models') return Response.json({ data: ['preview-a', 'preview-b', 'preview-small', 'preview-new'].map(id => ({ id })) });
      throw new Error('The preview server makes no network requests');
    }) as typeof fetch,
    webNetwork: {
      resolve: async () => { throw new Error('The preview server makes no network requests'); },
      get: async () => { throw new Error('The preview server makes no network requests'); },
    },
    downloadNetwork: {
      resolve: async () => { throw new Error('The preview server makes no network requests'); },
      open: async () => { throw new Error('The preview server makes no network requests'); },
    },
    mcpConnect: async () => { throw new Error('The preview server does not start MCP servers'); },
    browserDriver: { launch: async () => { throw new BrowserFailure('launch_failed', 'browser.launch_failed'); } },
    browserDisplay: false,
  });
  await app.status.probeAll(app.config());
  seed(app);

  const web = createWebServer(app);
  refuseServerApply(web.server);
  await web.listen({ host: HOST, port: PORT });
  void app.mcp.start().catch(() => undefined);
  app.worker.start();
  log(`[INFO] Preview server: http://${HOST}:${PORT}/ (data ${ROOT}; secrets removed from the environment: ${removed.length})`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    web.close();
    void app.mcp.stop().catch(() => undefined).finally(() => { app.close(); process.exit(0); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

await start();
