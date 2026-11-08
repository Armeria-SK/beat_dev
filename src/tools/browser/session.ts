// ブラウザ 1 つ（全会話で共有）の持ち主。起動・アイドルで閉じる・タブの持ち主・呼び出しを 1 つずつ・起動の失敗の扱い
// 道具は run() の中でしかページに触れない。タブは会話に属し、別の会話のタブは見えない・使えない・閉じられない
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { BrowserFailure, CLOSE_TIMEOUT_MS, localeFor, type BrowserDriver, type BrowserHandle, type LaunchOptions, type PageHandle } from './driver.ts';
import type { ElementTable } from './elements.ts';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from './egress-proxy.ts';

type BrowserConfig = AppConfig['tools']['browser'];

export interface BrowserSessionDeps {
  driver: BrowserDriver;
  config: () => AppConfig;
  paths: { browserProfile: string };
  log?: ((line: string) => void) | undefined;
  notify?: ((input: { kind: 'health_alert'; title: string; body?: string; link?: string; dedupKey: string }) => unknown) | undefined;
  // 厳密な秘密の値（鍵）。道具が結果から伏せるのに使う
  secrets?: (() => readonly string[]) | undefined;
  now?: (() => number) | undefined;
  // 時間切れの登録。戻り値は取り消し
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  startProxy?: ((options: EgressProxyOptions) => Promise<EgressProxy>) | undefined;
  // ログイン用の窓（見えるブラウザ）を出せる環境か。省くと、この計算機の環境変数から決める
  canShowWindow?: (() => boolean) | undefined;
}

// 見えるブラウザの窓を出せるか。Linux は画面（X11 か Wayland）が無ければ出せない。Windows・macOS はいつも出せる
export function headedAvailable(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform !== 'linux') return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

export interface BrowserStatus {
  enabled: boolean;
  // 自動操作のブラウザが起動しているか
  running: boolean;
  // ログイン用の窓が開いているか
  loginOpen: boolean;
  tabs: number;
  // 起動を休んでいる残り（分）。休んでいなければ 0
  pausedMinutes: number;
  // ログイン用の窓を出せる環境か
  canShowWindow: boolean;
}

export interface BrowserTab {
  readonly id: string;
  readonly conversationId: string;
  readonly page: PageHandle;
  // 最後に読んだ「触れるもの」の表。URL が変わったら使わない
  table: ElementTable | undefined;
  used: number;
}

export interface BrowserCall {
  conversationId: string;
  signal: AbortSignal;
}

export interface BrowserApi {
  readonly signal: AbortSignal;
  readonly config: BrowserConfig;
  openTab(): Promise<BrowserTab>;
  // id を省くと、この会話でいちばん最近使ったタブ。無い・別の会話のものなら no_tab
  tab(id?: string): BrowserTab;
  tabs(): BrowserTab[];
  touch(tab: BrowserTab): void;
  closeTab(id: string): Promise<boolean>;
  closeAll(): Promise<number>;
  // この呼び出しのあいだに中継が断った数（403 / 503）
  proxyDelta(): { blocked: number; busy: number };
  // work のあいだにページ側が開いた窓（ポップアップ）を、この会話の新しいタブとして残す。
  // 上限（maxTabs）を超える分は閉じて数だけ返す。work が失敗したら、集めた窓はすべて閉じる。work の外で開いた窓は今までどおり即座に閉じる
  withPopups<T>(work: () => Promise<T>): Promise<{ value: T; opened: BrowserTab[]; closed: number }>;
}

const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
const VIEWPORT = { width: 1280, height: 800 };

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let cancel: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => { cancel = setTimeout(resolve, ms); cancel.unref(); });
  try { await Promise.race([work.then(() => undefined, () => undefined), timeout]); } finally { clearTimeout(cancel); }
}

