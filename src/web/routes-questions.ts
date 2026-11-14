import type { App } from '../app.ts';
import { QuestionError } from '../questions/store.ts';
import { TaskError } from '../tasks/store.ts';
import { splitKey } from '../tasks/worker.ts';
import { domainProblem, readJson, requireObject, type Router, sendJson } from './http.ts';

const ANSWER_MAX = 4000;

function idOf(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(id) || id < 1) throw domainProblem(400, 'invalid_id', new QuestionError('invalid_id'));
  return id;
}

function answerOf(body: Record<string, unknown>): { choice: number | null; text?: string } {
  const { choice, text } = body;
  if (choice !== null && (typeof choice !== 'number' || !Number.isInteger(choice))) throw domainProblem(400, 'invalid_field', new QuestionError('invalid_answer'));
  if (text !== undefined && (typeof text !== 'string' || text.length > ANSWER_MAX)) throw domainProblem(400, 'invalid_field', new QuestionError('invalid_answer'));
  return { choice, ...(typeof text === 'string' ? { text } : {}) };
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
  router.add('POST', '/api/questions/:id/answer', async ({ req, res, params }) => {
    const id = idOf(params[0]);
    const input = answerOf(requireObject(await readJson(req)));
    let result;
    try {
      result = app.questions.answer(id, input);
    } catch (error) {
      if (error instanceof QuestionError) throw error.code === 'task_running' ? domainProblem(409, 'task', error) : domainProblem(400, 'invalid_field', error);
      if (error instanceof TaskError) throw domainProblem(409, 'task', error);
      throw error;
    }
    if (!result) throw domainProblem(404, 'not_found', new QuestionError('not_found', { id }));
    if (!result.repeated) {
      const row = app.questions.get(id);
      if (row?.project_id) {
        try {
          app.mesh.recordDecision(row.project_id, {
            questionId: id, question: row.question, answer: row.answer ?? '', picked: input.text?.trim() ? 'text' : 'option', kept: result.kind === 'kept', item: result.reopenedItem, external: row.tainted === 1,
          });
        } catch (error) { app.log(`[WARN] Could not write DECISIONS.md of product ${row.project_id}: ${(error as Error).message}`); }
      }
      if (result.resumedTaskId) app.kv.delete(splitKey(result.resumedTaskId));
      for (const taskId of [result.resumedTaskId, result.reopenedTaskId, result.fixTaskId]) if (taskId) app.worker.requestRun(taskId);
    }
    sendJson(res, 200, result);
  });
}
