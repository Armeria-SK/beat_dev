import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfRunRig, type Route } from './helpers/self-run-rig.ts';

const PS = process.platform === 'win32';

// The commands of the trial (plans/beat/steps/self-run-approvals/PLAN.md, P0) and where each goes in a task run
interface Case { name: string; input: { command: string; background?: boolean; timeoutSec?: number }; want: Route; ps?: boolean }
export const TRIAL_CASES: readonly Case[] = [
  { name: '#46 probe', input: { command: 'node --disable-warning=ExperimentalWarning .tmp/probe.ts' }, want: 'step4' },
  { name: '#48 e2e', input: { command: 'node --disable-warning=ExperimentalWarning scripts/e2e.ts 2>&1 | Select-Object -Last 60' }, want: 'step4', ps: true },
  { name: '#50 start (background)', input: { command: '$env:ROOMS_DB=".tmp/start-check.db"; $env:PORT="3999"; npm start', background: true }, want: 'step4', ps: true },
  { name: '#51 start (6 s)', input: { command: '$env:ROOMS_DB=".tmp/start-check.db"; $env:PORT="3999"; npm start', timeoutSec: 6 }, want: 'step4', ps: true },
  { name: 'v1 #43 cli', input: { command: 'npx tsx src/cli.ts samples/sample.csv' }, want: 'judge' },
  { name: 'v1 #44 cli --month', input: { command: 'npx tsx src/cli.ts samples/sample.csv --month 2026-11' }, want: 'judge' },
  { name: 'strong mark: POST to beat', input: { command: 'node scripts/poke.ts' }, want: 'judge' },
];

test('P0 物差し: 試しの 7 つのコマンドの行き先（タスクの実行）', async t => {
  const r = selfRunRig(t);
  const got: string[] = [];
  for (const c of TRIAL_CASES) {
    if (c.ps && !PS) continue;
    const { route, pre, detail } = await r.routeOf(c.input);
    if (route !== c.want) got.push(`${c.name}: ${route} (want ${c.want}) keys=${JSON.stringify(pre.reasonKeys)} ${detail.slice(0, 160)}`);
  }
  assert.deepEqual(got, []);
});

test('P0 物差し: 外の文を読んだ実行でも、7 つの行き先は同じ', async t => {
  const r = selfRunRig(t);
  const plain = selfRunRig(t);
  const diff: string[] = [];
  for (const c of TRIAL_CASES) {
    if (c.ps && !PS) continue;
    const a = await plain.routeOf(c.input);
    const b = await r.routeOf(c.input, r.tainted());
    if (a.route !== b.route) diff.push(`${c.name}: ${a.route} -> ${b.route} (${b.detail.slice(0, 120)})`);
  }
  assert.deepEqual(diff, []);
});

test('P1 V8: 道具の読む env・コードの読まない名前・決まっていない node の旗は、順 4 にならず判定役へ', async t => {
  const r = selfRunRig(t);
  const cases = [
    'node --watch scripts/e2e.ts', 'node --inspect scripts/e2e.ts', 'node --require ./scripts/e2e.ts .tmp/probe.ts',
    ...(PS ? ["$env:npm_config_userconfig='x'; npm start", "$env:BROWSER='x'; npm start", "$env:COR_PROFILER='x'; npm start", "$env:NODE_OPTIONS='--require ./x.js'; npm start",
      "$env:LUA_INIT='x'; npm start", "$env:KUBECONFIG='x'; npm start", "$env:OTHER_DB='x.db'; npm start", "$env:PORT='3999'; npm start"] : []),
  ];
  const got: string[] = [];
  for (const command of cases) {
    const { route, pre } = await r.routeOf({ command });
    const want = command.startsWith("$env:PORT='3999'") ? 'step4' : 'judge';
    if (route !== want) got.push(`${command}: ${route} (want ${want}) keys=${JSON.stringify(pre.reasonKeys)}`);
  }
  assert.deepEqual(got, []);
});

test('P1 1c: 弱い目印（config.json）は beat 自身に触る印にならず、判定役の文に手がかりとして載る', async t => {
  const r = selfRunRig(t);
  const { route, pre } = await r.routeOf({ command: 'npx tsx src/cli.ts samples/sample.csv' });
  assert.equal(route, 'judge');
  assert.ok(!pre.reasonKeys?.includes('code.self_touch'), JSON.stringify(pre.reasonKeys));
  assert.match(r.judge.prompts.at(-1)!.user, /why it needs approval: .*The code mentions config\.json/u);
});
