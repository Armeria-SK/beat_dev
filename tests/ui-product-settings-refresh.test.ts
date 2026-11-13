import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'screens', 'ProductSettings.tsx'), 'utf8');

test('ui/ProductSettings: フォルダが見つからない製品では、送り先の Refresh を押せない（backlog 322）', () => {
  assert.match(source, /<Button small variant="ghost" disabled=\{busy \|\| project\.folder_missing\} onClick=\{\(\) => void patch\(\{ refreshRemotes: true \}\)\}>\{t\('ui\.ps\.refresh'\)\}<\/Button>/u);
});
