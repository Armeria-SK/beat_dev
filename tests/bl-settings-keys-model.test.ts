import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyEnvEdit, kindPatch, updateListItem, type Config } from '../web/src/settings/model.ts';

// 340: Anthropic の Key variable の欄を空にしても、ほかの提供元と鍵（ANTHROPIC_API_KEY）を共有させない

type Row = Record<string, unknown>;
const providersOf = (config: Config): Row[] => config.providers as Row[];
const envOf = (config: Config, id: string): unknown => providersOf(config).find(p => p.id === id)!.apiKeyEnv;

const two = (): Config => ({ providers: [
  { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
  { id: 'claude2', kind: 'anthropic', apiKeyEnv: 'CLAUDE2_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
  { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'LOCAL_API_KEY', maxParallel: 1, timeoutMs: 600_000 },
] });

test('340: ANTHROPIC_API_KEY をほかの提供元が使っているとき、Anthropic の鍵の名前の欄を空にすると、ID から作った自分の名前になる', () => {
  const result = keyEnvEdit('');
  assert.ok('patch' in result);
  const next = updateListItem(two(), 'providers', 'claude2', result.patch);
  assert.equal(envOf(next, 'claude2'), 'BEAT_CLAUDE2_API_KEY');
  assert.equal(envOf(next, 'anthropic'), 'ANTHROPIC_API_KEY', 'ほかの提供元は動かさない');
  assert.equal(envOf(next, 'local'), 'LOCAL_API_KEY');
});

test('340: 書いていない Anthropic の既定の名前（暗黙の ANTHROPIC_API_KEY）を使う提供元がほかにあっても、同じに重ねない。作る名前が取られていれば番号を足す', () => {
  const implicit = two();
  providersOf(implicit)[0] = { id: 'anthropic', kind: 'anthropic', maxParallel: 2, timeoutMs: 600_000 };
  assert.equal(envOf(updateListItem(implicit, 'providers', 'claude2', { apiKeyEnv: undefined }), 'claude2'), 'BEAT_CLAUDE2_API_KEY');
  providersOf(implicit).push({ id: 'x', kind: 'openai_compatible', apiKeyEnv: 'BEAT_CLAUDE2_API_KEY', maxParallel: 1, timeoutMs: 600_000 });
  assert.equal(envOf(updateListItem(implicit, 'providers', 'claude2', { apiKeyEnv: undefined }), 'claude2'), 'BEAT_CLAUDE2_API_KEY_2');
});

test('340: 空にしても共有にならないとき（ほかに ANTHROPIC_API_KEY を使う提供元が無い）は、今までどおり名前を外して既定に任せる', () => {
  const alone: Config = { providers: [{ id: 'claude2', kind: 'anthropic', apiKeyEnv: 'CLAUDE2_API_KEY', maxParallel: 2, timeoutMs: 600_000 }, two().providers[2]] };
  const next = updateListItem(alone, 'providers', 'claude2', { apiKeyEnv: undefined });
  assert.equal('apiKeyEnv' in providersOf(next)[0]!, false);
  const openai = updateListItem(two(), 'providers', 'local', { apiKeyEnv: undefined });
  assert.equal('apiKeyEnv' in providersOf(openai)[2]!, false, 'Anthropic でない提供元の名前はサーバーが付けるので、画面で作らない');
});

test('340: 名前を書いた編集・名前に触らない編集・種類の編集（今まで）は変わらない', () => {
  assert.equal(envOf(updateListItem(two(), 'providers', 'claude2', { apiKeyEnv: 'MINE_API_KEY' }), 'claude2'), 'MINE_API_KEY', '書いた名前はそのまま');
  assert.equal(envOf(updateListItem(two(), 'providers', 'claude2', { maxParallel: 1 }), 'claude2'), 'CLAUDE2_API_KEY', '名前に触らない編集は名前を動かさない');
  const implicit = two();
  providersOf(implicit)[1] = { id: 'claude2', kind: 'anthropic', maxParallel: 2, timeoutMs: 600_000 };
  assert.equal('apiKeyEnv' in providersOf(updateListItem(implicit, 'providers', 'claude2', { maxParallel: 1 }))[1]!, false, '共有している設定を、別の編集のついでに書き換えない');
  assert.deepEqual(kindPatch(two(), 'local', 'anthropic'), { kind: 'anthropic' }, '書いてある名前のある提供元は種類を変えても名前を動かさない');
  assert.equal(envOf(updateListItem(two(), 'providers', 'local', { kind: 'anthropic', apiKeyEnv: undefined }), 'local'), 'BEAT_LOCAL_API_KEY', '種類を変えて名前も空にする編集');
});
