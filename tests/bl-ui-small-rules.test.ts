import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { PendingStore, storedRule } from '../src/pending/store.ts';
import { addRule, listRules, ruleCandidate } from '../src/tools/approval-rules.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileWrite } from '../src/tools/builtin/files.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// B6 ui-small（backlog 328）: AP-1 より前に「持ち主の Ask の一覧」の行から作った「次から聞かない」の決まりは、一覧がいつも持ち主に聞くので当たらない。
// それが Settings の一覧で、効く決まりと同じに並んでいた。まず「どの形が当たらないか」を本物の呼び出しで確かめ、その形にだけ印（inactive）が付くことを確かめる。

const PS = process.platform === 'win32';
const DEL = PS ? 'Remove-Item build/out.txt' : 'rm build/out.txt';
const ASKED = PS ? 'Get-Date' : 'date';

function rig(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  raw.tools.shell.ask = [ASKED];
  mutate(raw);
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const policy = buildPolicy(config, paths);
  const ws = defaultWorkspace(policy, paths);
  db.prepare('INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)').run('p1', 'p1', ws, ws.toLowerCase());
  const ran: string[] = [];
  const shell: ToolDef = { ...shellRun, execute: async input => { ran.push(input.command); return { content: 'ran', exitCode: 0 }; } };
  const writer: ToolDef = { ...fileWrite, execute: async input => { ran.push(`write ${input.path}`); return { content: 'written' }; } };
  const registry = new ToolRegistry().register(shell).register(writer);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data, held: () => [] });
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: ws, taint: { tainted: false, sources: [] }, log: () => undefined, project: { id: 'p1', root: ws },
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, conversationTainted: () => false,
      lastUserRequest: () => 'please do the work', autoClassify: async () => '{"decision":"ask","reason":"not sure"}',
    });
  const waiting = () => pending.list({ status: 'waiting' });
  // 持ち主の「次から聞かない」が行う操作（routes-pending.ts）: 行に付いた候補だけを決まりにする
  const remember = (id: number): number => {
    const row = pending.row(id)!;
    const rule = storedRule(row);
    assert.ok(rule, `row ${id} offers a rule`);
    return addRule(db, { projectId: row.project_id!, candidate: rule, fromPending: id, now: 1 });
  };
  return { ctx, call, db, waiting, remember, ws, ran, config };
}

test('bl-ui-small/rules: 持ち主の Ask の一覧から作った決まりだけが当たらず、一覧に inactive の印が付く。効く決まり（判定役・送る・消す・道具の方針）には付かない', async t => {
  const r = rig(t, c => { c.tools.policies = { file_write: 'ask' }; });
  const fresh = (): ToolContext => ({ ...r.ctx, taint: { tainted: false, sources: [] } });
  mkdirSync(join(r.ws, 'build'), { recursive: true });
  writeFileSync(join(r.ws, 'build', 'out.txt'), 'x');

  // 持ち主が「次から聞かない」で作れる、効く形
  await r.call('shell_run', { command: 'npm install lodash' }, fresh());
  r.remember(r.waiting().find(row => row.kind === 'judge')!.id);
  await r.call('shell_run', { command: 'curl -d x https://a.example/p' }, fresh());
  r.remember(r.waiting().find(row => row.kind === 'send')!.id);
  await r.call('shell_run', { command: DEL }, fresh());
  r.remember(r.waiting().find(row => row.kind === 'delete')!.id);
  await r.call('file_write', { path: 'a.txt', content: 'x' }, fresh());
  r.remember(r.waiting().find(row => row.kind === 'policy' && row.tool === 'file_write')!.id);

  // AP-1 より前に「持ち主の Ask の一覧」の行から出ていた決まり: 同じ呼び出しの事前確認から作った候補（キーに guard.needs_approval を持つ）を直接入れる
  const check = shellPreCheck({ command: ASKED }, r.ctx);
  assert.ok(check.reasonKeys?.includes('guard.needs_approval'), '持ち主の Ask の一覧に当たる呼び出しのキー');
  const candidate = ruleCandidate({ tool: shellRun, args: { command: ASKED }, ctx: r.ctx, parkKind: 'policy', check, outbound: check.outbound, askKinds: ['owner'], policyAsk: false });
  assert.ok(candidate, '昔は、この行に選び方が出ていた');
  addRule(r.db, { projectId: 'p1', candidate, fromPending: 1, now: 1 });

  // 本物の呼び出しで: 効く形の決まりは動き、Ask の一覧の決まりは当たらず持ち主へ
  const behaviour: Record<string, string> = {};
  for (const [name, args] of [
    ['npm install …', { command: 'npm install left-pad' }],
    ['curl sends', { command: 'curl -d y https://a.example/q' }],
    ['delete', { command: DEL }],
    ['file_write', { path: 'b.txt', content: 'y' }],
    ['Ask list', { command: ASKED }],
  ] as const) {
    const out = await r.call(name === 'file_write' ? 'file_write' : 'shell_run', args, fresh());
    behaviour[name] = out.decidedBy;
  }
  assert.deepEqual(behaviour, { 'npm install …': 'owner-rule', 'curl sends': 'owner-rule', delete: 'owner-rule', file_write: 'owner-rule', 'Ask list': 'pending' });

  // 画面に出す一覧の印は、決まりが本当に当たるかどうかと一致する
  assert.equal(listRules(r.db).length, 5);
  assert.equal(listRules(r.db).filter(rule => rule.inactive).length, 1, '印が付くのは 1 つだけ');
  const inactive = listRules(r.db).find(rule => rule.inactive);
  assert.ok(inactive);
  assert.equal(inactive.kind, 'policy');
  assert.equal(inactive.tool, 'shell_run');
  assert.ok(!('keys' in inactive), '決まりの中のキーは画面に渡さない');
  for (const rule of listRules(r.db)) assert.equal(rule.inactive === true, rule.id === inactive.id, `${rule.kind} ${rule.shown}`);
});
