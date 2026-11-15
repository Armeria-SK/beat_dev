import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ConfigStore } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { reviewPrompt } from '../src/memory/review.ts';
import { skillDraft } from '../src/tools/builtin/skills.ts';
import { growSkills } from '../src/tools/skills/store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const SKILL_LINE = /skill_draft/u;

test('the memory review prompt has no skill line; the skill review prompt has it', () => {
  const base = { trigger: 'manual' as const, transcript: '[User] hi', forgotten: [], language: 'en' as const };
  assert.doesNotMatch(reviewPrompt({ ...base, kind: 'memory' }), SKILL_LINE);
  assert.match(reviewPrompt({ ...base, kind: 'skill' }), SKILL_LINE);
  assert.match(reviewPrompt({ ...base, kind: 'skill', skillsAutoRegister: true }), /registered right away/u);
});

test('Grow skills: a config without the key reads as On and loads unchanged', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const config = testConfig();
  config.skills = { askBeforeRegister: false };
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  const loaded = new ConfigStore(path).load();
  assert.deepEqual(loaded.skills, { askBeforeRegister: false });
  assert.equal(growSkills(loaded), true);
  assert.equal(growSkills({}), true);
  assert.equal(growSkills({ skills: { grow: false } }), false);
});

async function setup(t: Parameters<typeof startApp>[0], grow: boolean, botMemory = true) {
  const s = await startApp(t, { models: [fakeModel('m1')], tools: builtinTools(), botMemory, configure: c => { c.skills = grow ? {} : { grow: false }; c.memory.review = true; c.memory.reviewIdleMinutes = 1440; } });
  s.app.skills.write({ name: 'kept-skill', description: 'A skill the owner already has', body: '1. Do the thing.' }, 'owner', 'you');
  const send = async (id: string, text: string) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text, permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  return { ...s, send };
}

const offered = (request: { tools: Array<{ name: string }>; system: { frozen: string; dynamic: string } }) =>
  request.tools.some(tool => tool.name === 'skill_draft') || `${request.system.frozen}\n${request.system.dynamic}`.includes('skill_draft');

for (const grow of [false, true]) {
  test(`Grow skills ${grow ? 'On' : 'Off'}: skill_draft is ${grow ? '' : 'not '}offered in chat, task and review runs; registered skills stay usable`, async t => {
    const s = await setup(t, grow);
    s.adapter().scripts = [call('skill_view', { name: 'kept-skill' }), reply('read it')];
    await s.send(uuid(1), 'use the skill');
    const viewed = s.app.db.prepare("SELECT ok FROM tool_calls WHERE tool = 'skill_view'").get() as { ok: number };
    assert.equal(viewed.ok, 1, 'skill_view still works');
    s.app.tasks.create({ title: 'Do it', origin: 'user', actor: 'user' });
    s.adapter().scripts = [call('task_complete', { summary: 'done' })];
    assert.equal(await s.app.worker.tick(), 'ran');
    s.app.db.prepare("DELETE FROM memory_jobs").run();
    s.app.reviews.enqueue('manual', 'manual:grow', { conversationId: uuid(1) });
    s.app.engine.lastUserActivity = 0;
    const skillJob = s.app.reviews.enqueue('manual', 'skill:manual:grow', { conversationId: uuid(1), kind: 'skill' })!;
    s.adapter().scripts = [reply('No changes'), reply('No changes')];
    assert.equal(await s.app.worker.tick(), 'ran');
    await s.app.worker.tick();
    const requests = s.adapter().calls;
    assert.equal(requests.length, grow ? 5 : 4);
    for (const [i, request] of requests.slice(0, 3).entries()) assert.equal(offered(request), grow, `${i}`);
    assert.equal(offered(requests[3]!), false, 'the memory review never offers skill_draft');
    assert.doesNotMatch(String(requests[3]!.messages.at(-1)?.content), SKILL_LINE, 'no skill line in the memory review prompt');
    assert.match(`${requests[0]!.system.frozen}`, /kept-skill/u, 'the skills list is still in the prompt');
    if (grow) {
      const review = String(requests[4]!.messages.at(-1)?.content);
      assert.match(review, /\[Review\]/u);
      assert.match(review, SKILL_LINE, 'skill line in the skill review prompt');
      assert.equal(offered(requests[4]!), true);
    } else {
      assert.equal(s.app.reviews.get(skillJob.id)!.status, 'done', 'a waiting skill review is skipped while Grow skills is Off');
    }
  });
}

