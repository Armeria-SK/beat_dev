import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startOfDayIn } from '../src/tasks/schedule.ts';
import { judgeStats, type JudgeStats, type JudgeTotals } from '../src/tools/judge-stats.ts';

const USAGE = 'usage: node scripts/judge-stats.ts --db <path to beat.db> [--days 7] [--timezone UTC] [--project <id>|none] [--runs 20] [--json]';

const cells = (t: JudgeTotals): string => `${t.calls}\t${t.allow}\t${t.ask}\t${t.failed}\t${t.inputTokens}\t${t.outputTokens}\t${t.ms}`;
const HEAD = 'calls\tallow\task\tfailed\tin_tokens\tout_tokens\tms';

export function renderStats(stats: JudgeStats): string {
  const section = (title: string, rows: Array<[string, JudgeTotals]>): string[] => [`## ${title}`, `name\t${HEAD}`, ...rows.map(([name, t]) => `${name}\t${cells(t)}`), ''];
  return [
    `# Judge calls ${new Date(stats.since).toISOString()} .. ${new Date(stats.until).toISOString()}`,
    `total\t${HEAD}`, `all\t${cells(stats.totals)}`, '',
    ...section('By reason key', stats.keys.map(k => [k.key, k])),
    ...section('By ask kind', stats.askKinds.map(k => [k.kind, k])),
    ...section('By day', stats.days.map(d => [d.day, d])),
    ...section('By judge model', stats.models.map(m => [m.model ?? '(not reported)', m])),
    ...section('Failed, by reason (before model = never reached a judge model)', stats.failures.map(f => [`${f.reason}${f.beforeModel ? ' (before model)' : ''}`, f])),
    ...section('By run', stats.runs.map(r => [`${r.runId} ${r.runKind}${r.projectId ? ` ${r.projectId}` : ''}`, r])),
  ].join('\n');
}

export function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

export function readStats(path: string, options: { days: number; timezone: string; project?: string | null | undefined; runs: number; now?: number | undefined }): JudgeStats {
  const db = openReadOnly(path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judge_calls'").get()) throw new Error('this database has no judge_calls table yet (start beat once with this version)');
    const now = options.now ?? Date.now();
    let since: number;
    try { since = startOfDayIn(options.timezone, now - (options.days - 1) * 86_400_000); } catch { throw new Error(`unknown timezone: ${options.timezone}`); }
    return judgeStats(db, { since, until: now + 1, project: options.project, timezone: options.timezone, runLimit: options.runs });
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' }, days: { type: 'string', default: '7' }, timezone: { type: 'string', default: 'UTC' },
      project: { type: 'string' }, runs: { type: 'string', default: '20' }, json: { type: 'boolean', default: false },
    },
  });
  const days = Number(values.days);
  const runs = Number(values.runs);
  if (!values.db || !Number.isInteger(days) || days < 1 || days > 366 || !Number.isInteger(runs) || runs < 1) throw new Error(USAGE);
  const project = values.project === undefined ? undefined : values.project === 'none' ? null : values.project;
  const stats = readStats(resolve(values.db), { days, timezone: values.timezone, project, runs });
  process.stdout.write(values.json ? `${JSON.stringify(stats, null, 2)}\n` : `${renderStats(stats)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
