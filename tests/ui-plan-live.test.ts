import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const UI = join(import.meta.dirname, '..', 'web', 'src', 'ui');
const pane = readFileSync(join(UI, 'panes', 'PlanPane.tsx'), 'utf8');
const css = readFileSync(join(UI, 'styles', 'panes.css'), 'utf8');

test('ui/PlanPane: Build の知らせ（changed・frozen）の role="status" は中身より前からある入れ物で、読み上げソフトが中身の追加を読む（backlog 406）', () => {
  assert.match(pane, /<div role="status" className="ui-plan__live">\s*\{buildNotice\?\.kind === 'changed' && <Notice tone="warn" icon="alert" title=\{t\('ui\.plan\.buildChanged'\)\} \/>\}\s*\{buildNotice\?\.kind === 'frozen' && <Notice /u);
  assert.doesNotMatch(pane, /\{buildNotice\?\.kind === '(changed|frozen)' && <div role="status">/u, '中身と一緒に作らない');
  assert.match(css, /^\.ui-plan__live:empty \{ position: absolute; \}$/mu, '空のときは列の間隔を取らない（display: none にしない）');
});
