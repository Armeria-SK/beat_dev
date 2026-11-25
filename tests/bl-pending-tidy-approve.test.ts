import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { readThen, reply, tempDir, type Script } from './helpers.ts';

async function rig(t: Parameters<typeof startApp>[0]) {
  const ran: string[] = [];
  const hold: ToolDef<{ text: string }> = {
    name: 'fake_hold', description: 'Test tool.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat'],
    summarize: input => ({ title: 'Hold', body: input.text }),
    async execute(input) { ran.push(input.text); return { content: 'ran', exitCode: 0 }; },
  };
  const products = realpathSync.native(tempDir(t as never));
  const root = join(products, 'prod');
  mkdirSync(root, { recursive: true });
  const file = join(root, 'report.txt');
  writeFileSync(file, 'one');
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: [...builtinTools(), hold as unknown as ToolDef] });
  const made = await s.json('/api/projects', 'POST', { root });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.id as string;
  const conversation = uuid(1);
  const say = async (text: string, scripts: Script[]) => {
    s.adapter().scripts = scripts;
    const sent = await s.json(`/api/conversations/${conversation}/messages`, 'POST', { text, projectId, permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  const park = async () => {
    const row = await s.app.pending.park({ tool: 'fake_hold', input: { text: 'send it' }, cwd: root, kind: 'judge', reason: 'Judge unsure', runId: 'run-1', runKind: 'chat', conversationId: conversation, projectId, files: [file] });
    s.app.db.prepare('UPDATE pending_actions SET created_at = ? WHERE id = ?').run(Date.now() - 5000, row.id);
    return row;
  };
  const approve = async (id: number) => {
    const res = await s.json(`/api/pending/${id}/approve`, 'POST', {});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await waitFor(() => s.app.pending.row(id)!.status !== 'running', `pending #${id} settled`);
    return s.app.pending.row(id)!;
  };
  return { ...s, ran, file, say, park, approve };
}

test('実機に近い道: 同じ会話の続きの file_edit が送るファイルを書き換えたあと、HTTP の approve は cancelled（動かない・理由つき）', async t => {
  const s = await rig(t);
  await s.say('hello', [reply('hi')]);
  const row = await s.park();
  await s.say('fix the report', [readThen('file_edit', { path: 'report.txt', old: 'one', new: 'twelve' }), reply('done')]);
  assert.equal(readFileSync(s.file, 'utf8'), 'twelve', '前提: 担当が書き換えた');

  const after = await s.approve(row.id);

  assert.equal(after.status, 'cancelled', after.output_preview ?? '');
  assert.match(after.reject_reason ?? '', /settled another way/u);
  assert.deepEqual(s.ran, [], '動いていない');
  const owner = s.app.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-pending'").get() as { n: number };
  assert.equal(Number(owner.n), 0);
  const counts = (await s.json('/api/pending/counts', 'GET')).body;
  assert.equal(counts.waiting, 0);
});

test('実機に近い道: 持ち主が手で書き換えたなら、HTTP の approve は今までどおり stale', async t => {
  const s = await rig(t);
  await s.say('hello', [reply('hi')]);
  const row = await s.park();
  writeFileSync(s.file, 'changed by hand');
  const after = await s.approve(row.id);
  assert.equal(after.status, 'stale', after.output_preview ?? '');
  assert.deepEqual(s.ran, []);
});
