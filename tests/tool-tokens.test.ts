import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import { estimateRequest, estimateToolTokens } from '../src/engine/tokens.ts';
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
  return { tools: last.tools.length, toolTokens: estimateToolTokens(last.tools), request: estimateRequest(`${last.system.frozen}\n${last.system.dynamic}`, [], last.tools).tokens };
}

test('T-1 tool-tokens: 既定の設定とブラウザオンの写しで表を出し、製品の計画モードの数は量の線の試験の組み立てと同じ（40% 以下）', async t => {
  for (const [label, configure] of [['default', () => undefined], ['browser', (c: AppConfig) => { c.tools.browser.enabled = true; }]] as const) {
    const measured = await measure(shaped(configure));
    assert.equal(measured.available, 12_672);
    const plan = row(measured, 'product plan');
    const direct = await productPlanRequest(t, configure);
    assert.equal(plan.tools, direct.tools, label);
    assert.equal(plan.toolTokens, direct.toolTokens, label);
    assert.ok(Math.abs(plan.request - direct.request) <= direct.request * 0.02, `${label}: ${plan.request} vs ${direct.request}`);
    assert.ok(plan.percent <= 40, `${label}: ${plan.percent}%`);
    assert.deepEqual(measured.rows.map(r => r.mode), ['product plan', 'plan (no product)', 'chat (no product)', 'chat (product)', 'task', 'review']);
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
    c.models = [{ id: 'zq-model-7c1f', provider: 'zq-provider-7c1f', model: 'zq-name-7c1f', contextLength: 4096, minContext: 1024, maxOutputTokens: 512, vision: false }];
  });
  writeFileSync(file, JSON.stringify(config));
  const before = readFileSync(file, 'utf8');
  const out = execFileSync(process.execPath, ['scripts/tool-tokens.ts', '--config', file], { encoding: 'utf8', env: { ...process.env, ZQ_KEY_7C1F: 'sk-ant-test-0000000000000000' } });
  assert.match(out, /^available: 12672$/mu);
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
