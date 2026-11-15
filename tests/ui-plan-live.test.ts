import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const css = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'styles', 'panes.css'), 'utf8');

test('ui/PlanPane: Build の知らせの入れ物（ui-plan__live）は、空のときは列の間隔を取らない（display: none にしない。backlog 406）', () => {
  assert.match(css, /^\.ui-plan__live:empty \{ position: absolute; \}$/mu);
});
