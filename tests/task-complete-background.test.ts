import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import { taskComplete } from '../src/tools/builtin/tasks.ts';
import { BackgroundJobs } from '../src/tools/shell/background.ts';
import { scrubEnv } from '../src/tools/shell/runner.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// 実機の会話 85ab1ade: Build の終わりの報告に、まだ動いていた裏のコマンド（bg-2 の Chrome）が出なかった。task_complete は、このタスクの動いている裏のコマンドを書く
test('task_complete lists the background commands of this task that are still running, in the result and in the summary', async t => {
  const dir = tempDir(t);
  const jobs = new BackgroundJobs({ logDir: join(dir, 'tool_outputs') });
  t.after(async () => { jobs.closeAll(); await new Promise(r => setTimeout(r, 300)); });
  const run = (taskId: string, command: string) => {
    const started = jobs.start({ conversationId: 'c1', projectId: 'p1', taskId, command, cwd: dir, file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: scrubEnv(), fetched: false });
    assert.ok('id' in started);
    return started.id;
  };
  const mine = run('t1', 'node dev-server.js');
  run('t2', 'node other-task.js');
  const task = { id: 't1', project_id: 'p1', spawned_by: 'parent', conversation_id: 'c1' };
  const control = { outcome: 'none' as string };
  const ctx = {
    config: defaultConfig(), conversationId: 'c1', paths: { data: dir }, signal: new AbortController().signal,
    task: { id: 't1', get control() { return control; }, set control(value) { Object.assign(control, value); } },
    services: { background: jobs, tasks: { openChildren: () => 0, get: () => task } },
  } as unknown as ToolContext;
  const out = await taskComplete.execute({ summary: 'done' }, ctx);
  const content = typeof out.content === 'string' ? out.content : JSON.stringify(out.content);
  assert.match(content, new RegExp(`${mine}.*dev-server`, 'u'));
  assert.doesNotMatch(content, /other-task/u);
  assert.match((control as unknown as { summary: string }).summary, /dev-server/u);

  await jobs.stopWhere({ taskId: 't1' });
  const again = { outcome: 'none' as string };
  const later = await taskComplete.execute({ summary: 'done' }, { ...ctx, task: { id: 't1', control: again } } as unknown as ToolContext);
  assert.doesNotMatch(typeof later.content === 'string' ? later.content : '', /dev-server/u, 'nothing listed once it is stopped');
});
