import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { webFetch } from '../src/tools/builtin/web.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { PendingStore } from '../src/pending/store.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { CONVERSATION, settled, startApp, waitFor } from './app-setup.ts';
import { tempDir, testConfig, type Script } from './helpers.ts';

// 外から読んだ内容のあとの書き込みの確かめ（種類が taint だけ）に、「この返事のあいだ、このフォルダ以下への書き込みを許可」を添える。
// 覆うのは、同じ実行の中の file_write / file_edit で、それ自身の確かめも taint だけのもの。それ以外は、すべて今までどおり

function setup(t: { after: (fn: () => void) => void }, options: { tainted?: boolean; mutate?: (c: AppConfig) => void; tools?: ToolDef[] } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun).register(webFetch);
  for (const tool of options.tools ?? []) registry.register(tool);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const makeCtx = (runId: string, tainted = options.tainted !== false): ToolContext => ({
    runId, conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: tainted ? { tainted: true, sources: ['web_fetch'] } : { tainted: false, sources: [] }, log: () => undefined,
  });
  const ctx = makeCtx('r1');
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, judgeAll: true, emit: () => undefined, conversationAutoRead: () => false,
      lastUserRequest: () => 'please write the notes', autoClassify: async () => { judge.calls++; return judge.answer; },
    });
  const judge = { answer: '{"decision":"ask","reason":"not sure"}', calls: 0 };
  const write = (path: string) => join(paths.workspace, path);
  return { paths, ctx, makeCtx, call, approvals, db, write, pending, judge };
}
type Setup = ReturnType<typeof setup>;

// 止まるはず: Pending に積まれ（決めたのは pending）、その行を返す
async function parked(s: Setup, name: string, args: unknown, c: ToolContext = s.ctx) {
  const outcome = await s.call(name, args, c);
  assert.equal(outcome.decidedBy, 'pending', `${name} ${JSON.stringify(args)}: ${outcome.output.content}`);
  return s.pending.list({ status: 'waiting' })[0]!;
}

test('外から読んだあとの書き込みのうち、保護された場所（人格・.git・道具の設定）・シェル・許可フォルダの外・次の実行は、止まったまま', async t => {
  const s = setup(t);
  for (const [path, kind] of [['SOUL.md', 'owner'], ['.git/config', 'owner'], ['.curlrc', 'owner'], ['sub/.gitattributes', 'judge'], ['.bashrc', 'judge'], ['.yarnrc', 'judge']] as const) {
    const row = await parked(s, 'file_write', { path, content: 'x' });
    assert.equal(row.kind, kind, path);
    assert.equal(existsSync(s.write(path)), false, `${path}: 書かれていない`);
  }
  assert.equal((await parked(s, 'shell_run', { command: 'echo hello' })).kind, 'judge');
  assert.equal((await parked(s, 'shell_run', { command: 'echo x > sub/s.txt' })).kind, 'judge');
  assert.equal(existsSync(s.write('sub/s.txt')), false);
  const outside = await s.call('file_write', { path: '../outside.txt', content: 'x' });
  assert.deepEqual([outside.decision, outside.decidedBy], ['deny', 'builtin']);
  assert.equal(existsSync(join(s.paths.workspace, '..', 'outside.txt')), false);
  const next = s.makeCtx('r2');
  assert.equal((await parked(s, 'file_write', { path: 'sub/y.txt', content: 'Y' }, next)).kind, 'judge');
  assert.equal(existsSync(s.write('sub/y.txt')), false);
});

