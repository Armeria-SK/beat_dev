import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'screens', 'Archived.tsx'), 'utf8');

test('ui/Archived: しまった製品の一覧は届くまで null のまま札を決め、読めなければ空にする。Restore は要るときだけ読みに行く（backlog 308）', () => {
  assert.match(source, /useState<Project\[\] \| null>\(null\)/u, '届いていないことを空の一覧と分ける');
  assert.match(source, /productLine\(c\.project_id, projects, shelved\)/u, '札は届いた一覧（または null）で決める');
  assert.match(source, /api\.projects\(true\)\.then\(r => setShelved\(r\.projects\)\)\.catch\(\(\) => setShelved\(\[\]\)\)/u, '読めなければ名前なしの札に戻す');
  assert.match(source, /needsShelved\(c\.project_id, projects, shelved\)/u, 'Restore で読みに行くかは needsShelved で決める');
});
