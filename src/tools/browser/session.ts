// ブラウザの持ち主。2 種類のブラウザを持つ:
// - 持ち主のブラウザ（永続のプロファイル。ログインが残る。全会話で 1 つ）: 持ち主が見ている会話（kind chat）が公開のページを開くときだけ使う
// - 作業用のブラウザ（プロファイルを残さない。使うときだけ起動）: 会話ごとに文脈（Cookie もタブも会話をまたがない）と、その文脈だけの中継を持つ。
//   製品の会話がループバック（開発サーバー）を開くときと、タスク・子の担当のすべてが使う。ループバックは、製品の実行の文脈の中継だけが通す
// 起動・アイドルで閉じる・タブの持ち主・呼び出しを 1 つずつ・起動の失敗の扱いもここ。
// 道具は run() の中でしかページに触れない。タブは会話に属し、別の会話のタブは見えない・使えない・閉じられない
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { selfPortsOf } from '../hooks/self-port.ts';
import { BrowserFailure, CLOSE_TIMEOUT_MS, systemLocale, type BrowserDriver, type BrowserHandle, type LaunchOptions, type PageHandle, type WorkBrowserHandle } from './driver.ts';
import type { ElementTable } from './elements.ts';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from './egress-proxy.ts';
import { allowedLoopbackUrl, deniedLoopbackPorts, type BrowserGrant } from './loopback.ts';

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
  // 自動操作のブラウザ（持ち主のもの・作業用のもののどちらか）が起動しているか
  running: boolean;
  // ログイン用の窓が開いているか
  loginOpen: boolean;
  tabs: number;
  // 起動を休んでいる残り（分）。休んでいなければ 0
  pausedMinutes: number;
  // ログイン用の窓を出せる環境か
  canShowWindow: boolean;
}

// owner: 持ち主のプロファイル（ログインあり）/ work: 会話ごとの作業用の文脈。開いたあと変わらない
export type BrowserTabKind = 'owner' | 'work';

export interface BrowserTab {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: BrowserTabKind;
  readonly page: PageHandle;
  // 最後に読んだ「触れるもの」の表。URL が変わったら使わない
  table: ElementTable | undefined;
  used: number;
}

export interface BrowserCall {
  grant: BrowserGrant;
  signal: AbortSignal;
}

export interface BrowserApi {
  readonly signal: AbortSignal;
  readonly config: BrowserConfig;
  readonly grant: BrowserGrant;
  // 種類のブラウザ・文脈をそのとき用意して、新しいタブを開く（owner は持ち主が見ている会話だけ）
  openTab(kind: BrowserTabKind): Promise<BrowserTab>;
  // id を省くと、この会話でいちばん最近使ったタブ。無い・別の会話のものなら no_tab
  tab(id?: string): BrowserTab;
  tabs(): BrowserTab[];
  touch(tab: BrowserTab): void;
  closeTab(id: string): Promise<boolean>;
  closeAll(): Promise<number>;
  // この呼び出しのあいだに中継（持ち主のものと、この会話の文脈のもの）が断った数（403 / 503）
  proxyDelta(): { blocked: number; busy: number };
  // work のあいだにページ側が開いた窓（ポップアップ）を、この会話の新しいタブとして残す。
  // 上限を超える分は閉じて数だけ返す。work が失敗したら、集めた窓はすべて閉じる。work の外で開いた窓・ほかの会話の文脈の窓は今までどおり即座に閉じる
  withPopups<T>(work: () => Promise<T>): Promise<{ value: T; opened: BrowserTab[]; closed: number }>;
}

const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
const VIEWPORT = { width: 1280, height: 800 };
// 全体のタブの上限（メモリの歯止め）。会話ごとの上限は設定の maxTabs
export const MAX_TABS_TOTAL = 16;

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

interface Proxied { handle: BrowserHandle; proxy: EgressProxy }
// 作業用の文脈（会話ごと）。許し（loopback・productId）は作ったときのもので、あとから広げない
interface Idle { token: number; cancel: (() => void) | undefined }
interface WorkContext extends Proxied { conversationId: string; loopback: boolean; productId: string | undefined; idle: Idle }
interface PopupSink { conversationId: string; attended: boolean; pages: Array<{ page: PageHandle; kind: BrowserTabKind; handle: BrowserHandle }> }

