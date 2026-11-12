import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { toolPolicy } from '../src/tools/tool-policy.ts';
import { toolPolicyLoosened } from '../web/src/settings/access.ts';
import { startScreenServer } from './screen-server.ts';

// 段 8（A3）: GET /api/tools と PATCH /api/tools/:name

interface ToolRow { name: string; effect: string; allowedIn: string[]; policy: string; configurable: boolean }
const patch = (s: Awaited<ReturnType<typeof startScreenServer>>, name: string, body: unknown, headers: Record<string, string> = {}) =>
  s.api(`/api/tools/${name}`, { method: 'PATCH', body: JSON.stringify(body), headers });
const fileOf = (s: Awaited<ReturnType<typeof startScreenServer>>) => JSON.parse(readFileSync(s.app.paths.config, 'utf8')) as { tools: { policies?: Record<string, string> } };

test('GET /api/tools: 組み込みの道具のうち記憶の道具を除く 38 個を、名前・効果・使える場面・方針・方針を持てるかで返す（既定は agent_run だけ ask、ほかは allow）', async t => {
  const s = await startScreenServer(t);
  const res = await s.api('/api/tools');
  assert.equal(res.status, 200);
  const { tools } = (await res.json()) as { tools: ToolRow[] };
  const server = builtinTools();
  assert.equal(tools.length, 38);
  assert.deepEqual(tools.map(tool => tool.name).sort(), server.map(tool => tool.name).filter(name => !name.startsWith('memory_')).sort());
  for (const tool of tools) {
    const def = server.find(d => d.name === tool.name)!;
    assert.deepEqual([tool.effect, tool.allowedIn, tool.policy], [def.effect, [...def.allowedIn], tool.name === 'agent_run' ? 'ask' : 'allow'], tool.name);
  }
  assert.deepEqual(tools.filter(tool => !tool.configurable).map(tool => tool.name).sort(), ['ask_user', 'task_checkpoint', 'task_complete']);
  assert.deepEqual(tools.find(tool => tool.name === 'history_search')!.allowedIn, ['chat', 'task', 'review'], '振り返りでも使う道具は、allowedIn に review がある（画面の添え書きの元）');
});

