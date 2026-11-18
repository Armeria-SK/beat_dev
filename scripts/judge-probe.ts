import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { findModel, parseConfig } from '../src/config/store.ts';
import { maxOutputFor } from '../src/engine/context-budget.ts';
import { modelEfforts } from '../src/engine/efforts.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { redactExact, redactSecrets } from '../src/shared/redaction.ts';
import { autoDecide, CLASSIFIER_TIMEOUT_MS, TruncatedReply, type AutoVerdict, type ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { JUDGE_CASES, JUDGE_CONTROLS, JUDGE_EXFIL_CASES, type JudgeCase } from '../tests/fixtures/judge-cases.ts';

export type ProbeMode = 'a' | 'b' | 'c';

export const MODE_LABELS: Record<ProbeMode, string> = {
  a: 'normal',
  b: 'lowest reasoning effort',
  c: 'while another long reply holds the provider slot',
};

const CONTENTION_SYSTEM = 'JUDGE-PROBE-CONTENTION: write a long, detailed answer.';
const CONTENTION_USER = 'Write a detailed essay of about 1,500 words on the history of bread, with section headings.';
const CONTENTION_TOKENS = 2000;
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RAW_LIMIT = 80;

export interface ProbeOptions {
  model: ModelConfig;
  provider: ProviderConfig;
  adapter: ProviderAdapter;
  cases: readonly JudgeCase[];
  runs: number;
  modes: readonly ProbeMode[];
  maxTokens: number;
  timeoutMs: number;
  effort?: string | undefined;
  secrets?: readonly string[] | undefined;
  onRow?: ((row: ProbeRow) => void) | undefined;
}

export interface ProbeRow {
  model: string;
  mode: ProbeMode;
  caseId: string;
  expect: 'allow' | 'ask';
  run: number;
  decision: 'allow' | 'ask';
  reason: string;
  failed?: AutoVerdict['failed'];
  truncated: boolean;
  raw: string;
  ms: number;
  waitMs: number;
  wrongAllow: boolean;
}

export interface ModeSummary {
  model: string;
  mode: ProbeMode;
  calls: number;
  wrongAllow: number;
  wrongAllowCases: string[];
  wrongAsk: number;
  failed: number;
  failedPct: number;
  truncated: number;
  medianMs: number;
  medianWaitMs: number;
}

export function minimalEffort(efforts: readonly string[]): string | undefined {
  for (const name of EFFORT_ORDER) if (efforts.includes(name)) return name;
  return efforts[0];
}

const oneLine = (text: string, secrets: readonly string[]) => redactSecrets(redactExact(text, secrets)).replace(/\s+/gu, ' ').trim().slice(0, RAW_LIMIT);

interface CallNote { truncated: boolean; raw: string; waitMs: number }

async function classify(options: ProbeOptions, limiter: EndpointLimiter, prompt: ClassifierPrompt, signal: AbortSignal, effort: string | undefined, note: CallNote): Promise<string> {
  const { adapter, provider, model } = options;
  const started = performance.now();
  const release = await limiter.acquire(provider.id, () => provider.maxParallel, signal);
  note.waitMs = performance.now() - started;
  try {
    let text = '';
    for await (const event of adapter.stream({
      model, system: { frozen: prompt.system, dynamic: '' }, messages: [{ role: 'user', content: prompt.user }], tools: [], maxOutputTokens: Math.min(options.maxTokens, maxOutputFor(model, model.contextLength ?? Infinity)), effort, signal,
    })) {
      if (event.type === 'text') text += event.delta;
      else if (event.type === 'done' && event.stop === 'max_tokens') { note.truncated = true; note.raw = text; throw new TruncatedReply(); }
    }
    note.raw = text;
    return redactExact(text, options.secrets ?? []);
  } finally { release(); }
}

async function holdSlot(options: ProbeOptions, limiter: EndpointLimiter, signal: AbortSignal): Promise<{ done: Promise<void> }> {
  const { adapter, provider, model } = options;
  const release = await limiter.acquire(provider.id, () => provider.maxParallel, signal);
  const done = (async () => {
    try {
      for await (const _event of adapter.stream({
        model, system: { frozen: CONTENTION_SYSTEM, dynamic: '' }, messages: [{ role: 'user', content: CONTENTION_USER }], tools: [], maxOutputTokens: Math.min(CONTENTION_TOKENS, maxOutputFor(model, model.contextLength ?? Infinity)), signal,
      })) { if (signal.aborted) break; }
    } catch { } finally { release(); }
  })();
  return { done };
}

export async function runProbe(options: ProbeOptions): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const cases = options.cases.filter(c => c.step === 5);
  for (const mode of options.modes) {
    const limiter = new EndpointLimiter();
    const effort = mode === 'b' ? options.effort : undefined;
    for (let run = 1; run <= options.runs; run++) {
      for (const c of cases) {
        const note: CallNote = { truncated: false, raw: '', waitMs: 0 };
        const background = new AbortController();
        const holder = mode === 'c' ? await holdSlot(options, limiter, background.signal) : undefined;
        const started = performance.now();
        const verdict = await autoDecide(c.input, (prompt, signal) => classify(options, limiter, prompt, signal, effort, note), new AbortController().signal, options.timeoutMs);
        const ms = performance.now() - started;
        background.abort();
        await holder?.done;
        const row: ProbeRow = {
          model: options.model.id, mode, caseId: c.id, expect: c.expect, run, decision: verdict.decision, reason: verdict.reason,
          ...(verdict.failed ? { failed: verdict.failed } : {}),
          truncated: note.truncated, raw: verdict.failed ? oneLine(note.raw, options.secrets ?? []) : '',
          ms: Math.round(ms), waitMs: Math.round(note.waitMs), wrongAllow: c.expect === 'ask' && verdict.decision === 'allow',
        };
        rows.push(row);
        options.onRow?.(row);
      }
    }
  }
  return rows;
}

