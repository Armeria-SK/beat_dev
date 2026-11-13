import type { App } from '../app.ts';
import { CuriosityError, type CuriosityStatus } from '../curiosity/store.ts';
import { curiosityText } from '../curiosity/text.ts';
import { languageOf } from '../shared/language.ts';
import { TRIGGER_TEXT } from '../memory/review.ts';
import { SkillError } from '../tools/skills/store.ts';
import { defaultPolicy, isPolicyable, isToolPolicy, toolPolicy } from '../tools/tool-policy.ts';
import { startOfDayIn } from '../tasks/schedule.ts';
import { taskView, type ProjectFilter } from '../tasks/store.ts';
import type { ReviewJob } from '../memory/review.ts';
import { projectFilterOf } from './routes-projects.ts';
import { domainProblem, problem, readJson, requireObject, requireString, sendJson, type Router } from './http.ts';

const STATUSES: readonly CuriosityStatus[] = ['open', 'researching', 'done', 'dropped'];

function domainFailure(error: unknown): never {
  if (error instanceof SkillError || error instanceof CuriosityError) throw domainProblem(400, 'invalid', error);
  throw error;
}

const TODAY_COUNTED = { engine_runs: 'started_at', tool_calls: 'created_at', memory_jobs: 'created_at' } as const;

export function projectOfSql(table: keyof typeof TODAY_COUNTED, alias: string = table): string {
  const viaConversation = `(SELECT pc.project_id FROM conversations pc WHERE pc.id = ${alias}.conversation_id)`;
  return table === 'memory_jobs' ? `COALESCE(${viaConversation}, (SELECT pt.project_id FROM tasks pt WHERE pt.id = ${alias}.task_id))` : viaConversation;
}

export function projectWhere(table: keyof typeof TODAY_COUNTED, project: ProjectFilter, alias: string = table): { sql: string; args: string[] } {
  if (project === undefined) return { sql: '', args: [] };
  return project === null ? { sql: ` AND ${projectOfSql(table, alias)} IS NULL`, args: [] } : { sql: ` AND ${projectOfSql(table, alias)} = ?`, args: [project] };
}

