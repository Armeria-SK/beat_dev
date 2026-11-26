import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent } from '../../src/engine/types.ts';
import { fakeModel, settled, startApp } from '../app-setup.ts';
import { tempDir } from '../helpers.ts';
import { ScriptedRuntime, scriptedFactory } from './scripted-runtime.ts';

// 実行役の会話の試験（runtime-bridge・runtime-approval）が共に使う、本物の App に台本どおりの実行役をつなぐ道具
export const SECRET = 'zq-env-secret-value-7f3a9c1d5e';

export async function rig(t: Parameters<typeof startApp>[0], options: { permission?: string; kind?: 'claude-code' | 'codex'; env?: Record<string, string>; efforts?: string[]; providerVision?: boolean; approvalWaitMs?: number; configure?: (config: Parameters<NonNullable<Parameters<typeof startApp>[1]>['configure'] & {}>[0]) => void } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const holder: { current?: ScriptedRuntime } = {};
  const kind = options.kind ?? 'claude-code';
  const s = await startApp(t, {
    models: [{ id: 'cc', runtime: kind, model: 'sonnet', vision: false, ...(options.efforts ? { efforts: options.efforts } : {}) }, fakeModel('m1', { vision: options.providerVision === true })],
    configure: config => {
      config.runtimes = [{ id: kind, kind, enabled: true, ...(options.permission ? { permission: options.permission } : {}) }];
      config.routing.chat = ['cc', 'm1'];
      options.configure?.(config);
    },
    runtimeFactories: { [kind]: scriptedFactory(holder) },
    projectFolderExempt: [products],
    runtimeStopGraceMs: 150,
    ...(options.approvalWaitMs !== undefined ? { runtimeApprovalWaitMs: options.approvalWaitMs } : {}),
    env: options.env ?? { FAKE_KEY: SECRET },
  });
  assert.ok(s.app.runtimes.find(s.app.config(), kind).ok);
  const runtime = holder.current!;
  const product = async (name = 'prod', files: Record<string, string> = {}) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const events: RunEvent[] = [];
  s.app.bus.subscribe(entry => events.push(entry.event));
  const check = async () => { const res = await s.json(`/api/runtimes/${kind}/check`, 'POST'); assert.equal(res.status, 200, JSON.stringify(res.body)); };
  const send = async (conversation: string, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${conversation}/messages`, 'POST', { text, ...extra });
  const turn = async (conversation: string, text: string, extra: Record<string, unknown> = {}) => {
    const sent = await send(conversation, text, extra);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    return sent.body.runId as string;
  };
  const rows = (conversation: string) => s.app.conversations.messages(conversation, 100).map(r => r.message);
  return { s, runtime, product, events, check, send, turn, rows, products };
}
