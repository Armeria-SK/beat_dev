import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { requirementsText, REQUIREMENTS_COMPACT_BELOW } from '../src/engine/workspace.ts';
import { resolvePaths } from '../src/paths.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir } from './helpers.ts';

const FULL_RULE = /## Widen to daily use\n/u;
const SECTIONS = /Sections: Goal \([^)]*\), Scope \([^)]*\), Daily use, Assumptions, Steps, Risks, Open questions\./u;

function fullRules(text: string): void {
  assert.match(text, FULL_RULE);
  const section = text.split('\n## ').find(part => part.startsWith('Widen to daily use'))!;
  assert.match(section, /3-5 scenes of daily use/u);
  assert.match(section, /ai_added/u);
  assert.match(section, /notDoing/u);
  assert.match(section, /ask_owner/u);
  assert.match(section, /at most 6/iu);
  assert.match(section, /Daily use section/u);
  assert.match(text, SECTIONS);
}

function compactRule(text: string): void {
  assert.doesNotMatch(text, FULL_RULE);
  const lines = text.split('\n').filter(line => /everyday scenes/u.test(line));
  assert.equal(lines.length, 1, '小さい形は 1 文だけ');
  const [line] = lines as [string];
  for (const rule of [/ai_added/u, /at most 6/iu, /notDoing/u, /ask_owner/u, /under Daily use\.$/u]) assert.match(line, rule);
  assert.match(text, /sections: Goal, Scope, Daily use, Assumptions,/u);
}

test('U1 要件の聞き取りの文: 使える量が 32,000 以上なら「毎日使う場面へ広げる」節（AI が足すのは 6 つまで・計画の節 Daily use）、未満なら同じことを 1 文で', t => {
  const paths = resolvePaths(tempDir(t));
  fullRules(requirementsText(paths, REQUIREMENTS_COMPACT_BELOW));
  compactRule(requirementsText(paths, REQUIREMENTS_COMPACT_BELOW - 1));
});

test('U1 毎回の system（本物の App）: 製品の計画モードの会話に、大きいモデルでは「Daily use」の節、使える量が 32,000 未満のモデルでは 1 文が入る', async t => {
  const products = realpathSync.native(tempDir(t));
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('small', { contextLength: 98_304, maxOutputTokens: 80_716 })], projectFolderExempt: [products], tools: builtinTools() });
  const dir = join(products, 'shop');
  mkdirSync(dir, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root: dir });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = (made.body.project as { id: string }).id;
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    if (sent.status === 202 && sent.body.runId) await settled(s.app, sent.body.runId);
  };
  s.adapter().scripts = [reply('a'), reply('b')];
  await send(uuid(1), { text: 'plan', projectId, permissionMode: 'plan' });
  fullRules(s.adapter().calls.at(-1)!.system.dynamic);
  await send(uuid(2), { text: 'plan', projectId, permissionMode: 'plan', modelId: 'small' });
  const small = s.adapter().calls.at(-1)!.system.dynamic;
  assert.match(small, /# Requirements interview \(compact\)\n/u);
  compactRule(small);
});
