import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type Migration } from '../../src/db/database.ts';
import { MIGRATIONS } from '../../src/db/migrations.ts';
import { tempDir } from '../helpers.ts';

export function assertMidwayKeepsShape(
  t: { after: (fn: () => void) => void },
  from: number,
  seed: (path: string) => Record<string, number>,
  counts: (db: DatabaseSync) => Record<string, number>,
  untouched: (db: DatabaseSync) => void,
): void {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const before = seed(path);
  const failing: Migration[] = [...MIGRATIONS.slice(0, from), db => { db.exec(String(MIGRATIONS[from])); throw new Error('stopped midway'); }];
  assert.throws(() => openDatabase(path, failing, { backupDir: join(dir, 'backups') }), /stopped midway/u);
  assert.ok(existsSync(join(dir, 'backups')), '落ちる前に控えは取ってある');
  const db = openDatabase(path, MIGRATIONS.slice(0, from));
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, from);
    assert.deepEqual(counts(db), before);
    untouched(db);
  } finally { db.close(); }
}
