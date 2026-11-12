import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, defaultConfig, parseConfig } from '../src/config/store.ts';
import { en } from '../web/src/i18n/en.ts';
import { accessWidening } from '../web/src/settings/access.ts';
import type { Config } from '../web/src/settings/model.ts';
import { planSave } from '../web/src/ui/settings/commit.ts';

const hook = (matcher: string, enabled?: boolean) => ({ matcher, command: ['node', `${matcher}.js`], timeoutMs: 1000, onError: 'deny', ...(enabled === undefined ? {} : { enabled }) });

function withHooks(pre: unknown[], post: unknown[] = []): Config {
  return { tools: { hooks: { preToolUse: pre, postToolUse: post } } };
}

test('設定: フックの enabled は書かなくてもよく（古い設定はそのまま読める・書き足さない）、true / false を受け、ほかの型は断る', () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.tools.hooks.preToolUse = [{ matcher: 'a', command: ['x'] }, { matcher: 'b', command: ['y'], enabled: false }, { matcher: 'c', command: ['z'], enabled: true }];
  const parsed = parseConfig(raw);
  assert.deepEqual(parsed.tools.hooks.preToolUse.map(h => h.enabled), [undefined, false, true]);
  assert.equal('enabled' in parsed.tools.hooks.preToolUse[0]!, false);
  raw.tools.hooks.preToolUse[0].enabled = 'no';
  assert.throws(() => parseConfig(raw), ConfigError);
});

test('広がりの検出: 使う前のフックをオフにするのは広がり。オンに戻す・使ったあとのフックをオフにするのは数えない', () => {
  const before = withHooks([hook('a'), hook('b', true)], [hook('p')]);
  const offUnset = withHooks([hook('a', false), hook('b', true)], [hook('p')]);
  assert.deepEqual(accessWidening(before, offUnset), [{ kind: 'hook-disabled', stage: 'preToolUse', hook: { matcher: 'a', command: ['node', 'a.js'] } }]);
  const offExplicit = withHooks([hook('a'), hook('b', false)], [hook('p')]);
  assert.deepEqual(accessWidening(before, offExplicit).map(a => a.kind), ['hook-disabled']);

  assert.deepEqual(accessWidening(offUnset, before), [], 'オンに戻すのは確かめない');
  assert.deepEqual(accessWidening(before, withHooks([hook('a', true), hook('b', true)], [hook('p')])), [], '書いていない → true は同じ意味');
  assert.deepEqual(accessWidening(before, withHooks([hook('a'), hook('b', true)], [hook('p', false)])), [], '使ったあとのフックは道具を止めない');

  const editedAndOff = withHooks([{ ...hook('a', false), command: ['node', 'other.js'] }, hook('b', true)], [hook('p')]);
  assert.deepEqual(accessWidening(before, editedAndOff).map(a => a.kind), ['hook-edited', 'hook-disabled'], '書き換えと一緒にオフにしても、オフは並ぶ');
  assert.deepEqual(accessWidening(offUnset, withHooks([{ ...hook('a', true), command: ['node', 'other.js'] }, hook('b', true)], [hook('p')])).map(a => a.kind), ['hook-edited']);
  assert.match(en['access.hookDisabled']('before a tool runs', 'a → node a.js'), /Turn off a hook/u);
});

test('保存の手順: フックをオフにする保存は、確かめを通るまで保存しない。オンにする保存はそのまま通る', () => {
  const latest = withHooks([hook('a')]);
  const turnOff = (c: Config): Config => ({ ...c, tools: { hooks: { preToolUse: [hook('a', false)], postToolUse: [] } } });
  const first = planSave(latest, turnOff, null);
  assert.equal(first.kind, 'confirm');
  if (first.kind !== 'confirm') return;
  assert.deepEqual(first.items.map(i => i.kind), ['hook-disabled']);
  assert.equal(planSave(latest, turnOff, first.key).kind, 'save');
  assert.equal(planSave(turnOff(latest), c => ({ ...c, tools: { hooks: { preToolUse: [hook('a', true)], postToolUse: [] } } }), null).kind, 'save');
});
