import type { DatabaseSync } from 'node:sqlite';
import { QUESTION_CATEGORIES } from '../questions/store.ts';
import { judgeStats } from '../tools/judge-stats.ts';

export interface GrowthQuery {
  project?: string | null | undefined;
  month?: string | undefined;
  timezone?: string | undefined;
}

export interface CategoryStats { category: string; asked: number; answered: number; kept: number; keptRate: number | null; noAssumption: number }

export interface SkillStats { name: string; uses: number; taskUses: number; chatUses: number; tasks: number; done: number; failed: number; cancelled: number; unfinished: number }

export interface GrowthBucket {
  month: string;
  projectId: string | null;
  tasks: number;
  questions: { asked: number; perTask: number | null; answered: number; kept: number; keptRate: number | null; noAssumption: number; byCategory: CategoryStats[] };
  judgeAsked: number;
  pending: number;
  checks: { decisions: number; notEnough: number; notEnoughShare: number | null };
  skills: SkillStats[];
}

export interface GrowthStats { month: string | null; projectId: string | null | undefined; skillsCountedSince: number | null; buckets: GrowthBucket[] }

export const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DAY = 86_400_000;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

function monthFormat(timezone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit' };
  try { return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timezone ?? 'UTC' }); }
  catch { return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' }); }
}

const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function emptyBucket(month: string, projectId: string | null): GrowthBucket {
  return {
    month, projectId, tasks: 0,
    questions: { asked: 0, perTask: null, answered: 0, kept: 0, keptRate: null, noAssumption: 0, byCategory: [] },
    judgeAsked: 0, pending: 0, checks: { decisions: 0, notEnough: 0, notEnoughShare: null }, skills: [],
  };
}

