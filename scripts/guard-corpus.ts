// Compare the shell guard of two checkouts (base and head) over the same corpus of strings (plans/beat/steps/control-bodies).
//   extract --repo <base> --repo <head> --out <dir>/corpus.json   string literals of every <repo>/tests/**/*.ts (union), under 2,000 chars, plus the cd templates
//   run --repo <checkout> --corpus <dir>/corpus.json --out <file>     each string, in each form (plain, wrapped, after a cd prefix), in each fixture,
//                                                                     through checkShellCommand as powershell (windows); bash: plain form only
//   compare <base.json> <head.json> --corpus <dir>/corpus.json        same / stricter / looser per row; exit code 1 on any looser row,
//                                                                     or on a changed plain row with no control keyword that is not in EXPECTED
// The fixtures live in <dir of corpus>/fx, so both runs see the same paths: ws (with sub, private, ro, and a repo b whose config sets core.fsmonitor).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CD_PREFIXES, corpusOf, guardRowOf, looserThan, normal, routeOf, type GuardModules, type GuardRow, type Route } from '../tests/helpers/guard-route.ts';

const USAGE = [
  'usage: node --import ./tests/helpers/tsx-loader.mjs scripts/guard-corpus.ts extract --repo <base> --repo <head> --out <dir>/corpus.json',
  '       ... run --repo <checkout> --corpus <dir>/corpus.json --out <file>',
  '       ... compare <base.json> <head.json> --corpus <dir>/corpus.json',
].join('\n');

const CONTROL_WORD = /(?:^|[^\w-])(?:try|catch|finally|trap|while|do|until|for|foreach|switch|function|filter|begin|process|end|clean|dynamicparam|param|return|throw|exit|class|enum|data|workflow|parallel|sequence|inlinescript|using)(?![\w-])/iu;

// cd shapes the review named, run in every fixture and form
const CD_TEMPLATES = [
  'cd b\ngit status', 'cd ..\nRemove-Item -Recurse -Force ws', 'cd private\nGet-Content notes.txt', 'cd ro\nSet-Content x.txt y', 'cd ..\nGet-Content ws/.env',
  'Set-Location ..\nRemove-Item -Recurse -Force sub', 'cd ..\ncd ..\nRemove-Item -Recurse -Force *', 'cd b; git fetch origin', 'git pull',
];

// Forms of one string (PowerShell): plain, two bodies, and every cd prefix in front
const FORMS: Array<[string, (c: string) => string]> = [
  ['plain', c => c],
  ['try', c => `try {\n${c}\n} catch {}`],
  ['while', c => `while ($true) {\n${c}\n}`],
  ...CD_PREFIXES.map(([p]): [string, (c: string) => string] => [`after ${p}`, c => `${p}\n${c}`]),
];

