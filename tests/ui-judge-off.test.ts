import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import { en } from '../web/src/i18n/en.ts';
import { decidedByLabel } from '../web/src/runlog-meta.ts';
import { accessWidening } from '../web/src/settings/access.ts';
import type { Config } from '../web/src/settings/model.ts';
import { planSave } from '../web/src/ui/settings/commit.ts';
import { JUDGE_OFF, judgeChoice, judgeIsOff, rolesOf, setJudge } from '../web/src/ui/settings/view.ts';

// J-4 の画面: Settings の判定役の行の「Off — run without a judge」、選ぶときの確かめの 1 枚、上の帯の「Judge off」、Runs の「off」、道具の行の「No judge」

const base = (): Config => structuredClone(defaultConfig()) as unknown as Config;
const source = (path: string): string => readFileSync(path, 'utf8');

test('J-4 画面: 判定役の行で Off を選ぶと routing.judgeMode が off になり、選んでいた判定役のモデルは残る。モデルか「会話と同じ」を選び直すと鍵が消えて On', () => {
  const config = { ...base(), routing: { ...base().routing, chat: ['a'], judge: ['b', 'c'] } } as Config;
  const offed = setJudge(config, JUDGE_OFF);
  assert.equal(offed.routing.judgeMode, 'off');
  assert.deepEqual(offed.routing.judge, ['b', 'c']);
  assert.equal(judgeIsOff(offed), true);
  assert.equal(judgeChoice(offed), JUDGE_OFF);
  assert.equal(rolesOf(offed).judge, 'b');
  const back = setJudge(offed, 'b');
  assert.equal(Object.hasOwn(back.routing, 'judgeMode'), false);
  assert.equal(judgeChoice(back), 'b');
  const same = setJudge(offed, '');
  assert.equal(Object.hasOwn(same.routing, 'judgeMode'), false);
  assert.equal(judgeChoice(same), '');
  assert.equal(judgeIsOff(base()), false, '鍵が無ければ On');
  assert.match(JUDGE_OFF, /^[^a-z0-9]/u, 'モデルの ID にはなれない値');
});

test('J-4 画面: Off にする保存は確かめの 1 枚を出す（設定の生の編集でも同じ）。On に戻す・Off のまま他を変えるのは確かめない', () => {
  const before = base();
  const offed = setJudge(before, JUDGE_OFF);
  assert.deepEqual(accessWidening(before, offed), [{ kind: 'judge-off' }]);
  assert.equal(planSave(before, c => setJudge(c, JUDGE_OFF), null).kind, 'confirm');
  assert.deepEqual(accessWidening(offed, setJudge(offed, '')), []);
  assert.deepEqual(accessWidening(offed, { ...offed, timezone: 'UTC' } as Config), []);
  const raw = { ...before, routing: { ...before.routing, judgeMode: 'off' } } as Config;
  assert.deepEqual(accessWidening(before, raw), [{ kind: 'judge-off' }]);
});

test('J-4 画面: 確かめの 1 枚は、止まらなくなるもの・外を読んだあと・控えの無い実行・今までどおり止まるものを書く', () => {
  assert.match(en['access.judgeOff'], /run at once, with no check/u);
  assert.match(en['access.judgeOffTaint'], /after beat has read outside content/u);
  assert.match(en['access.judgeOffTaint'], /Sending data out stays in Pending/u);
  for (const part of [/Chats \(product chats too\)/u, /other tasks/u, /not git repositories/u, /snapshot timed out/u, /only takes you back to the point where the Build task started/u]) assert.match(en['access.judgeOffSnapshot'], part);
  for (const part of [/shutdown/u, /calling beat itself/u, /sends, deletions, protected files, Ask tools/u, /code that touches beat itself/u, /plan mode/u, /second check/u, /approve a Pending action/u]) assert.match(en['access.judgeOffStill'], part);
  const text = source('web/src/ui/settings/access-text.tsx');
  assert.ok(text.includes("case 'judge-off':"));
  for (const key of ['access.judgeOff', 'access.judgeOffTaint', 'access.judgeOffSnapshot', 'access.judgeOffStill']) assert.ok(text.includes(`t('${key}')`), key);
});

test('J-4 画面: 判定役の行に Off の選び方、Off のあいだは行の説明も変わる', () => {
  assert.equal(en['ui.set.models.judgeOff'], 'Off — run without a judge');
  const page = source('web/src/ui/settings/agent.tsx');
  assert.ok(page.includes("{ value: JUDGE_OFF, label: t('ui.set.models.judgeOff') }"));
  assert.ok(page.includes('value={judgeChoice(ctx.config)}'));
  assert.ok(page.includes("judgeIsOff(ctx.config) ? t('ui.set.models.judgeOffDesc')"));
});

test('J-4 画面: Off のあいだ、上の帯（広い画面の横の帯の頭・狭い画面の上の帯）に「Judge off」、押すと Settings の判定役の行がある区分へ。Runs の Judge today の横に off', () => {
  assert.equal(en['ui.judgeOff'], 'Judge off');
  assert.equal(en['ui.runs.judgeOff'], 'off');
  const parts = source('web/src/ui/parts.tsx');
  assert.ok(parts.includes('href="#/settings/models"'));
  assert.ok(source('web/src/ui/Sidebar.tsx').includes('{judgeOff && <JudgeOffChip />}'));
  assert.ok(source('web/src/ui/NarrowBar.tsx').includes('{judgeOff && <JudgeOffChip />}'));
  const app = source('web/src/ui/App.tsx');
  assert.equal(app.split('judgeOff={worker?.judgeOff === true}').length - 1, 2);
  assert.ok(source('web/src/ui/screens/Runs.tsx').includes("{data?.judgeOff && <> <span className=\"bt-chip\" data-judge-off>{t('ui.runs.judgeOff')}</span></>}"));
  assert.ok(source('web/src/ui/screens/Runs.tsx').includes('judgedLine(data.judged) ?? (data.judgeOff ? { allowed: 0, parked: 0, notRun: 0 } : null)'), '判定役の数が 0 の日でも、Off なら Judge today の行と off を出す');
  assert.ok(source('src/web/routes-tasks.ts').includes('judgeOff: judgeOff(app.config())'));
  assert.ok(source('src/web/server.ts').includes('judgeOff: judgeOff(app.config())'));
});

test('J-4 画面: 道具の行と記録に「No judge (owner setting)」', () => {
  assert.equal(decidedByLabel('no-judge'), 'No judge (owner setting)');
  assert.equal(en['ui.tool.noJudge'], 'No judge (owner setting)');
  const row = source('web/src/ui/ToolRow.tsx');
  assert.ok(row.includes("if (gate.by === 'no-judge') return <span className=\"ui-tool__why\">{t('ui.tool.noJudge')}</span>;"));
});