export class BrowserSession {
  readonly #d: BrowserSessionDeps;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  #handle: BrowserHandle | undefined;
  #proxy: EgressProxy | undefined;
  // ログイン用の窓（持ち主が自分で操作する見えるブラウザ）。開いているあいだ、道具の呼び出しは断る
  #login: { handle: BrowserHandle; proxy: EgressProxy } | undefined;
  #tabs = new Map<string, BrowserTab>();
  // withPopups のあいだだけ、ページ側が開いた窓を集める入れ物
  #popups: PageHandle[] | undefined;
  #nextTab = 1;
  #clock = 0;
  #locked = false;
  #waiters: Array<() => void> = [];
  #failures = 0;
  #pausedUntil = 0;
  #cancelIdle: (() => void) | undefined;
  #idleToken = 0;
  // close() のたびに増える。起動の途中で閉じられたら、できたものを捨てる
  #epoch = 0;

  constructor(deps: BrowserSessionDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#schedule = deps.schedule ?? defaultSchedule;
  }

  secrets(): readonly string[] { return this.#d.secrets?.() ?? []; }
  enabled(): boolean { return this.#d.config().tools.browser.enabled; }
  // この会話で開いているタブの数（browser_close が、閉じるものが無いのにブラウザを起動しないための確かめ）
  tabCount(conversationId: string): number { return [...this.#tabs.values()].filter(tab => tab.conversationId === conversationId).length; }

  async run<T>(call: BrowserCall, fn: (api: BrowserApi) => Promise<T>): Promise<T> {
    if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
    await this.#acquire(call.signal);
    try {
      if (call.signal.aborted) throw new BrowserFailure('aborted', 'browser.aborted');
      if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
      // 同じプロファイルを 2 つのブラウザで開けない。ログイン用の窓が開いているあいだは、道具は使えない
      if (this.#login) throw new BrowserFailure('login_open', 'browser.login_open');
      this.#cancelIdleTimer();
      await this.#ensureLaunched();
      return await fn(this.#api(call));
    } finally {
      if (this.#handle) this.#armIdle();
      this.#release();
    }
  }

  // 会話を消したとき、その会話のタブを閉じる（起動していなければ何もしない）
  async closeConversation(ids: readonly string[]): Promise<void> {
    if (this.#tabs.size === 0) return;
    await this.#acquire(undefined);
    try {
      for (const tab of [...this.#tabs.values()]) if (ids.includes(tab.conversationId)) await this.#closeTab(tab);
    } finally { this.#release(); }
  }

  // 設定が変わった。無効になったら閉じる（ほかの変更は次の起動から効く）
  async applyConfig(config: AppConfig): Promise<void> {
    if (!config.tools.browser.enabled) { await this.#shutdown(); await this.#closeLogin(); }
  }

  async close(): Promise<void> {
    this.#epoch += 1;
    this.#cancelIdleTimer();
    await this.#shutdown();
    await this.#closeLogin();
  }

  // ---- 設定の画面から（ログイン用の窓・止める・プロファイルの削除） ----
  status(): BrowserStatus {
    const now = this.#now();
    return {
      enabled: this.enabled(),
      running: this.#handle !== undefined,
      loginOpen: this.#login !== undefined,
      tabs: this.#tabs.size,
      pausedMinutes: now < this.#pausedUntil ? Math.max(1, Math.ceil((this.#pausedUntil - now) / 60_000)) : 0,
      canShowWindow: this.canShowWindow(),
    };
  }

  canShowWindow(): boolean { return (this.#d.canShowWindow ?? (() => headedAvailable(process.platform, process.env)))(); }

  // ログイン用に、同じプロファイル・同じ中継で、見えるブラウザを開く。自動操作のブラウザが動いていたら先に止める（同じプロファイルは同時に開けない）。
  // 窓にはポップアップを閉じる仕掛けを付けない（ログインの画面が別の窓を開くことがある）。窓が閉じられたら、ログイン用の窓は無いことになる
  async openLogin(): Promise<{ alreadyOpen: boolean }> {
    if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
    if (!this.canShowWindow()) throw new BrowserFailure('no_display', 'browser.no_display');
    await this.#acquire(undefined);
    try {
      if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
      if (this.#login) return { alreadyOpen: true };
      this.#cancelIdleTimer();
      await this.#shutdown();
      const { handle, proxy } = await this.#start(false, true);
      this.#login = { handle, proxy };
      handle.onDisconnected(() => { if (this.#login?.handle === handle) void this.#closeLogin(); });
      return { alreadyOpen: false };
    } finally { this.#release(); }
  }

  // ログイン用の窓と自動操作のブラウザをどちらも閉じる（「ブラウザを閉じる」ボタン）
  async closeAll(): Promise<void> {
    await this.#acquire(undefined);
    try {
      this.#cancelIdleTimer();
      await this.#shutdown();
      await this.#closeLogin();
    } finally { this.#release(); }
  }

  // ブラウザをすべて止め、ほかの呼び出しを待たせたまま fn を走らせる（プロファイルの削除のあいだに再起動されないため）
  async withStopped<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire(undefined);
    try {
      this.#cancelIdleTimer();
      await this.#shutdown();
      await this.#closeLogin();
      return await fn();
    } finally { this.#release(); }
  }

  // ---- 呼び出しを 1 つずつ ----
  async #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw new BrowserFailure('aborted', 'browser.aborted');
    if (!this.#locked) { this.#locked = true; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new BrowserFailure('aborted', 'browser.aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next(); else this.#locked = false;
  }

  // ---- 起動 ----
  async #ensureLaunched(): Promise<void> {
    if (this.#handle) return;
    const now = this.#now();
    if (now < this.#pausedUntil) throw new BrowserFailure('paused', 'browser.launch_paused', { minutes: String(Math.max(1, Math.ceil((this.#pausedUntil - now) / 60_000))) });
    const { handle, proxy } = await this.#start(this.#d.config().tools.browser.headless, false);
    handle.onPage(page => {
      if (this.#popups) { this.#popups.push(page); return; }
      void page.close().catch(() => undefined);
    });
    handle.onDisconnected(() => { if (this.#handle === handle) void this.#shutdown(); });
    this.#handle = handle; this.#proxy = proxy;
    this.#failures = 0;
  }

  // 中継とブラウザを起動する（自動操作もログイン用の窓も、同じプロファイル・同じ中継）。失敗したら中継を閉じる。
  // 起動の失敗を数える（続くと休む）のは自動操作のときだけ。持ち主が自分で開くログイン用の窓の失敗は、画面にそのまま返す
  async #start(headless: boolean, login: boolean): Promise<{ handle: BrowserHandle; proxy: EgressProxy }> {
    const epoch = this.#epoch;
    const config = this.#d.config();
    const browser = config.tools.browser;
    let proxy: EgressProxy | undefined;
    try {
      const username = 'clive';
      const password = randomBytes(24).toString('hex');
      proxy = await (this.#d.startProxy ?? startEgressProxy)({ username, password, maxBytesPerMinute: browser.limits.maxMbPerMinute * 1024 * 1024, ...(this.#d.log ? { log: this.#d.log } : {}) });
      const options: LaunchOptions = {
        profileDir: this.#d.paths.browserProfile,
        channel: browser.channel === 'chrome' ? 'chrome' : undefined,
        executablePath: browser.channel === 'path' && browser.executablePath ? browser.executablePath : undefined,
        headless,
        proxy: { server: `http://${proxy.host}:${proxy.port}`, username, password },
        viewport: VIEWPORT,
        locale: localeFor(languageOf(config)),
        actionTimeoutMs: browser.limits.actionTimeoutSec * 1000,
      };
      const handle = await this.#d.driver.launch(options);
      if (epoch !== this.#epoch) { await withTimeout(handle.close(), CLOSE_TIMEOUT_MS); throw new BrowserFailure('aborted', 'browser.aborted'); }
      return { handle, proxy };
    } catch (error) {
      await proxy?.close().catch(() => undefined);
      if (error instanceof BrowserFailure && error.code === 'aborted') throw error;
      if (!login) this.#failed(error); else this.#d.log?.(`browser login window failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
      throw error instanceof BrowserFailure ? error : new BrowserFailure('launch_failed', 'browser.launch_failed');
    }
  }

  #failed(error: unknown): void {
    this.#failures += 1;
    this.#d.log?.(`browser launch failed (${this.#failures}): ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
    if (this.#failures < FAILURES_BEFORE_PAUSE) return;
    this.#pausedUntil = this.#now() + PAUSE_MS;
    const language = languageOf(this.#d.config());
    try {
      this.#d.notify?.({
        kind: 'health_alert', title: toolText(language, 'browser.notify_title'),
        body: toolText(language, 'browser.notify_body', { count: String(this.#failures) }), link: '#/settings', dedupKey: 'browser-launch',
      });
    } catch { /* お知らせの失敗で呼び出しを変えない */ }
  }

  // ---- 閉じる ----
  async #closeLogin(): Promise<void> {
    const login = this.#login;
    this.#login = undefined;
    if (!login) return;
    await withTimeout(login.handle.close(), CLOSE_TIMEOUT_MS);
    await login.proxy.close().catch(() => undefined);
  }

  async #shutdown(): Promise<void> {
    const handle = this.#handle; const proxy = this.#proxy;
    this.#handle = undefined; this.#proxy = undefined;
    this.#tabs.clear();
    if (handle) await withTimeout(handle.close(), CLOSE_TIMEOUT_MS);
    if (proxy) await proxy.close().catch(() => undefined);
  }

  #cancelIdleTimer(): void {
    this.#idleToken += 1;
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
  }

  #armIdle(): void {
    this.#cancelIdleTimer();
    const token = this.#idleToken;
    const minutes = this.#d.config().tools.browser.limits.idleCloseMinutes;
    this.#cancelIdle = this.#schedule(() => { void this.#idleClose(token); }, minutes * 60_000);
  }

  async #idleClose(token: number): Promise<void> {
    if (token !== this.#idleToken) return;
    await this.#acquire(undefined);
    try {
      // 待っているあいだに使われていたら、閉じない
      if (token === this.#idleToken) await this.#shutdown();
    } finally { this.#release(); }
  }

  // ---- タブ ----
  async #closeTab(tab: BrowserTab): Promise<void> {
    this.#tabs.delete(tab.id);
    await withTimeout(tab.page.close(), CLOSE_TIMEOUT_MS);
  }

  #api(call: BrowserCall): BrowserApi {
    const handle = this.#handle!;
    const proxy = this.#proxy!;
    const start = proxy.stats();
    const own = (): BrowserTab[] => [...this.#tabs.values()].filter(tab => tab.conversationId === call.conversationId);
    const config = this.#d.config().tools.browser;
    return {
      signal: call.signal,
      config,
      openTab: async () => {
        if (this.#tabs.size >= config.limits.maxTabs) throw new BrowserFailure('tab_limit', 'browser.tab_limit', { max: String(config.limits.maxTabs) });
        const page = await handle.newPage();
        const tab: BrowserTab = { id: `t${this.#nextTab++}`, conversationId: call.conversationId, page, table: undefined, used: ++this.#clock };
        this.#tabs.set(tab.id, tab);
        return tab;
      },
      tab: id => {
        const mine = own();
        const found = id === undefined ? mine.sort((a, b) => b.used - a.used)[0] : mine.find(tab => tab.id === id);
        if (!found) throw new BrowserFailure('no_tab', 'browser.no_tab', { tab: id ?? '' });
        return found;
      },
      tabs: () => own(),
      touch: tab => { tab.used = ++this.#clock; },
      closeTab: async id => {
        const tab = own().find(x => x.id === id);
        if (!tab) return false;
        await this.#closeTab(tab);
        return true;
      },
      closeAll: async () => {
        const mine = own();
        for (const tab of mine) await this.#closeTab(tab);
        return mine.length;
      },
      proxyDelta: () => { const now = proxy.stats(); return { blocked: now.blocked - start.blocked, busy: now.busy - start.busy }; },
      withPopups: async work => {
        const sink: PageHandle[] = [];
        this.#popups = sink;
        let value: Awaited<ReturnType<typeof work>>;
        try {
          value = await work();
        } catch (error) {
          this.#popups = undefined;
          for (const page of sink) await withTimeout(page.close(), CLOSE_TIMEOUT_MS);
          throw error;
        }
        this.#popups = undefined;
        const opened: BrowserTab[] = [];
        let closed = 0;
        for (const page of sink) {
          if (this.#tabs.size >= config.limits.maxTabs) { await withTimeout(page.close(), CLOSE_TIMEOUT_MS); closed += 1; continue; }
          const tab: BrowserTab = { id: `t${this.#nextTab++}`, conversationId: call.conversationId, page, table: undefined, used: ++this.#clock };
          this.#tabs.set(tab.id, tab);
          opened.push(tab);
        }
        return { value, opened, closed };
      },
    };
  }
}
