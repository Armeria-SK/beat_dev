import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools, type App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import { contextAvailable, maxOutputFor } from '../src/engine/context-budget.ts';
import { estimateRequest, estimateTextTokens, estimateToolTokens } from '../src/engine/tokens.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { projectDir } from '../src/projects/store.ts';
import { skillView } from '../src/tools/builtin/skills.ts';
import { SKILLS_INDEX_DESCRIPTION_MAX, SkillStore, skillsIndexBudget, type Skill } from '../src/tools/skills/store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { MEASURE_MODEL, measure, renderTable, type Measured } from '../scripts/tool-tokens.ts';
import { settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir } from './helpers.ts';

// T-1: scripts/tool-tokens.ts はモードごとに渡る道具の数・量・最初の頼みの量・使える量に対する % を出す。数だけを出し、設定の値は出さない

const shaped = (change: (config: AppConfig) => void): AppConfig => { const config = defaultConfig(); change(config); return config; };
const row = (measured: Measured, mode: string) => measured.rows.find(r => r.mode === mode)!;

async function productPlanRequest(t: Parameters<typeof startApp>[0], configure: (config: AppConfig) => void) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [{ ...MEASURE_MODEL, provider: 'fake' }], projectFolderExempt: [products], tools: builtinTools(), configure });
  const dir = join(products, 'Demo');
  mkdirSync(dir, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root: dir });
  s.adapter().scripts = [reply('ok')];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'x', projectId: made.body.project.id, permissionMode: 'plan' });
  await settled(s.app, sent.body.runId);
  const last = s.adapter().calls.at(-1)!;
  return { tools: last.tools.length, toolTokens: estimateToolTokens(last.tools), request: estimateRequest(`${last.system.frozen}\n${last.system.dynamic}`, [], last.tools, 1, last.system.tail).tokens };
}

test('T-1 tool-tokens: 既定の設定とブラウザオンの写しで表を出し、製品の計画モードの数は量の線の試験の組み立てと同じ（40% 以下）', async t => {
  for (const [label, configure] of [['default', () => undefined], ['browser', (c: AppConfig) => { c.tools.browser.enabled = true; }]] as const) {
    const measured = await measure(shaped(configure));
    assert.equal(measured.available, 45_875);
    const plan = row(measured, 'product plan');
    const direct = await productPlanRequest(t, configure);
    assert.equal(plan.tools, direct.tools, label);
    assert.equal(plan.toolTokens, direct.toolTokens, label);
    assert.ok(Math.abs(plan.request - direct.request) <= direct.request * 0.02, `${label}: ${plan.request} vs ${direct.request}`);
    assert.ok(plan.percent <= 40, `${label}: ${plan.percent}%`);
    assert.deepEqual(measured.rows.map(r => r.mode), ['product plan', 'plan (no product)', 'chat (no product)', 'chat (product)', 'task', 'review', 'research']);
    assert.deepEqual(measured.off, ['agent child']);
  }
});

test('T-1 tool-tokens: agent_run がオンなら子の担当の行も出る', async () => {
  const measured = await measure(shaped(c => { c.tools.agent.enabled = true; }));
  const child = row(measured, 'agent child');
  assert.ok(child.tools > 0 && child.request > 0);
  assert.deepEqual(measured.off, []);
});

