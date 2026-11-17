// How strict a shell verdict is, for the "never less strict" invariant (plans/beat/steps/control-bodies).
// Shared by tests/guard-corpus-invariant.test.ts and scripts/guard-corpus.ts so both judge "stricter / looser" the same way.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ownerKeysOf, POLICY_KEYS, REASON_ORDER, refusedKeysOf } from '../../src/tools/hooks/decision-order.ts';

export type Route = 'allow' | 'judge' | 'product' | 'owner' | 'refused';
export const ROUTES: readonly Route[] = ['allow', 'judge', 'product', 'owner', 'refused'];
const RANK: Record<Route, number> = { allow: 0, judge: 1, product: 2, owner: 3, refused: 4 };

export type OutKind = 'none' | 'send' | 'delete' | 'deny';

export interface GuardRow {
  decision: 'allow' | 'ask' | 'deny';
  reasonKeys: string[];
  askKinds: string[];
  fetched: boolean;
  downloaded: boolean;
  limits: boolean;
  // push destinations from pushesOf: a folder, or null when beat cannot tell which repository
  pushes: Array<string | null>;
  outbound: OutKind;
  throw?: string;
}

// Keys that the pipeline sends to the owner instead of the judge when the judge is off
export const NO_JUDGE_OWNER_KEYS: ReadonlySet<string> = new Set(['code.self_touch', 'shape.control_opaque']);

export function routeOf(row: GuardRow, opts: { judgeOff: boolean }): Route {
  if (row.throw !== undefined) return 'refused';
  if (row.decision === 'deny' || refusedKeysOf(row.reasonKeys).length > 0 || row.outbound === 'deny') return 'refused';
  if (row.decision === 'allow') return row.outbound === 'send' || row.outbound === 'delete' ? 'owner' : 'allow';
  if (ownerKeysOf(row.reasonKeys).length > 0 || row.reasonKeys.some(k => POLICY_KEYS.has(k))) return 'owner';
  if (row.outbound === 'send' || row.outbound === 'delete') return 'owner';
  if (opts.judgeOff && row.reasonKeys.some(k => NO_JUDGE_OWNER_KEYS.has(k))) return 'owner';
  if (row.reasonKeys.some(k => REASON_ORDER.get(k) === 4)) return 'product';
  return opts.judgeOff ? 'allow' : 'judge';
}

const OUT_RANK: Record<OutKind, number> = { none: 0, send: 1, delete: 1, deny: 2 };
const keysOfOrder = (keys: readonly string[], order: number): string[] => [...new Set(keys.filter(k => REASON_ORDER.get(k) === order || (order === 3 && POLICY_KEYS.has(k))))];

// Every way in which `after` is looser than `before`. Empty = the same or stricter.
export function looserThan(before: GuardRow, after: GuardRow): string[] {
  if (after.throw !== undefined) return [];
  const out: string[] = [];
  for (const judgeOff of [false, true]) {
    const a = routeOf(before, { judgeOff });
    const b = routeOf(after, { judgeOff });
    if (RANK[b] < RANK[a]) out.push(`route${judgeOff ? '(judge off)' : ''} ${a} -> ${b}`);
  }
  if (routeOf(after, { judgeOff: false }) === 'refused') return out;
  for (const order of [1, 3]) {
    const lost = keysOfOrder(before.reasonKeys, order).filter(k => !after.reasonKeys.includes(k));
    if (lost.length) out.push(`order ${order} keys lost: ${lost.join(',')}`);
  }
  // Inside a block, an ask can become a once-only ("code") ask, which is stricter; a lost kind is fine when "code" took its place
  const lostKinds = before.decision === 'ask' ? before.askKinds.filter(k => !after.askKinds.includes(k)) : [];
  if (lostKinds.length && !after.askKinds.includes('code')) out.push(`askKinds lost: ${lostKinds.join(',')}`);
  if (OUT_RANK[after.outbound] < OUT_RANK[before.outbound]) out.push(`outbound ${before.outbound} -> ${after.outbound}`);
  if (after.pushes.length < before.pushes.length) out.push(`pushes ${before.pushes.length} -> ${after.pushes.length}`);
  else if (!after.pushes.includes(null)) {
    const lost = before.pushes.filter(d => d !== null && !after.pushes.includes(d));
    if (lost.length || (before.pushes.includes(null))) out.push(`push destinations lost: ${before.pushes.join(',')} -> ${after.pushes.join(',')}`);
  }
  for (const flag of ['fetched', 'downloaded', 'limits'] as const) if (before[flag] && !after[flag]) out.push(`${flag} lost`);
  return out;
}

export function stricterThan(before: GuardRow, after: GuardRow): boolean {
  if (looserThan(before, after).length) return false;
  return JSON.stringify(normal(before)) !== JSON.stringify(normal(after));
}

// String literals of every tests/**/*.ts file (TypeScript's own parser, so template literals and regexes are not misread), deduplicated, sorted
export function corpusOf(testsDir: string): string[] {
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') ? [full] : [];
  });
  const found = new Set<string>();
  for (const file of files(testsDir).sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const visit = (node: import('typescript').Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.length < 2000 && node.text.trim() !== '') found.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
}

// The guard modules of one checkout (the script loads them from a base and a head checkout)
export interface GuardModules {
  checkShellCommand: (command: string, cwd: string, opts: Record<string, unknown>) => {
    decision: GuardRow['decision']; reasonKeys: string[]; askKinds: string[]; fetched: boolean; downloaded: boolean; limits: boolean; statements: unknown[];
  };
  pushesOf: (statements: never[], reasonKeys: readonly string[]) => Array<{ dir: string | null }>;
  outboundOf: (facts: { tool: 'shell'; statements: never[] }, env: Record<string, unknown>) => { kind: string } | undefined;
}

const NO_GIT = { isTracked: () => false, isClean: () => false, isCreated: () => false, pushUrls: () => undefined, pushRemote: () => undefined };

export function guardRowOf(mods: GuardModules, command: string, shell: 'powershell' | 'bash', ws: string): GuardRow {
  try {
    const v = mods.checkShellCommand(command, ws, { policy: { roots: [{ path: ws, mode: 'write' }], deny: [] }, outsideRoots: 'ask', shell, windows: shell === 'powershell' });
    const statements = v.statements as never[];
    const out = v.decision === 'deny' ? undefined : mods.outboundOf({ tool: 'shell', statements }, NO_GIT);
    return {
      decision: v.decision, reasonKeys: [...v.reasonKeys], askKinds: [...v.askKinds], fetched: v.fetched, downloaded: v.downloaded, limits: v.limits,
      pushes: mods.pushesOf(statements, v.reasonKeys).map(p => p.dir), outbound: (out?.kind ?? 'none') as OutKind,
    };
  } catch (error) {
    return { decision: 'deny', reasonKeys: [], askKinds: [], fetched: false, downloaded: false, limits: false, pushes: [], outbound: 'none', throw: String((error as Error).message ?? error).slice(0, 200) };
  }
}

export const normal = (row: GuardRow): GuardRow => ({
  ...row, reasonKeys: [...new Set(row.reasonKeys)].sort(), askKinds: [...new Set(row.askKinds)].sort(), pushes: [...row.pushes].map(String).sort() as Array<string | null>,
});
