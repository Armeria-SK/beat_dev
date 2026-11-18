// 外の MCP サーバーの接続と、その道具の登録を預かる（F8）。
// - つなぐのは、web サーバーを起動したとき（start）と、設定が変わったとき（reload）、持ち主が「接続し直す」を押したとき（restart）。
// - off のサーバーにはつながない（子のプロセスも起こさない）。道具の on/off は、つなぎ直さず登録し直すだけ。
// - 道具は、設定の tools に書かれて on のものだけを、mcp_<id>_<名前> で ToolRegistry の組（id ごと）に置く。
// - 説明・入力の形は、持ち主が最初に確かめた形を kv に固定し（pins）、違ったら止める（changed。受け入れるまで使わない）。
// - 落ちたら少し待ってつなぎ直す。1 時間に restartsPerHour 回を越えたらやめて持ち主に知らせる。
import type { AppConfig, Language, McpServerConfig } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import { createHash } from 'node:crypto';
import { languageOf } from '../shared/language.ts';
import { toolText } from '../shared/messages/tools.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { NotifyInput } from '../notify/notifications.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { HeldValue, ToolDef } from '../tools/types.ts';
import { mcpToolName } from './names.ts';
import { McpPins, shapeOf, type McpShape } from './pins.ts';
import { buildMcpTool, cleanDescription, heldValues, type McpCaller, type McpRemoteTool } from './tool.ts';

export interface McpLink {
  caller: McpCaller;
  list(): Promise<McpRemoteTool[]>;
  close(): Promise<void>;
  // 子のプロセスの stderr の末尾（stdio のときだけ。無ければ空）
  stderr(): string;
}

export interface McpConnectInput {
  server: McpServerConfig;
  // 設定の env・headers が指した変数の値（これだけを子に渡す。アプリのほかの変数は渡さない）
  env: Record<string, string>;
  headers: Record<string, string>;
  // つながったあとに切れたとき（相手が落ちた・口が閉じた）に呼ぶ。こちらから close したときは呼ばなくてよい
  onClose: (reason?: string) => void;
}
export type McpConnect = (input: McpConnectInput) => Promise<McpLink>;

export type McpServerState = 'connecting' | 'ready' | 'failed' | 'off';
export type McpToolState = 'registered' | 'off' | 'changed' | 'missing' | 'schema_invalid' | 'unlisted';

export interface McpToolStatus {
  // サーバーでの元の名前
  name: string;
  // モデルに見える登録名
  registered: string;
  state: McpToolState;
  reason?: string | undefined;
  // 整えた説明（モデルに渡るもの）
  description: string;
}

export interface McpServerStatus {
  id: string;
  transport: McpServerConfig['transport'];
  enabled: boolean;
  target: string;
  state: McpServerState;
  // 固定の語（env_missing / connect_failed / timeout / list_failed / too_many_restarts / dropped）
  reason?: string | undefined;
  // 理由の詳しい文（秘密を伏せて 300 字まで）
  detail?: string | undefined;
  stderr: string;
  tools: McpToolStatus[];
}

export interface McpManagerDeps {
  config: () => AppConfig;
  // .env の値（app.env）。設定の env・headers が指した名前の値だけを読む
  env: Record<string, string | undefined>;
  tools: ToolRegistry;
  kv: KV;
  log: (line: string) => void;
  notify: (input: NotifyInput) => void;
  connect?: McpConnect;
  now?: () => number;
  schedule?: (fn: () => void | Promise<void>, ms: number) => { cancel: () => void };
}

const HOUR_MS = 3_600_000;
const STDERR_MAX = 4096;
const REMOTE_TOOLS_MAX = 256;
const DETAIL_MAX = 300;
const CLOSE_MS = 5000;