export function growthStats(db: DatabaseSync, query: GrowthQuery = {}): GrowthStats {
  const format = monthFormat(query.timezone);
  const monthOf = (at: number): string => {
    const parts = format.formatToParts(at);
    return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
  };
  const match = query.month === undefined ? null : MONTH.exec(query.month);
  if (query.month !== undefined && !match) throw new RangeError('month must be YYYY-MM');
  const since = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) - DAY : 0;
  const until = match ? Date.UTC(Number(match[1]), Number(match[2]), 1) + DAY : Date.now() + 1;
  const inMonth = (month: string): boolean => query.month === undefined || month === query.month;
  const projectSql = (column: string): { sql: string; args: string[] } => query.project === undefined ? { sql: '', args: [] }
    : query.project === null ? { sql: ` AND ${column} IS NULL`, args: [] } : { sql: ` AND ${column} = ?`, args: [query.project] };

  const buckets = new Map<string, GrowthBucket>();
  const categories = new Map<string, Map<string, CategoryStats>>();
  const skills = new Map<string, Map<string, SkillStats & { seen: Set<string> }>>();
  const bucket = (at: number, projectId: string | null): GrowthBucket | undefined => {
    const month = monthOf(at);
    if (!inMonth(month)) return undefined;
    const key = `${month}\u0000${projectId ?? ''}`;
    return buckets.get(key) ?? buckets.set(key, emptyBucket(month, projectId)).get(key)!;
  };
  const keyOf = (b: GrowthBucket): string => `${b.month}\u0000${b.projectId ?? ''}`;

  const tasks = projectSql('project_id');
  for (const row of db.prepare(`SELECT project_id, created_at FROM tasks WHERE conversation_id IS NOT NULL AND NOT (cron IS NOT NULL AND parent_id IS NULL) AND proposed_by IS NOT 'scout-run'
    AND created_at >= ? AND created_at < ?${tasks.sql}`).all(since, until, ...tasks.args) as Array<{ project_id: string | null; created_at: number }>) {
    const b = bucket(Number(row.created_at), row.project_id);
    if (b) b.tasks++;
  }

  const questions = projectSql('project_id');
  for (const row of db.prepare(`SELECT project_id, kind, category, chosen, status, answer_kind, created_at FROM questions WHERE created_at >= ? AND created_at < ?${questions.sql}`)
    .all(since, until, ...questions.args) as Array<{ project_id: string | null; kind: string; category: string; chosen: number | null; status: string; answer_kind: string | null; created_at: number }>) {
    const b = bucket(Number(row.created_at), row.project_id);
    if (!b) continue;
    const assumed = row.chosen !== null;
    const answered = assumed && row.status === 'answered' ? 1 : 0;
    const kept = row.answer_kind === 'kept' ? 1 : 0;
    const none = assumed ? 0 : 1;
    b.questions.asked++;
    b.questions.answered += answered;
    b.questions.kept += kept;
    b.questions.noAssumption += none;
    if (row.kind !== 'ai') continue;
    const byCategory = categories.get(keyOf(b)) ?? categories.set(keyOf(b), new Map()).get(keyOf(b))!;
    const entry = byCategory.get(row.category) ?? byCategory.set(row.category, { category: row.category, asked: 0, answered: 0, kept: 0, keptRate: null, noAssumption: 0 }).get(row.category)!;
    entry.asked++;
    entry.answered += answered;
    entry.kept += kept;
    entry.noAssumption += none;
  }

  const judgeProjects = query.project !== undefined ? [query.project]
    : (db.prepare('SELECT DISTINCT project_id FROM judge_calls WHERE created_at >= ? AND created_at < ?').all(since, until) as Array<{ project_id: string | null }>).map(r => r.project_id);
  for (const projectId of judgeProjects) {
    const stats = judgeStats(db, { since, until, project: projectId, timezone: query.timezone });
    for (const day of stats.days) {
      if (day.ask === 0) continue;
      const month = day.day.slice(0, 7);
      if (!inMonth(month)) continue;
      const key = `${month}\u0000${projectId ?? ''}`;
      (buckets.get(key) ?? buckets.set(key, emptyBucket(month, projectId)).get(key)!).judgeAsked += day.ask;
    }
  }

  const pending = projectSql('project_id');
  for (const row of db.prepare(`SELECT project_id, created_at FROM pending_actions WHERE created_at >= ? AND created_at < ?${pending.sql}`)
    .all(since, until, ...pending.args) as Array<{ project_id: string | null; created_at: number }>) {
    const b = bucket(Number(row.created_at), row.project_id);
    if (b) b.pending++;
  }

  const checks = projectSql('t.project_id');
  for (const row of db.prepare(`SELECT t.project_id, e.content, e.created_at FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE e.kind = 'owner_check' AND e.created_at >= ? AND e.created_at < ?${checks.sql}`).all(since, until, ...checks.args) as Array<{ project_id: string | null; content: string | null; created_at: number }>) {
    let result: unknown;
    try { result = (JSON.parse(row.content ?? '') as { result?: unknown }).result; } catch { continue; }
    if (result !== 'checked' && result !== 'insufficient') continue;
    const b = bucket(Number(row.created_at), row.project_id);
    if (!b) continue;
    b.checks.decisions++;
    if (result === 'insufficient') b.checks.notEnough++;
  }

  const used = projectSql('COALESCE(k.project_id, oc.project_id)');
  for (const row of db.prepare(`SELECT CASE WHEN json_valid(u.input) THEN json_extract(u.input, '$.name') END AS name, u.created_at, k.id AS task_id, k.status,
      COALESCE(k.project_id, oc.project_id) AS project_id
    FROM tool_calls u
    LEFT JOIN engine_runs ur ON ur.id = u.run_id
    LEFT JOIN conversations uc ON uc.id = u.conversation_id
    LEFT JOIN engine_runs pr ON pr.id = COALESCE(ur.parent_run_id, uc.parent_run_id)
    LEFT JOIN conversations oc ON oc.id = COALESCE(pr.conversation_id, u.conversation_id)
    LEFT JOIN tasks k ON k.id = (SELECT x.id FROM tasks x WHERE x.conversation_id = COALESCE(pr.conversation_id, u.conversation_id) ORDER BY x.updated_at DESC LIMIT 1)
    WHERE u.created_at >= ? AND u.created_at < ? AND u.tool = 'skill_view' AND u.ok = 1 AND u.decision = 'allow' AND u.conversation_id IS NOT NULL
      AND (ur.kind IS NULL OR ur.kind != 'review')${used.sql}`).all(since, until, ...used.args) as Array<{ name: unknown; created_at: number; task_id: string | null; status: string | null; project_id: string | null }>) {
    if (typeof row.name !== 'string' || !SKILL_NAME.test(row.name)) continue;
    const b = bucket(Number(row.created_at), row.project_id);
    if (!b) continue;
    const bySkill = skills.get(keyOf(b)) ?? skills.set(keyOf(b), new Map()).get(keyOf(b))!;
    const entry = bySkill.get(row.name) ?? bySkill.set(row.name, { name: row.name, uses: 0, taskUses: 0, chatUses: 0, tasks: 0, done: 0, failed: 0, cancelled: 0, unfinished: 0, seen: new Set() }).get(row.name)!;
    entry.uses++;
    if (row.task_id === null) { entry.chatUses++; continue; }
    entry.taskUses++;
    if (entry.seen.has(row.task_id)) continue;
    entry.seen.add(row.task_id);
    entry.tasks++;
    if (row.status !== null && FINISHED.has(row.status)) entry[row.status as 'done' | 'failed' | 'cancelled']++;
    else entry.unfinished++;
  }

  const order = new Map<string, number>(QUESTION_CATEGORIES.map((category, i) => [category, i]));
  const rank = (category: string): number => order.get(category) ?? QUESTION_CATEGORIES.length;
  const result = [...buckets.values()].map(b => {
    const key = keyOf(b);
    b.questions.perTask = rate(b.questions.asked, b.tasks);
    b.questions.keptRate = rate(b.questions.kept, b.questions.answered);
    b.questions.byCategory = [...(categories.get(key)?.values() ?? [])].map(c => ({ ...c, keptRate: rate(c.kept, c.answered) })).sort((x, y) => rank(x.category) - rank(y.category) || x.category.localeCompare(y.category));
    b.checks.notEnoughShare = rate(b.checks.notEnough, b.checks.decisions);
    b.skills = [...(skills.get(key)?.values() ?? [])].map(({ seen: _seen, ...s }) => s).sort((x, y) => y.uses - x.uses || x.name.localeCompare(y.name));
    return b;
  });
  result.sort((x, y) => y.month.localeCompare(x.month) || (x.projectId ?? '').localeCompare(y.projectId ?? ''));
  const first = db.prepare('SELECT MIN(created_at) AS at FROM tool_calls').get() as { at: number | null };
  return { month: query.month ?? null, projectId: query.project, skillsCountedSince: first.at === null ? null : Number(first.at), buckets: result };
}
