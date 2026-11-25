import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessWidening } from '../web/src/settings/access.ts';
import type { Config } from '../web/src/settings/model.ts';

// 339: 「外へ広げる変更」の見張りが、検索の回数の上限（tools.web.maxSearchesPerHour）を上げることを数える

const withWeb = (web: Record<string, unknown>): Config => ({ tools: { web: { fetch: true, search: 'auto', ...web } } });
const none = (): Config => ({ tools: { web: { fetch: true, search: 'auto' } } });

test('339: 検索の回数の上限を上げると、上限を上げる変更として数える（既定の 30 から上げるときも）', () => {
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 30 }), withWeb({ maxSearchesPerHour: 120 })), [
    { kind: 'limit-raised', key: 'tools.web.maxSearchesPerHour', from: 30, to: 120 },
  ]);
  assert.deepEqual(accessWidening(none(), withWeb({ maxSearchesPerHour: 100 })), [
    { kind: 'limit-raised', key: 'tools.web.maxSearchesPerHour', from: 30, to: 100 },
  ], '書いていなかった（既定の 30）ものを上げる');
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 100 }), withWeb({ maxSearchesPerHour: 600 })), [
    { kind: 'limit-raised', key: 'tools.web.maxSearchesPerHour', from: 100, to: 600 },
  ]);
});

test('339: 下げる・同じ・書かなくなる（既定の 30 に戻る）・数でない値は数えない', () => {
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 100 }), withWeb({ maxSearchesPerHour: 10 })), []);
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 100 }), withWeb({ maxSearchesPerHour: 100 })), []);
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 100 }), none()), [], '書かなくなると既定の 30 に下がる');
  assert.deepEqual(accessWidening(none(), none()), []);
  assert.deepEqual(accessWidening(none(), withWeb({ maxSearchesPerHour: 30 })), [], '既定と同じ値を書いただけ');
  assert.deepEqual(accessWidening(none(), withWeb({ maxSearchesPerHour: 5 })), []);
  assert.deepEqual(accessWidening(withWeb({ maxSearchesPerHour: 10 }), withWeb({ maxSearchesPerHour: '999' })), [], '数でない値は上げたことにしない（サーバーが断る）');
  assert.deepEqual(accessWidening({}, { tools: { web: null } } as unknown as Config), [], 'web が読めない形でも落ちない');
});

test('339: 検索をオンにする変更と同時でも、上限の変更は別の 1 行として並ぶ', () => {
  const before = withWeb({ search: 'off', maxSearchesPerHour: 30 });
  const after = withWeb({ search: 'auto', maxSearchesPerHour: 60 });
  assert.deepEqual(accessWidening(before, after).map(a => a.kind), ['web-search-on', 'limit-raised']);
});
