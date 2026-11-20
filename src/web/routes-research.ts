import type { App } from '../app.ts';
import { ResearchError } from '../research/labels.ts';
import { OwnerAct } from '../research/run.ts';
import { parseProjectResearch, researchSettings } from '../research/settings.ts';
import type { ResearchItemRow, ResearchRunRow } from '../research/store.ts';
import { domainProblem, problem, readJson, requireObject, sendJson, type Router } from './http.ts';

const ID = /^[0-9a-f-]{36}$/u;

const STATUS: Partial<Record<string, number>> = { not_found: 404, not_owner: 403, running: 409, finished: 409, source_gone: 409, no_model: 409, not_confirmed: 409, changed: 409, conversation_running: 409, too_long: 400, bad_choice: 400 };

export function researchProblem(error: unknown): never {
  if (error instanceof ResearchError) throw domainProblem(STATUS[error.code] ?? 400, 'research', error);
  throw error;
}

export function itemView(item: ResearchItemRow) {
  return {
    id: item.id, kind: item.kind, name: item.name_or_label, detail: item.detail, url: item.url, license: item.license, updated: item.updated, language: item.language,
    products: JSON.parse(item.products) as number[], options: item.options ? JSON.parse(item.options) as string[] : null,
    defaultChecked: item.default_checked === 1, defaultReason: item.default_reason, recommended: item.recommended, decision: item.decision, reason: item.reason,
  };
}

export function recordView(app: App, record: ResearchRunRow | undefined) {
  if (!record) return null;
  const store = app.research.store;
  return {
    id: record.id, phase: record.phase, mode: record.mode, status: record.status, partial: record.partial === 1, auto: record.auto === 1, stopReason: record.stop_reason,
    createdAt: record.created_at, finishedAt: record.finished_at, confirmedAt: record.confirmed_at,
    shownHash: store.shownHash(record.id), items: store.items(record.id).map(itemView),
  };
}

export function registerResearchRoutes(router: Router, app: App): void {
  const projectOf = (id: string) => {
    const project = app.projects.get(id);
    if (!project) throw problem(404, 'not_found', 'item_missing');
    return project;
  };

  router.add('GET', '/api/projects/:id/research', async ({ res, params }) => {
    const project = projectOf(params[0]!);
    const store = app.research.store;
    sendJson(res, 200, {
      settings: researchSettings(app.config(), parseProjectResearch(project.research_settings)),
      own: parseProjectResearch(project.research_settings) ?? null,
      products: recordView(app, store.latest(project.id, 'products')),
      libraries: recordView(app, store.latest(project.id, 'libraries')),
    });
  });

  // 「調べる」ボタン（R3.12 (b)）: 持ち主の画面の口だけ。前の記録が終わっていれば何度でも
  router.add('POST', '/api/projects/:id/research', async ({ req, res, params }) => {
    const project = projectOf(params[0]!);
    const body = requireObject(await readJson(req));
    const conversationId = typeof body.conversationId === 'string' && ID.test(body.conversationId) ? body.conversationId : undefined;
    if (!conversationId) throw problem(400, 'invalid_request', 'required', { field: 'conversationId', params: { field: 'conversationId' } });
    try {
      const record = app.research.start({ projectId: project.id, sourceConversationId: conversationId, trigger: 'owner_button', owner: new OwnerAct() });
      sendJson(res, 202, { research: recordView(app, record) });
    } catch (error) { researchProblem(error); }
  });

  router.add('POST', '/api/research/:id/skip', async ({ res, params }) => {
    try {
      const record = await app.research.skip(params[0]!);
      sendJson(res, 200, { research: recordView(app, record) });
    } catch (error) { researchProblem(error); }
  });
}
