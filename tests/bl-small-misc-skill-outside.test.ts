import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { SkillStore } from '../src/tools/skills/store.ts';
import { skillHistory } from '../web/src/ui/library.ts';
import type { SkillVersion } from '../web/src/api.ts';
import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import { tempDir } from './helpers.ts';

interface SkillsProps { target: { kind: 'skill'; name: string }; revision: string; running: boolean; onDrafts: (n: number) => void }
const { Skills } = await loadTsx<{ Skills: ComponentType<SkillsProps> }>('../web/src/ui/screens/Skills.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

function store(t: { after: (fn: () => void) => void }) {
  let clock = 1_000;
  const root = tempDir(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const dir = join(root, 'skills');
  const backups = join(root, 'backups', 'skills');
  const make = () => new SkillStore(db, dir, () => clock++, () => 'en', () => undefined, backups);
  const direct = (name: string, body: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "Memo"\n---\n\n${body}\n`);
  };
  return { make, skills: make(), direct, backups };
}

test('スキルの版: SKILL.md を外から直接書き換えた版は beat の下書きの版ではなく outside の版になる。下書きの承認は beat、画面の保存は you のまま', t => {
  const s = store(t);
  s.skills.write({ name: 'memo', description: 'Memo', body: 'v1' });
  s.direct('memo', 'v2 typed in an editor');
  s.skills.write({ name: 'memo', description: 'Memo', body: 'v3 saved on screen' });
  const draft = s.skills.draft({ name: 'memo', description: 'Memo', body: 'v4 approved draft' });
  s.skills.approve(draft.id);
  assert.deepEqual(s.skills.history('memo').map(v => [v.who, v.body]), [['beat', 'v3 saved on screen'], ['you', 'v2 typed in an editor'], ['outside', 'v1']]);
  assert.ok(readdirSync(join(s.backups, 'memo')).some(file => /^\d+-outside\.md$/u.test(file)), 'the version file is named for the outside author');
  assert.deepEqual(s.make().history('memo').map(v => v.who), ['beat', 'you', 'outside'], 'a fresh store reads the outside file back');
});

const version = (id: string, who: SkillVersion['who'], body: string): SkillVersion => ({ id, at: Number(id.split('-')[0]), who, lines: 1, description: 'Memo', body });

test('ui/library: 外からの書き換えの行は outside の印が付き、author は beat のまま（自動登録の印とも別）。ほかの行には付かない', () => {
  const rows = skillHistory([version('4-outside', 'outside', 'c'), version('3-beat', 'beat', 'b'), version('2-you', 'you', 'a'), version('1-beat-auto', 'beat-auto', '')], { description: 'Memo', body: 'd' });
  assert.deepEqual(rows.map(r => [r.key, r.outside, r.auto, r.who]), [
    ['4-outside', true, false, 'beat'], ['3-beat', false, false, 'beat'], ['2-you', false, false, 'you'], ['1-beat-auto', false, true, 'beat'], ['oldest:1-beat-auto', false, true, 'beat'],
  ]);
});

test('ui/Skills（DOM）: History の外からの書き換えの行は「Edited outside beat」で、author の欄に beat と出さない。下書きの行は今までどおり', async () => {
  const versions = [version('4000-outside', 'outside', 'c'), version('3000-beat', 'beat', 'b'), version('2000-you', 'you', 'a')];
  globalThis.fetch = (async (path: string | URL | Request) => {
    const p = String(path);
    const summary = { name: 'memo', description: 'Memo', uses: 0, lastUsedAt: null, updatedAt: 5000, registered: true };
    const out = p === '/api/skills' ? { skills: [summary], dir: 'x' } : p === '/api/review' ? { skillDrafts: [] } : p === '/api/tools' ? { tools: [] }
      : p === '/api/settings' ? { config: {}, apiKeys: {}, configError: null, restartRequired: false, configPath: 'x' }
        : p === '/api/skills/memo' ? { skill: { ...summary, body: 'd' } } : p === '/api/skills/memo/history' ? { versions } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { container } = await render(createElement(Skills, { target: { kind: 'skill', name: 'memo' }, revision: '0', running: false, onDrafts: () => undefined }));
  await update(() => new Promise(resolve => setTimeout(resolve, 300)));
  const rows = [...container.querySelectorAll('.ui-lib__version')].map(row => ({ title: row.querySelector('.bt-row__title')?.textContent, sub: row.querySelector('.bt-row__sub')?.textContent ?? '' }));
  assert.deepEqual(rows.slice(0, 3).map(r => r.title), ['Edited outside beat', 'Updated from a draft', 'Edited by you']);
  assert.match(rows[1]!.sub, /^beat · /u);
  assert.match(rows[2]!.sub, /^you · /u);
  assert.doesNotMatch(rows[0]!.sub, /beat|you/u, 'the outside row names no author');
});
