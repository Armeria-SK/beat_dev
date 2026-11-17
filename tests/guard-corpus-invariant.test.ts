import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { corpusOf, guardRowOf, looserThan, routeOf, type GuardModules, type GuardRow } from './helpers/guard-route.ts';
import { tempDir } from './helpers.ts';

// control-bodies invariant: for every string C of the test corpus and every PowerShell body T that runs it,
// verdict(T(C)) is never looser than verdict(C) (route with the judge on and off, order 1 / 3 keys, ask kinds, pushes, outbound, fetch marks).
// Default size: the whole corpus in a try body, plus two more wrappers in turn for each string that is refused, owner-bound, pushed, sent or fetched at top level.
// BEAT_GUARD_CORPUS=full runs every wrapper over the whole corpus.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;
const FULL = process.env.BEAT_GUARD_CORPUS === 'full';

const TRY = (c: string): string => `try {\n${c}\n} catch {}`;
const WRAPS: Array<[string, (c: string) => string, ((c: string) => boolean)?]> = [
  ['try', TRY],
  ['catch', c => `try {}\ncatch {\n${c}\n}`],
  ['finally', c => `try {} finally {\n${c}\n}`],
  ['while', c => `while ($true) {\n${c}\n}`],
  ['do', c => `do {\n${c}\n} while ($false)`],
  ['for', c => `for (;;) {\n${c}\n}`],
  ['switch clause', c => `switch (1) { 1 {\n${c}\n} }`],
  ['switch label block', c => `switch (1) { {\n${c}\n} {} }`],
  ['function', c => `function f {\n${c}\n}`],
  ['trap', c => `trap {\n${c}\n}`],
  ['begin', c => `begin {\n${c}\n}`],
  ['return', c => `return ${c}`, c => onePipeline(c)],
];

// One pipeline with no statement separator: the only kind `return C` can carry
function onePipeline(c: string): boolean {
  if (/[\n;]|&&|\|\|/u.test(c)) return false;
  const lexed = lexShell(c, 'powershell');
  return lexed.ok && lexed.statements.length > 0 && lexed.statements.every(s => s.kind === 'command' && s.shapes.length === 0 && !s.inBlock);
}

// Rows refused only because the outer string has no command at all: a body with nothing in it is harmless, not a looser verdict
const EMPTY_ONLY = (row: GuardRow): boolean => row.reasonKeys.length > 0 && row.reasonKeys.every(k => k === 'guard.no_command' || k === 'guard.empty');

const risky = (row: GuardRow): boolean => routeOf(row, { judgeOff: false }) === 'refused' || routeOf(row, { judgeOff: true }) === 'owner'
  || row.pushes.length > 0 || row.outbound !== 'none' || row.fetched || row.limits;

test('control bodies invariant: no corpus string is judged more loosely inside a PowerShell body than at top level', { timeout: 600_000 }, t => {
  const corpus = corpusOf(join(dirname(fileURLToPath(import.meta.url))));
  const ws = join(tempDir(t), 'ws');
  mkdirSync(ws, { recursive: true });
  const real = realish(ws);
  // Strings the lexer refuses at top level are refused for their own syntax; their wrapped forms are covered by the try row only through lexable strings
  const lexable = corpus.filter(c => lexShell(c, 'powershell').ok);
  const wrong: string[] = [];
  let checked = 0;
  let riskyCount = 0;
  for (const c of lexable) {
    const top = guardRowOf(MODS, c, 'powershell', real);
    if (EMPTY_ONLY(top)) continue;
    const more = FULL || risky(top);
    // By default each risky string gets two more wrappers in turn, so every wrapper sees a share of them within the time budget
    const picked = new Set(more && !FULL ? [1 + (riskyCount % (WRAPS.length - 1)), 1 + ((riskyCount * 5 + 3) % (WRAPS.length - 1))] : []);
    if (more) riskyCount++;
    for (const [index, [name, wrap, when]] of WRAPS.entries()) {
      if (index > 0 && !FULL && !picked.has(index)) continue;
      if (when && !when(c)) continue;
      const inner = guardRowOf(MODS, wrap(c), 'powershell', real);
      checked++;
      const looser = looserThan(top, inner);
      if (looser.length) wrong.push(`${name}: ${JSON.stringify(c).slice(0, 160)} -> ${looser.join('; ')}`);
    }
  }
  t.diagnostic(`corpus ${corpus.length}, lexable ${lexable.length}, more wrappers for ${riskyCount}, wrapped checks ${checked}`);
  assert.ok(lexable.length > 10_000, `corpus too small: ${lexable.length}`);
  assert.deepEqual(wrong.slice(0, 40), [], `${wrong.length} looser rows`);
});

test('control bodies invariant: the route helper itself orders refused > owner > product > judge > allow', () => {
  const row = (over: Partial<GuardRow>): GuardRow => ({ decision: 'ask', reasonKeys: [], askKinds: [], fetched: false, downloaded: false, limits: false, pushes: [], outbound: 'none', ...over });
  const order = [
    row({ decision: 'allow' }), row({ reasonKeys: ['shape.control'] }), row({ reasonKeys: ['list.command'] }), row({ reasonKeys: ['list.git_config'] }), row({ decision: 'deny', reasonKeys: ['scope.deny'] }),
  ];
  assert.deepEqual(order.map(r => routeOf(r, { judgeOff: false })), ['allow', 'judge', 'product', 'owner', 'refused']);
  for (let i = 1; i < order.length; i++) {
    assert.notDeepEqual(looserThan(order[i]!, order[i - 1]!), [], `${i} -> ${i - 1} is looser`);
    assert.deepEqual(looserThan(order[i - 1]!, order[i]!), [], `${i - 1} -> ${i} is not looser`);
  }
  assert.equal(routeOf(row({ reasonKeys: ['shape.control_opaque'] }), { judgeOff: true }), 'owner');
  assert.equal(routeOf(row({ reasonKeys: ['shape.control_opaque'] }), { judgeOff: false }), 'judge');
  assert.notDeepEqual(looserThan(row({ pushes: [null] }), row({})), []);
  assert.notDeepEqual(looserThan(row({ outbound: 'delete' }), row({})), []);
  assert.notDeepEqual(looserThan(row({ reasonKeys: ['list.git_config'], outbound: 'send' }), row({ reasonKeys: ['list.git_config'] })), []);
  assert.notDeepEqual(looserThan(row({ fetched: true }), row({})), []);
});
