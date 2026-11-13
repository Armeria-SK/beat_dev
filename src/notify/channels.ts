import type { AppConfig, NotifyChannelConfig } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import type { Env, FetchLike } from '../providers/types.ts';
import { languageOf } from '../shared/language.ts';
import { notifyText } from '../shared/messages/notify.ts';
import { isSafeOutboundUrl } from '../shared/url.ts';
import type { NotificationKind, NotifyEvent, NotifyInput } from './notifications.ts';

// 外の送り先（webhook）へ通知を送る。聞き手（Notifications.listen）の 1 つとして動く。
// 秘密（URL・token）はここで環境変数から読み、ログ・kv・状態・例外には出さない（出すのは送り先の id と環境変数の名前だけ）。
// 作りの定数は設定で変えない（やり直しの待ち・中身の大きさの上限）
export const NOTIFY_RETRY_DELAY_MS = 2_000;
export const NOTIFY_MAX_PAYLOAD_BYTES = 8_192;
export const NOTIFY_BODY_MAX_CHARS = 1_000;

export type DeliverReason = 'env_missing' | 'bad_url' | 'timeout' | 'network' | 'redirect' | `http_${number}`;

// kv の notify:channel:<id>。成功か失敗かの最後の記録だけ（秘密は入れない）
interface ChannelRecord { lastOkAt?: number; lastFailAt?: number; reason?: string; fails: number }

export interface ChannelStatus {
  id: string;
  kind: 'webhook';
  enabled: boolean;
  kinds: NotificationKind[];
  includeBody: boolean;
  urlEnv: string;
  tokenEnv: string | null;
  urlSet: boolean;
  tokenSet: boolean;
  lastOkAt: number | null;
  lastFailAt: number | null;
  reason: string | null;
  fails: number;
}

export type TestResult = { ok: true } | { ok: false; reason: DeliverReason };

export interface NotifyChannelsOptions {
  config: () => AppConfig;
  env: Env;
  fetch?: FetchLike | undefined;
  now: () => number;
  log: (line: string) => void;
  kv: KV;
  // 送り先の失敗・上限を持ち主へ知らせる通知（外へは送らない印を付けて渡す）
  alert: (input: NotifyInput) => void;
  // やり直しの待ち。試験で差し替える
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

type Attempt = { ok: true } | { ok: false; reason: DeliverReason; retry: boolean };

const recordKey = (id: string): string => `notify:channel:${id}`;

export class NotifyChannels {
  readonly #o: NotifyChannelsOptions;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  #hour = -1;
  #sent = 0;

