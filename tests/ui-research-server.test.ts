import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';
import { researchApp } from './helpers/research-app.ts';

// beat R (M7・R-4): 製品ごとの「作る前に調べる」の上書き（PATCH /api/projects/:id の researchSettings）

test('製品の上書き: 保存すると GET の own と効く設定に出る。null で全体に戻る。形の違うものは 400 で何も変えない', async t => {
  const s = await researchApp(t, { configure: c => { c.research = { when: 'new', mode: 'batch', limits: { searches: 9 } }; } });
  const read = async () => (await s.json(`/api/projects/${s.projectId}/research`, 'GET')).body;
  assert.equal((await read()).own, null);
  const saved = await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: { when: 'button', limits: { minutes: 5 }, preferLanguages: ['Go'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = await read();
  assert.deepEqual(after.own, { when: 'button', limits: { minutes: 5 }, preferLanguages: ['Go'] });
  assert.equal(after.settings.when, 'button');
  assert.equal(after.settings.mode, 'batch', 'rows not overridden follow the global settings');
  assert.deepEqual([after.settings.limits.searches, after.settings.limits.minutes], [9, 5]);
  assert.deepEqual(after.settings.preferLanguages, ['Go']);
  for (const bad of [{ when: 'sometimes' }, { limits: { candidates: 9 } }, { preferLanguages: ['Cobol'] }, { other: 1 }, 'off', [1]]) {
    const refused = await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await read()).own, { when: 'button', limits: { minutes: 5 }, preferLanguages: ['Go'] }, 'a refused PATCH changes nothing');
  assert.equal((await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: {} })).status, 200);
  assert.equal((await read()).own, null, 'an empty override is stored as none');
  await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: { when: 'off' } });
  assert.equal((await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: null })).status, 200);
  assert.equal((await read()).own, null);
});

test('製品の上書き「調べない」: 全体が new でも、その製品では最初の発言で自動に始まらない。上書きを外すと始まる', async t => {
  const s = await researchApp(t);
  assert.equal((await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: { when: 'off' } })).status, 200);
  s.adapter().scripts.push(reply('Tell me more.'));
  await s.send(1, 'I want a Markdown notes app with tags.');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(s.records().length, 0, 'the product override turns the automatic start off');
  assert.equal((await s.json(`/api/projects/${s.projectId}`, 'PATCH', { researchSettings: null })).status, 200);
  s.adapter().scripts.push(reply('Noted.'), reply('done'));
  await s.send(1, 'It should also sync.');
  await waitFor(() => s.records().length === 1, 'the automatic start with the global setting', 5000);
  await s.settle();
});
