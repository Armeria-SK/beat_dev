import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MISS_RATIO, missReason, openReadOnly, tokenReport, type MissReason } from '../token-report.ts';

// ブラウザの確かめの物差し（plans/beat/steps/browser-rethink/PLAN.md の P0）。物差しの会話 1 つの数を DB とアプリの記録から集める。DB は読むだけ。

const USAGE = 'usage: node scripts/browser-bench/collect.ts --db <beat.db> --conversation <id> [--events <events.jsonl>]';
const PRELOAD = (name: string): boolean => name.startsWith('browser_') || ['pending_withdraw', 'deviation_add', 'image_view'].includes(name);

export const ITEMS = ['submit', 'list', 'plus10', 'date_button', 'mark_ordered', 'logout'] as const;
export type Item = typeof ITEMS[number];

interface CallRow { run_id: string; seq: number; purpose: string; model: string; input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; output_tokens: number | null; removed: number; tools_hash: string; frozen_hash: string; dynamic_hash: string; started_at: number }

// アプリの記録で、受け入れ 6 項目の操作が実際に起きたか
export function appRecord(lines: readonly string[]): Record<Item, boolean> & { adminLoginFailed: number } {
  const events = lines.filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as { kind: string; added?: number[]; after?: number; ok?: boolean }]; } catch { return []; } });
  const submitted = events.filter(e => e.kind === 'submit');
  return {
    submit: submitted.length > 0,
    list: events.some(e => e.kind === 'list_view' && (e.added ?? []).length > 0),
    plus10: events.some(e => e.kind === 'plus10'),
    date_button: events.some(e => e.kind === 'date_button'),
    mark_ordered: events.some(e => e.kind === 'mark_ordered'),
    logout: events.some(e => e.kind === 'logout'),
    adminLoginFailed: events.filter(e => e.kind === 'admin_login' && e.ok === false).length,
  };
}

export function collect(dbPath: string, conversationId: string, eventsPath?: string) {
  const db = openReadOnly(dbPath);
  try {
    const report = tokenReport(db, { since: 0, until: Date.now() + 1, runLimit: 10_000 });
    const conversation = report.conversations.find(c => c.conversationId === conversationId);
    const runs = report.runs.filter(r => r.conversationId === conversationId).sort((a, b) => a.startedAt - b.startedAt);

    const calls = db.prepare(`
      SELECT m.run_id, m.seq, m.purpose, m.model, m.input_tokens, m.cache_read_tokens, m.cache_write_tokens, m.output_tokens, m.removed, m.tools_hash, m.frozen_hash, m.dynamic_hash, m.started_at
      FROM model_calls m JOIN engine_runs r ON r.id = m.run_id WHERE r.conversation_id = ? AND m.purpose != 'compact' ORDER BY m.started_at, m.run_id, m.seq
    `).all(conversationId) as unknown as CallRow[];
    const misses: Partial<Record<MissReason, { count: number; lostTokens: number }>> = {};
    calls.forEach((row, i) => {
      const prev = calls[i - 1];
      if (!prev || row.cache_read_tokens === null) return;
      const expected = prev.cache_write_tokens !== null ? (prev.cache_read_tokens ?? 0) + prev.cache_write_tokens : prev.input_tokens ?? 0;
      if (expected <= 0 || row.cache_read_tokens >= expected * MISS_RATIO) return;
      const reason = missReason(prev, row);
      const m = misses[reason] ?? { count: 0, lostTokens: 0 };
      m.count++; m.lostTokens += expected - row.cache_read_tokens;
      misses[reason] = m;
    });

    const tools = db.prepare('SELECT tool, decision, decided_by, input, created_at FROM tool_calls WHERE conversation_id = ? ORDER BY created_at').all(conversationId) as Array<{ tool: string; decision: string; decided_by: string; input: string; created_at: number }>;
    const byTool: Record<string, number> = {};
    for (const t of tools) byTool[t.tool] = (byTool[t.tool] ?? 0) + 1;
    const browser = tools.filter(t => t.tool.startsWith('browser_'));
    const actSteps = browser.filter(t => t.tool === 'browser_act').reduce((n, t) => { try { return n + ((JSON.parse(t.input) as { steps?: unknown[] }).steps?.length ?? 0); } catch { return n; } }, 0);

    const searches = (db.prepare("SELECT parts FROM messages WHERE conversation_id = ? AND role = 'tool' ORDER BY id").all(conversationId) as Array<{ parts: string }>)
      .flatMap(row => { try { const p = JSON.parse(row.parts) as { name?: string; content?: string }; return p.name === 'tool_search' ? [p.content ?? ''] : []; } catch { return []; } })
      .map(content => [...content.matchAll(/^## (\S+)$/gmu)].map(m => m[1]!));
    const loads = searches.filter(names => names.length > 0);

    const pending = db.prepare('SELECT tool, kind, status FROM pending_actions WHERE conversation_id = ? ORDER BY id').all(conversationId) as Array<{ tool: string; kind: string; status: string }>;
    const asks = tools.filter(t => t.decision === 'ask').map(t => `${t.tool}:${t.decided_by}`);
    const lastAssistant = (db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant' AND text != '' ORDER BY id DESC LIMIT 1").get(conversationId) as { text: string } | undefined)?.text ?? '';
    const events = eventsPath && existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split(/\r?\n/u) : [];

    return {
      conversationId,
      runs: runs.map(r => ({ runId: r.runId, kind: r.kind, turn: r.turn, discarded: r.discarded, compact: r.compact, children: r.children })),
      a_roundTrips: runs.reduce((n, r) => n + r.turn + r.discarded, 0),
      b_browserCalls: browser.length, b_actSteps: actSteps,
      c_input: conversation?.volume.input ?? 0,
      d_cacheWrite: conversation?.volume.write ?? 0,
      volume: conversation?.volume ?? null,
      e_toolsMisses: misses.tools ?? { count: 0, lostTokens: 0 },
      e_preloadLoads: loads.filter(names => names.some(PRELOAD)).length,
      e_otherLoads: loads.filter(names => !names.some(PRELOAD)).length,
      toolSearchLoads: loads,
      misses,
      g_pending: pending.length, pending, asks,
      judge: { calls: runs.reduce((n, r) => n + r.judge.calls, 0), input: conversation?.judgeInput ?? 0 },
      compactVolume: conversation?.compactVolume ?? null,
      byTool,
      browserSequence: browser.map(t => `${t.tool.replace('browser_', '')}${t.decision === 'allow' ? '' : `(${t.decision})`}`).join(' '),
      app: appRecord(events),
      finalAnswer: lastAssistant,
    };
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { db: { type: 'string' }, conversation: { type: 'string' }, events: { type: 'string' } } });
  if (!values.db || !values.conversation) throw new Error(USAGE);
  process.stdout.write(`${JSON.stringify(collect(resolve(values.db), values.conversation, values.events && resolve(values.events)), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
