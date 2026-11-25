import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
import { researchApp } from './helpers/research-app.ts';

// beat R: 調べる設定は Settings の全体の設定だけ。製品ごとの上書き（R-4）は外した。
// 列 projects.research_settings は残してあるが、もう読まない（前に保存された上書きが見えないまま効き続けないように）

type Shop = Awaited<ReturnType<typeof researchApp>>;
const STORED = { when: 'off', mode: 'one_by_one', limits: { minutes: 5 }, askLanguage: false, preferLanguages: ['Go'], avoidLanguages: ['Python'] };
const storedOverride = (s: Shop): string | null => (s.app.db.prepare('SELECT research_settings FROM projects WHERE id = ?').get(s.projectId) as { research_settings: string | null }).research_settings;
const storeOverride = (s: Shop, value: unknown): void => { s.app.db.prepare('UPDATE projects SET research_settings = ? WHERE id = ?').run(JSON.stringify(value), s.projectId); };

test('前の上書きが列に残っている製品: GET の settings は Settings の全体の設定のまま（上書きは効かず、own も返さない）', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'new', mode: 'batch', limits: { searches: 9 } }; } });
  storeOverride(s, STORED);
  const got = await s.json(`/api/projects/${s.projectId}/research`, 'GET');
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.settings, { when: 'new', mode: 'batch', limits: { candidates: 8, searches: 9, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] });
  assert.equal('own' in got.body, false, 'the view no longer carries a per-product override');
});

test('前の上書き「調べない」が列に残っている製品: 全体が new なら、最初の発言で自動に始まる', async t => {
  const s = await researchApp(t);
  storeOverride(s, { when: 'off' });
  s.adapter().scripts.push(reply('Noted.'), reply('done'));
  await s.send(1, 'I want a Markdown notes app with tags.');
  await waitFor(() => s.records().length === 1, 'the automatic start follows the global setting, not the stored override', 5000);
  await s.settle();
});

test('PATCH /api/projects/:id の researchSettings は受け付けない（無視され、列も効く設定も変わらない）', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'button' }; } });
  const before = storedOverride(s);
  const patched = await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: STORED });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(storedOverride(s), before, 'the column is not written');
  const got = await s.json(`/api/projects/${s.projectId}/research`, 'GET');
  assert.equal(got.body.settings.when, 'button');
  const renamed = await s.json(`/api/projects/${s.projectId}`, 'PATCH', { name: 'Renamed', researchSettings: STORED });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.project.name, 'Renamed', 'the other fields of the same PATCH still apply');
  assert.equal(storedOverride(s), before);
});
