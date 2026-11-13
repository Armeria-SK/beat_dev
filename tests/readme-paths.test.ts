import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

test('README: 指しているファイル（リンクと、web/・src/ などのパス）はどれも今ある。消したフォントや @fontsource を書かない（backlog 267）', () => {
  const paths = new Set<string>();
  for (const m of readme.matchAll(/\]\(([^)#:]+)\)/gu)) paths.add(m[1]!);
  for (const m of readme.matchAll(/`((?:web|src|scripts|tests|templates|deploy)\/[^`*<>\s]+\.(?:ts|tsx|md|css|json|mjs|ps1|sh))`/gu)) paths.add(m[1]!);
  assert.ok(paths.size > 0);
  assert.deepEqual([...paths].filter(p => !existsSync(join(ROOT, p))), []);
  assert.doesNotMatch(readme, /@fontsource/u, '書体はシステムのもので、同梱していない');
});
