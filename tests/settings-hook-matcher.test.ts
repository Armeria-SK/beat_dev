import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Settings › Hooks: 「Tools (matcher)」の欄はどれも required で、空にして離れると保存した値へ戻る', () => {
  const source = readFileSync(new URL('../web/src/ui/settings/computer.tsx', import.meta.url), 'utf8');
  const fields = source.split('\n').filter(line => line.includes('<CommitField') && line.includes("label={t('ui.set.hooks.matcher')}"));
  assert.equal(fields.length, 2, 'Protect files の欄と、自分で足すフックの欄');
  for (const line of fields) {
    assert.match(line, /\srequired\s/u, line.trim());
    assert.match(line, /onCommit=\{matcher => edit\(\{ matcher \}\)\}/u, line.trim());
  }
});