export class BrowserSession {
  readonly #d: BrowserSessionDeps;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  // 持ち主のブラウザ
  #owner: Proxied | undefined;
  // ログイン用の窓（持ち主が自分で操作する見えるブラウザ）。開いているあいだ、持ち主のブラウザを使う呼び出しは断る
  #login: Proxied | undefined;
  // 作業用のブラウザと、起動のときの土台の中継（公開の決まりだけ）
  #work: { browser: WorkBrowserHandle; proxy: EgressProxy } | undefined;
  #contexts = new Map<string, WorkContext>();
  #tabs = new Map<string, BrowserTab>();
  readonly #tabHandles = new WeakMap<BrowserTab, BrowserHandle>();
  // withPopups のあいだだけ、ページ側が開いた窓を集める入れ物
  #popups: PopupSink | undefined;
  #nextTab = 1;
  #clock = 0;
  #locked = false;
  #waiters: Array<() => void> = [];
  #failures = 0;
  #pausedUntil = 0;
  #ownerIdle: Idle = { token: 0, cancel: undefined };
  // close() のたびに増える。起動の途中で閉じられたら、できたものを捨てる
  #epoch = 0;
  // 作ってから見た beat のポートすべて（起動の時の設定を含む）。設定を変えて反映する前も、動いている古いポートを断り続ける
  #selfPorts = new Set<number>();

  constructor(deps: BrowserSessionDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#schedule = deps.schedule ?? defaultSchedule;
    this.#noteSelfPorts();
  }