test('T-1 tool-tokens: 新しいプロセスで設定のファイルを渡すと表を出し、数だけで設定の値は出さない。ファイルは書き換えない', t => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  const config = shaped(c => {
    c.tools.browser.enabled = true;
    c.timezone = 'Asia/Tokyo';
    c.tools.roots = [{ path: join(dir, 'zq-root-7c1f'), mode: 'read' }];
    c.providers = [{ id: 'zq-provider-7c1f', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'ZQ_KEY_7C1F', maxParallel: 1, timeoutMs: 1000 }];
    c.models = [{ id: 'zq-model-7c1f', provider: 'zq-provider-7c1f', model: 'zq-name-7c1f', contextLength: 4096, maxOutputTokens: 512, vision: false }];
  });
  writeFileSync(file, JSON.stringify(config));
  const before = readFileSync(file, 'utf8');
  const out = execFileSync(process.execPath, ['scripts/tool-tokens.ts', '--config', file], { encoding: 'utf8', env: { ...process.env, ZQ_KEY_7C1F: 'sk-ant-test-0000000000000000' } });
  assert.match(out, /^available: 45875$/mu);
  assert.match(out, /^\| product plan \| \d+ \| \d+ \| \d+ \| \d+\.\d% \|$/mu);
  assert.match(out, /^\| agent child \| off \|/mu);
  for (const value of ['zq-', '7c1f', '7C1F', 'Asia/Tokyo', 'sk-ant', '127.0.0.1', dir]) assert.ok(!out.includes(value), value);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(renderTable({ available: 1, rows: [], off: [] }).split('\n')[0], 'available: 1');
});