interface Entry {
  id: string;
  fingerprint: string;
  generation: number;
  state: McpServerState;
  reason?: string | undefined;
  detail?: string | undefined;
  link?: McpLink | undefined;
  remote?: McpRemoteTool[] | undefined;
  view: McpToolStatus[];
  lastStderr: string;
  attempts: number[];
  timer?: { cancel: () => void } | undefined;
  notifiedChanged: Set<string>;
  failedNotified: boolean;
  // このサーバーへ渡した秘密の値（env・headers）。エラー・stderr・答えの文から、一般の形に当たらなくても伏せる
  secrets: string[];
  held: HeldValue[];
}

// 秘密の値の伏せ字は、短すぎる値（普通の語に当たってしまう）は対象にしない
const SECRET_MIN = 4;

// サーバーが広告した名前でも、持ち主が tools に書いた名前だけを拾う（constructor や toString などの継承されたものは拾わない）
function configuredTool(server: McpServerConfig, name: string): McpServerConfig['tools'][string] | undefined {
  return Object.hasOwn(server.tools, name) ? server.tools[name] : undefined;
}

function fingerprintOf(s: McpServerConfig): string {
  return JSON.stringify([s.enabled, s.transport, s.command ?? null, s.cwd ?? null, s.url ?? null, s.env, s.headers]);
}

function refs(map: Record<string, string>, env: Record<string, string | undefined>): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, variable] of Object.entries(map)) {
    const value = env[variable];
    if (value === undefined || value === '') missing.push(variable);
    else values[name] = value;
  }
  return { values, missing };
}

function describeError(error: unknown, secrets: readonly string[]): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), secrets).replace(/\s+/gu, ' ').slice(0, DETAIL_MAX);
}

// 時間内に終わらなければ投げる。遅れて終わった値は onLate に渡す（接続を閉じるため）
function withTimeout<T>(promise: Promise<T>, ms: number, onLate: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error('timeout')); }, ms);
    promise.then(value => {
      clearTimeout(timer);
      if (done) onLate(value); else { done = true; resolve(value); }
    }, error => {
      clearTimeout(timer);
      if (!done) { done = true; reject(error); }
    });
  });
}

// 閉じるのは、時間内に終わらなくても待ちきらない
function closeWithin(link: McpLink, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    link.close().catch(() => undefined).then(() => { clearTimeout(timer); resolve(); });
  });
}

export class McpManager {
  readonly #d: McpManagerDeps;
  readonly #pins: McpPins;
  readonly #entries = new Map<string, Entry>();
  #started = false;

  constructor(deps: McpManagerDeps) {
    this.#d = deps;
    this.#pins = new McpPins(deps.kv);
  }

  async start(): Promise<void> {
    this.#started = true;
    await this.reload();
  }

  async stop(): Promise<void> {
    this.#started = false;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(entry => this.#teardown(entry)));
    for (const entry of entries) this.#d.tools.removeGroup(entry.id);
  }