  #noteSelfPorts(config: AppConfig = this.#d.config()): void {
    for (const port of selfPortsOf(config.server).ports) this.#selfPorts.add(port);
  }

  secrets(): readonly string[] { return this.#d.secrets?.() ?? []; }
  enabled(): boolean { return this.#d.config().tools.browser.enabled; }
  // この会話で開いているタブの数（browser_close が、閉じるものが無いのにブラウザを起動しないための確かめ）
  tabCount(conversationId: string): number { return [...this.#tabs.values()].filter(tab => tab.conversationId === conversationId).length; }
  tabUrl(conversationId: string, id?: string): string | undefined {
    const mine = [...this.#tabs.values()].filter(tab => tab.conversationId === conversationId);
    const found = id === undefined ? mine.sort((a, b) => b.used - a.used)[0] : mine.find(tab => tab.id === id);
    return found?.page.url();
  }
  // この会話のタブの種類（無ければ undefined）。browser_open の事前の判定が、tab の種類違いをブラウザを起動せずに見分ける
  tabKind(conversationId: string, id: string): BrowserTabKind | undefined {
    const tab = this.#tabs.get(id);
    return tab?.conversationId === conversationId ? tab.kind : undefined;
  }

  // ループバックの断るポート（D-3）。設定・これまで見た beat のポート・いま動いている中継すべてのポートから、呼ぶたびに作る
  loopbackDenied(): ReadonlySet<number> {
    this.#noteSelfPorts();
    const ports: number[] = [...this.#selfPorts];
    for (const proxied of [this.#owner, this.#login, this.#work, ...this.#contexts.values()]) if (proxied) ports.push(proxied.proxy.port);
    return deniedLoopbackPorts(this.#d.config(), ports);
  }

  async run<T>(call: BrowserCall, fn: (api: BrowserApi) => Promise<T>): Promise<T> {
    if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
    await this.#acquire(call.signal);
    try {
      if (call.signal.aborted) throw new BrowserFailure('aborted', 'browser.aborted');
      if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
      if (call.grant.attended) this.#cancelIdle(this.#ownerIdle);
      const context = this.#contexts.get(call.grant.conversationId);
      if (context) {
        this.#cancelIdle(context.idle);
        // 許しが呼び出しと違えば、文脈（とそのタブ）を閉じて作り直す（許しをあとから広げない・狭めた許しで古いタブを使わせない）
        if (context.loopback !== call.grant.loopback || context.productId !== call.grant.productId) await this.#closeContext(context);
      }
      return await fn(this.#api(call));
    } finally {
      if (this.#owner && call.grant.attended) this.#armIdle(this.#ownerIdle, () => this.#shutdownOwner());
      const context = this.#contexts.get(call.grant.conversationId);
      if (context) this.#armIdle(context.idle, () => this.#closeContext(context));
      this.#release();
    }
  }

  // 会話を消したとき、その会話のタブと作業用の文脈を閉じる（起動していなければ何もしない）
  async closeConversation(ids: readonly string[]): Promise<void> {
    if (this.#tabs.size === 0 && this.#contexts.size === 0) return;
    await this.#acquire(undefined);
    try {
      for (const tab of [...this.#tabs.values()]) if (ids.includes(tab.conversationId)) await this.#closeTab(tab);
      for (const id of ids) { const context = this.#contexts.get(id); if (context) await this.#closeContext(context); }
    } finally { this.#release(); }
  }

  // 設定が変わった。無効になったら閉じる（ほかの変更は次の起動から効く。断るポート・ホストは要求のたびに読む）
  async applyConfig(config: AppConfig): Promise<void> {
    this.#noteSelfPorts(config);
    if (!config.tools.browser.enabled) { await this.#shutdown(); await this.#closeLogin(); }
  }

  async close(): Promise<void> {
    this.#epoch += 1;
    await this.#shutdown();
    await this.#closeLogin();
  }

  // ---- 設定の画面から（ログイン用の窓・止める・プロファイルの削除） ----
  status(): BrowserStatus {
    const now = this.#now();
    return {
      enabled: this.enabled(),
      running: this.#owner !== undefined || this.#work !== undefined,
      loginOpen: this.#login !== undefined,
      tabs: this.#tabs.size,
      pausedMinutes: now < this.#pausedUntil ? Math.max(1, Math.ceil((this.#pausedUntil - now) / 60_000)) : 0,
      canShowWindow: this.canShowWindow(),
    };
  }

  canShowWindow(): boolean { return (this.#d.canShowWindow ?? (() => headedAvailable(process.platform, process.env)))(); }

  // ログイン用に、同じプロファイル・同じ中継で、見えるブラウザを開く。持ち主のブラウザが動いていたら先に止める（同じプロファイルは同時に開けない）。
  // 作業用のブラウザはプロファイルを使わないので止めない。
  // 窓にはポップアップを閉じる仕掛けを付けない（ログインの画面が別の窓を開くことがある）。窓が閉じられたら、ログイン用の窓は無いことになる
  async openLogin(): Promise<{ alreadyOpen: boolean }> {
    if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
    if (!this.canShowWindow()) throw new BrowserFailure('no_display', 'browser.no_display');
    await this.#acquire(undefined);
    try {
      if (!this.enabled()) throw new BrowserFailure('disabled', 'browser.disabled');
      if (this.#login) return { alreadyOpen: true };
      await this.#shutdownOwner();
      const { handle, proxy } = await this.#startOwner(false, true);
      this.#login = { handle, proxy };
      handle.onDisconnected(() => { if (this.#login?.handle === handle) void this.#closeLogin(); });
      return { alreadyOpen: false };
    } finally { this.#release(); }
  }

  // ログイン用の窓と自動操作のブラウザ（両方）を閉じる（「ブラウザを閉じる」ボタン）
  async closeAll(): Promise<void> {
    await this.#acquire(undefined);
    try {
      await this.#shutdown();
      await this.#closeLogin();
    } finally { this.#release(); }
  }

  // ブラウザをすべて止め、ほかの呼び出しを待たせたまま fn を走らせる（プロファイルの削除のあいだに再起動されないため）
  async withStopped<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire(undefined);
    try {
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
  #checkPaused(): void {
    const now = this.#now();
    if (now < this.#pausedUntil) throw new BrowserFailure('paused', 'browser.launch_paused', { minutes: String(Math.max(1, Math.ceil((this.#pausedUntil - now) / 60_000))) });
  }

  // 中継の作り方。denyHosts（beat 自身の名前）はどの中継にも付け、要求のたびに設定を読む
  async #proxy(loopback: boolean): Promise<{ proxy: EgressProxy; username: string; password: string }> {
    const username = 'beat';
    const password = randomBytes(24).toString('hex');
    const browser = this.#d.config().tools.browser;
    const proxy = await (this.#d.startProxy ?? startEgressProxy)({
      username, password, maxBytesPerMinute: browser.limits.maxMbPerMinute * 1024 * 1024,
      denyHosts: () => selfPortsOf(this.#d.config().server).hosts,
      ...(loopback ? { loopback: { denyPorts: () => this.loopbackDenied() } } : {}),
      ...(this.#d.log ? { log: this.#d.log } : {}),
    });
    return { proxy, username, password };
  }

  async #ensureOwner(): Promise<BrowserHandle> {
    if (this.#owner) return this.#owner.handle;
    this.#checkPaused();
    const { handle, proxy } = await this.#startOwner(this.#d.config().tools.browser.headless, false);
    handle.onPage(page => this.#popup(page, 'owner', handle));
    handle.onDisconnected(() => { if (this.#owner?.handle === handle) void this.#shutdownOwner(); });
    this.#owner = { handle, proxy };
    this.#failures = 0;
    return handle;
  }

  // 持ち主のブラウザ（自動操作もログイン用の窓も、同じプロファイル・同じ形の中継）を起動する。失敗したら中継を閉じる。
  // 起動の失敗を数える（続くと休む）のは自動操作のときだけ。持ち主が自分で開くログイン用の窓の失敗は、画面にそのまま返す
  async #startOwner(headless: boolean, login: boolean): Promise<Proxied> {
    const epoch = this.#epoch;
    const browser = this.#d.config().tools.browser;
    let proxy: EgressProxy | undefined;
    try {
      const made = await this.#proxy(false);
      proxy = made.proxy;
      const options: LaunchOptions = {
        profileDir: this.#d.paths.browserProfile,
        channel: browser.channel === 'chrome' ? 'chrome' : undefined,
        executablePath: browser.channel === 'path' && browser.executablePath ? browser.executablePath : undefined,
        headless,
        proxy: { server: `http://${proxy.host}:${proxy.port}`, username: made.username, password: made.password },
        viewport: VIEWPORT,
        locale: systemLocale(),
        actionTimeoutMs: browser.limits.actionTimeoutSec * 1000,
        // 操作の一覧への、確かめを出せない遷移の守り。一覧は遷移のたびに読む。ログイン用の窓は、持ち主が自分で操作するので守りを付けない
        sites: login ? () => [] : () => this.#d.config().tools.browser.sites,
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

  // 作業用のブラウザ（土台の中継つき）。起動の失敗の数え方と休みは持ち主のブラウザと同じ
  async #ensureWork(): Promise<WorkBrowserHandle> {
    if (this.#work) return this.#work.browser;
    this.#checkPaused();
    const epoch = this.#epoch;
    const config = this.#d.config().tools.browser;
    let proxy: EgressProxy | undefined;
    try {
      const made = await this.#proxy(false);
      proxy = made.proxy;
      if (!this.#d.driver.launchWork) throw new BrowserFailure('launch_failed', 'browser.launch_failed');
      const browser = await this.#d.driver.launchWork({
        channel: config.channel === 'chrome' ? 'chrome' : undefined,
        executablePath: config.channel === 'path' && config.executablePath ? config.executablePath : undefined,
        headless: config.headless,
        proxy: { server: `http://${proxy.host}:${proxy.port}`, username: made.username, password: made.password },
      });
      if (epoch !== this.#epoch) { await withTimeout(browser.close(), CLOSE_TIMEOUT_MS); throw new BrowserFailure('aborted', 'browser.aborted'); }
      browser.onDisconnected(() => { if (this.#work?.browser === browser) void this.#shutdownWork(); });
      this.#work = { browser, proxy };
      this.#failures = 0;
      return browser;
    } catch (error) {
      await proxy?.close().catch(() => undefined);
      if (error instanceof BrowserFailure && error.code === 'aborted') throw error;
      this.#failed(error);
      throw error instanceof BrowserFailure ? error : new BrowserFailure('launch_failed', 'browser.launch_failed');
    }
  }

  // この会話の作業用の文脈（無ければ作る）。中継は文脈ごと（別のポート・別の合言葉・別の許し）
  async #ensureContext(grant: BrowserGrant): Promise<WorkContext> {
    const existing = this.#contexts.get(grant.conversationId);
    if (existing) return existing;
    const browser = await this.#ensureWork();
    const config = this.#d.config().tools.browser;
    let made: { proxy: EgressProxy; username: string; password: string } | undefined;
    let handle: BrowserHandle;
    try {
      made = await this.#proxy(grant.loopback);
      handle = await browser.newContext({
        proxy: { server: `http://${made.proxy.host}:${made.proxy.port}`, username: made.username, password: made.password },
        viewport: VIEWPORT,
        locale: systemLocale(),
        actionTimeoutMs: config.limits.actionTimeoutSec * 1000,
        sites: () => this.#d.config().tools.browser.sites,
        loopback: grant.loopback ? url => allowedLoopbackUrl(url, this.loopbackDenied()) : undefined,
      });
    } catch (error) {
      await made?.proxy.close().catch(() => undefined);
      // 文脈が 1 つも無いなら、いま起動した作業用のブラウザと土台の中継を残さない
      if (this.#contexts.size === 0) await this.#shutdownWork();
      throw error instanceof BrowserFailure ? error : new BrowserFailure('launch_failed', 'browser.launch_failed');
    }
    // 作っているあいだに作業用のブラウザが閉じられたら、できた文脈を捨てる
    if (this.#work?.browser !== browser) {
      await withTimeout(handle.close(), CLOSE_TIMEOUT_MS);
      await made.proxy.close().catch(() => undefined);
      throw new BrowserFailure('aborted', 'browser.aborted');
    }
    const context: WorkContext = { conversationId: grant.conversationId, loopback: grant.loopback, productId: grant.productId, handle, proxy: made.proxy, idle: { token: 0, cancel: undefined } };
    handle.onPage(page => this.#popup(page, 'work', handle));
    handle.onDisconnected(() => { if (this.#contexts.get(context.conversationId) === context) void this.#closeContext(context); });
    this.#contexts.set(grant.conversationId, context);
    return context;
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

  // ---- ページ側が開いた窓 ----
  // withPopups の最中に、その呼び出しの会話の窓だけを集める（持ち主のブラウザの窓は持ち主が見ている会話だけ・作業用は同じ会話の文脈だけ）。ほかは閉じる
  #popup(page: PageHandle, kind: BrowserTabKind, handle: BrowserHandle): void {
    const sink = this.#popups;
    const mine = sink !== undefined && (kind === 'owner' ? sink.attended : this.#contexts.get(sink.conversationId)?.handle === handle);
    if (sink && mine) { sink.pages.push({ page, kind, handle }); return; }
    void page.close().catch(() => undefined);
  }

  // ---- 閉じる ----
  async #closeLogin(): Promise<void> {
    const login = this.#login;
    this.#login = undefined;
    if (!login) return;
    await withTimeout(login.handle.close(), CLOSE_TIMEOUT_MS);
    await login.proxy.close().catch(() => undefined);
  }

  #dropTabs(match: (tab: BrowserTab) => boolean): void {
    for (const tab of [...this.#tabs.values()]) if (match(tab)) this.#tabs.delete(tab.id);
  }

  async #shutdownOwner(): Promise<void> {
    this.#cancelIdle(this.#ownerIdle);
    const owner = this.#owner;
    this.#owner = undefined;
    this.#dropTabs(tab => tab.kind === 'owner');
    if (!owner) return;
    await withTimeout(owner.handle.close(), CLOSE_TIMEOUT_MS);
    await owner.proxy.close().catch(() => undefined);
  }

  async #closeContext(context: WorkContext): Promise<void> {
    this.#cancelIdle(context.idle);
    if (this.#contexts.get(context.conversationId) === context) this.#contexts.delete(context.conversationId);
    this.#dropTabs(tab => tab.kind === 'work' && this.#tabHandles.get(tab) === context.handle);
    await withTimeout(context.handle.close(), CLOSE_TIMEOUT_MS);
    await context.proxy.close().catch(() => undefined);
    // 最後の文脈が閉じたら、作業用のブラウザも閉じる
    if (this.#contexts.size === 0) await this.#shutdownWork();
  }

  async #shutdownWork(): Promise<void> {
    for (const context of [...this.#contexts.values()]) {
      this.#cancelIdle(context.idle);
      this.#contexts.delete(context.conversationId);
      await withTimeout(context.handle.close(), CLOSE_TIMEOUT_MS);
      await context.proxy.close().catch(() => undefined);
    }
    this.#dropTabs(tab => tab.kind === 'work');
    const work = this.#work;
    this.#work = undefined;
    if (!work) return;
    await withTimeout(work.browser.close(), CLOSE_TIMEOUT_MS);
    await work.proxy.close().catch(() => undefined);
  }

  async #shutdown(): Promise<void> {
    await this.#shutdownOwner();
    await this.#shutdownWork();
  }

  // ---- アイドルで閉じる（持ち主のブラウザ・作業用の文脈ごと。最後に使ってから idleCloseMinutes） ----
  #cancelIdle(idle: Idle): void {
    idle.token += 1;
    idle.cancel?.();
    idle.cancel = undefined;
  }

  #armIdle(idle: Idle, close: () => Promise<void>): void {
    this.#cancelIdle(idle);
    const minutes = this.#d.config().tools.browser.limits.idleCloseMinutes;
    const token = idle.token;
    idle.cancel = this.#schedule(() => { void this.#idleClose(idle, token, close); }, minutes * 60_000);
  }

  async #idleClose(idle: Idle, token: number, close: () => Promise<void>): Promise<void> {
    if (idle.token !== token) return;
    await this.#acquire(undefined);
    try {
      // 待っているあいだに使われていたら、閉じない
      if (idle.token === token) await close();
    } finally { this.#release(); }
  }

  // ---- タブ ----
  async #closeTab(tab: BrowserTab): Promise<void> {
    this.#tabs.delete(tab.id);
    await withTimeout(tab.page.close(), CLOSE_TIMEOUT_MS);
  }

  #addTab(conversationId: string, kind: BrowserTabKind, page: PageHandle, handle: BrowserHandle): BrowserTab {
    const tab: BrowserTab = { id: `t${this.#nextTab++}`, conversationId, kind, page, table: undefined, used: ++this.#clock };
    this.#tabs.set(tab.id, tab);
    this.#tabHandles.set(tab, handle);
    return tab;
  }

  // タブの上限: 会話ごとに maxTabs、全体で MAX_TABS_TOTAL。超えるなら、その失敗
  #tabLimit(conversationId: string, maxTabs: number): BrowserFailure | undefined {
    if (this.tabCount(conversationId) >= maxTabs) return new BrowserFailure('tab_limit', 'browser.tab_limit', { max: String(maxTabs) });
    if (this.#tabs.size >= MAX_TABS_TOTAL) return new BrowserFailure('tab_limit', 'browser.tab_limit_total', { max: MAX_TABS_TOTAL });
    return undefined;
  }

  #api(call: BrowserCall): BrowserApi {
    const grant = call.grant;
    const config = this.#d.config().tools.browser;
    // 持ち主のタブは、持ち主が見ている会話の呼び出しからだけ見える（人のいない実行は持ち主のログインのあるタブに触れない）
    const own = (): BrowserTab[] => [...this.#tabs.values()].filter(tab => tab.conversationId === grant.conversationId && (tab.kind === 'work' || grant.attended));
    const proxies = (): EgressProxy[] => {
      const list: EgressProxy[] = [];
      if (this.#owner && grant.attended) list.push(this.#owner.proxy);
      const context = this.#contexts.get(grant.conversationId);
      if (context) list.push(context.proxy);
      return list;
    };
    const start = new Map(proxies().map(proxy => [proxy, proxy.stats()]));
    return {
      signal: call.signal,
      config,
      grant,
      openTab: async kind => {
        const limit = this.#tabLimit(grant.conversationId, config.limits.maxTabs);
        if (limit) throw limit;
        if (kind === 'owner') {
          // 人のいない実行は、持ち主のプロファイル（ログインあり）を一度も使わない
          if (!grant.attended) throw new BrowserFailure('blocked', 'browser.tab_kind', { tab: 'new' });
          // 同じプロファイルを 2 つのブラウザで開けない。ログイン用の窓が開いているあいだは、持ち主のブラウザは使えない
          if (this.#login) throw new BrowserFailure('login_open', 'browser.login_open');
          const handle = await this.#ensureOwner();
          return this.#addTab(grant.conversationId, 'owner', await handle.newPage(), handle);
        }
        const context = await this.#ensureContext(grant);
        return this.#addTab(grant.conversationId, 'work', await context.handle.newPage(), context.handle);
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
      proxyDelta: () => {
        let blocked = 0; let busy = 0;
        for (const proxy of proxies()) {
          const now = proxy.stats(); const before = start.get(proxy);
          blocked += now.blocked - (before?.blocked ?? 0); busy += now.busy - (before?.busy ?? 0);
        }
        return { blocked, busy };
      },
      withPopups: async work => {
        const sink: PopupSink = { conversationId: grant.conversationId, attended: grant.attended, pages: [] };
        this.#popups = sink;
        let value: Awaited<ReturnType<typeof work>>;
        try {
          value = await work();
        } catch (error) {
          this.#popups = undefined;
          for (const { page } of sink.pages) await withTimeout(page.close(), CLOSE_TIMEOUT_MS);
          throw error;
        }
        this.#popups = undefined;
        const opened: BrowserTab[] = [];
        let closed = 0;
        for (const { page, kind, handle } of sink.pages) {
          if (this.#tabLimit(grant.conversationId, config.limits.maxTabs)) { await withTimeout(page.close(), CLOSE_TIMEOUT_MS); closed += 1; continue; }
          opened.push(this.#addTab(grant.conversationId, kind, page, handle));
        }
        return { value, opened, closed };
      },
    };
  }
}
