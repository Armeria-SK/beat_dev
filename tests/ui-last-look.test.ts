import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SCREENS = join(import.meta.dirname, '..', 'web', 'src', 'ui', 'screens');
const overview = readFileSync(join(SCREENS, 'Overview.tsx'), 'utf8');
const home = readFileSync(join(SCREENS, 'ProductHome.tsx'), 'utf8');

test('ui/ProductHome: 知らない製品の ID で開いても、最後に見た時刻 beat.lastLook.<ID> を書かない（backlog 302）', () => {
  const hook = overview.slice(overview.indexOf('export function useLastLook('), overview.indexOf('export function useRunActions('));
  assert.match(hook, /useLastLook\(\s*key: string,\s*keep = true\s*\)/u, '書くかどうかを渡せる');
  assert.match(hook, /if \(!keep\) return/u, 'keep が false なら書く手続きを付けない');
  assert.match(hook, /\[\s*key,\s*keep\s*\]/u);
  assert.match(home, /useLastLook\(\s*productLookKey\(id\),\s*project !== undefined\s*\)/u, '製品が分かっているときだけ書く');
});
