import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const LABEL = "label={t('ui.set.hooks.matcher')}";
const matcherFields = (source: string): string[] => (source.match(/<CommitField\b[\s\S]*?\/>/gu) ?? []).filter(field => field.includes(LABEL));
const problemsOf = (field: string): string[] => [
  ...(/\srequired(?=[\s/])/u.test(field) ? [] : ['required']),
  ...(/onCommit=\{\s*matcher\s*=>\s*edit\(\{\s*matcher\s*\}\)\s*\}/u.test(field) ? [] : ['onCommit']),
];

test('Settings › Hooks: 「Tools (matcher)」の欄はどれも required で、空にして離れると保存した値へ戻る', () => {
  const source = readFileSync(new URL('../web/src/ui/settings/computer.tsx', import.meta.url), 'utf8');
  const fields = matcherFields(source);
  assert.equal(fields.length, 2, 'Protect files の欄と、自分で足すフックの欄');
  for (const field of fields) assert.deepEqual(problemsOf(field), [], field);
});

test('Settings › Hooks の欄の読み方: 欄が何行に分けて書かれていても見つけ、required や onCommit が無ければ気づく', () => {
  const split = `<Row>\n  <CommitField\n    value={hook.matcher}\n    ${LABEL}\n    mono\n    required\n    onCommit={matcher => edit({ matcher })}\n  />\n</Row>`;
  assert.equal(matcherFields(split).length, 1);
  assert.deepEqual(problemsOf(matcherFields(split)[0]!), []);
  const loose = `<CommitField value={a} label={t('other')} required onCommit={x => y(x)} />\n<CommitField\n  ${LABEL}\n  mono\n/>`;
  assert.equal(matcherFields(loose).length, 1, 'ほかの欄は数えない');
  assert.deepEqual(problemsOf(matcherFields(loose)[0]!), ['required', 'onCommit']);
  assert.deepEqual(problemsOf(`<CommitField ${LABEL} required/>`), ['onCommit']);
});