test('外から読んでいなくても止まる書き込み（人格・.git）は Pending に積まれ、ふつうの書き込みは止まらない。方針 ask は Pending、鍵らしい文字を含む通信は断る', async t => {
  const plain = setup(t, { tainted: false });
  plain.judge.answer = '{"decision":"allow","reason":"fits the request"}';
  assert.equal((await parked(plain, 'file_write', { path: 'SOUL.md', content: 'x' })).kind, 'owner');
  assert.equal(existsSync(plain.write('SOUL.md')), false);
  assert.equal((await parked(plain, 'file_write', { path: '.git/config', content: 'x' })).kind, 'owner');
  assert.equal((await fileWrite.preCheck!({ path: '.git/config', content: 'x' }, plain.ctx)).onceOnly, true);
  assert.equal(existsSync(plain.write('.git/config')), false);
  assert.equal(plain.judge.calls, 0, '判定役が許すと答える場合でも、判定役に回さない');
  assert.equal((await plain.call('file_write', { path: 'notes/a.txt', content: 'A' })).decidedBy, 'builtin');
  const policy = setup(t, { mutate: c => { c.tools.policies = { file_write: 'ask' }; } });
  assert.equal((await policy.call('file_write', { path: 'notes/a.txt', content: 'A' })).decidedBy, 'pending');
  assert.equal((await policy.call('file_write', { path: 'notes/b.txt', content: 'B' })).decidedBy, 'pending');
  assert.deepEqual(policy.pending.list({ status: 'waiting' }).map(row => row.kind), ['policy', 'policy']);
  assert.equal(existsSync(policy.write('notes/a.txt')), false);
  const web = setup(t);
  const fetched = await web.call('web_fetch', { url: 'https://example.com/?key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(fetched.decision, 'deny', fetched.output.content);
  assert.equal(web.pending.list({ status: 'waiting' }).length, 0);
});

// ── 本物のエンジンと API を通す ──

const toolCall = (name: string, args: unknown): Script => async function* () {
  yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args } };
  yield { type: 'done', stop: 'tool_use' };
};
const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' }; };

// 前の道（札）: 4-3b-1 で消す
test('エンジンと API: 添付を読んだ実行の file_write の札に grantFolder が付き、POST /api/approvals/:id の folder で同じフォルダの file_write は札なしで動く。実行ログの API にフォルダが出る。次の実行は札', async t => {
  const s = await startApp(t, { judgeAll: false });
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  s.adapter().scripts = [toolCall('file_write', { path: 'notes/a.txt', content: 'A' }), toolCall('file_write', { path: 'notes/b.txt', content: 'B' }), say('書きました')];
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '添付を読んで、メモに書いて', attachments: [upload.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '最初の札');
  const listed = await s.json('/api/approvals', 'GET');
  const card = listed.body.approvals[0];
  assert.ok(card.grantFolder.endsWith('notes'), JSON.stringify(card));
  assert.deepEqual(card.reasons.length, 1, 'taint の理由だけ');
  const decided = await s.json(`/api/approvals/${card.id}`, 'POST', { decision: 'folder' });
  assert.equal(decided.status, 200);
  await settled(s.app, sent.body.runId);
  assert.equal(readFileSync(join(s.paths.workspace, 'notes/b.txt'), 'utf8'), 'B', '2 つ目は札なしで書かれた');
  assert.equal(s.app.approvals.pending().length, 0);

  const logged = await s.json('/api/tool-calls', 'GET');
  const writes = (logged.body.toolCalls as Array<{ tool: string; decided_by: string; grantFolder: string | null; approval_id: string | null; autoReason: string | null }>).filter(r => r.tool === 'file_write');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(w => w.decided_by).sort(), ['folder-grant', 'user']);
  assert.ok(writes.every(w => w.grantFolder === card.grantFolder && w.approval_id === card.id), '許可した札と、許したフォルダが両方の行に出る');
  assert.ok(writes.every(w => w.autoReason === null));

  // 次の実行（また添付を読む）は、札から
  const again = s.app.uploads.save({ name: 'memo2.txt', mime: 'text/plain', body: Buffer.from('別の添付') });
  s.adapter().scripts = [toolCall('file_write', { path: 'notes/c.txt', content: 'C' }), say('書きました')];
  const next = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'もう一つ', attachments: [again.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '次の実行の札');
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, next.body.runId);
  assert.equal(existsSync(join(s.paths.workspace, 'notes/c.txt')), false);

  // 知らない決定は 400（folder を含む一覧で知らせる）
  const bad = await s.json('/api/approvals/none', 'POST', { decision: 'maybe' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.params.values, 'once / conversation / folder / deny');
});