test('T-1 tool-tokens: 読めない設定のファイルは、中身を出さずに断る', t => {
  const file = join(tempDir(t), 'config.json');
  writeFileSync(file, '{"tools": "zq-bad-7c1f"}');
  try {
    execFileSync(process.execPath, ['scripts/tool-tokens.ts', '--config', file], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('should fail');
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    assert.match(stderr, /the config file is not valid/u);
    assert.ok(!stderr.includes('zq-bad'), stderr);
  }
});

// TE-7: 毎回の固定の部分（道具の仕様 + 固定の system + dynamic + 最初の tail）は、64k のモデルの使える量の 35% 以内（持ち主の決め Q6）
const FIXED_LINE_PERCENT = 35;
const skillName = (i: number) => `skill-${String(i).padStart(3, '0')}`;
const longDescription = (i: number) => `${i}: ${'手順を読んでから作業するときに使う。'.repeat(20)}`.slice(0, 300);
const write200 = (skills: Pick<App['skills'], 'write'>, order: number[] = [...Array(200).keys()]) => {
  for (const i of order) skills.write({ name: skillName(i), description: longDescription(i), body: 'Steps' });
};
const allOn = (c: AppConfig) => { c.tools.browser.enabled = true; c.tools.agent.enabled = true; c.tools.agent.inTasks = true; };
// コードが上限を持つほかの部分も目いっぱいにする: 指示ファイル（使える量の 5%）と mesh の目次（2%）
const fillAll = (app: App, product: { root: string; projectId: string }) => {
  write200(app.skills);
  writeFileSync(join(product.root, 'AGENTS.md'), '指示ファイルの決まりをここに書いておく。'.repeat(5_000));
  const mesh = projectDir(app.paths.projects, product.projectId);
  mkdirSync(mesh, { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(mesh, `notes-${String(i).padStart(3, '0')}-${'x'.repeat(40)}.md`), `# ${'見出しの文'.repeat(20)}\n`);
};
const skillCtx = (skills: SkillStore) => ({ config: defaultConfig(), services: { skills }, kind: 'chat', conversationId: 'c1', runId: 'r1' }) as unknown as ToolContext;

test('TE-7 固定の部分の線: 既定・全部オン・skills 200 個のどれでも、どのモードも 64k の使える量の 35% 以内', async () => {
  for (const [label, configure, prepare] of [
    ['default', () => undefined, undefined],
    ['all on', allOn, undefined],
    ['all on + 200 skills + full instructions and mesh index', allOn, fillAll],
  ] as const) {
    const measured = await measure(shaped(configure), prepare ? { prepare } : {});
    assert.equal(measured.available, 45_875);
    assert.ok(measured.rows.some(r => r.mode === 'research'), label);
    for (const r of measured.rows) assert.ok(r.percent <= FIXED_LINE_PERCENT, `${label}: ${r.mode} ${r.percent}% (${r.request} tokens)`);
  }
});

test('TE-7 skills の一覧: 名前の順で決まり、書いた順・使った回数に揺れない。3% の線と 160 字の説明、あふれた分は 1 行', t => {
  const make = () => {
    const db = openDatabase(':memory:', MIGRATIONS);
    t.after(() => db.close());
    return new SkillStore(db, join(tempDir(t), 'skills'));
  };
  const a = make();
  const b = make();
  write200(a);
  write200(b, [...Array(200).keys()].reverse());
  for (let i = 199; i >= 150; i--) b.recordUse(skillName(i));
  const budget = skillsIndexBudget(45_875);
  assert.equal(budget, 1_376);
  const text = a.index('en', budget);
  assert.equal(b.index('en', budget), text);
  assert.equal(a.index('en', budget), text);
  assert.ok(estimateTextTokens(text) <= budget, `${estimateTextTokens(text)} > ${budget}`);
  const lines = text.split('\n');
  const items = lines.slice(2, -1);
  assert.ok(items.length > 0 && items.length < 200, String(items.length));
  assert.deepEqual(items.map(line => line.slice(2, line.indexOf(':'))), [...Array(items.length).keys()].map(skillName));
  for (const line of items) assert.ok([...line.slice(line.indexOf(': ') + 2)].length <= SKILLS_INDEX_DESCRIPTION_MAX, line);
  assert.equal(lines.at(-1), `- ${200 - items.length} more not listed here (read with skill_view; a name it does not know returns the full list)`);
  assert.equal(a.index('en', 1_000_000).split('\n').length, 202, '線が広ければ全部載り、あふれの行は無い');
});

test('TE-7 skills の一覧: 線は会話で使えるいちばん小さいモデルの使える量の 3% で、モデルが大きければ広がる', async t => {
  const model = { ...MEASURE_MODEL, provider: 'fake', contextLength: 262_144 };
  const s = await startApp(t, { models: [model], tools: builtinTools() });
  write200(s.app.skills);
  s.adapter().scripts = [reply('ok')];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'x' });
  await settled(s.app, sent.body.runId);
  const frozen = s.adapter().calls.at(-1)!.system.frozen;
  const budget = skillsIndexBudget(contextAvailable(model.contextLength, maxOutputFor(model, model.contextLength)));
  const section = frozen.slice(frozen.indexOf('# Skills (procedures)')).split('\n').filter(line => line.startsWith('- skill-') || line.includes('more not listed here'));
  const listed = section.filter(line => line.startsWith('- skill-')).length;
  assert.ok(budget > 1_376, String(budget));
  assert.equal(section.join('\n'), s.app.skills.index('en', budget).split('\n').slice(2).join('\n'));
  assert.ok(listed > s.app.skills.index('en').split('\n').length - 3, String(listed));
});

test('TE-7 skills の一覧: 渡された並びによらず、一覧そのものが名前の順に並べる', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skill = (name: string): Skill => ({ name, description: name, body: 'Steps', uses: 0, lastUsedAt: null, updatedAt: 0, registered: true });
  class Reversed extends SkillStore { override listRegistered(): Skill[] { return [skill('b-skill'), skill('a-skill')]; } }
  const lines = new Reversed(db, join(tempDir(t), 'skills')).index('en').split('\n').slice(2);
  assert.deepEqual(lines, ['- a-skill: a-skill', '- b-skill: b-skill']);
});

test('TE-7 skills の一覧: 一覧から落ちた skill も skill_view で見つかる（知らない名前で全部の名前が返る）', async t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skills = new SkillStore(db, join(tempDir(t), 'skills'));
  write200(skills);
  assert.ok(!skills.index('en', skillsIndexBudget(45_875)).includes(skillName(199)));
  const out = await skillView.execute({ name: '?' }, skillCtx(skills));
  assert.equal(out.isError, true);
  assert.ok(out.content.includes(skillName(199)), out.content.slice(0, 200));
});
