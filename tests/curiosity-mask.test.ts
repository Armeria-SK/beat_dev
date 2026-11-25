import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';

// 好奇心の一覧（GET・POST・PATCH の返事）は、topic・why・result から秘密を伏せて返す。DB の行は元のまま（伏せるのは出口だけ）。
// タスクの結果の要約（result_summary）は、タスクの画面では伏せているので、ここだけ漏れる形を直す

const HELD = 'held-provider-value-987654';
const KEYLIKE = `sk-ant-api03-${'k'.repeat(40)}`;

async function setup(t: Parameters<typeof startApp>[0]) {
  return startApp(t, { env: { FAKE_KEY: HELD } });
}

test('好奇心の一覧: result・topic・why の登録済みの提供元の鍵と鍵の形は、返事から伏せる。DB の行は元のまま', async t => {
  const s = await setup(t);
  assert.deepEqual(s.app.registry.secrets(), [HELD], '準備: 提供元の鍵が登録されている');
  const item = s.app.curiosity.add({ topic: `Why does ${HELD} fail`, why: `Because of ${KEYLIKE}`, source: 'user' });
  const done = s.app.curiosity.update(item.id, { status: 'done', result: `Found: ${HELD} and ${KEYLIKE} in the logs` });
  const listed = await s.json('/api/curiosity?all=1', 'GET');
  assert.equal(listed.status, 200);
  const text = JSON.stringify(listed.body);
  for (const secret of [HELD, KEYLIKE, 'k'.repeat(40)]) assert.equal(text.includes(secret), false, `返事に ${secret.slice(0, 12)}… が残っている: ${text}`);
  const [row] = listed.body.items as Array<{ id: number; topic: string; why: string; result: string; status: string }>;
  assert.equal(row!.id, item.id);
  assert.equal(row!.status, 'done', '状態は変えない');
  assert.equal(row!.topic, 'Why does [REDACTED] fail');
  assert.equal(row!.why, 'Because of [REDACTED]');
  assert.equal(row!.result, 'Found: [REDACTED] and [REDACTED] in the logs');
  const stored = s.app.curiosity.get(item.id)!;
  assert.equal(stored.result, done.result, 'DB の result は元のまま');
  assert.equal(stored.result, `Found: ${HELD} and ${KEYLIKE} in the logs`);
  assert.equal(stored.topic, `Why does ${HELD} fail`, 'DB の topic は元のまま');
  assert.equal(stored.why, `Because of ${KEYLIKE}`, 'DB の why は元のまま');
});

test('好奇心の一覧: POST と PATCH の返事も同じように伏せる（DB は元のまま）', async t => {
  const s = await setup(t);
  const made = await s.json('/api/curiosity', 'POST', { topic: `Check ${HELD}`, why: `Why ${KEYLIKE}` });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(JSON.stringify(made.body).includes(HELD), false);
  assert.equal(JSON.stringify(made.body).includes('k'.repeat(40)), false);
  assert.equal(made.body.item.topic, 'Check [REDACTED]');
  const id = made.body.item.id as number;
  const patched = await s.json(`/api/curiosity/${id}`, 'PATCH', { status: 'done', result: `Answer ${HELD}` });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(JSON.stringify(patched.body).includes(HELD), false);
  assert.equal(patched.body.item.result, 'Answer [REDACTED]');
  assert.equal(patched.body.item.status, 'done');
  assert.equal(s.app.curiosity.get(id)!.result, `Answer ${HELD}`, 'DB の result は元のまま');
  assert.equal(s.app.curiosity.get(id)!.topic, `Check ${HELD}`);
});

test('好奇心の一覧: 秘密の無い行・null の欄は今のまま（伏せすぎない）', async t => {
  const s = await setup(t);
  const plain = s.app.curiosity.add({ topic: 'How do tasks and disks work?', why: 'task-runner-config and risk-assessment-report', source: 'beat' });
  s.app.curiosity.update(plain.id, { status: 'done', result: 'The disk-partition-tool is fine. Nothing secret here: ghp_short.' });
  const bare = s.app.curiosity.add({ topic: 'No why and no result', source: 'user' });
  const listed = await s.json('/api/curiosity?all=1', 'GET');
  const byId = new Map((listed.body.items as Array<Record<string, unknown>>).map(row => [row.id, row]));
  assert.deepEqual(byId.get(plain.id), { ...s.app.curiosity.get(plain.id) }, '秘密の無い行は DB の行と同じ');
  assert.equal(byId.get(bare.id)!.why, null);
  assert.equal(byId.get(bare.id)!.result, null);
  assert.equal(listed.body.items.length, 2);
});
