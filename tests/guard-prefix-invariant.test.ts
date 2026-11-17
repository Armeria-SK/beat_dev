import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { CD_PREFIXES, corpusOf, guardRowOf, looserThan, routeOf, type GuardModules, type GuardRow } from './helpers/guard-route.ts';
import { tempDir } from './helpers.ts';

// control-bodies fix-back: a cd that may not run, may run again, or cannot be worked out, placed in front of a command,
// never makes that command judged more loosely than on its own. For every risky corpus string C and each prefix P:
// verdict(P + "\n" + C) is never looser than verdict(C). Default: 4 prefixes; BEAT_GUARD_CORPUS=full runs all 12.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;
const FULL = process.env.BEAT_GUARD_CORPUS === 'full';

const EMPTY_ONLY = (row: GuardRow): boolean => row.reasonKeys.length > 0 && row.reasonKeys.every(k => k === 'guard.no_command' || k === 'guard.empty');
const risky = (row: GuardRow): boolean => routeOf(row, { judgeOff: false }) === 'refused' || routeOf(row, { judgeOff: true }) === 'owner'
  || row.pushes.length > 0 || row.outbound !== 'none' || row.fetched;

test('cd prefix invariant: no risky corpus string is judged more loosely after a cd that may not run or cannot be worked out', { timeout: 600_000 }, t => {
  const corpus = corpusOf(join(dirname(fileURLToPath(import.meta.url))));
  const ws = join(tempDir(t), 'ws');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  const real = realish(ws);
  const prefixes = CD_PREFIXES.filter(([, inDefault]) => FULL || inDefault).map(([p]) => p);
  const wrong: string[] = [];
  let riskyCount = 0;
  let checked = 0;
  for (const c of corpus) {
    if (!lexShell(c, 'powershell').ok) continue;
    const alone = guardRowOf(MODS, c, 'powershell', real);
    if (EMPTY_ONLY(alone) || !risky(alone)) continue;
    riskyCount++;
    for (const p of prefixes) {
      const after = guardRowOf(MODS, `${p}\n${c}`, 'powershell', real);
      checked++;
      const looser = looserThan(alone, after);
      if (looser.length) wrong.push(`${p} | ${JSON.stringify(c).slice(0, 140)} -> ${looser.join('; ')}`);
    }
  }
  t.diagnostic(`risky ${riskyCount}, prefixes ${prefixes.length}, prefix checks ${checked}`);
  assert.ok(riskyCount > 3_000, `too few risky strings: ${riskyCount}`);
  assert.deepEqual(wrong.slice(0, 40), [], `${wrong.length} looser rows`);
});
