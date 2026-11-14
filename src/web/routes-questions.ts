import type { App } from '../app.ts';
import { QuestionError } from '../questions/store.ts';
import { domainProblem, readJson, requireObject, type Router, sendJson } from './http.ts';

function idOf(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(id) || id < 1) throw domainProblem(400, 'invalid_id', new QuestionError('invalid_id'));
  return id;
}

export function registerQuestionRoutes(router: Router, app: App): void {
  const text = (url: URL, name: string): string | undefined => {
    const value = url.searchParams.get(name);
    return value === null || value === '' ? undefined : value.slice(0, 200);
  };
  router.add('GET', '/api/questions', ({ res, url }) => {
    const status = text(url, 'status') ?? 'open';
    if (status !== 'open' && status !== 'answered') throw domainProblem(400, 'invalid_field', new QuestionError('invalid_status'));
    const before = text(url, 'before');
    sendJson(res, 200, { items: app.questions.list({ status, projectId: text(url, 'projectId'), ...(before !== undefined ? { before: idOf(before) } : {}) }) });
  });
  router.add('GET', '/api/questions/counts', ({ res }) => sendJson(res, 200, app.questions.counts()));
  router.add('POST', '/api/questions/:id/answer', async ({ req, params }) => {
    const id = idOf(params[0]);
    requireObject(await readJson(req));
    throw domainProblem(404, 'not_found', new QuestionError('not_found', { id }));
  });
}