  // 設定に合わせる。増えたサーバーはつなぎ、消えたものは切って固定も消す。つなぎ方が変わったものはつなぎ直し、道具の設定だけ変わったものは登録し直す
  async reload(): Promise<void> {
    if (!this.#started) return;
    const servers = this.#d.config().mcp.servers;
    const ids = new Set(servers.map(s => s.id));
    const gone = [...this.#entries.values()].filter(e => !ids.has(e.id));
    // 道具の登録と固定は先に消し、接続を閉じるのは待たせない（遅い 1 台が、ほかの更新を止めないように）
    const closing = gone.map(entry => {
      this.#entries.delete(entry.id);
      this.#d.tools.removeGroup(entry.id);
      this.#pins.forget(entry.id);
      return this.#teardown(entry);
    });
    await Promise.all(closing);
    const work: Array<Promise<void>> = [];
    for (const server of servers) {
      const entry = this.#entries.get(server.id);
      if (!entry || entry.fingerprint !== fingerprintOf(server)) work.push(this.#open(server, false));
      else if (entry.state === 'ready') this.#register(entry, server);
    }
    await Promise.all(work);
  }

  // 接続し直す（持ち主の操作。落ちた回数の数え直しも兼ねる）
  async restart(id: string): Promise<void> {
    const server = this.#d.config().mcp.servers.find(s => s.id === id);
    if (!server || !this.#started) return;
    const entry = this.#entries.get(id);
    if (entry) { entry.attempts = []; entry.failedNotified = false; }
    await this.#open(server, false);
  }

  // 説明・入力の形が変わって止まっている道具を、いま見えている形のまま受け入れる
  accept(id: string, tool: string): boolean {
    const entry = this.#entries.get(id);
    const server = this.#d.config().mcp.servers.find(s => s.id === id);
    const remote = entry?.remote?.find(r => r.name === tool);
    if (!entry || entry.state !== 'ready' || !server || !remote || configuredTool(server, tool) === undefined) return false;
    this.#pins.pin(id, tool, remote);
    this.#register(entry, server);
    return true;
  }

  diff(id: string, tool: string): { before?: McpShape; after: McpShape } | undefined {
    const remote = this.#entries.get(id)?.remote?.find(r => r.name === tool);
    if (!remote) return undefined;
    const before = this.#pins.previous(id, tool);
    return { ...(before ? { before } : {}), after: shapeOf(remote) };
  }

  status(): McpServerStatus[] {
    const config = this.#d.config();
    return config.mcp.servers.map(server => {
      const entry = this.#entries.get(server.id);
      const state: McpServerState = !server.enabled ? 'off' : entry?.state ?? 'connecting';
      const tools = entry?.remote ? entry.view : Object.keys(server.tools).map(name => ({
        name, registered: mcpToolName(server.id, name), description: '',
        state: (!server.enabled || configuredTool(server, name)?.enabled === false ? 'off' : 'missing') as McpToolState,
        ...(server.enabled ? { reason: 'not_connected' } : {}),
      }));
      const stderr = entry?.link ? entry.link.stderr() : entry?.lastStderr ?? '';
      return {
        id: server.id, transport: server.transport, enabled: server.enabled, target: this.#target(server, entry?.secrets ?? []),
        state, ...(entry?.reason ? { reason: entry.reason } : {}), ...(entry?.detail ? { detail: entry.detail } : {}),
        stderr: redactSecrets(stderr.slice(-2 * STDERR_MAX), entry?.secrets ?? []).slice(-STDERR_MAX),
        tools,
      };
    });
  }

  #target(server: McpServerConfig, secrets: readonly string[]): string {
    if (server.transport === 'stdio') return redactSecrets((server.command ?? []).join(' '), secrets).slice(0, 500);
    try {
      const url = new URL(server.url ?? '');
      return `${url.origin}${url.pathname}`;
    } catch { return ''; }
  }

  async #teardown(entry: Entry): Promise<void> {
    await this.#detach(entry);
  }

  // 同期の部分（世代を進め、いまの接続を手放す）を先に済ませ、閉じるのだけを待つ。世代は、await の前に確定させる
  #detach(entry: Entry): Promise<void> {
    entry.generation++;
    entry.timer?.cancel();
    entry.timer = undefined;
    const link = entry.link;
    if (link) entry.lastStderr = link.stderr();
    entry.link = undefined;
    entry.remote = undefined;
    entry.view = [];
    return link ? closeWithin(link, CLOSE_MS) : Promise.resolve();
  }

  #entryFor(server: McpServerConfig): Entry {
    let entry = this.#entries.get(server.id);
    if (!entry) {
      entry = { id: server.id, fingerprint: '', generation: 0, state: 'connecting', view: [], lastStderr: '', attempts: [], notifiedChanged: new Set(), failedNotified: false, secrets: [], held: [] };
      this.#entries.set(server.id, entry);
    }
    return entry;
  }

