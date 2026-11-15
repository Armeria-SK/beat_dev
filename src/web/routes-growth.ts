import type { App } from '../app.ts';
import { growthStats, MONTH } from '../growth/stats.ts';
import { problem, type Router, sendJson } from './http.ts';
import { projectFilterOf } from './routes-projects.ts';

export function registerGrowthRoutes(router: Router, app: App): void {
  router.add('GET', '/api/growth/stats', ({ res, url }) => {
    const project = projectFilterOf(url);
    const month = url.searchParams.get('month') ?? undefined;
    if (month !== undefined && !MONTH.test(month)) throw problem(400, 'invalid_field', 'bad_month', { field: 'month' });
    sendJson(res, 200, growthStats(app.db, { project, month, timezone: app.config().timezone }));
  });
}
