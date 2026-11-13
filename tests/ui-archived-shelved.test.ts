import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'screens', 'Archived.tsx'), 'utf8');

test('ui/Archived: しまった製品の一覧が届くまでは行に「archived product」を出さず、Restore の知らせは一覧を読んでから作る（backlog 308）', () => {
  assert.match(source, /const \[shelved, setShelved\] = useState<Project\[\] \| null>\(null\);/u, '届いていないことを空の一覧と分ける');
  assert.match(source, /const line = productLine\(c\.project_id, projects, shelved \?\? \[\]\);\s*if \(!line \|\| \(line\.archived && shelved === null\)\) return null;/u, '届く前は製品の札を出さない');
  assert.match(source, /const readShelved = async \(\): Promise<Project\[\]> => shelved \?\? api\.projects\(true\)\.then\(r => r\.projects, \(\) => \[\]\);/u);
  assert.match(source, /const line = productLine\(c\.project_id, projects, await readShelved\(\)\);/u, 'Restore の知らせは届いた一覧で作る');
});
