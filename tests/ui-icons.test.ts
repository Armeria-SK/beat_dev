import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLYPHS, pillGlyph } from '../web/src/ui/icons.ts';

test('ui/icons: StatusPill の印は、ok が check、danger が x、ほかは点のまま', () => {
  assert.deepEqual(['ok', 'danger', 'running', 'waiting', 'warn', undefined].map(pillGlyph), ['check', 'x', null, null, null, null]);
  assert.ok(GLYPHS.check && GLYPHS.x);
});