test('Grow skills Off: a waiting skill review is skipped, not run later, and tool results from while it was Off are not read later', async t => {
  const s = await setup(t, false, false);
  s.adapter().scripts = [reply('hello')];
  await s.send(uuid(1), 'hi there');
  s.app.db.prepare('DELETE FROM memory_jobs').run();
  s.app.engine.lastUserActivity = 0;
  const job = s.app.reviews.enqueue('manual', 'skill:manual:none', { conversationId: uuid(1), kind: 'skill' })!;
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.reviews.get(job.id)!.status, 'done');
  assert.match(s.app.reviews.get(job.id)!.note ?? '', /Skill reviews are off/u);
  assert.equal(s.adapter().calls.length, 1, 'only the chat reply called the model');
  s.adapter().scripts = [...Array.from({ length: 10 }, (_, i) => call('skill_view', { name: `missing-${i}` })), reply('done')];
  await s.send(uuid(1), 'look at many');
  assert.equal(s.app.kv.get(`review:skill-upto:${uuid(1)}`), String(s.app.conversations.messages(uuid(1), 1).at(-1)!.id), 'the reading place moves past what happened while Off');
  await s.app.applyConfig({ ...s.app.config(), skills: {} }, { probe: false });
  s.adapter().scripts = [reply('ok')];
  await s.send(uuid(1), 'thanks');
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'skill' AND status = 'pending'").get()!.n, 0, 'the 10 tool results from while Off do not queue a review once On');
});

test('Grow skills turned Off while a run is going: skill_draft is refused from then on, even though the run started with it On', async t => {
  const s = await setup(t, true);
  const started = s.app.config();
  await s.app.applyConfig({ ...started, skills: { grow: false } }, { probe: false });
  const out = await skillDraft.execute({ name: 'late-one', description: 'd', body: 'b', reason: 'r' }, { config: started, services: { skills: s.app.skills }, conversationId: uuid(3), runId: 'r' } as unknown as ToolContext);
  assert.equal(out.isError, true);
  assert.deepEqual(s.app.skills.drafts('pending', 10).map(d => d.name), []);
});

test('Grow skills Off: a skill_draft call made anyway is refused and no draft is made; existing drafts stay', async t => {
  const s = await setup(t, true);
  const before = s.app.skills.draft({ name: 'old-draft', description: 'd', body: 'b', reason: 'r' });
  await s.app.applyConfig({ ...s.app.config(), skills: { grow: false } }, { probe: false });
  assert.throws(() => s.app.skills.draft({ name: 'store-one', description: 'd', body: 'b', reason: 'r', autoOk: true }), /Growing skills is off/u, 'the store itself refuses, whoever calls it');
  s.adapter().scripts = [call('skill_draft', { name: 'new-one', description: 'd', body: 'b', reason: 'r' }), reply('ok')];
  await s.send(uuid(2), 'make a skill');
  const row = s.app.db.prepare("SELECT ok FROM tool_calls WHERE tool = 'skill_draft'").get() as { ok: number };
  assert.equal(row.ok, 0);
  const direct = await skillDraft.execute({ name: 'direct-one', description: 'd', body: 'b', reason: 'r' }, { config: s.app.config(), services: { skills: s.app.skills }, conversationId: uuid(2), runId: 'r' } as unknown as ToolContext);
  assert.equal(direct.isError, true, 'the tool itself refuses when growth is Off, even if a run reaches it');
  assert.deepEqual(s.app.skills.drafts('pending', 10).map(d => d.name), ['old-draft']);
  assert.equal(s.app.skills.approve(before.id).name, 'old-draft', 'the owner can still approve an old draft');
  assert.ok(s.app.skills.getRegistered('old-draft'));
});
