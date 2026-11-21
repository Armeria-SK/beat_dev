import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { selfRunRig } from './helpers/self-run-rig.ts';

// P3 (plans/beat/steps/self-run-approvals/PLAN.md, V29): reading outside content never by itself changes where a call goes
const WIN = process.platform === 'win32';
const CURL = WIN ? 'curl.exe' : 'curl';
const LONG = 'a'.repeat(400);

test('V29: 長い問い合わせの GET（curl・wget -O-・iwr）は、外を読んだ実行でも読んでいない実行でも判定役（list.long_query）', async t => {
  const commands: Array<[string, 'bash' | 'powershell']> = [[`${CURL} -s "https://example.com/search?q=${LONG}"`, WIN ? 'powershell' : 'bash'], [`wget -O- "https://example.com/search?q=${LONG}"`, 'bash'], ...(WIN ? [[`iwr "https://example.com/search?q=${LONG}"`, 'powershell'] as [string, 'powershell']] : [])];
  for (const [command, shell] of commands) {
    const seen: string[] = [];
    for (const dirty of [false, true]) {
      const r = selfRunRig(t, c => { c.tools.shell.shell = shell; });
      const { route, pre, detail } = await r.routeOf({ command }, dirty ? r.tainted() : r.ctx);
      assert.ok(pre.reasonKeys?.includes('list.long_query'), `${command}: ${JSON.stringify(pre.reasonKeys)}`);
      assert.ok(pre.askKinds?.includes('egress'), command);
      seen.push(route);
      assert.equal(route, 'judge', `${command} (${dirty}): ${detail}`);
      assert.deepEqual(r.ran, [], '積んだだけで動かない');
    }
    assert.equal(seen[0], seen[1]);
  }
});

test('V29: 短い問い合わせの GET は今までどおり確かめなし、秘密に見える文字の GET は断る。どちらも外を読んだかを問わない', async t => {
  for (const [command, want] of [[`${CURL} -s "https://example.com/search?q=weather"`, 'allow'], [`${CURL} -s "https://example.com/?k=sk-ant-test-0000000000000000"`, 'deny']] as const) {
    for (const dirty of [false, true]) {
      const r = selfRunRig(t);
      const { route, pre, detail } = await r.routeOf({ command }, dirty ? r.tainted() : r.ctx);
      assert.equal(route, want, `${command} (${dirty}): ${detail}`);
      assert.ok(!pre.reasonKeys?.includes('list.long_query'), command);
    }
  }
});

test('V29: MCP の書く道具は外を読んだかを問わず判定役、読む道具は外を読んだかを問わず同じ行き先', async t => {
  const mcp = (name: string, effect: ToolDef['effect']): ToolDef => ({
    name, description: 'mcp (test)', input: Type.Object({}), effect, allowedIn: ['chat', 'task'], mcp: { server: 's1', tool: name.slice(9) }, execute: async () => ({ content: 'ran' }),
    // the same pre-check as src/mcp/tool.ts: a write tool asks, a read tool does not
    preCheck: () => (effect === 'write' ? { decision: 'ask', reasons: ['writes'], askKinds: [], sends: false, removes: false } : { decision: 'allow', reasons: [], sends: false, removes: false }),
  });
  for (const [name, effect] of [['mcp__s1__put', 'write'], ['mcp__s1__get', 'network']] as const) {
    const seen: unknown[] = [];
    for (const dirty of [false, true]) {
      const r = selfRunRig(t);
      const registry = new ToolRegistry().register(shellRun).register(mcp(name, effect));
      const before = r.judge.calls;
      const out = await r.call(name, {}, { ...(dirty ? r.tainted() : r.ctx), kind: 'chat', task: undefined }, { registry });
      seen.push([out.decision, out.decidedBy, r.judge.calls - before]);
    }
    assert.deepEqual(seen[1], seen[0], `${name}: ${JSON.stringify(seen)}`);
    if (effect === 'write') assert.equal((seen[0] as [string, string, number])[2], 1, 'the write tool goes to the judge');
  }
});

test('V29: 外を読んだことで聞き方を変える部品が src に残っていない', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/u.test(name)) files.push(path);
    }
  };
  walk(join(import.meta.dirname, '..', 'src'));
  const left = files.flatMap(file => {
    const text = readFileSync(file, 'utf8');
    return ['escalateOnTaint', 'SHELL_FETCH_TO_JUDGE', 'owner_task_taint', 'fetchEgress', "'pipeline.taint'", "'pipeline.shell_fetch'"].filter(word => text.includes(word)).map(word => `${file}: ${word}`);
  });
  assert.deepEqual(left, []);
  const skills = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'builtin', 'skills.ts'), 'utf8');
  const autoOk = skills.split('\n').find(line => line.includes('const autoOk'))!;
  assert.match(autoOk, /ctx\.kind === 'review' \?/u, 'only a review looks at the taint');
  assert.doesNotMatch(autoOk.split(':').slice(1).join(':'), /taint/u, 'a chat or task run does not look at the taint');
});
