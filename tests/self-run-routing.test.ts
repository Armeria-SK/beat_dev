import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
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
    const before = r.judge.prompts.length;
    const { route, pre, detail } = await r.routeOf(c.input);
    if (route !== c.want) got.push(`${c.name}: ${route} (want ${c.want}) keys=${JSON.stringify(pre.reasonKeys)} ${detail.slice(0, 160)}`);
    const prompt = route === 'judge' ? r.judge.prompts[before]?.user ?? '' : '';
    if (c.input.command.startsWith('npx tsx src/cli.ts') && route === 'judge' && (prompt.includes('<<FILES-') || !prompt.includes(c.input.command))) got.push(`${c.name}: npx tsx must reach the judge as the command only (R23)`);
    if (c.input.command === 'node scripts/poke.ts' && route === 'judge') {
      const files = prompt.slice(prompt.indexOf('<<FILES-'), prompt.indexOf('<<END-FILES-'));
      if (!files.includes(join(r.ws, 'scripts/poke.ts')) || !files.includes('fetch(')) got.push(`${c.name}: the judge was not shown scripts/poke.ts: ${files.slice(0, 160)}`);
    }
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

test('P1 V8: 道具の読む env・コードの読まない名前・決まっていない node の旗は、順 4 にならない（env は判定役、node の旗は判定役に見せずに持ち主）', async t => {
  const r = selfRunRig(t);
  const cases = [
    'node --watch scripts/e2e.ts', 'node --inspect scripts/e2e.ts', 'node --require ./scripts/e2e.ts .tmp/probe.ts',
    ...(PS ? ["$env:npm_config_userconfig='x'; npm start", "$env:BROWSER='x'; npm start", "$env:COR_PROFILER='x'; npm start", "$env:NODE_OPTIONS='--require ./x.js'; npm start",
      "$env:LUA_INIT='x'; npm start", "$env:KUBECONFIG='x'; npm start", "$env:OTHER_DB='x.db'; npm start", "$env:PORT='3999'; npm start"] : []),
  ];
  const got: string[] = [];
  for (const command of cases) {
    const { route, pre } = await r.routeOf({ command });
    const want = command.startsWith("$env:PORT='3999'") ? 'step4' : command.startsWith('node --') ? 'owner' : 'judge';
    if (route !== want) got.push(`${command}: ${route} (want ${want}) keys=${JSON.stringify(pre.reasonKeys)}`);
  }
  assert.deepEqual(got, []);
});

// The product of the v3 trial (plans/beat/steps/v3-approvals/PLAN.md): the same shapes as tmp/beat-ux-trial/study
export const V3_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'study-hub', type: 'commonjs', scripts: { start: 'node server.js', test: 'node scripts/smoke-test.js' } }, null, 2),
  'lib/db.js': "const { DatabaseSync } = require('node:sqlite');\nconst path = require('node:path');\nmodule.exports = dir => new DatabaseSync(path.join(dir, 'study.sqlite'));\n",
  'lib/app.js': [
    'function createApp(db) {',
    '  return (req, res) => {',
    "    db.exec('BEGIN IMMEDIATE');",
    "    const host = String(req.headers.host || 'localhost').replace(/[^\\w.:\\-\\[\\]]/g, '');",
    "    const url = new URL(req.url, 'http://localhost');",
    '    res.end(host + url.pathname);',
    '  };',
    '}',
    'module.exports = { createApp };',
    '',
  ].join('\n'),
  'scripts/smoke-test.js': [
    "const http = require('node:http');",
    "const { createApp } = require('../lib/app.js');",
    'const server = http.createServer(createApp({ exec() {} }));',
    'let base;',
    '(async () => {',
    "  await new Promise((r) => server.listen(0, '127.0.0.1', r));",
    "  base = 'http://127.0.0.1:' + server.address().port;",
    "  const r = await fetch(base + '/api/admin/members', { method: 'POST' });",
    '  console.log(r.status);',
    '  server.close();',
    '})();',
    '',
  ].join('\n'),
  'scripts/seed.js': "const path = require('node:path');\nconst dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));\nconsole.log(dataDir);\n",
  'server.js': [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const http = require('node:http');",
    '// .env があれば読み込む(既にある環境変数が優先)',
    'function loadDotEnv(file) {',
    '  if (!fs.existsSync(file)) return;',
    "  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {",
    '    const m = /^(\\w+)=(.*)$/.exec(line);',
    '    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];',
    '  }',
    '}',
    "loadDotEnv(path.join(__dirname, '.env'));",
    'const port = Number(process.env.PORT || 3000);',
    "const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));",
    "const passphrase = process.env.ADMIN_PASSPHRASE || '';",
    "const server = http.createServer((req, res) => res.end('ok'));",
    'server.listen(port, () => {',
    '  console.log(`study hub: http://localhost:${port}/ (data: ${dataDir}, ${passphrase.length})`);',
    '});',
    '',
  ].join('\n'),
};

const SQLITE_PROBE = "node -e \"const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(':memory:'); d.exec('create table t(a)'); console.log('sqlite ok')\"";

test('v3 P1: #52（版を見るだけ + git log | head）と #53（SQLite を試す node -e）は判定役に回り、判定役はコマンド（#53 はその場のコードそのもの）を見る', async t => {
  const r = selfRunRig(t, () => undefined, V3_FILES);
  const got: string[] = [];
  const cases: Array<{ command: string; want: Route; ps?: boolean }> = [
    { command: 'node -v; npm -v; git log --oneline | head -3', want: 'judge', ps: true },
    { command: SQLITE_PROBE, want: 'judge' },
  ];
  for (const c of cases) {
    if (c.ps && !PS) continue;
    const before = r.judge.prompts.length;
    const { route, pre, detail } = await r.routeOf({ command: c.command });
    if (route !== c.want) { got.push(`${c.command}: ${route} (want ${c.want}) keys=${JSON.stringify(pre.reasonKeys)} ${detail.slice(0, 160)}`); continue; }
    const prompt = r.judge.prompts[before]?.user ?? '';
    if (!prompt.includes(c.command)) got.push(`${c.command}: the judge did not see the command`);
    if (prompt.includes('<<FILES-')) got.push(`${c.command}: FILES shown`);
  }
  assert.deepEqual(got, []);
});

test('v3 P1: 版の表示がコードの実行に変わる形・実行が 2 つ・別のプログラムを起こすその場のコード・送信は、持ち主に行ったまま', async t => {
  const r = selfRunRig(t, () => undefined, V3_FILES);
  const cases = [
    ...(PS ? ["$env:NODE_OPTIONS='--require ./x.js'; node -v"] : ['NODE_OPTIONS=--require=./x.js node -v']),
    ...(PS ? ['node -v; node x.js; node y.js | head -3'] : []),
    "node -e \"require('child_process').exec('x')\"",
    "node -e \"const {exec}=require('child_process'); exec('x')\"",
    "node -e \"process.binding('spawn_sync').spawn({})\"",
    "python -c \"import os; os.popen('x')\"",
    "ruby -e \"Kernel.exec('x')\"",
    "node -e \"fetch('http://x')\"",
  ];
  const got: string[] = [];
  for (const command of cases) {
    const { route, pre, detail } = await r.routeOf({ command });
    if (route !== 'owner') got.push(`${command}: ${route} (want owner) keys=${JSON.stringify(pre.reasonKeys)} ${detail.slice(0, 120)}`);
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
