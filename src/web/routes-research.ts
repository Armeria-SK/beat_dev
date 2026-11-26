import type { App } from '../app.ts';
import { ResearchError } from '../research/labels.ts';
import { OwnerAct } from '../research/run.ts';
import { researchSettings } from '../research/settings.ts';
import type { ConfirmPick } from '../research/confirm.ts';
import { checkCommandFor } from '../research/choices.ts';
import { pickedLanguage, type ResearchItemRow, type ResearchRunRow } from '../research/store.ts';
import { domainProblem, problem, readJson, requireObject, sendJson, type Router } from './http.ts';

const ID = /^[0-9a-f-]{36}$/u;
const PICKS_MAX = 80;

const STATUS: Partial<Record<string, number>> = { not_found: 404, not_owner: 403, running: 409, not_finished: 409, finished: 409, source_gone: 409, runtime_source: 409, no_model: 409, not_confirmed: 409, changed: 409, conversation_running: 409, too_long: 400, bad_choice: 400 };

export function researchProblem(error: unknown): never {
  if (error instanceof ResearchError) throw domainProblem(STATUS[error.code] ?? 400, 'research', error);
  throw error;
}

export function itemView(item: ResearchItemRow) {
  return {
    id: item.id, kind: item.kind, name: item.name_or_label, detail: item.detail, url: item.url, license: item.license, updated: item.updated, language: item.language,
    products: JSON.parse(item.products) as number[], options: item.options ? JSON.parse(item.options) as string[] : null,
    by: item.kind === 'choice' ? ((JSON.parse(item.evidence || '{}') as { by?: string }).by === 'code' ? 'code' : 'model') : null,
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
      settings: researchSettings(app.config()),
      products: recordView(app, store.latest(project.id, 'products')),
      libraries: recordView(app, store.latest(project.id, 'libraries')),
      // R-3: 確かめのコマンドが空のときだけ、確定した言語の既定の案（持ち主が押すと製品の PATCH で入る）
      suggestedCheck: project.check_command ? null : (() => { const language = pickedLanguage(app.db, project.id); return language ? checkCommandFor(language) : null; })(),
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

  // 守り 3 の 1: 計画の会話へ入る道は、持ち主の画面のこの口 1 本だけ（書き込みの口と同じ Origin の確かめ）
  router.add('POST', '/api/research/:id/confirm', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const shownHash = typeof body.shownHash === 'string' && /^[0-9a-f]{64}$/u.test(body.shownHash) ? body.shownHash : undefined;
    if (!shownHash) throw problem(400, 'invalid_request', 'required', { field: 'shownHash', params: { field: 'shownHash' } });
    if (!Array.isArray(body.picks) || body.picks.length > PICKS_MAX) throw problem(400, 'invalid_request', 'required', { field: 'picks', params: { field: 'picks' } });
    const picks: ConfirmPick[] = [];
    for (const raw of body.picks as unknown[]) {
      const pick = raw as Record<string, unknown> | null;
      if (!pick || typeof pick !== 'object' || !Number.isInteger(pick.id) || !(typeof pick.decision === 'string' || Number.isInteger(pick.decision))
        || (pick.reason !== undefined && typeof pick.reason !== 'string') || (pick.setup !== undefined && typeof pick.setup !== 'boolean')) {
        throw problem(400, 'invalid_request', 'required', { field: 'picks', params: { field: 'picks' } });
      }
      picks.push({ id: pick.id as number, decision: pick.decision as string | number, ...(typeof pick.reason === 'string' ? { reason: pick.reason } : {}), ...(pick.setup === true ? { setup: true } : {}) });
    }
    try {
      const out = app.research.confirm(params[0]!, { shownHash, picks }, new OwnerAct());
      sendJson(res, 200, { research: recordView(app, out.record), replied: out.replied, setupTask: out.setupTask ?? null, libraries: recordView(app, out.libraries) });
    } catch (error) { researchProblem(error); }
  });

  router.add('POST', '/api/research/:id/skip', async ({ res, params }) => {
    try {
      const record = await app.research.skip(params[0]!);
      sendJson(res, 200, { research: recordView(app, record) });
    } catch (error) { researchProblem(error); }
  });
}