  // auto: 落ちたあとの自動のつなぎ直し（失敗したら、また回数を数えてやり直す）。持ち主の操作や設定の変更では、失敗はそのまま failed にする
  async #open(server: McpServerConfig, auto: boolean): Promise<void> {
    const entry = this.#entryFor(server);
    const closing = this.#detach(entry);
    this.#d.tools.removeGroup(server.id);
    entry.fingerprint = fingerprintOf(server);
    entry.reason = undefined;
    entry.detail = undefined;
    const generation = entry.generation;
    await closing;
    if (entry.generation !== generation) return;
    if (!server.enabled) { entry.state = 'off'; return; }
    entry.state = 'connecting';
    const fail = (reason: string, detail?: string): void => {
      if (entry.generation !== generation) return;
      entry.state = 'failed';
      entry.reason = reason;
      entry.detail = detail;
      this.#d.log(`[WARN] Could not connect to MCP server "${server.id}" (${reason}${detail ? `: ${detail}` : ''})`);
      if (auto) this.#retry(server.id, entry, reason);
    };
    const env = refs(server.env, this.#d.env);
    const headers = refs(server.headers, this.#d.env);
    entry.secrets = [...Object.values(env.values), ...Object.values(headers.values)].filter(v => v.length >= SECRET_MIN);
    entry.held = heldValues(env.values, headers.values);
    const missing = [...env.missing, ...headers.missing];
    if (missing.length) { fail('env_missing', missing.join(', ')); return; }
    const limits = this.#d.config().mcp.limits;
    const connect = this.#d.connect;
    if (!connect) { fail('connect_failed', 'no connector'); return; }
    let link: McpLink;
    try {
      link = await withTimeout(connect({
        server, env: env.values, headers: headers.values,
        onClose: reason => this.#dropped(server.id, generation, reason),
      }), limits.connectTimeoutMs, late => { void late.close().catch(() => undefined); });
    } catch (error) {
      fail((error as Error).message === 'timeout' ? 'timeout' : 'connect_failed', (error as Error).message === 'timeout' ? undefined : describeError(error, entry.secrets));
      return;
    }
    if (entry.generation !== generation) { await closeWithin(link, CLOSE_MS); return; }
    let remote: McpRemoteTool[];
    try {
      remote = await withTimeout(link.list(), limits.connectTimeoutMs, () => undefined);
    } catch (error) {
      await closeWithin(link, CLOSE_MS);
      fail((error as Error).message === 'timeout' ? 'timeout' : 'list_failed', (error as Error).message === 'timeout' ? undefined : describeError(error, entry.secrets));
      return;
    }
    if (entry.generation !== generation) { await closeWithin(link, CLOSE_MS); return; }
    entry.link = link;
    entry.remote = remote.slice(0, REMOTE_TOOLS_MAX);
    entry.state = 'ready';
    this.#register(entry, this.#d.config().mcp.servers.find(s => s.id === server.id) ?? server);
  }

  #dropped(id: string, generation: number, reason?: string): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.generation !== generation || entry.state !== 'ready') return;
    void this.#detach(entry);
    this.#d.tools.removeGroup(id);
    this.#retry(id, entry, 'dropped', reason);
  }

