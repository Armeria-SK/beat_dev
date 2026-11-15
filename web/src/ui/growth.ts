import type { GrowthBucket, GrowthStats } from '../api.ts';

export const GROWTH_MONTHS_MAX = 24;

export function monthKey(ms: number, zone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit' }).formatToParts(ms); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit' }).formatToParts(ms); }
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}

export function growthMonths(since: number, now: number, zone: string, max = GROWTH_MONTHS_MAX): string[] {
  const first = monthKey(Math.min(since, now), zone);
  let [year, month] = monthKey(now, zone).split('-').map(Number) as [number, number];
  const months: string[] = [];
  while (months.length < max) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key <= first) break;
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return months;
}

export function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short' }).format(Date.UTC(year, index - 1, 1));
}

export function emptyGrowthBucket(month: string, projectId: string | null): GrowthBucket {
  return {
    month, projectId, tasks: 0,
    questions: { asked: 0, perTask: null, answered: 0, kept: 0, keptRate: null, noAssumption: 0, byCategory: [] },
    judgeAsked: 0, pending: 0, checks: { decisions: 0, notEnough: 0, notEnoughShare: null }, skills: [],
  };
}

export function growthBucket(stats: GrowthStats, month: string, projectId: string): GrowthBucket {
  return stats.buckets.find(b => b.month === month && b.projectId === projectId) ?? emptyGrowthBucket(month, projectId);
}

export const percentText = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

export const perTaskText = (n: number | null): string => (n === null ? '—' : String(Math.round(n * 10) / 10));
