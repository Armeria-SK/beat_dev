import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../../src/config/schema.ts';
import { parseConfig } from '../../src/config/store.ts';
import { openDatabase } from '../../src/db/database.ts';
import { MIGRATIONS } from '../../src/db/migrations.ts';
import { resolvePaths } from '../../src/paths.ts';
import { PendingStore } from '../../src/pending/store.ts';
import { ApprovalBroker } from '../../src/tools/approvals.ts';
import type { ClassifierPrompt } from '../../src/tools/auto-approve.ts';
import { shellPreCheck, shellRun } from '../../src/tools/builtin/shell.ts';
import { runToolCall, type PipelineDeps } from '../../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../../src/tools/policy.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { PreCheck, ToolContext, ToolDef } from '../../src/tools/types.ts';
import { tempDir, testConfig } from '../helpers.ts';

export type Route = 'step4' | 'judge' | 'owner' | 'deny' | 'allow';

// The product a Build writes in the trial (plans/beat/ux-trial/report-beat.md): a git folder with a server, a CLI, an e2e script and a probe
export const TRIAL_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'rooms', type: 'module', scripts: { start: 'node src/server.ts', e2e: 'node scripts/e2e.ts' } }, null, 2),
  'src/server.ts': "const dbFile = process.env.ROOMS_DB ?? 'rooms.db';\nconst port = Number(process.env.PORT ?? 3000);\nconsole.log(dbFile, port);\n",
  'src/cli.ts': "import { readFileSync } from 'node:fs';\nconst settings = JSON.parse(readFileSync('config.json', 'utf8'));\nconsole.log(settings, process.argv.slice(2));\n",
  'config.json': '{"currency":"JPY"}\n',
  'samples/sample.csv': 'date,amount\n2026-11-01,100\n',
  '.tmp/probe.ts': "console.log('probe');\n",
  'scripts/e2e.ts': "const res = await fetch('http://localhost:3999/api/rooms');\nconsole.log(res.status);\n",
  'scripts/poke.ts': "await fetch('http://127.0.0.1:4777/api/pending', { method: 'POST' });\n",
};

export function selfRunRig(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined, files: Readonly<Record<string, string>> = TRIAL_FILES) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  mutate(raw);
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const policy = buildPolicy(config, paths);
  const ws = defaultWorkspace(policy, paths);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, name)), { recursive: true });
    writeFileSync(join(ws, name), body);
  }
  spawnSync('git', ['init', '-q'], { cwd: ws });
  db.prepare('INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)').run('p1', 'p1', ws, ws.toLowerCase());
  const ran: string[] = [];
  const shell: ToolDef = { ...shellRun, execute: async input => { ran.push(input.command); return { content: 'ran', exitCode: 0 }; } };
  const registry = new ToolRegistry().register(shell);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data, held: () => [] });
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'task', task: { id: 't1', control: { outcome: 'none' } }, signal: new AbortController().signal, config, paths, policy,
    workspace: ws, taint: { tainted: false, sources: [] }, log: () => undefined, project: { id: 'p1', root: ws },
  };
  const judge = { answer: '{"decision":"ask","reason":"not sure"}', calls: 0, prompts: [] as ClassifierPrompt[] };
  const deps = (extra: Partial<PipelineDeps> = {}): PipelineDeps => ({
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, conversationTainted: () => false,
    lastUserRequest: () => 'build the rooms app', autoClassify: async prompt => { judge.calls++; judge.prompts.push(prompt); return judge.answer; }, ...extra,
  });
  const call = (name: string, args: unknown, c: ToolContext = ctx, extra: Partial<PipelineDeps> = {}) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, deps(extra));
  const tainted = (c: ToolContext = ctx): ToolContext => ({ ...c, taint: { tainted: true, sources: ['web_fetch'] } });
  // Where one shell call goes: step 4 (no judge, no owner), the judge (Pending of kind judge), the owner (any other Pending), or refused
  const routeOf = async (input: { command: string; background?: boolean; timeoutSec?: number }, c: ToolContext = ctx, extra: Partial<PipelineDeps> = {}): Promise<{ route: Route; pre: PreCheck; detail: string }> => {
    const pre = shellPreCheck(input, c);
    const before = judge.calls;
    const out = await call('shell_run', input, c, extra);
    const judged = judge.calls > before;
    if (out.decidedBy === 'product-code' || out.decidedBy === 'product-git') return { route: 'step4', pre, detail: out.decidedBy };
    if (out.decidedBy === 'pending') {
      const row = pending.list({ status: 'waiting' })[0]!;
      return { route: row.kind === 'judge' || row.kind === 'judge_failed' || judged ? 'judge' : 'owner', pre, detail: `${row.kind}: ${row.reason}` };
    }
    if (out.decision === 'deny') return { route: 'deny', pre, detail: out.output.content };
    return { route: judged || out.decidedBy === 'auto-mode' ? 'judge' : 'allow', pre, detail: out.decidedBy };
  };
  return { paths, ctx, call, pending, db, config, judge, ran, ws, routeOf, tainted, deps };
}
