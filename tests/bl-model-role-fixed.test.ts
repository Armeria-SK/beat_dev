import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App } from '../src/app.ts';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import { requiredContext } from '../src/engine/status.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

const model = (id: string, contextLength: number): ModelConfig => ({ id, provider: 'fa', model: id, contextLength, maxOutputTokens: 1024, vision: false });

async function start(t: { after: (fn: () => void) => void }, routing: Partial<AppConfig['routing']>) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fa', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [model('chat-m', 200_000), model('bg-m', 200_000)];
  config.routing = { chat: [], background: [], ...routing, retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  t.after(() => app.close());
  await app.status.probeAll(app.config());
  const reroute = (next: Partial<AppConfig['routing']>, bgContext?: number) => {
    const current = app.config();
    return app.applyConfig({ ...current, routing: { ...current.routing, chat: [], background: [], ...next }, models: current.models.map(m => (m.id === 'bg-m' && bgContext !== undefined ? { ...m, contextLength: bgContext } : m)) });
  };
  const bg = () => app.config().models.find(m => m.id === 'bg-m')!;
  const chat = () => app.config().models.find(m => m.id === 'chat-m')!;
  return { app, reroute, bg, chat };
}

// Tools only a conversation is given (an external MCP server's tools are offered to chat, never to a task)
const chatOnlyTools = (count: number): ToolDef[] => Array.from({ length: count }, (_, i) => ({
  name: `mcp_big_t${i}`, description: 'Does one thing.', input: Type.Object({}), effect: 'read', allowedIn: ['chat'], mcp: { server: 'big', tool: `t${i}` },
  async execute() { return { content: '' }; },
}));

test('裏の仕事だけのモデルは、会話だけの道具が増えても、会話の道具の大きさで「使えない」にならない', async t => {
  const s = await start(t, { chat: ['chat-m'], background: ['bg-m'] });
  const before = s.app.baseTokens(s.bg());
  s.app.tools.setGroup('big', chatOnlyTools(300));
  assert.equal(s.app.baseTokens(s.bg()), before, '裏の仕事だけのモデルの数え方に、会話だけの道具は入らない');
  const chatSize = s.app.baseTokens(s.chat());
  assert.ok(chatSize > before + 3000, `会話のモデルの数え方には入る（${chatSize} と ${before}）`);

  const needs = requiredContext(s.bg(), s.app.baseTokens(s.bg()), s.app.memoryTokens());
  const asChat = requiredContext(s.bg(), s.app.baseTokens(), s.app.memoryTokens());
  assert.ok(asChat > needs + 3000, '会話の道具の大きさで数えると、必要な長さがこれだけ大きくなる');
  const length = needs + 500;
  assert.ok(length < asChat);

  await s.reroute({ chat: ['chat-m'], background: ['bg-m'] }, length);
  assert.equal(s.app.status.get('bg-m')!.status, 'ok', s.app.status.get('bg-m')!.message);
  assert.equal(s.app.status.get('bg-m')!.required, needs);
  assert.equal(s.app.status.get('chat-m')!.status, 'ok');
  assert.equal(s.app.engine.backgroundBlocked(), undefined, '裏の仕事を始める側（エンジン）も、このモデルを使える先として数える');

  await s.reroute({ chat: ['chat-m', 'bg-m'], background: ['bg-m'] });
  const asBoth = s.app.status.get('bg-m')!;
  assert.equal(asBoth.status, 'too_small', '会話にも入れたら、会話の道具で数える（今までと同じ）');
  assert.equal(asBoth.required, asChat);
  assert.ok(s.app.engine.backgroundBlocked(), '会話の道具の大きさでは入らないので、裏の仕事の先としても使えない');
});

test('会話に割り当てたモデルは、今までと同じ数え方（会話の道具）で判定する', async t => {
  const s = await start(t, { chat: ['chat-m'], background: ['bg-m'] });
  s.app.tools.setGroup('big', chatOnlyTools(50));
  const today = s.app.baseTokens();
  assert.equal(s.app.baseTokens(s.chat()), today, '会話に入っているモデル');
  assert.ok(s.app.baseTokens(s.bg()) < today, '前提: 裏の仕事だけのモデルは、会話より小さい数え方になる');

  await s.reroute({ chat: ['chat-m', 'bg-m'], background: ['bg-m'] });
  assert.equal(s.app.baseTokens(s.bg()), today, '会話にも裏の仕事にも入っているモデル');

  await s.reroute({ chat: ['chat-m'], background: [] });
  assert.equal(s.app.baseTokens(s.chat()), today, '裏の順番が空なら、会話のモデルが裏の仕事も受け持つ');

  await s.reroute({ chat: ['chat-m'], background: ['chat-m'], judge: ['bg-m'] });
  assert.equal(s.app.baseTokens(s.bg()), today, 'どちらの順番にも入っていないモデル（判定役だけ・選ばれて使うだけ）は、会話で使われうるので会話で数える');

  await s.reroute({});
  assert.equal(s.app.baseTokens(s.bg()), today, '順番がどちらも空なら、全部のモデルが会話に使われる');
});