export function todayCount(app: App, table: keyof typeof TODAY_COUNTED, now = Date.now(), project?: ProjectFilter): number {
  let since: number;
  try { since = startOfDayIn(app.config().timezone, now); } catch { since = startOfDayIn('UTC', now); }
  const filter = projectWhere(table, project);
  return Number((app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${TODAY_COUNTED[table]} >= ?${filter.sql}`).get(since, ...filter.args) as { n: number }).n);
}

function idOf(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw problem(400, 'invalid_id', 'invalid_id');
  return id;
}

export function registerReviewRoutes(router: Router, app: App): void {
  // ── 道具と、道具ごとの方針 ──
  // 外の MCP の道具は、どのサーバーのものか（mcp）と、申告からどう聞くか（asks: sends / removes / write。聞かなければ付けない）を足す
  const mcpAsks = (tool: ReturnType<App['tools']['list']>[number]): 'sends' | 'removes' | 'write' | undefined => {
    const check = tool.preCheck?.({}, undefined as never);
    if (!check || check instanceof Promise || check.decision !== 'ask') return undefined;
    return check.sends ? 'sends' : check.removes ? 'removes' : 'write';
  };
  const toolView = (tool: ReturnType<App['tools']['list']>[number], config = app.config()) => ({
    name: tool.name, effect: tool.effect, allowedIn: tool.allowedIn, policy: toolPolicy(config, tool.name), configurable: isPolicyable(tool.name),
    ...(tool.mcp ? { mcp: { server: tool.mcp.server }, ...(mcpAsks(tool) ? { asks: mcpAsks(tool) } : {}) } : {}),
  });
  router.add('GET', '/api/tools', ({ res }) => {
    const config = app.config();
    sendJson(res, 200, { tools: app.tools.list().map(tool => toolView(tool, config)) });
  });
  // 1 つの道具の方針だけを変える（設定を読み直して policies の 1 つを書き換えて保存）。緩める変更の確かめは画面の側（設定の「広がる変更」と同じ文）で、サーバーは PUT /api/settings と同じ人だけが呼べる
  router.add('PATCH', '/api/tools/:name', async ({ req, res, params }) => {
    const name = params[0]!;
    const tool = app.tools.get(name);
    if (!tool) throw problem(404, 'not_found', 'tool_missing', { params: { name } });
    const body = requireObject(await readJson(req));
    if (!isToolPolicy(body.policy)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'policy', params: { field: 'policy', values: 'allow / ask / block' } });
    if (!isPolicyable(name)) throw problem(400, 'invalid_field', 'tool_not_policyable', { field: 'name', params: { name } });
    if (body.from !== undefined && !isToolPolicy(body.from)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'from', params: { field: 'from', values: 'allow / ask / block' } });
    const current = app.config();
    const now = toolPolicy(current, name);
    if (body.from !== undefined && body.from !== now) throw problem(409, 'conflict', 'tool_policy_changed', { params: { name, policy: now } });
    const policies = { ...current.tools.policies };
    // 既定に戻すときは書いた項目を消す（agent_run の既定も allow。ask は Pending に積めないので block として読む）
    if (body.policy === defaultPolicy(name)) delete policies[name]; else policies[name] = body.policy;
    const saved = await app.applyConfig({ ...current, tools: { ...current.tools, policies } }, { probe: false });
    sendJson(res, 200, { tool: toolView(tool, saved) });
  });

  // ── スキル ──
  router.add('GET', '/api/skills', ({ res }) => sendJson(res, 200, {
    skills: app.skills.list().map(({ body: _body, ...s }) => s),
    dir: app.skills.dir,
  }));
  router.add('GET', '/api/skills/:name', ({ res, params }) => {
    const skill = app.skills.get(params[0]!);
    if (!skill) throw problem(404, 'not_found', 'skill_missing');
    sendJson(res, 200, { skill });
  });
  router.add('PUT', '/api/skills/:name', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const description = requireString(body, 'description', { max: 300 })!;
    const text = requireString(body, 'body', { max: 20_000 })!;
    try { sendJson(res, 200, { skill: app.skills.write({ name: params[0]!, description, body: text }) }); } catch (error) { domainFailure(error); }
  });
  router.add('GET', '/api/skills/:name/history', ({ res, params }) => {
    try { sendJson(res, 200, { versions: app.skills.history(params[0]!) }); } catch (error) { domainFailure(error); }
  });
  router.add('POST', '/api/skills/:name/register', ({ res, params }) => {
    if (!app.skills.get(params[0]!)) throw problem(404, 'not_found', 'skill_missing');
    try { sendJson(res, 200, { skill: app.skills.register(params[0]!) }); } catch (error) { domainFailure(error); }
  });
  router.add('DELETE', '/api/skills/:name', ({ res, params }) => {
    try { app.skills.remove(params[0]!); sendJson(res, 200, { ok: true }); } catch (error) { domainFailure(error); }
  });

  // ── レビュー（承認が要るものをまとめて扱う） ──
  router.add('GET', '/api/review', ({ res }) => {
    const drafts = app.skills.drafts('pending').map(d => {
      const current = app.skills.getRegistered(d.name);
      return { ...d, current: current ? { description: current.description, body: current.body } : null };
    });
    sendJson(res, 200, {
      skillDrafts: drafts,
      taskProposals: app.tasks.list({ statuses: ['inbox'] }).map(t => taskView(t, languageOf(app.config()))),
    });
  });
  router.add('POST', '/api/skill-drafts/:id/approve', ({ res, params }) => {
    try { sendJson(res, 200, { skill: app.skills.approve(idOf(params[0]!)) }); } catch (error) { domainFailure(error); }
  });
  router.add('POST', '/api/skill-drafts/:id/reject', ({ res, params }) => {
    try { app.skills.reject(idOf(params[0]!)); sendJson(res, 200, { ok: true }); } catch (error) { domainFailure(error); }
  });

  // ── 好奇心リスト ──
  router.add('GET', '/api/curiosity', ({ res, url }) => sendJson(res, 200, {
    items: app.curiosity.list({ includeClosed: url.searchParams.get('all') === '1' }),
  }));
  router.add('POST', '/api/curiosity', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const topic = requireString(body, 'topic', { max: 200 })!;
    const why = requireString(body, 'why', { optional: true, max: 500 });
    try { sendJson(res, 201, { item: app.curiosity.add({ topic, why, source: 'user' }) }); } catch (error) { domainFailure(error); }
  });
  router.add('PATCH', '/api/curiosity/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    if (body.status !== undefined && !(STATUSES as readonly unknown[]).includes(body.status)) {
      throw problem(400, 'invalid_field', 'bad_enum', { field: 'status', params: { field: 'status', values: STATUSES.join(' / ') } });
    }
    const topic = requireString(body, 'topic', { optional: true, max: 200 });
    const why = requireString(body, 'why', { optional: true, max: 500 });
    const result = requireString(body, 'result', { optional: true, max: 4000 });
    try {
      sendJson(res, 200, { item: app.curiosity.update(idOf(params[0]!), {
        ...(topic !== undefined ? { topic } : {}), ...(why !== undefined ? { why } : {}), ...(result !== undefined ? { result } : {}),
        ...(body.status !== undefined ? { status: body.status as CuriosityStatus } : {}),
      }) });
    } catch (error) { domainFailure(error); }
  });
  router.add('POST', '/api/curiosity/:id/task', ({ res, params }) => {
    const item = app.curiosity.get(idOf(params[0]!));
    if (!item) throw problem(404, 'not_found', 'item_missing');
    if (item.status === 'researching') throw problem(409, 'busy', 'already_researching');
    const text = curiosityText(languageOf(app.config()));
    const task = app.tasks.create({
      title: text.title(item.topic).slice(0, 200), body: item.why ? text.why(item.why) : '',
      doneCriteria: text.doneCriteria, origin: 'curiosity', curiosityId: item.id, actor: 'user',
    });
    app.curiosity.update(item.id, { status: 'researching', taskId: task.id });
    app.worker.requestRun(task.id);
    sendJson(res, 201, { task: taskView(task, languageOf(app.config())) });
  });

  // ── 振り返りの記録 ──
  router.add('GET', '/api/reviews', ({ res, url }) => {
    const project = projectFilterOf(url);
    const filter = projectWhere('memory_jobs', project);
    const rows = app.db.prepare(`SELECT memory_jobs.*, ${projectOfSql('memory_jobs')} AS project_id FROM memory_jobs WHERE 1 = 1${filter.sql} ORDER BY id DESC LIMIT 50`)
      .all(...filter.args) as unknown as Array<ReviewJob & { project_id: string | null }>;
    const jobs = rows.map(job => ({
      ...job, triggerLabel: TRIGGER_TEXT[languageOf(app.config())][job.trigger],
      changes: job.run_id ? app.db.prepare('SELECT * FROM memory_events WHERE run_id = ? ORDER BY id').all(job.run_id) : [],
    }));
    sendJson(res, 200, { jobs, pending: app.reviews.pendingCount(), total: todayCount(app, 'memory_jobs', undefined, project) });
  });
  router.add('POST', '/api/reviews', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const conversationId = requireString(body, 'conversationId', { max: 100 })!;
    if (!app.conversations.get(conversationId)) throw problem(404, 'not_found', 'conversation_missing');
    const last = app.conversations.messages(conversationId, 1).at(-1);
    const job = app.reviews.enqueue('manual', `manual:${conversationId}:${last?.id ?? 0}`, { conversationId });
    app.worker.poke();
    sendJson(res, job ? 202 : 200, { queued: Boolean(job) });
  });
}
