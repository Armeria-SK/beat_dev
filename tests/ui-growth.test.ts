import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GrowthStats } from '../web/src/api.ts';
import { growthBucket, growthMonths, monthKey, monthLabel, percentText, perTaskText } from '../web/src/ui/growth.ts';

test('ui/growth: 月はタイムゾーンで決める（UTC の月末でも東京では次の月）', () => {
  const at = Date.UTC(2026, 9, 31, 20, 0);
  assert.equal(monthKey(at, 'UTC'), '2026-10');
  assert.equal(monthKey(at, 'Asia/Tokyo'), '2026-11');
  assert.equal(monthKey(at, 'Not/AZone'), '2026-10', '読めないタイムゾーンは UTC');
});

test('ui/growth: 選べる月は今月から製品を作った月まで、新しい順。年をまたぐ。上限で切る。未来に作った製品でも今月は出る', () => {
  const now = Date.UTC(2026, 1, 10);
  assert.deepEqual(growthMonths(Date.UTC(2025, 10, 20), now, 'UTC'), ['2026-02', '2026-01', '2025-12', '2025-11']);
  assert.deepEqual(growthMonths(Date.UTC(2026, 1, 1), now, 'UTC'), ['2026-02']);
  assert.deepEqual(growthMonths(Date.UTC(2027, 1, 1), now, 'UTC'), ['2026-02']);
  assert.equal(growthMonths(0, now, 'UTC').length, 24);
  assert.equal(growthMonths(0, now, 'UTC', 3).at(-1), '2025-12');
});

test('ui/growth: 月の名前・割合・タスクあたりの数の書き方。数の無い割合は「—」', () => {
  assert.equal(monthLabel('2026-11'), 'Nov 2026');
  assert.equal(monthLabel('2026-01'), 'Jan 2026');
  assert.equal(percentText(null), '—');
  assert.equal(percentText(2 / 3), '67%');
  assert.equal(percentText(0), '0%');
  assert.equal(perTaskText(null), '—');
  assert.equal(perTaskText(1.25), '1.3');
  assert.equal(perTaskText(2), '2');
});

test('ui/growth: その月・その製品の箱だけを使う。無ければ 0 の箱', () => {
  const stats: GrowthStats = {
    month: '2026-11', projectId: 'p1', skillsCountedSince: null,
    buckets: [{
      month: '2026-11', projectId: 'p1', tasks: 4, judgeAsked: 1, pending: 2, skills: [], checks: { decisions: 0, notEnough: 0, notEnoughShare: null },
      questions: { asked: 3, perTask: 0.75, answered: 1, kept: 1, keptRate: 1, noAssumption: 2, byCategory: [] },
    }],
  };
  assert.equal(growthBucket(stats, '2026-11', 'p1').tasks, 4);
  const empty = growthBucket(stats, '2026-10', 'p1');
  assert.equal(empty.tasks, 0);
  assert.equal(empty.questions.keptRate, null);
  assert.equal(growthBucket(stats, '2026-11', 'p2').tasks, 0);
});
