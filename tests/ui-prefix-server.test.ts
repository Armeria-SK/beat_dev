import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { createWebServer } from '../src/web/server.ts';
import type { Conversation, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import type { ChangesTarget } from '../web/src/ui/kanban.ts';
import { FakeAdapter, readThen, reply, tempDir, testConfig } from './helpers.ts';
import { toolCall } from './helpers/task-app.ts';

// beat 8-6c: the real server task view (8-6b's GET /api/tasks and GET /api/tasks/:id for a real Pre-fix) drawn by the board and the task screen

interface KanbanProps {
  conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>; onOpenChanges?: (target: ChangesTarget) => void;
}
const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);
const { TaskScreen } = await loadTsx<{ TaskScreen: ComponentType<{ id: string; revision: string; worker: null; projects: readonly Project[]; pending: number }> }>('../web/src/ui/screens/Task.tsx', import.meta.url);

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown };
const realMedia = g.matchMedia;

function gitIn(dir: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = realMedia;
});

const settle = async () => { for (let i = 0; i < 5; i++) await update(() => new Promise(resolve => setTimeout(resolve, 10))); };

async function realPrefix(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(dir, 'beat'));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'near', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'near', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0, scout: ['m'] };
  config.worker.enabled = true;
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => {}, workerTimers: false,
    adapterOverride: p => { const made = adapters.get(p.id) ?? new FakeAdapter(p); adapters.set(p.id, made); return made; },
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { app.worker.stop(); app.engine.stopAll(); web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });

  const product = join(dir, 'product');
  mkdirSync(product, { recursive: true });
  gitIn(product, 'init', '-q', '-b', 'main');
  writeFileSync(join(product, 'a.txt'), 'bug\n');
  writeFileSync(join(product, 'check.js'), "const fs = require('fs');\nprocess.exit(fs.readFileSync('a.txt', 'utf8').includes('fixed') ? 0 : 1);\n");
  gitIn(product, 'add', '-A');
  gitIn(product, 'commit', '-q', '-m', 'first');
  const project = app.projects.create({ name: 'P', root: product, rootKey: rootKeyOf(product), checkCommand: 'node check.js' });
  app.projects.update(project.id, { scoutMode: 'fix' });
  const build = app.tasks.create({ title: 'build', origin: 'user', actor: 'user', projectId: project.id, acceptanceItems: ['i1'] });
  app.tasks.finish(build.id, 'done', 'built', 'user');
  const proposal = app.tasks.create({
    title: 'Fix the a.txt bug', body: 'x', origin: 'self', propose: true, projectId: project.id, actor: 'beat',
    proposal: { kind: 'bug', why: 'a.txt says bug. The check fails on it.', area: ['a.txt'], size: 'S', goal: null, evidence: null, ledger: null, fixable: true },
  });
  app.tasks.markUntrusted(proposal.id, 'scout', 'Proposed by a scout run');
  adapters.get('near')!.scripts.push(readThen('file_edit', { path: 'a.txt', old: 'bug', new: 'fixed' }), reply('Changed bug to fixed.'));
  assert.equal(await app.worker.tick(), 'ran');
  const row = app.db.prepare("SELECT id, branch, state FROM worktrees WHERE kind = 'fix'").get() as { id: string; branch: string; state: string } | undefined;
  assert.equal(row?.state, 'branch', 'the fix run left a Pre-fix branch');

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', origin);
    return realFetch(`${origin}${String(input)}`, { ...init, headers });
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const projects = ((await (await globalThis.fetch('/api/projects')).json()) as { projects: Project[] }).projects;
  return { app, project, projects, proposal, row: row! };
}

test('ui/Kanban (8-6c, real server): a real Pre-fix from 8-6b reads "Pre-fix · bug" with its diff and Open diff in Proposed; after Approve it waits in Awaiting check as "Pre-fix · merge it"', { skip: !gitAvailable }, async t => {
  const s = await realPrefix(t);
  const opened: ChangesTarget[] = [];
  const props: KanbanProps = { conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: s.projects, pendingByTask: new Map(), questionsByTask: new Map(), onOpenChanges: target => { opened.push(target); } };
  const { container } = await render(createElement(Kanban, props));
  await settle();
  const cardIn = (column: string) => container.querySelector<HTMLElement>(`[data-col="${column}"] article.bt-card[data-task="${s.proposal.id}"]`);
  const card = cardIn('proposed');
  assert.ok(card, container.textContent ?? '');
  assert.equal(card.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.prefix.bug']);
  assert.equal(card.querySelector('.bt-card__head .bt-pill--ok')?.textContent, en['ui.kanban.prefix.checks']);
  const diff = card.querySelector('[data-prefix-diff]');
  assert.ok(diff, 'the diff is on the card');
  assert.equal(diff.querySelector('.bt-diff__file')?.textContent, '1 file+1 −1');
  assert.deepEqual([...diff.querySelectorAll('.bt-diff__line')].map(line => [line.className, line.textContent]), [
    ['bt-diff__line bt-diff__line--del', '− bug'], ['bt-diff__line bt-diff__line--add', '+ fixed'],
  ]);
  assert.ok([...card.querySelectorAll('.bt-card__meta span')].some(span => span.textContent === s.row.branch), 'the branch name is on the card');
  await click(byText(card, 'button', en['ui.kanban.prefix.openDiff']));
  assert.deepEqual(opened, [{ productId: s.project.id, worktreeId: s.row.id, branch: s.row.branch }], 'Open diff opens the fix row from the server');

  await click(byText(card, 'button', en['ui.kanban.approve']));
  await settle();
  assert.equal(cardIn('proposed'), null);
  const check = cardIn('check');
  assert.ok(check, `the approved pre-fix waits in Awaiting check: ${container.textContent}`);
  assert.equal(check.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.prefix.mergeIt']);
  assert.ok(byText(check, 'button', en['ui.kanban.markMerged']));
  assert.equal(check.querySelector('[data-prefix-diff]'), null);
});

test('ui/Task (8-6c, real server): the task screen of a real Pre-fix names the 8-6b events (Pre-fix, Branch) instead of their raw kinds', { skip: !gitAvailable }, async t => {
  const s = await realPrefix(t);
  const kinds = s.app.tasks.events(s.proposal.id).map(e => e.kind);
  assert.ok(kinds.includes('prefix'), kinds.join(','));
  await globalThis.fetch(`/api/tasks/${s.proposal.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  for (let i = 0; i < 50 && !s.app.tasks.events(s.proposal.id).some(e => e.kind === 'worktree'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(s.app.tasks.events(s.proposal.id).some(e => e.kind === 'worktree'), 'rejecting the pre-fix records the branch event');
  const { container } = await render(createElement(TaskScreen, { id: s.proposal.id, revision: '0', worker: null, projects: s.projects, pending: 0 }));
  await settle();
  const titles = [...container.querySelectorAll('.ui-event .bt-row__title')].map(el => el.firstChild?.textContent ?? '');
  assert.ok(titles.includes(en['tasks.event.prefix']), titles.join(' | '));
  assert.ok(titles.includes(en['tasks.event.worktree']), titles.join(' | '));
  assert.ok(!titles.includes('prefix') && !titles.includes('worktree'), 'no raw event kind on the screen');
  const texts = [...container.querySelectorAll('.ui-event__text')].map(el => el.textContent ?? '');
  assert.ok(texts.some(text => text.startsWith(`Pre-fix rejected, so the branch ${s.row.branch}`)), texts.join(' | '));
  assert.ok(!texts.some(text => text.includes('event.prefix')), 'no raw text key');
});
