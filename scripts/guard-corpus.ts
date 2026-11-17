// Compare the shell guard of two checkouts (base and head) over the same corpus of strings (plans/beat/steps/control-bodies).
//   extract --repo <base> --out <dir>/corpus.json        string literals of <base>/tests/**/*.ts, deduplicated, under 2,000 chars
//   run --repo <checkout> --corpus <dir>/corpus.json --out <file>   each string through checkShellCommand as powershell (windows) and bash (posix)
//   compare <base.json> <head.json> --corpus <dir>/corpus.json   same / stricter / looser per row; exit code 1 on any looser row,
//                                                               or on any change in a row with no control keyword
// The workspace folder is <dir of corpus>/ws, so both runs see the same paths.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { corpusOf, guardRowOf, looserThan, normal, routeOf, type GuardModules, type GuardRow, type Route } from '../tests/helpers/guard-route.ts';

const USAGE = [
  'usage: node --import ./tests/helpers/tsx-loader.mjs <head>/scripts/guard-corpus.ts extract --repo <base> --out <dir>/corpus.json',
  '       ... run --repo <checkout> --corpus <dir>/corpus.json --out <file>',
  '       ... compare <base.json> <head.json> --corpus <dir>/corpus.json',
].join('\n');

const SHELLS = ['powershell', 'bash'] as const;
type Shell = typeof SHELLS[number];
interface Verdicts { repo: string; rows: Record<Shell, GuardRow[]> }

const CONTROL_WORD = /(?:^|[^\w-])(?:try|catch|finally|trap|while|do|until|for|foreach|switch|function|filter|begin|process|end|clean|dynamicparam|param|return|throw|exit|class|enum|data|workflow|parallel|sequence|inlinescript|using)(?![\w-])/iu;

function extract(repo: string, outFile: string): void {
  const found = corpusOf(join(repo, 'tests'));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(found));
  console.log(`corpus: ${found.length} strings -> ${outFile}`);
}

async function run(repo: string, corpusFile: string, outFile: string): Promise<void> {
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as string[];
  const at = (rel: string) => import(pathToFileURL(join(resolve(repo), rel)).href);
  const guard = await at('src/tools/hooks/shell-guard.ts');
  const outbound = await at('src/tools/hooks/outbound.ts');
  const scope = await at('src/tools/hooks/scope.ts');
  const mods: GuardModules = { checkShellCommand: guard.checkShellCommand, pushesOf: outbound.pushesOf, outboundOf: outbound.outboundOf };
  const ws = join(dirname(resolve(corpusFile)), 'ws');
  mkdirSync(ws, { recursive: true });
  const real = scope.realish(ws) as string;
  const started = Date.now();
  const rows = {} as Record<Shell, GuardRow[]>;
  for (const shell of SHELLS) rows[shell] = corpus.map(command => guardRowOf(mods, command, shell, real));
  writeFileSync(outFile, JSON.stringify({ repo: resolve(repo), rows } satisfies Verdicts));
  console.log(`run: ${corpus.length} strings x ${SHELLS.length} shells in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outFile}`);
}

function compare(baseFile: string, headFile: string, corpusFile: string): number {
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as string[];
  const base = JSON.parse(readFileSync(baseFile, 'utf8')) as Verdicts;
  const head = JSON.parse(readFileSync(headFile, 'utf8')) as Verdicts;
  let bad = 0;
  for (const shell of SHELLS) {
    const counts = { same: 0, stricter: 0, looser: 0, leaked: 0 };
    const moves = new Map<string, number>();
    const addedKeys = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const [i, command] of corpus.entries()) {
      const a = base.rows[shell][i]!;
      const b = head.rows[shell][i]!;
      const equal = JSON.stringify(normal(a)) === JSON.stringify(normal(b));
      if (equal) { counts.same++; continue; }
      const looser = looserThan(a, b);
      if (looser.length) {
        counts.looser++;
        console.log(`LOOSER ${shell} #${i}: ${JSON.stringify(command).slice(0, 200)}\n  ${looser.join('; ')}`);
      } else counts.stricter++;
      if (!CONTROL_WORD.test(command)) {
        counts.leaked++;
        console.log(`CHANGED WITHOUT A CONTROL WORD ${shell} #${i}: ${JSON.stringify(command).slice(0, 200)}`);
      }
      for (const judgeOff of [false, true]) {
        const from: Route = routeOf(a, { judgeOff });
        const to: Route = routeOf(b, { judgeOff });
        if (from !== to) bump(moves, `${judgeOff ? 'judge off' : 'judge on '}: ${from} -> ${to}`);
      }
      for (const key of new Set(b.reasonKeys)) if (!a.reasonKeys.includes(key)) bump(addedKeys, key);
    }
    console.log(`\n## ${shell}: ${corpus.length} rows — same ${counts.same}, stricter ${counts.stricter}, looser ${counts.looser}; changed rows without a control word ${counts.leaked}`);
    for (const [move, n] of [...moves].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${move}\t${n}`);
    console.log('  added reason keys:');
    for (const [key, n] of [...addedKeys].sort((x, y) => y[1] - x[1])) console.log(`    ${key}\t${n}`);
    bad += counts.looser + counts.leaked;
  }
  return bad > 0 ? 1 : 0;
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string' }, out: { type: 'string' }, corpus: { type: 'string' } } });
const [cmd, ...rest] = positionals;
if (cmd === 'extract' && values.repo && values.out) extract(values.repo, values.out);
else if (cmd === 'run' && values.repo && values.corpus && values.out) await run(values.repo, values.corpus, values.out);
else if (cmd === 'compare' && rest.length === 2 && values.corpus) process.exitCode = compare(rest[0]!, rest[1]!, values.corpus);
else { console.error(USAGE); process.exitCode = 2; }
