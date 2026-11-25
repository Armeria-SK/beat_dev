import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// shell_run の timeoutSec が設定の上限（maxTimeoutSec）より大きいとき、黙って切り下げず、返事に切り下げたことと上限を書く。
// 道具の説明も、設定の上限と食い違う数を言わない

function setup(t: { after: (fn: () => void) => void }, maxTimeoutSec: number) {
  const dir = realpathSync.native(tempDir(t));
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.shell.maxTimeoutSec = maxTimeoutSec;
  const config = parseConfig(raw);
  const policy = buildPolicy(config, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, workspace: defaultWorkspace(policy, paths),
    taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  return { ctx, config };
}

const QUICK = 'node -e "console.log(1)"';

test('timeoutSec が上限より大きいとき、返事に「切り下げた」ことと上限の秒数を書く', async t => {
  const s = setup(t, 2);
  const out = await shellRun.execute({ command: QUICK, timeoutSec: 900 }, s.ctx, undefined as never);
  assert.equal(out.isError, false, out.content);
  assert.match(out.content, /timeoutSec was 900 s, but the limit is 2 s, so 2 s was used/u);
});

test('上限を超える timeoutSec で本当に切られたとき、切られた秒数の行と切り下げの行の両方がある', async t => {
  const s = setup(t, 1);
  const out = await shellRun.execute({ command: 'node -e "setTimeout(() => {}, 20000)"', timeoutSec: 900 }, s.ctx, undefined as never);
  assert.equal(out.isError, true);
  assert.match(out.content, /Stopped after the 1 s timeout/u);
  assert.match(out.content, /timeoutSec was 900 s, but the limit is 1 s, so 1 s was used/u);
});

test('上限以下の timeoutSec・timeoutSec 無しでは、切り下げの行を付けない', async t => {
  const s = setup(t, 3);
  for (const input of [{ command: QUICK, timeoutSec: 3 }, { command: QUICK, timeoutSec: 2 }, { command: QUICK }]) {
    const out = await shellRun.execute(input, s.ctx, undefined as never);
    assert.equal(out.isError, false, out.content);
    assert.doesNotMatch(out.content, /timeoutSec was/u, JSON.stringify(input));
  }
});

test('道具の説明は、設定の上限（maxTimeoutSec）の秒数を言い、切り下げて返事に書くと伝える', t => {
  const s = setup(t, 900);
  const [spec] = ToolRegistry.specs([shellRun], s.config);
  assert.match(spec!.description, /timeoutSec cannot go above the maximum set in the settings \(900 s\)/u);
  assert.match(spec!.description, /lowered to that maximum and the result says so/u);
  assert.doesNotMatch(spec!.description, /\b600 s\b/u);
  assert.match(shellRun.description, /lowered to that maximum and the result says so/u, '設定を渡さない説明にも、上限があることは書く');
});