// Plain rows without a control keyword that are expected to become stricter in this change (security review D7)
const EXPECTED: Array<{ shell: 'powershell' | 'bash'; pattern: RegExp; why: string }> = [
  { shell: 'powershell', pattern: /\bcd\b|set-location|pushd|popd/iu, why: 'a cd that may not run / cannot be worked out keeps every folder and every check' },
  { shell: 'bash', pattern: /\bcd\b|pushd|popd/iu, why: 'a cd that cannot be worked out no longer skips git and path checks' },
  { shell: 'powershell', pattern: /^\s*git\b|\bgit\s/iu, why: 'git after an odd / unknown repo goes on to the network and path checks' },
  { shell: 'bash', pattern: /^\s*git\b|\bgit\s/iu, why: 'git after an odd / unknown repo goes on to the network and path checks' },
  { shell: 'powershell', pattern: /^\s*\[CmdletBinding/iu, why: 'an attribute before param is refused again, as on base' },
  { shell: 'bash', pattern: /(?:^|[\s;&|({/$])(?:sudo|doas|su|pkexec|runas)\s/u, why: 'assign-guard: sudo / doas / su / pkexec not at the head of a line is refused as guard.elevate' },
  { shell: 'powershell', pattern: /^\s*(?:\[[\w.]+(?:\[\])?\])*\$[\w:]+[^\s=]*\s*[+\-*/%]?=/u, why: 'assign-guard: the right-hand side of an assignment is read as a statement ($p=@{…} as a hashtable, a bare right side as a command, no right side as a lex error)' },
];

const SHELLS = ['powershell', 'bash'] as const;
type Shell = typeof SHELLS[number];
interface Fixture { name: string; cwd: string; policy: Record<string, unknown> }
interface Verdicts { repo: string; keys: string[]; rows: GuardRow[] }

function fixtures(dir: string, realish: (p: string) => string): Fixture[] {
  const ws = join(dir, 'ws');
  for (const sub of ['sub', 'private', 'ro', 'b', 'a']) mkdirSync(join(ws, sub), { recursive: true });
  writeFileSync(join(ws, 'private', 'notes.txt'), 'x');
  writeFileSync(join(ws, 'ro', 'x.txt'), 'x');
  // b is its own repository even when the fixtures sit inside another one: init it, then write only to b's own config file
  // (never `git -C b config`, which would write to the enclosing repository when b is not yet a repository)
  execFileSync('git', ['init', '-q', join(ws, 'b')]);
  execFileSync('git', ['config', '--file', join(ws, 'b', '.git', 'config'), 'core.fsmonitor', 'node put.js']);
  const real = realish(ws);
  const plain = { roots: [{ path: real, mode: 'write' }], deny: [] };
  return [
    { name: 'root', cwd: real, policy: plain },
    { name: 'sub', cwd: join(real, 'sub'), policy: plain },
    { name: 'deny+ro', cwd: real, policy: { roots: [{ path: real, mode: 'write' }, { path: join(real, 'ro'), mode: 'read' }], deny: [join(real, 'private')] } },
  ];
}

function extract(repos: string[], outFile: string): void {
  const found = new Set<string>(CD_TEMPLATES);
  for (const repo of repos) for (const s of corpusOf(join(repo, 'tests'))) found.add(s);
  const list = [...found].sort();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(list));
  console.log(`corpus: ${list.length} strings from ${repos.length} checkouts -> ${outFile}`);
}

async function run(repo: string, corpusFile: string, outFile: string): Promise<void> {
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as string[];
  const at = (rel: string) => import(pathToFileURL(join(resolve(repo), rel)).href);
  const guard = await at('src/tools/hooks/shell-guard.ts');
  const outbound = await at('src/tools/hooks/outbound.ts');
  const scope = await at('src/tools/hooks/scope.ts');
  const mods: GuardModules = { checkShellCommand: guard.checkShellCommand, pushesOf: outbound.pushesOf, outboundOf: outbound.outboundOf };
  const fx = fixtures(join(dirname(resolve(corpusFile)), 'fx'), scope.realish);
  const started = Date.now();
  const keys: string[] = [];
  const rows: GuardRow[] = [];
  for (const f of fx) {
    for (const [i, command] of corpus.entries()) {
      for (const [form, wrap] of FORMS) {
        keys.push(`powershell|${f.name}|${form}|${i}`);
        rows.push(guardRowOf(mods, wrap(command), 'powershell', f.cwd, f.policy));
      }
      keys.push(`bash|${f.name}|plain|${i}`);
      rows.push(guardRowOf(mods, command, 'bash', f.cwd, f.policy));
    }
  }
  writeFileSync(outFile, JSON.stringify({ repo: resolve(repo), keys, rows } satisfies Verdicts));
  console.log(`run: ${corpus.length} strings, ${fx.length} fixtures, ${FORMS.length} PowerShell forms + bash plain = ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outFile}`);
}

function compare(baseFile: string, headFile: string, corpusFile: string): number {
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as string[];
  const base = JSON.parse(readFileSync(baseFile, 'utf8')) as Verdicts;
  const head = JSON.parse(readFileSync(headFile, 'utf8')) as Verdicts;
  if (JSON.stringify(base.keys) !== JSON.stringify(head.keys)) { console.log('the two runs have different rows (run both with the same script and corpus)'); return 2; }
  const groups = new Map<string, { same: number; stricter: number; looser: number; leaked: number; moves: Map<string, number> }>();
  const expectedHits = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let bad = 0;
  let printed = 0;
  for (const [n, key] of base.keys.entries()) {
    const [shell, fixture, form, index] = key.split('|') as [Shell, string, string, string];
    const command = corpus[Number(index)]!;
    const group = `${shell} | ${fixture} | ${form}`;
    const g = groups.get(group) ?? { same: 0, stricter: 0, looser: 0, leaked: 0, moves: new Map() };
    groups.set(group, g);
    const a = base.rows[n]!;
    const b = head.rows[n]!;
    if (JSON.stringify(normal(a)) === JSON.stringify(normal(b))) { g.same++; continue; }
    const looser = looserThan(a, b);
    if (looser.length) {
      g.looser++;
      if (printed++ < 200) console.log(`LOOSER ${group} #${index}: ${JSON.stringify(command).slice(0, 200)}\n  ${looser.join('; ')}`);
    } else g.stricter++;
    if (form === 'plain' && !CONTROL_WORD.test(command)) {
      const why = EXPECTED.find(e => e.shell === shell && e.pattern.test(command));
      if (why) bump(expectedHits, `${shell}: ${why.why}`);
      else {
        g.leaked++;
        if (printed++ < 200) console.log(`CHANGED, NOT EXPECTED ${group} #${index}: ${JSON.stringify(command).slice(0, 200)}`);
      }
    }
    for (const judgeOff of [false, true]) {
      const from: Route = routeOf(a, { judgeOff });
      const to: Route = routeOf(b, { judgeOff });
      if (from !== to) bump(g.moves, `${judgeOff ? 'judge off' : 'judge on '}: ${from} -> ${to}`);
    }
  }
  for (const [group, g] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`## ${group}: same ${g.same}, stricter ${g.stricter}, looser ${g.looser}, changed and not expected ${g.leaked}`);
    for (const [move, n] of [...g.moves].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`    ${move}\t${n}`);
    bad += g.looser + g.leaked;
  }
  console.log('\nexpected stricter plain rows without a control keyword:');
  for (const [why, n] of expectedHits) console.log(`  ${n}\t${why}`);
  const total = [...groups.values()].reduce((s, g) => ({ rows: s.rows + g.same + g.stricter + g.looser, looser: s.looser + g.looser, stricter: s.stricter + g.stricter }), { rows: 0, looser: 0, stricter: 0 });
  console.log(`\nTOTAL rows ${total.rows}, stricter ${total.stricter}, looser ${total.looser}, changed and not expected ${bad - total.looser}`);
  return bad > 0 ? 1 : 0;
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string', multiple: true }, out: { type: 'string' }, corpus: { type: 'string' } } });
const [cmd, ...rest] = positionals;
const repos = values.repo ?? [];
if (cmd === 'extract' && repos.length && values.out) extract(repos, values.out);
else if (cmd === 'run' && repos.length === 1 && values.corpus && values.out) await run(repos[0]!, values.corpus, values.out);
else if (cmd === 'compare' && rest.length === 2 && values.corpus) process.exitCode = compare(rest[0]!, rest[1]!, values.corpus);
else { console.error(USAGE); process.exitCode = 2; }