  #retry(id: string, entry: Entry, reason: string, detail?: string): void {
    const config = this.#d.config();
    const now = (this.#d.now ?? Date.now)();
    entry.attempts = entry.attempts.filter(t => now - t < HOUR_MS);
    const max = config.mcp.limits.restartsPerHour;
    if (entry.attempts.length >= max) {
      entry.state = 'failed';
      entry.reason = 'too_many_restarts';
      entry.detail = detail === undefined ? undefined : describeError(detail, entry.secrets);
      if (!entry.failedNotified) {
        entry.failedNotified = true;
        const language = languageOf(config);
        this.#d.notify({ kind: 'health_alert', title: toolText(language, 'mcp.failed_title', { server: id }), body: toolText(language, 'mcp.failed_body', { server: id, max: String(max) }), dedupKey: `mcp-failed:${id}` });
      }
      return;
    }
    entry.attempts.push(now);
    entry.state = 'connecting';
    entry.reason = reason;
    entry.detail = detail === undefined ? undefined : describeError(detail, entry.secrets);
    const delay = Math.min(1000 * 2 ** (entry.attempts.length - 1), 30_000);
    const schedule = this.#d.schedule ?? ((fn, ms) => { const timer = setTimeout(() => { void fn(); }, ms); timer.unref(); return { cancel: () => clearTimeout(timer) }; });
    entry.timer = schedule(async () => {
      entry.timer = undefined;
      const server = this.#d.config().mcp.servers.find(s => s.id === id);
      if (!server || this.#entries.get(id) !== entry || !this.#started) return;
      await this.#open(server, true);
    }, delay);
  }

  // いまの設定と、サーバーが返した道具の一覧から、モデルに渡す道具を決めて組に置く
  #register(entry: Entry, server: McpServerConfig): void {
    const config = this.#d.config();
    const language: Language = languageOf(config);
    const limits = config.mcp.limits;
    const remote = entry.remote ?? [];
    const tools: ToolDef[] = [];
    const view: McpToolStatus[] = [];
    const seen = new Set<string>();
    for (const r of remote) {
      const base = { name: r.name, registered: mcpToolName(server.id, r.name), description: cleanDescription(r.description) };
      const configured = configuredTool(server, r.name);
      if (!configured) { view.push({ ...base, state: 'unlisted' }); continue; }
      if (configured.enabled === false) { view.push({ ...base, state: 'off' }); continue; }
      const built = buildMcpTool({ server, remote: r, entry: configured, language, limits, caller: () => this.#entries.get(server.id)?.link?.caller, secrets: () => this.#entries.get(server.id)?.secrets ?? [], held: () => this.#entries.get(server.id)?.held ?? [] });
      if (!built.ok) { view.push({ ...base, state: 'schema_invalid', reason: built.reason }); continue; }
      if (seen.has(built.tool.name)) { view.push({ ...base, state: 'schema_invalid', reason: 'duplicate_name' }); continue; }
      const pin = this.#pins.check(server.id, r.name, r);
      if (pin === 'changed') {
        view.push({ ...base, state: 'changed' });
        this.#noticeChanged(entry, server.id, r, language);
        continue;
      }
      if (pin === 'new') this.#pins.pin(server.id, r.name, r);
      seen.add(built.tool.name);
      tools.push(built.tool);
      view.push({ ...base, state: 'registered' });
    }
    const listed = new Set(remote.map(r => r.name));
    for (const name of Object.keys(server.tools)) {
      if (!listed.has(name)) view.push({ name, registered: mcpToolName(server.id, name), description: '', state: 'missing', reason: 'not_found' });
    }
    entry.view = view;
    try { this.#d.tools.setGroup(server.id, tools); }
    catch (error) {
      // 古い組を残さない（新しい形を置けなかったのに、前の道具が使えるままにしない）
      this.#d.tools.removeGroup(server.id);
      this.#d.log(`[ERROR] Could not register the tools of MCP server "${server.id}": ${(error as Error).message}`); }
  }

  #noticeChanged(entry: Entry, server: string, remote: McpRemoteTool, language: Language): void {
    const signature = JSON.stringify(shapeOf(remote));
    const key = `${remote.name}\n${signature}`;
    if (entry.notifiedChanged.has(key)) return;
    entry.notifiedChanged.add(key);
    // 通知は外のチャンネルにも出るので、サーバーが書いた文は入れない（道具の名前は、持ち主が tools に書いたもの）
    this.#d.notify({
      kind: 'health_alert',
      title: toolText(language, 'mcp.changed_title', { tool: remote.name }),
      body: toolText(language, 'mcp.changed_body', { server, tool: remote.name }),
      dedupKey: `mcp-changed:${server}:${remote.name}:${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`,
    });
  }
}