  constructor(options: NotifyChannelsOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  // 新しい通知を、送る先へ送る。待たなくてよい（決して reject しない）。送る先が無ければ何もしない
  async deliver(n: NotifyEvent): Promise<void> {
    try {
      if (n.noForward) return;
      const config = this.#o.config();
      const targets = config.notify.channels.filter(c => c.enabled && c.kinds.includes(n.kind));
      if (targets.length === 0) return;
      const sendable = targets.filter(() => this.#reserve(config));
      await Promise.all(sendable.map(c => this.#send(config, c, n)));
    } catch (error) {
      this.#o.log(`[ERROR] Unexpected failure while notifying external destinations: ${(error as Error).name}`);
    }
  }

  // 決まった文を 1 通送り、結果を返す（画面の「試しに送る」）。無効でも・種類に入っていなくても送る。1 時間の上限には数えない。送り先が無ければ undefined
  async test(id: string): Promise<TestResult | undefined> {
    const config = this.#o.config();
    const channel = config.notify.channels.find(c => c.id === id);
    if (!channel) return undefined;
    const now = this.#o.now();
    const n: NotifyEvent = { id: 0, kind: 'info', title: notifyText(languageOf(config), 'test'), body: null, link: null, dedup_key: null, read_at: null, created_at: now };
    return this.#send(config, channel, n);
  }

  status(): ChannelStatus[] {
    const config = this.#o.config();
    return config.notify.channels.map(c => {
      const record = this.#o.kv.getJson<ChannelRecord>(recordKey(c.id));
      return {
        id: c.id, kind: c.kind, enabled: c.enabled, kinds: [...c.kinds], includeBody: c.includeBody,
        urlEnv: c.urlEnv, tokenEnv: c.tokenEnv ?? null,
        urlSet: Boolean(this.#o.env[c.urlEnv]), tokenSet: c.tokenEnv ? Boolean(this.#o.env[c.tokenEnv]) : false,
        lastOkAt: record?.lastOkAt ?? null, lastFailAt: record?.lastFailAt ?? null, reason: record?.reason ?? null, fails: record?.fails ?? 0,
      };
    });
  }

  // 1 時間の合計の上限（配信の数。やり直しの fetch は数えない: 最悪で上限の 3 倍。窓は固定で、再起動で 0 に戻る）。越えたら false。越える最初の 1 回だけ持ち主へ知らせる
  #reserve(config: AppConfig): boolean {
    const now = this.#o.now();
    const hour = Math.floor(now / 3_600_000);
    if (hour !== this.#hour) { this.#hour = hour; this.#sent = 0; }
    const max = config.notify.limits.maxSendsPerHour;
    if (this.#sent >= max) {
      if (this.#sent === max) {
        this.#sent += 1;
        this.#o.alert({ kind: 'info', title: notifyText(languageOf(config), 'cap_reached', { max }), dedupKey: `notify-cap:${hour}`, link: '#/settings', noForward: true });
      }
      return false;
    }
    this.#sent += 1;
    return true;
  }

  async #send(config: AppConfig, channel: NotifyChannelConfig, n: NotifyEvent): Promise<TestResult> {
    const { limits } = config.notify;
    let result: Attempt = await this.#attempt(config, channel, n);
    for (let retried = 0; !result.ok && result.retry && retried < limits.retries; retried += 1) {
      await this.#sleep(NOTIFY_RETRY_DELAY_MS);
      result = await this.#attempt(config, channel, n);
    }
    this.#record(config, channel, result);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async #attempt(config: AppConfig, channel: NotifyChannelConfig, n: NotifyEvent): Promise<Attempt> {
    const url = this.#o.env[channel.urlEnv];
    if (!url) return { ok: false, reason: 'env_missing', retry: false };
    if (!isSafeOutboundUrl(url)) return { ok: false, reason: 'bad_url', retry: false };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = channel.tokenEnv ? this.#o.env[channel.tokenEnv] : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await this.#fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(config.notify.limits.timeoutMs), headers, body: buildPayload(config, channel, n) });
      // 応答の本文は読まない（読まずに捨てる）
      void res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'redirect', retry: false };
      return { ok: false, reason: `http_${res.status}`, retry: res.status === 429 || res.status >= 500 };
    } catch (error) {
      // 例外の文には URL が入りうるので、種類だけを見る
      const name = (error as Error | undefined)?.name;
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', retry: true };
    }
  }

  #record(config: AppConfig, channel: NotifyChannelConfig, result: Attempt): void {
    const key = recordKey(channel.id);
    const previous = this.#o.kv.getJson<ChannelRecord>(key);
    const now = this.#o.now();
    if (result.ok) {
      this.#o.kv.setJson(key, { lastOkAt: now, fails: 0 } satisfies ChannelRecord);
      return;
    }
    const fails = (previous?.fails ?? 0) + 1;
    this.#o.kv.setJson(key, { ...(previous?.lastOkAt === undefined ? {} : { lastOkAt: previous.lastOkAt }), lastFailAt: now, reason: result.reason, fails } satisfies ChannelRecord);
    this.#o.log(`[WARN] Could not send to notification destination "${channel.id}" (${result.reason})`);
    if (fails >= config.notify.limits.failsBeforeAlert) {
      this.#o.alert({ kind: 'health_alert', title: notifyText(languageOf(config), 'channel_failing', { id: channel.id, fails, reason: result.reason }), link: '#/settings', dedupKey: `notify-channel-fail:${channel.id}`, noForward: true });
    }
  }
}

// 送る中身。キーの順は固定
export function buildPayload(config: AppConfig, channel: NotifyChannelConfig, n: NotifyEvent): string {
  const title = n.title;
  const body = channel.includeBody && n.body ? n.body.slice(0, NOTIFY_BODY_MAX_CHARS) : undefined;
  const base = config.notify.publicBaseUrl.replace(/\/+$/u, '');
  const link = base !== '' && n.link?.startsWith('#/') ? `${base}/${n.link}` : undefined;
  const make = (t: string, b: string | undefined): string => JSON.stringify({
    source: 'beat', version: 1, kind: n.kind, title: t,
    ...(b === undefined ? {} : { body: b }), ...(link === undefined ? {} : { link }),
    createdAt: new Date(n.created_at).toISOString(),
  });
  let json = make(title, body);
  // 大きすぎるときは、本文を外し、それでも大きければ題を切る
  if (Buffer.byteLength(json) > NOTIFY_MAX_PAYLOAD_BYTES) json = make(title, undefined);
  if (Buffer.byteLength(json) > NOTIFY_MAX_PAYLOAD_BYTES) json = make(title.slice(0, 50), undefined);
  return json;
}