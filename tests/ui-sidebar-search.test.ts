import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'Sidebar.tsx'), 'utf8');
const search = source.slice(source.indexOf('function SessionSearch('), source.indexOf('function SessionRow('));

test('ui/Sidebar: 過去の会話の検索が失敗したら "No matches" ではなく読めなかったことを出す（backlog 242）', () => {
  assert.ok(search.length > 0, 'SessionSearch がある');
  assert.doesNotMatch(search, /\.catch\(\(\) => \{ if \(live\) setHits\(\[\]\); \}\)/u, '失敗を「0 件」として扱わない');
  assert.match(search, /\.catch\(\(\) => \{ if \(live\) \{ setHits\(null\); setFailed\(true\); \} \}\)/u, '失敗の印を立てる');
  assert.match(search, /\{failed && <span className="bt-meta ui-search__none ui-danger" role="status">\{t\('ui\.kanban\.loadFailed'\)\}<\/span>\}/u, '失敗の文を出す');
  assert.match(search, /if \(!q\) \{ setHits\(null\); setFailed\(false\); return undefined; \}/u, '空にしたら失敗の印を消す');
  assert.match(search, /\.then\(r => \{ if \(live\) \{ setHits\(r\.hits\); setFailed\(false\); \} \}\)/u, '読めたら失敗の印を消す');
});
