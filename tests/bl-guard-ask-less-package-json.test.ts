import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileRead, fileReadLog, fileWrite } from '../src/tools/builtin/files.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { runToolCall, type PipelineDeps } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// L157: 製品の package.json を file_write で書くと聞かれる、という報告の確かめ。既定の守る一覧（.github/workflows/**）に package.json は無く、
// 外を読んだかどうかでも、会話・タスクのどちらでも、ふつうのファイルを書くのと同じに（判定役も Pending も呼ばずに）通る。一覧に書いたときだけ owner で積む

function rig(t: { after: (fn: () => void) => void }, always?: string[]) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  raw.tools.hooks.preToolUse = [always ? { ...DEFAULT_PROTECT_FILES, always } : DEFAULT_PROTECT_FILES];
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(fileWrite);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const root = join(paths.workspace, 'prod');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push');
  const project = { id: 'p1', root };
  const policy = buildPolicy(config, paths, { root }, [root]);
  const ctx: ToolContext = { runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, workspace: root, taint: { tainted: false, sources: [] }, log: () => undefined, project };
  ctx.fileReads = fileReadLog(new KV(db), ctx.conversationId);
  const judged: string[] = [];
  const deps: PipelineDeps = {
    registry, approvals, pending, db, emit: () => undefined, conversationTainted: () => false, lastUserRequest: () => 'please add a dependency to the product',
    autoClassify: async prompt => { judged.push(prompt.user); return '{"decision":"allow","reason":"fits the request"}'; },
  };
  const write = async (name: string, c: Partial<ToolContext> = {}) => {
    await fileRead.execute({ path: name }, ctx);
    const outcome = await runToolCall({ id: `call-${Math.random()}`, name: 'file_write', arguments: { path: name, content: '{"name":"p"}' } }, { ...ctx, ...c }, deps);
    return { decision: outcome.decision, decidedBy: outcome.decidedBy, content: outcome.output.content, judged: judged.length, waiting: pending.list({ status: 'waiting' }).map(row => row.kind) };
  };
  return { write };
}

const TAINTED = { taint: { tainted: true, sources: ['web_fetch'] } };
const TASK = { kind: 'task' as const, permissionMode: 'auto' as const, task: { id: 't1', control: { outcome: 'none' as const } } };
const CASES: Array<[string, Partial<ToolContext>]> = [['会話・外を読んでいない', {}], ['会話・外を読んだ', TAINTED], ['タスク（auto）・外を読んでいない', TASK], ['タスク（auto）・外を読んだ', { ...TASK, ...TAINTED }]];

test('L157（再現しない）: 既定の守る一覧では、package.json への file_write は、ふつうのファイルと同じに確かめなしで通る（会話もタスクも、外を読んだ後も）', async t => {
  for (const [label, c] of CASES) {
    const r = rig(t);
    const control = await r.write('notes.txt', c);
    const pkg = await r.write('package.json', c);
    assert.deepEqual([control.decision, control.decidedBy, control.judged, control.waiting], ['allow', 'builtin', 0, []], `${label}: 比べるふつうのファイル: ${control.content}`);
    assert.deepEqual([pkg.decision, pkg.decidedBy, pkg.judged, pkg.waiting], ['allow', 'builtin', 0, []], `${label}: package.json: ${pkg.content}`);
  }
});

test('L157 対照: 守る一覧に package.json を書いたときと、既定の一覧の .github/workflows の中は、判定役を呼ばずに守る一覧の確かめ（hook）で積む', async t => {
  for (const [label, c] of CASES) {
    const listed = await rig(t, ['.github/workflows/**', 'package.json']).write('package.json', c);
    assert.deepEqual([listed.decidedBy, listed.judged, listed.waiting], ['pending', 0, ['hook']], `${label}: 一覧に書いた package.json: ${listed.content}`);
    const workflow = await rig(t).write('.github/workflows/ci.yml', c);
    assert.deepEqual([workflow.decidedBy, workflow.judged, workflow.waiting], ['pending', 0, ['hook']], `${label}: 既定の一覧の workflows: ${workflow.content}`);
  }
});