test('PATCH /api/tools/:name: 方針を 1 つだけ変えて設定に保存する。allow に戻すと書いた項目を消す。ほかの設定には触れず、モデルの確認の通信もしない', async t => {
  const s = await startScreenServer(t);
  let probes = 0;
  const probeAll = s.app.status.probeAll.bind(s.app.status);
  s.app.status.probeAll = async (...args: Parameters<typeof probeAll>) => { probes++; return probeAll(...args); };
  const before = fileOf(s) as Record<string, any>;

  const res = await patch(s, 'shell_run', { policy: 'ask' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tool: { name: 'shell_run', effect: 'exec', allowedIn: ['chat', 'task', 'agent'], policy: 'ask', configurable: true } });
  assert.equal((await patch(s, 'file_write', { policy: 'block' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies, { shell_run: 'ask', file_write: 'block' });
  const after = fileOf(s) as Record<string, any>;
  assert.deepEqual({ ...after, tools: { ...after.tools, policies: undefined } }, { ...before, tools: { ...before.tools, policies: undefined } }, 'policies 以外は変わらない');
  const listed = ((await (await s.api('/api/tools')).json()) as { tools: ToolRow[] }).tools;
  assert.deepEqual(listed.filter(tool => tool.policy !== 'allow').map(tool => `${tool.name}:${tool.policy}`).sort(), ['agent_run:ask', 'file_write:block', 'shell_run:ask']);
  assert.equal(s.app.config().tools.policies.shell_run, 'ask', '再起動なしでエンジンが読む設定に入る');

  assert.equal((await patch(s, 'shell_run', { policy: 'allow' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies, { file_write: 'block' }, 'allow に戻すと書いた項目を消す');
  assert.equal(probes, 0, '道具の方針を変えるだけでは、モデルの確認の通信をしない');
});

test('PATCH /api/tools/agent_run: 既定は ask。allow にすると「allow」と書いて残り、ask に戻すと項目が消える（書かない状態が既定の ask）。T-28', async t => {
  const s = await startScreenServer(t);
  const policyOf = async () => ((await (await s.api('/api/tools')).json()) as { tools: ToolRow[] }).tools.find(tool => tool.name === 'agent_run')!.policy;
  assert.equal(await policyOf(), 'ask', '書かないときは ask');
  assert.deepEqual(fileOf(s).tools.policies ?? {}, {});
  assert.equal((await patch(s, 'agent_run', { policy: 'allow' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies, { agent_run: 'allow' }, '既定の ask を allow にしたことが設定に残る');
  assert.equal(await policyOf(), 'allow');
  assert.equal((await patch(s, 'agent_run', { policy: 'ask' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies ?? {}, {}, '既定に戻すと項目を消す');
  assert.equal(await policyOf(), 'ask');
  assert.equal((await patch(s, 'agent_run', { policy: 'block' })).status, 200);
  assert.equal(await policyOf(), 'block');
});

test('toolPolicy: agent_run は書かなければ ask、読めない値も ask（ほかの道具は allow）。画面の「ゆるめる」判定も、既定の ask から allow を緩めると数える。T-28', () => {
  const none = { tools: {} };
  assert.equal(toolPolicy(none, 'agent_run'), 'ask');
  assert.equal(toolPolicy(none, 'shell_run'), 'allow');
  assert.equal(toolPolicy({ tools: { policies: { agent_run: 'bogus', shell_run: 'bogus' } } }, 'agent_run'), 'ask');
  assert.equal(toolPolicy({ tools: { policies: { agent_run: 'bogus', shell_run: 'bogus' } } }, 'shell_run'), 'allow');
  assert.equal(toolPolicy({ tools: { policies: { agent_run: 'allow' } } }, 'agent_run'), 'allow');
  assert.deepEqual(toolPolicyLoosened('agent_run', undefined, 'allow'), { kind: 'tool-policy-loosened', tool: 'agent_run', from: 'ask', to: 'allow' });
  assert.equal(toolPolicyLoosened('agent_run', undefined, 'ask'), null);
  assert.equal(toolPolicyLoosened('shell_run', undefined, 'allow'), null);
});
test('PATCH /api/tools/:name: 同時に別の道具を変えても、どちらも残る（書き換えの取りこぼしが無い）', async t => {
  const s = await startScreenServer(t);
  const results = await Promise.all(['file_write', 'file_edit', 'shell_run', 'web_fetch'].map((name, i) => patch(s, name, { policy: i % 2 ? 'ask' : 'block' })));
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200]);
  assert.deepEqual(fileOf(s).tools.policies, { file_write: 'block', file_edit: 'ask', shell_run: 'block', web_fetch: 'ask' });
});

test('PATCH /api/tools/:name: from（画面が見ていた前の方針）が今の方針と違えば 409 で何も書かない。合っていれば通り、from なしは今までどおり', async t => {
  const s = await startScreenServer(t);
  assert.equal((await patch(s, 'shell_run', { policy: 'block' })).status, 200);
  const stale = await patch(s, 'shell_run', { policy: 'allow', from: 'ask' });
  assert.equal(stale.status, 409);
  const body = (await stale.json()) as { code: string; params: Record<string, string> };
  assert.deepEqual([body.code, body.params], ['http.tool_policy_changed', { name: 'shell_run', policy: 'block' }]);
  assert.equal(s.app.config().tools.policies.shell_run, 'block', '締めた方針は緩まない');
  assert.equal((await patch(s, 'shell_run', { policy: 'allow', from: 'nope' })).status, 400);
  assert.equal(s.app.config().tools.policies.shell_run, 'block');
  assert.equal((await patch(s, 'shell_run', { policy: 'ask', from: 'block' })).status, 200);
  assert.equal((await patch(s, 'agent_run', { policy: 'allow', from: 'ask' })).status, 200, '書いていない道具の from は既定の方針と比べる');
  assert.equal((await patch(s, 'shell_run', { policy: 'allow' })).status, 200, 'from なしは比べない');
  assert.deepEqual(fileOf(s).tools.policies, { agent_run: 'allow' });
});

test('PATCH /api/tools/:name: 知らない道具は 404、方針を持てない道具・知らない方針は 400（どれも何も書かない）', async t => {
  const s = await startScreenServer(t);
  const wrote = () => fileOf(s).tools.policies;
  const start = wrote();
  const unknown = await patch(s, 'no_such_tool', { policy: 'ask' });
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { code: string }).code, 'http.tool_missing');
  for (const name of ['task_complete', 'task_checkpoint', 'ask_user']) {
    const res = await patch(s, name, { policy: 'block' });
    assert.equal(res.status, 400, name);
    assert.equal(((await res.json()) as { code: string }).code, 'http.tool_not_policyable');
  }
  for (const body of [{ policy: 'never' }, { policy: 3 }, {}, { policy: null }]) {
    const res = await patch(s, 'shell_run', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await patch(s, '__proto__', { policy: 'ask' })).status, 404, 'Object の予約された名前も、道具ではない');
  assert.deepEqual(wrote(), start, '失敗では何も書かない');
});

test('PATCH /api/tools/:name: 書き込みなので Origin が要る。別のサイトの Origin・Sec-Fetch-Site: cross-site は断る', async t => {
  const s = await startScreenServer(t);
  const origin = new URL((await s.api('/api/health')).url).origin;
  const raw = (headers: Record<string, string>) => fetch(`${origin}/api/tools/shell_run`, { method: 'PATCH', body: JSON.stringify({ policy: 'block' }), headers: { 'Content-Type': 'application/json', ...headers } });
  assert.equal((await raw({})).status, 403, 'Origin なし');
  assert.equal((await raw({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(fileOf(s).tools.policies && Object.keys(fileOf(s).tools.policies!).length, 0, '断った要求は何も書かない');
});