const median = (values: readonly number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function summarizeRows(rows: readonly ProbeRow[]): ModeSummary[] {
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(group => {
    const failed = group.filter(r => r.failed !== undefined).length;
    return {
      model: group[0]!.model, mode: group[0]!.mode, calls: group.length,
      wrongAllow: group.filter(r => r.wrongAllow).length,
      wrongAllowCases: [...new Set(group.filter(r => r.wrongAllow).map(r => r.caseId))],
      wrongAsk: group.filter(r => r.expect === 'allow' && r.decision === 'ask').length,
      failed, failedPct: Math.round((failed / group.length) * 1000) / 10,
      truncated: group.filter(r => r.truncated).length,
      medianMs: median(group.map(r => r.ms)), medianWaitMs: median(group.map(r => r.waitMs)),
    };
  });
}

const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

export interface ReportMeta { cases: readonly JudgeCase[]; controls: readonly JudgeCase[]; title: string; notes: readonly string[] }

export function renderReport(rows: readonly ProbeRow[], meta: ReportMeta): string {
  const summary = summarizeRows(rows);
  const lines = [`# ${meta.title}`, '', ...meta.notes.map(n => `- ${n}`), ''];
  lines.push('## Summary', '', '| model | mode | calls | wrong allow | wrong ask | no answer (timeout / unparsable / error) | truncated | median ms | median wait ms | wrongly allowed cases |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summary) lines.push(`| ${s.model} | ${s.mode} | ${s.calls} | ${s.wrongAllow} | ${s.wrongAsk} | ${s.failed} (${s.failedPct}%) | ${s.truncated} | ${s.medianMs} | ${s.medianWaitMs} | ${s.wrongAllowCases.join(', ') || '-'} |`);
  lines.push('', 'Modes: ' + (Object.keys(MODE_LABELS) as ProbeMode[]).map(m => `(${m}) ${MODE_LABELS[m]}`).join(', '), '');
  lines.push('## Cases', '', '| id | expect | step | why it reaches that step | summary |', '|---|---|---|---|---|');
  for (const c of [...meta.cases, ...meta.controls]) lines.push(`| ${c.id} | ${c.expect} | ${c.step} | ${cell(c.stepNote)} | ${cell(c.summary)} |`);
  lines.push('', `Controls (not sent to the judge): ${meta.controls.map(c => `${c.id} (step ${c.step})`).join(', ') || '-'}`, '');
  lines.push('## Calls', '', '| model | mode | case | run | expect | decision | flag | ms | wait ms | reason / raw |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const flag = r.wrongAllow ? '**WRONG ALLOW**' : r.truncated ? 'truncated' : r.failed ?? (r.expect === r.decision ? 'ok' : 'wrong ask');
    lines.push(`| ${r.model} | ${r.mode} | ${r.caseId} | ${r.run} | ${r.expect} | ${r.decision} | ${flag} | ${r.ms} | ${r.waitMs} | ${cell(r.failed ? r.raw : r.reason)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function providerNote(id: string, provider: ProviderConfig, model: ModelConfig, secrets: readonly string[]): string {
  return redactSecrets(`${id}: ${provider.kind} ${provider.baseUrl ?? ''} model ${model.model}, maxParallel ${provider.maxParallel}`, secrets);
}

const USAGE ='Usage: node scripts/judge-probe.ts --config <settings.json> [--models id,id] [--modes a,b,c] [--runs 3] [--max-tokens 400] [--timeout 20000] [--effort <value>] [--out <file.md>]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' }, models: { type: 'string' }, modes: { type: 'string', default: 'a,b,c' }, runs: { type: 'string', default: '3' },
      'max-tokens': { type: 'string', default: '400' }, timeout: { type: 'string', default: String(CLASSIFIER_TIMEOUT_MS) }, effort: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (!values.config) throw new Error(USAGE);
  const config = parseConfig(JSON.parse(readFileSync(resolve(values.config), 'utf8')));
  const modes = values.modes.split(',').map(m => m.trim()).filter((m): m is ProbeMode => m === 'a' || m === 'b' || m === 'c');
  const runs = Number(values.runs);
  const maxTokens = Number(values['max-tokens']);
  const timeoutMs = Number(values.timeout);
  if (!modes.length || !Number.isInteger(runs) || runs < 1 || !Number.isInteger(maxTokens) || maxTokens < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error(USAGE);
  const ids = values.models ? values.models.split(',').map(s => s.trim()).filter(Boolean) : [...new Set([...config.routing.chat, ...config.routing.background])];
  const registry = new ProviderRegistry({ env: process.env });
  registry.reload(config);
  const secrets = registry.secrets();
  const rows: ProbeRow[] = [];
  const exfilRows: ProbeRow[] = [];
  const notes = [`date: ${new Date().toISOString()}`, `max output tokens: ${maxTokens}, timeout: ${timeoutMs} ms (includes waiting for the provider slot, as now), runs per case: ${runs}`];
  for (const id of ids) {
    const found = findModel(config, id);
    if (!found) { notes.push(`${id}: not in models, skipped`); continue; }
    const adapter = registry.get(found.provider.id);
    if (!adapter) { notes.push(`${id}: no adapter, skipped`); continue; }
    let effort = values.effort;
    if (!effort && modes.includes('b')) {
      const probed = await adapter.probe(found.model, 0).catch(() => undefined);
      effort = minimalEffort(modelEfforts(found.model, probed));
    }
    const modelModes = modes.filter(m => m !== 'b' || effort !== undefined);
    if (modes.includes('b')) notes.push(effort ? `${id}: mode b sends reasoning_effort "${effort}"` : `${id}: mode b skipped (the provider offers no reasoning effort; pass --effort to force one)`);
    notes.push(providerNote(id, found.provider, found.model, secrets));
    const options = {
      model: found.model, provider: found.provider, adapter, runs, modes: modelModes, maxTokens, timeoutMs, effort, secrets,
      onRow: (r: ProbeRow) => process.stderr.write(`${r.model} ${r.mode} ${r.caseId} #${r.run}: ${r.decision}${r.failed ? ` (${r.failed})` : ''}${r.wrongAllow ? ' WRONG ALLOW' : ''} ${r.ms}ms wait ${r.waitMs}ms\n`),
    };
    rows.push(...await runProbe({ ...options, cases: JUDGE_CASES }));
    exfilRows.push(...await runProbe({ ...options, cases: JUDGE_EXFIL_CASES }));
  }
  const report = `${renderReport(rows, { cases: JUDGE_CASES, controls: JUDGE_CONTROLS, title: 'Judge probe', notes })}\n${renderReport(exfilRows, { cases: JUDGE_EXFIL_CASES, controls: [], title: 'Judge probe: exfiltration cases', notes: [] })}`;
  if (values.out) writeFileSync(resolve(values.out), report);
  else process.stdout.write(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
