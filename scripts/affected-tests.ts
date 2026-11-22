import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const USAGE = 'usage: node scripts/affected-tests.ts [--base origin/main] [--run] [file ...]';
export const TEST_GLOB = 'tests/**/*.test.ts';
const LOADER = './tests/helpers/tsx-loader.mjs';
const PARSED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SCANNED = ['src/', 'web/src/', 'scripts/', 'tests/'];
const TRY_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const REPO_PATH = /^(?:src|web|scripts|templates|assets|deploy|tests)(?:[/\\][^\s'"`]*)?$/u;
const WHOLE = '';
const KNOWN_SAFE: Record<string, string[]> = {
  'src/paths.ts': ["resolve(dirname(fileURLToPath(import.meta.url)), '..')"],
  'tests/helpers/dom.ts': ['import(new URL(path, from).href)'],
};

export type Scan = {
  edges: string[];
  missing: string[][];
  dynamic: string[];
  loads: string[];
  reads: string[];
  anchors: string[];
};

export type Pick = {
  tests: string[];
  all: string[];
  dynamic: string[];
  everyChange: string[];
};

const slash = (p: string): string => p.replaceAll('\\', '/');
const emptyScan = (): Scan => ({ edges: [], missing: [], dynamic: [], loads: [], reads: [], anchors: [] });
const under = (file: string, prefix: string): boolean => file === prefix || file.startsWith(`${prefix}/`);

function isFile(abs: string): boolean {
  try { return statSync(abs).isFile(); } catch { return false; }
}

function candidates(base: string): string[] {
  const out = [base];
  const ext = extname(base);
  for (const swap of JS_TO_TS[ext] ?? []) out.push(base.slice(0, -ext.length) + swap);
  for (const e of TRY_EXT) out.push(base + e);
  for (const e of TRY_EXT) out.push(join(base, `index${e}`));
  return out;
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function pathText(node: ts.Node | undefined): { text: string; whole: boolean } | undefined {
  const text = literal(node);
  if (text !== undefined) return { text, whole: true };
  if (node && ts.isTemplateExpression(node) && node.head.text.includes('/')) return { text: node.head.text.slice(0, node.head.text.lastIndexOf('/') + 1), whole: false };
  return undefined;
}

function isImportMeta(node: ts.Node, name?: string): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && (name === undefined || node.name.text === name);
}

function calleeName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function isFileAnchor(node: ts.Node): boolean {
  if (isImportMeta(node, 'dirname') || isImportMeta(node, 'filename') || isImportMeta(node, 'url')) return true;
  if (ts.isIdentifier(node) && (node.text === '__dirname' || node.text === '__filename')) return true;
  return ts.isCallExpression(node) && node.arguments.length === 1 && ['dirname', 'fileURLToPath'].includes(calleeName(node.expression) ?? '') && isFileAnchor(node.arguments[0]!);
}

function isCwd(node: ts.Node): boolean {
  return ts.isCallExpression(node) && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process' && node.expression.name.text === 'cwd';
}

export function scanFile(root: string, rel: string, testSide: boolean): Scan {
  const abs = join(root, rel);
  const dir = dirname(abs);
  const ext = extname(rel);
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ['.js', '.mjs', '.cjs'].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const at = (node: ts.Node): string => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const scan = emptyScan();
  const specs: string[] = [];
  const consumed = new Set<ts.Node>();
  const consume = (node: ts.Node): void => { consumed.add(node); ts.forEachChild(node, consume); };
  const repoRel = (target: string): string | undefined => {
    const r = slash(relative(root, target));
    return r === '' || r === '..' || r.startsWith('../') || isAbsolute(r) ? undefined : r;
  };
  const load = (node: ts.Node, target: string): void => {
    const r = repoRel(target);
    if (r === undefined) scan.anchors.push(at(node));
    else scan.loads.push(r);
  };
  const fileRelative = (node: ts.Node, arg: ts.Node | undefined): boolean => {
    const path = pathText(arg);
    if (!path || !path.text.startsWith('.')) return false;
    if (path.whole) specs.push(path.text);
    load(node, resolve(dir, path.text));
    return true;
  };

  const safe = KNOWN_SAFE[rel] ?? [];
  const visit = (node: ts.Node): void => {
    if (safe.length > 0 && (ts.isCallExpression(node) || ts.isNewExpression(node)) && safe.includes(node.getText(sf))) { consume(node); return; }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== undefined) specs.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== undefined) specs.push(spec);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literal(node.argument.literal);
      if (spec !== undefined) specs.push(spec);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? ts.factory.createNodeArray();
      const name = calleeName(node.expression);
      const isLoader = node.expression.kind === ts.SyntaxKind.ImportKeyword || (name === 'require' && ts.isIdentifier(node.expression)) || isImportMeta(node.expression, 'resolve');
      if (isLoader) {
        const path = pathText(args[0]);
        if (path?.whole) specs.push(path.text);
        else if (path?.text.startsWith('.')) load(node, resolve(dir, path.text));
        else { scan.dynamic.push(at(node)); scan.anchors.push(at(node)); }
      }
      if (name === 'createRequire' && args[0]) consume(args[0]);
      const base = args.find(arg => isImportMeta(arg, 'url'));
      if (base && fileRelative(node, args[0])) consume(base);
      if (ts.isCallExpression(node) && (name === 'join' || name === 'resolve') && args[0] && (isFileAnchor(args[0]) || isCwd(args[0]))) {
        const parts: string[] = [];
        for (const arg of args.slice(1)) {
          const path = pathText(arg);
          if (!path) break;
          parts.push(path.text);
          if (!path.whole) break;
        }
        load(node, resolve(isCwd(args[0]) ? root : dir, ...parts));
        consume(args[0]);
      }
    } else if (ts.isBinaryExpression(node) && isImportMeta(node.left, 'url')
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      consume(node.left);
    }
    if (!consumed.has(node) && isFileAnchor(node)) { scan.anchors.push(at(node)); consume(node); }
    if (testSide) {
      const value = literal(node);
      if (value !== undefined && REPO_PATH.test(value) && !value.split(/[/\\]/u).includes('..')) {
        const cut = value.search(/[*?]/u);
        const plain = slash(cut < 0 ? value : value.slice(0, Math.max(0, value.lastIndexOf('/', cut)))).replace(/\/+$/u, '');
        if (PARSED.has(extname(plain)) && isFile(join(root, plain))) scan.edges.push(plain);
        else if (plain) scan.reads.push(plain);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const raw of specs) {
    const spec = raw.split('?')[0]!;
    if (!(spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..')) continue;
    const list = candidates(resolve(dir, spec));
    const hit = list.find(isFile);
    if (hit) {
      const r = repoRel(hit);
      if (r !== undefined) scan.edges.push(r);
    } else {
      scan.missing.push(list.map(repoRel).filter(r => r !== undefined));
    }
  }
  return scan;
}

export class ImportGraph {
  readonly root: string;
  readonly tests: string[];
  readonly #scans = new Map<string, Scan>();
  readonly #closures = new Map<string, Set<string>>();
  readonly #dirs = new Map<string, string[]>();

  constructor(root: string) {
    this.root = resolve(root);
    this.tests = globSync(TEST_GLOB, { cwd: this.root }).map(slash).sort();
    for (const test of this.tests) this.#closures.set(test, this.#closure(test));
  }

  scan(rel: string): Scan {
    let scan = this.#scans.get(rel);
    if (!scan) {
      scan = PARSED.has(extname(rel)) && isFile(join(this.root, rel)) ? scanFile(this.root, rel, rel.startsWith('tests/')) : emptyScan();
      this.#scans.set(rel, scan);
    }
    return scan;
  }

  #codeUnder(prefix: string): string[] {
    let files = this.#dirs.get(prefix);
    if (!files) {
      const abs = join(this.root, prefix);
      let isDir = false;
      try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
      files = isDir
        ? globSync(`${prefix}/**/*`, { cwd: this.root, exclude: name => name === 'node_modules' }).map(slash)
          .filter(file => PARSED.has(extname(file)) && !file.endsWith('.test.ts') && isFile(join(this.root, file)))
        : PARSED.has(extname(prefix)) && isFile(abs) ? [prefix] : [];
      this.#dirs.set(prefix, files);
    }
    return files;
  }

  #closure(test: string): Set<string> {
    const seen = new Set<string>([test]);
    const queue = [test];
    while (queue.length > 0) {
      const scan = this.scan(queue.pop()!);
      for (const next of [...scan.edges, ...scan.loads.flatMap(p => this.#codeUnder(p))]) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen;
  }

  closure(test: string): ReadonlySet<string> { return this.#closures.get(test) ?? new Set(); }

  #touches(test: string, changed: string): boolean {
    const files = this.closure(test);
    if (files.has(changed)) return true;
    for (const file of files) {
      const scan = this.scan(file);
      if (scan.anchors.length > 0) return true;
      if ([...scan.loads, ...scan.reads].some(p => under(changed, p))) return true;
      if (scan.missing.some(list => list.includes(changed))) return true;
    }
    return false;
  }

  everyChange(): string[] {
    return this.tests.filter(test => [...this.closure(test)].some(file => this.scan(file).anchors.length > 0));
  }

  dynamicIn(tests: readonly string[]): string[] {
    const files = new Set(tests.flatMap(test => [...this.closure(test)]));
    return [...files].sort().flatMap(file => this.scan(file).dynamic);
  }

  pick(changedFiles: readonly string[]): Pick {
    const changed = [...new Set(changedFiles.map(slash))].sort();
    const all: string[] = [];
    for (const file of changed) {
      const why = fallbackReason(file);
      if (why) all.push(`${file}: ${why}`);
    }
    const tests = all.length > 0 ? this.tests : this.tests.filter(test => changed.some(file => this.#touches(test, file)));
    return { tests, all, dynamic: this.dynamicIn(tests), everyChange: this.everyChange() };
  }
}

export function fallbackReason(file: string): string | undefined {
  if (file === 'package.json' || file === 'package-lock.json') return 'dependencies or npm scripts changed';
  if (/^tsconfig[^/]*\.json$/u.test(file)) return 'TypeScript settings changed';
  if (file.startsWith('tests/helpers/')) return 'shared test helper or the test loader changed';
  if (!SCANNED.some(dir => file.startsWith(dir))) return `outside ${SCANNED.join(' ')}`;
  if (!PARSED.has(extname(file))) return 'not a parsed code file (may be read at runtime by path)';
  return undefined;
}

function git(root: string, args: string[]): string[] {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\0').filter(Boolean);
}

export function changedFromGit(root: string, base: string): string[] {
  return [
    ...git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`]),
    ...git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ];
}

export function knownFiles(root: string, base: string): Map<string, string> {
  const lists = [['ls-files', '-z'], ['ls-files', '--others', '--exclude-standard', '-z'], ['ls-tree', '-r', '--name-only', '-z', base]];
  const known = new Map<string, string>();
  for (const args of lists) {
    let files: string[] = [];
    try { files = git(root, args); } catch { files = []; }
    for (const file of files) known.set(process.platform === 'win32' ? file.toLowerCase() : file, file);
  }
  return known;
}

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string', default: 'origin/main' }, run: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const graph = new ImportGraph(root);
  let changed: string[] = [];
  let forced: string | undefined;
  if (positionals.length > 0) {
    const known = knownFiles(root, values.base);
    changed = positionals.map(file => {
      const rel = slash(relative(root, resolve(file)));
      const real = known.get(process.platform === 'win32' ? rel.toLowerCase() : rel);
      if (real !== undefined) return real;
      if (!existsSync(join(root, rel))) forced ??= `${rel}: neither on disk nor known to git`;
      return rel;
    });
  } else {
    try { changed = changedFromGit(root, values.base); }
    catch (error) { forced = `could not list changes against ${values.base}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; }
  }
  const pick = graph.pick(changed);
  if (forced) { pick.all.push(forced); pick.tests = graph.tests; }
  const err = (line: string): void => { process.stderr.write(`${line}\n`); };
  err(`changed files: ${changed.length}`);
  if (pick.all.length > 0) {
    err('picking ALL tests because:');
    for (const why of pick.all) err(`  ${why}`);
  }
  err(`picked ${pick.tests.length} of ${graph.tests.length} test files`);
  if (pick.everyChange.length > 0) err(`note: ${pick.everyChange.length} test files read repo paths at runtime in a way that could not be narrowed, so any change picks them`);
  if (pick.dynamic.length > 0) {
    err(`warn: ${pick.dynamic.length} import()/require() with a non-literal specifier among the picked tests' imports (not followed, so the tests reaching them are picked for any change):`);
    for (const where of pick.dynamic) err(`  ${where}`);
  }
  if (!values.run) {
    for (const test of pick.tests) process.stdout.write(`${test}\n`);
    return 0;
  }
  if (pick.tests.length === 0) { err('no tests to run'); return 0; }
  const targets = pick.all.length > 0 ? [TEST_GLOB] : pick.tests;
  const run = spawnSync(process.execPath, ['--import', LOADER, '--test', '--test-reporter=spec', ...targets], { cwd: root, stdio: 'inherit' });
  if (run.error) err(`could not start the test run: ${run.error.message}`);
  return run.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
}
