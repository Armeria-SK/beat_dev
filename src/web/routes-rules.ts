import type { App } from '../app.ts';
import { PendingError } from '../pending/store.ts';
import { listRules, removeRule } from '../tools/approval-rules.ts';
import { domainProblem, type Router, sendJson } from './http.ts';

// J-5: the owner's "don't ask again" rules. Listing and removal only; rules are added from the Pending approve (routes-pending.ts) and never edited (a wider rule would need a new approval)
export function registerRuleRoutes(router: Router, app: App): void {
  router.add('GET', '/api/approval-rules', ({ res }) => sendJson(res, 200, { items: listRules(app.db).map(rule => ({ ...rule, shown: app.pending.markHeld(rule.shown) })) }));
  router.add('DELETE', '/api/approval-rules/:id', ({ res, params }) => {
    const raw = params[0];
    const id = Number(raw);
    if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(id) || id < 1) throw domainProblem(400, 'invalid_id', new PendingError('invalid_rule_id'));
    if (!removeRule(app.db, id)) throw domainProblem(404, 'not_found', new PendingError('rule_not_found', { id }));
    sendJson(res, 200, { removed: id });
  });
}
