import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probe, renderTable, summarize, type QuestionResult } from '../scripts/memory-probe.ts';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { MEMORY_QUESTIONS, PROBE_NOTES } from './fixtures/memory-questions.ts';
import { tempDir } from './helpers.ts';

// beat 10-4b の台本（scripts/memory-probe.ts）を、筋書きの決まった偽のモデルで動かす
const provider: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
const models: ModelConfig[] = [
  { id: 'good', provider: 'fake', model: 'good', contextLength: 65536, maxOutputTokens: 4096, vision: false },
  { id: 'bad', provider: 'fake', model: 'bad', contextLength: 65536, maxOutputTokens: 4096, vision: false },
];
const config = (): AppConfig => ({ ...defaultConfig(), providers: [provider], models, routing: { chat: ['good', 'bad'], background: [], retriesPerModel: 0 } });

type Step = Array<StreamEvent>;
const call = (name: string, args: unknown): Step => [{ type: 'tool_call', call: { id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args } }, { type: 'done', stop: 'tool_use' }];
const say = (text: string): Step => [{ type: 'text', delta: text }, { type: 'done', stop: 'end_turn' }];

// good: 記憶の問いでは目次の名前から mesh_read で読み、読んだ本文で答える。対照では読まない。書く問いでは memory_save を読み込んで保存する
// bad: 読まずに答え、対照では読み、書く問いでは保存しない
function fakeAdapter(): ProviderAdapter {
  return {
    provider,
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      const question = MEMORY_QUESTIONS.find(q => q.text === request.messages[0]?.content);
      const good = request.model.id === 'good';
      const turn = request.messages.filter(m => m.role === 'assistant').length;
      const lastTool = [...request.messages].reverse().find(m => m.role === 'tool');
      let step: Step = say('ok');
      if (!question) step = say('ok');
      else if (question.kind === 'direct' || question.kind === 'indirect') {
        if (good && turn === 0) step = call('mesh_read', { file: `memory/${question.note}.md` });
        else step = say(good ? `From memory: ${lastTool?.content ?? ''}` : 'I do not know.');
      } else if (question.kind === 'control') {
        if (!good && turn === 0) step = call('mesh_read', { file: 'memory/staging-host.md' });
        else step = say('Answer.');
      } else if (good && turn === 0) step = call('tool_search', { query: 'memory_save' });
      else if (good && turn === 1) step = call('memory_save', { title: `Rule ${question.id}`, content: `The owner set rule ${question.id} for this product.`, why: 'The owner asked' });
      else step = say(good ? 'Saved.' : 'Sure, I will remember.');
      yield* step;
    },
    async probe(model: ModelConfig, required: number) {
      return { modelId: model.id, server: 'generic', required, declared: model.contextLength, effective: model.contextLength!, status: 'ok' as const, message: '', checkedAt: Date.now() };
    },
  };
}

test('memory-probe: 問いは直接 5・間接 5・対照 4・書く 3。直接と間接はどれも、置く記憶の本文にだけある印を持つ', () => {
  assert.deepEqual(['direct', 'indirect', 'control', 'write'].map(kind => MEMORY_QUESTIONS.filter(q => q.kind === kind).length), [5, 5, 4, 3]);
  assert.ok(PROBE_NOTES.length >= 6 && PROBE_NOTES.length <= 8);
  for (const q of MEMORY_QUESTIONS.filter(q => q.kind === 'direct' || q.kind === 'indirect')) {
    const note = PROBE_NOTES.find(n => n.name === q.note);
    assert.ok(note, q.id);
    assert.match(note.content, q.marker!, q.id);
    assert.doesNotMatch(q.text, q.marker!, `${q.id}: 問いの文に答えが無い`);
  }
});

test('memory-probe: 偽のモデルで、読む・使う・対照で読まない・書くを数え、合格の線と照らす。表に答えや記憶の中身は出さない', async t => {
  const results = await probe(config(), { work: tempDir(t), adapterOverride: () => fakeAdapter(), env: {}, timeoutMs: 20_000 });
  assert.deepEqual(results.map(r => r.modelId), ['good', 'bad']);
  const [good, bad] = results.map(r => summarize(r.results));
  assert.deepEqual({ ...good!, pass: undefined }, { direct: 5, directOf: 5, indirect: 5, indirectOf: 5, controlReads: 0, controlOf: 4, write: 3, writeOf: 3, failed: 0, pass: undefined });
  assert.deepEqual(good!.pass, { direct: true, indirect: true, control: true, write: true });
  assert.deepEqual({ ...bad!, pass: undefined }, { direct: 0, directOf: 5, indirect: 0, indirectOf: 5, controlReads: 4, controlOf: 4, write: 0, writeOf: 3, failed: 0, pass: undefined });
  assert.deepEqual(bad!.pass, { direct: false, indirect: false, control: false, write: false });
  const goodWrite = results[0]!.results.filter((r: QuestionResult) => r.kind === 'write');
  assert.ok(goodWrite.every(r => r.loaded && r.saved && r.english));
  assert.ok(results[0]!.results.filter(r => r.kind === 'direct').every(r => r.readNote && !r.searched));
  const table = renderTable(results);
  assert.match(table, /\| direct: read and used the note \| 5\/5 \| 4\/5 \| pass \|/u);
  assert.match(table, /\| control: read a note anyway \| 4\/4 \| at most half \| BELOW \|/u);
  for (const note of PROBE_NOTES) assert.ok(!table.includes(note.content.slice(0, 20)), note.name);
  for (const q of MEMORY_QUESTIONS) assert.ok(!table.includes(q.text), q.id);
});

test('memory-probe: 設定に無いモデルの名前は断る', async () => {
  await assert.rejects(probe(config(), { models: ['nope'] }), /unknown model\(s\): nope/u);
});
