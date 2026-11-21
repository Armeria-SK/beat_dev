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

// レビューの指摘（2026-11-21）を形で縛る: 最初の質問の前に広げて同じ ask_owner の回で聞く（2 回目の質問の回を作らない）・
// 当てはまらない場面は飛ばす・「やらない」は AI の出どころで書き、固定のあとは計画の Scope out へ・6 つは一覧ごと
const SHARED: RegExp[] = [/Before first questions/u, /ai_added/u, /notDoing lines? \(source ai_added; (once )?locked: plan Scope out\)/u, /same ask_owner round/u, /at most 6 (such items )?per list/iu, /skip(ping)? covered/iu];

function fullRules(text: string): void {
  assert.match(text, FULL_RULE);
  const section = text.split('\n## ').find(part => part.startsWith('Widen to daily use'))!;
  for (const rule of [...SHARED, /3-5 daily-use scenes/u, /a small change may need none/u, /after go ahead: an assumption/u, /Daily use section/u]) assert.match(section, rule);
  assert.match(text, SECTIONS);
}

function compactRule(text: string): void {
  assert.doesNotMatch(text, FULL_RULE);
  const lines = text.split('\n').filter(line => /everyday scenes/u.test(line));
  assert.equal(lines.length, 1, '小さい形は 1 文だけ');
  const [line] = lines as [string];
  for (const rule of [...SHARED, /under Daily use\.$/u]) assert.match(line, rule);
  assert.match(text, /sections: Goal, Scope, Daily use, Assumptions,/u);
}

test('U1 要件の聞き取りの文: 使える量が 32,000 以上なら「毎日使う場面へ広げる」節（AI が足すのは 6 つまで・計画の節 Daily use）、未満なら同じことを 1 文で', t => {
  const paths = resolvePaths(tempDir(t));
  fullRules(requirementsText(paths, REQUIREMENTS_COMPACT_BELOW));
  compactRule(requirementsText(paths, REQUIREMENTS_COMPACT_BELOW - 1));
});

test('U1 毎回の system（本物の App）: 製品の計画モードの会話で、{build_button} の置き換えと system の組み立てのあとも「Daily use」の節（大きいモデル）・1 文（使える量が 32,000 未満）が欠けずに届く', async t => {
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
