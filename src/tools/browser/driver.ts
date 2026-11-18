// ブラウザの driver。playwright-core を import するのはこのファイルだけ（動的 import。無効のあいだは読み込まない）。
// 試験は偽の driver（tests/helpers/fake-browser.ts）を使う。本物は BEAT_BROWSER_LIVE=1 のときだけ動かす
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Frame, Locator, Page, Request, Route } from 'playwright-core';
import type { Language } from '../../config/schema.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { isEdgeExecutable } from '../../shared/browser-path.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';
import { isLoopbackUrl } from './loopback.ts';
import { listedNavigationVerdict, loopbackVerdict, routeVerdict, type RouteRefusal, type RouteVerdict } from './route.ts';

export type BrowserFailureCode =
  | 'disabled' | 'no_browser' | 'launch_failed' | 'profile_busy' | 'paused' | 'tab_limit' | 'no_tab'
  | 'timeout' | 'aborted' | 'lost' | 'blocked' | 'nav_failed' | 'page_changed' | 'act_failed' | 'login_open' | 'no_display';

// 文の鍵は道具の文（tools.ts）か、守りの文（guard.ts。9-1a で足したループバックなどの文）
export type BrowserMessageKey = ToolMessageKey | GuardMessageKey;
const browserText = (language: Language, key: BrowserMessageKey, params: MessageParams): string =>
  Object.hasOwn(toolText.tables.en, key) ? toolText(language, key as ToolMessageKey, params) : guardText(language, key as GuardMessageKey, params);

// ブラウザの道具の失敗。key と params からアプリの決まった文を作る（nav_failed だけ、相手・Playwright の文字が params に入る）
export class BrowserFailure extends Error {
  readonly code: BrowserFailureCode;
  readonly key: BrowserMessageKey;
  readonly params: MessageParams;
  constructor(code: BrowserFailureCode, key: BrowserMessageKey, params: MessageParams = {}) {
    super(browserText('en', key, params));
    this.code = code; this.key = key; this.params = params;
  }

  text(language: Language): string { return browserText(language, this.key, this.params); }
  // 文が全部アプリの決まった文か（そうなら、外から読んだ内容を含まない）
  get appTextOnly(): boolean { return this.code !== 'nav_failed'; }
}

export const REFUSAL_KEYS: Record<RouteRefusal, BrowserMessageKey> = {
  scheme: 'browser.blocked_scheme',
  navigation: 'browser.blocked_navigation',
  downgrade: 'browser.blocked_downgrade',
  listed: 'browser.blocked_listed',
  loopback: 'browser.blocked_loopback',
};

export interface LaunchOptions {
  profileDir: string;
  // どちらも undefined なら自動（手元の Chrome）。Edge は使わない
  channel: 'chrome' | undefined;
  executablePath: string | undefined;
  headless: boolean;
  proxy: { server: string; username: string; password: string };
  viewport: { width: number; height: number };
  locale: string;
  actionTimeoutMs: number;
  // 操作の一覧（tools.browser.sites）を、遷移のたびに読む関数。一覧のサイトへの確かめを出せない遷移（リダイレクトなど）を断るのに使う。
  // 省くと（ログイン用の窓など）この守りは働かない
  sites?: (() => readonly string[]) | undefined;
}

// 作業用のブラウザ（プロファイルを残さない chromium.launch）の起動の選択。proxy は土台の中継（公開の決まりだけ・ループバックなし）
export type WorkLaunchOptions = Pick<LaunchOptions, 'channel' | 'executablePath' | 'headless' | 'proxy'>;

// 作業用の文脈（会話ごと）。proxy はその文脈だけの中継。loopback は「許されたループバックの URL か」（許しが無ければ undefined = ループバックは全部断る）
export interface WorkContextOptions extends Pick<LaunchOptions, 'proxy' | 'viewport' | 'locale' | 'actionTimeoutMs' | 'sites'> {
  loopback?: ((url: string) => boolean) | undefined;
}

export interface WorkBrowserHandle {
  newContext(options: WorkContextOptions): Promise<BrowserHandle>;
  onDisconnected(cb: () => void): void;
  close(): Promise<void>;
}

export interface ElementState { visible: boolean; enabled: boolean }

// 探し直す要素: 役割・名前（完全一致）・何番目か・読んだときの全部の数（数が違えば別のページとみなして触らない）
export interface ElementTarget { role: string; name: string; nth: number; count: number }
// 探し直した要素の属性（パスワード欄などの判定に使う。ariaSnapshot からは分からないので、要素そのものから読む）
export interface ElementDetail extends ElementState {
  // <input> は DOM の type（ブラウザが正規化したもの）、それ以外は type 属性。小文字。無ければ undefined
  type: string | undefined;
  autocomplete: string | undefined;
}
// 操作のあいだに起きたページ側の出来事。数だけ（ダイアログの文などページの文字は持たない）
export interface ActionEvents { dialogs: number; downloads: number; fileChoosers: number }

export interface PageHandle {
  url(): string;
  title(): Promise<string>;
  // 見えている本文（innerText 相当）。maxChars を超える分は切る
  text(maxChars: number): Promise<string>;
  // ariaSnapshot（elements.ts が読む）
  snapshot(): Promise<string>;
  goto(url: string, timeoutMs: number): Promise<{ status: number | undefined }>;
  // 数が読んだときと同じで nth 番目があるときだけ、その要素の状態と属性。そうでなければ undefined
  locate(target: ElementTarget): Promise<ElementDetail | undefined>;
  // 押す / 文字を入れる（submit なら最後に Enter）。実行の直前に数をもう一度確かめ、違えば page_changed。
  // ダイアログは閉じ（beforeunload だけ離れる）、ダウンロードは断り、ファイル選択は閉じて、数を返す
  click(target: ElementTarget, timeoutMs: number): Promise<ActionEvents>;
  fill(target: ElementTarget, text: string, submit: boolean, timeoutMs: number): Promise<ActionEvents>;
  // 見えている範囲だけの PNG
  screenshot(): Promise<Buffer>;
  // 要求の横取りが最後に断った遷移の理由（goto の前に消し、断られたら入る）
  lastRefusal(): RouteRefusal | undefined;
  close(): Promise<void>;
}

export interface BrowserHandle {
  newPage(): Promise<PageHandle>;
  pages(): PageHandle[];
  // ページ側が開いた窓（ポップアップ）。newPage で作ったものは通知しない
  onPage(cb: (page: PageHandle) => void): void;
  close(): Promise<void>;
  onDisconnected(cb: () => void): void;
}

export interface BrowserDriver {
  // 起動に失敗したら BrowserFailure を投げる
  launch(options: LaunchOptions): Promise<BrowserHandle>;
  // 作業用のブラウザ（会話ごとの文脈を作る）。起動に失敗したら BrowserFailure を投げる。持たない driver（下見のサーバーの起動しない driver）は作業用を起動できない
  launchWork?(options: WorkLaunchOptions): Promise<WorkBrowserHandle>;
}

export const LAUNCH_TIMEOUT_MS = 30_000;
export const CLOSE_TIMEOUT_MS = 10_000;

// ブラウザの子プロセスに渡す環境変数の名前（これだけ。.env の鍵などは渡さない）
const ENV_NAMES = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']);

export function childEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_NAMES.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

// Playwright が標準で付ける --disable-features の中身（playwright-core 1.65 時点）。
// Chromium は --disable-features を 1 つしか読まず、あとから渡した引数が勝つ。こちらの --disable-features が Playwright の既定を潰さないよう、既定をここに写して足す
// （MediaRouter・OptimizationHints・NetworkTimeServiceQuerying・PreconnectToSearch などは、起動時の余計な通信を止める）。
// Playwright の版を上げたら、tests/browser-driver-static.test.ts が一覧との食い違いを見つける
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'HttpsUpgrades', 'HttpsFirstBalancedModeAutoEnable', 'LensOverlay',
  'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'AvoidCorsURLLoaderRestartOnRedirect', 'TcpPortRandomizationWin',
  'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled', 'PreconnectToSearch', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
];

// 固定の起動引数（設定で外せない）
export function launchArgs(): string[] {
  return [
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--no-pings',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--deny-permission-prompts',
    `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, 'PasswordManagerOnboarding', 'AutofillServerCommunication'].join(',')}`,
  ];
}

// Playwright の起動の選択（ブラウザの分。固定。設定で変えられるのは headless・channel・executablePath だけ）
export function browserLaunchOptions(o: WorkLaunchOptions, env: Record<string, string> = childEnv()) {
  return {
    ...(o.channel ? { channel: o.channel } : {}),
    ...(o.executablePath ? { executablePath: o.executablePath } : {}),
    headless: o.headless,
    proxy: { server: o.proxy.server, username: o.proxy.username, password: o.proxy.password },
    args: launchArgs(),
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  };
}

// Playwright の文脈の選択（ページの分。固定）
export function contextOptions(o: Pick<LaunchOptions, 'viewport' | 'locale'>) {
  return {
    viewport: { width: o.viewport.width, height: o.viewport.height },
    locale: o.locale,
    acceptDownloads: false,
    serviceWorkers: 'block' as const,
    bypassCSP: false,
    javaScriptEnabled: true,
    permissions: [] as string[],
    ignoreHTTPSErrors: false,
  };
}

// 持ち主のプロファイル（launchPersistentContext）の選択 = ブラウザの分 + 文脈の分
export function playwrightOptions(o: LaunchOptions, env: Record<string, string> = childEnv()) {
  return { ...browserLaunchOptions(o, env), ...contextOptions(o) };
}

// 作業用の文脈の選択。中継は文脈ごと。ループバックも文脈の中継に通す（<-loopback> を自分で書く: Playwright の環境変数に左右されない）
export function workContextOptions(o: WorkContextOptions) {
  return {
    ...contextOptions(o),
    proxy: { server: o.proxy.server, username: o.proxy.username, password: o.proxy.password, bypass: '<-loopback>' },
  };
}

export function systemLocale(): string { return Intl.DateTimeFormat().resolvedOptions().locale; }

// パスワードを覚えさせない・自動で入れさせない（プロファイルの Default/Preferences。ブラウザが閉じているあいだに書く）
export function seedPreferences(profileDir: string): void {
  const dir = join(profileDir, 'Default');
  // プロファイルはログイン情報（cookie）を持つので、持ち主だけが読める権限（0o700）にする。Windows では権限の指定は無視される
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(profileDir, 0o700); chmodSync(dir, 0o700); } catch { /* 直せなくても起動は止めない */ }
  const file = join(dir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
  } catch (e) {
    // 無ければ新しく作る。壊れていて読めないものは触らない（ブラウザが作り直す）
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const profile = typeof prefs['profile'] === 'object' && prefs['profile'] !== null ? prefs['profile'] as Record<string, unknown> : {};
  prefs['credentials_enable_service'] = false;
  prefs['profile'] = { ...profile, password_manager_enabled: false };
  writeFileSync(file, JSON.stringify(prefs), { encoding: 'utf8', mode: 0o600 });
}

function classifyLaunchError(error: unknown): BrowserFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|is not found at|distribution '.*' is not found|Chromium distribution|no such file/iu.test(message)) return new BrowserFailure('no_browser', 'browser.no_browser');
  if (/ProcessSingleton|SingletonLock|already in use|profile appears to be in use|user data directory is already/iu.test(message)) return new BrowserFailure('profile_busy', 'browser.profile_busy');
  return new BrowserFailure('launch_failed', 'browser.launch_failed');
}

const clipLine = (text: string, max: number) => text.replace(/\s+/gu, ' ').trim().slice(0, max);

// 要求を出した枠の出どころの URL。空の枠（about:blank / about:srcdoc）は親の枠、空の窓は開いた元のページの URL。読めなければ undefined
export async function frameSource(frame: Frame): Promise<string | undefined> {
  let current: Frame | null = frame;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    const url = current.url();
    if (url !== '' && !url.startsWith('about:')) return url;
    const parent: Frame | null = current.parentFrame();
    if (parent !== null) { current = parent; continue; }
    const opener: Page | null = await current.page().opener().catch(() => null);
    current = opener === null ? null : opener.mainFrame();
  }
  return undefined;
}

// 押したあと、遷移や新しい窓が起きるのを少し待つ（長くは待たない）
const SETTLE_MS = 250;
const SETTLE_LOAD_MS = 1000;

class PlaywrightPage implements PageHandle {
  readonly page: Page;
  refusal: RouteRefusal | undefined;
  // goto の最中だけ入る、browser_open が確かめを済ませた入口の URL（その最初の要求は、一覧のサイトの URL でも断らない）
  entry: string | undefined;
  #events: ActionEvents = { dialogs: 0, downloads: 0, fileChoosers: 0 };
  constructor(page: Page) {
    this.page = page;
    // ページ側の出来事には、いつも自分で答える（放っておくとページが止まる）。中身は読まない
    page.on('dialog', dialog => {
      this.#events.dialogs++;
      // beforeunload（離れてよいか）だけは、離れるのを妨げないよう受ける。ほかの alert / confirm / prompt は閉じる（承諾しない）
      void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on('download', download => { this.#events.downloads++; void download.cancel().catch(() => undefined); });
    page.on('filechooser', () => { this.#events.fileChoosers++; });
  }

  url(): string { return this.page.url(); }
  title(): Promise<string> { return this.page.title(); }
  async text(maxChars: number): Promise<string> {
    const text = await this.page.locator('body').innerText();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  snapshot(): Promise<string> { return this.page.locator('body').ariaSnapshot(); }

  async goto(url: string, timeoutMs: number): Promise<{ status: number | undefined }> {
    this.refusal = undefined;
    try { this.entry = new URL(url).href; } catch { this.entry = undefined; }
    try {
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { status: response?.status() };
    } catch (e) {
      if (this.refusal) throw new BrowserFailure('blocked', REFUSAL_KEYS[this.refusal]);
      const message = e instanceof Error ? e.message : String(e);
      if ((e as { name?: string }).name === 'TimeoutError') throw new BrowserFailure('timeout', 'browser.timeout', { sec: Math.round(timeoutMs / 1000) });
      throw new BrowserFailure('nav_failed', 'browser.nav_failed', { reason: clipLine(message.replace(/^page\.goto:\s*/iu, ''), 200) });
    } finally {
      this.entry = undefined;
    }
  }

  async #locator(target: ElementTarget): Promise<Locator | undefined> {
    const all = this.page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true });
    if (target.nth >= target.count || await all.count() !== target.count) return undefined;
    return all.nth(target.nth);
  }

  async locate(target: ElementTarget): Promise<ElementDetail | undefined> {
    const one = await this.#locator(target);
    if (!one) return undefined;
    const attrs = await one.evaluate((el: Element) => {
      const input = el instanceof HTMLInputElement ? el.type : el.getAttribute('type');
      return { type: input ? input.trim().toLowerCase() : null, autocomplete: (el.getAttribute('autocomplete') ?? '').trim().toLowerCase() || null };
    });
    return { visible: await one.isVisible(), enabled: await one.isEnabled(), type: attrs.type ?? undefined, autocomplete: attrs.autocomplete ?? undefined };
  }

  // 操作の前に出来事の数を 0 に戻し、あとで返す
  async #act(target: ElementTarget, timeoutMs: number, work: (one: Locator) => Promise<void>): Promise<ActionEvents> {
    const one = await this.#locator(target);
    if (!one) throw new BrowserFailure('page_changed', 'browser.page_changed');
    this.#events = { dialogs: 0, downloads: 0, fileChoosers: 0 };
    try {
      await work(one);
    } catch (e) {
      if ((e as { name?: string }).name === 'TimeoutError') throw new BrowserFailure('timeout', 'browser.timeout', { sec: Math.round(timeoutMs / 1000) });
      // Playwright の文にはページの文字が入りうるので、そのままは出さない
      throw new BrowserFailure('act_failed', 'browser.act_failed');
    }
    await new Promise<void>(resolve => { setTimeout(resolve, SETTLE_MS); });
    await this.page.waitForLoadState('domcontentloaded', { timeout: SETTLE_LOAD_MS }).catch(() => undefined);
    return { ...this.#events };
  }

  click(target: ElementTarget, timeoutMs: number): Promise<ActionEvents> {
    return this.#act(target, timeoutMs, one => one.click({ timeout: timeoutMs }));
  }

  fill(target: ElementTarget, text: string, submit: boolean, timeoutMs: number): Promise<ActionEvents> {
    return this.#act(target, timeoutMs, async one => {
      await one.fill(text, { timeout: timeoutMs });
      if (submit) await one.press('Enter', { timeout: timeoutMs });
    });
  }

  screenshot(): Promise<Buffer> { return this.page.screenshot({ type: 'png', fullPage: false }); }
  lastRefusal(): RouteRefusal | undefined { return this.refusal; }
  async close(): Promise<void> { await this.page.close({ runBeforeUnload: false }); }
}

// 試験のために export（本物の BrowserContext の代わりに偽物を渡して、窓の見分けを試す）
export class PlaywrightBrowser implements BrowserHandle {
  readonly #context: BrowserContext;
  readonly #wrappers = new WeakMap<Page, PlaywrightPage>();
  readonly #own = new WeakSet<Page>();
  #onPage: ((page: PageHandle) => void) | undefined;
  // newPage の最中（数えるのは、同時に呼ばれても崩れないため）。そのあいだに届いた opener の無い窓は、戻りを待ってから見分ける
  #creating = 0;
  readonly #undecided = new Set<Page>();

  readonly #sites: () => readonly string[];
  // 許されたループバックの URL か（作業用の文脈で許しがあるときだけ）。持ち主のプロファイル・許しの無い文脈は、ループバックを全部断る
  readonly #loopback: (url: string) => boolean;

  constructor(context: BrowserContext, sites: () => readonly string[] = () => [], loopback?: ((url: string) => boolean) | undefined) {
    this.#context = context; this.#sites = sites; this.#loopback = loopback ?? (() => false);
  }

  wrap(page: Page): PlaywrightPage {
    let wrapper = this.#wrappers.get(page);
    if (!wrapper) { wrapper = new PlaywrightPage(page); this.#wrappers.set(page, wrapper); }
    return wrapper;
  }

  async install(): Promise<void> {
    await this.#context.route('**/*', route => this.#intercept(route));
    this.#context.on('page', page => { void this.#classify(page); });
  }

  // 新しい窓の見分け: opener（開いた元のページ）を持つものは、ページが開いた popup。
  // opener の無いものは、自分の newPage の窓か、noopener で開かれた窓。newPage の外で届いたものと、newPage の戻りで自分の窓と分かった以外は popup
  async #classify(page: Page): Promise<void> {
    let opener: Page | null;
    // opener が読めない（窓がもう閉じた・接続が切れた等）ときは、安全側に倒して「opener の無い窓」として扱う。
    // 自分の newPage の窓でなければ popup になる（黙って自分のタブ扱いにはしない）
    try { opener = await page.opener(); } catch { opener = null; }
    if (opener === null && this.#own.has(page)) return;
    if (opener === null && this.#creating > 0) { this.#undecided.add(page); return; }
    this.#onPage?.(this.wrap(page));
  }

  // 副の守り。判定できないものは断る（本体は中継）
  async #intercept(route: Route): Promise<void> {
    try {
      const request = route.request();
      const frame = request.frame();
      const owner = this.#wrappers.get(frame.page());
      const verdict = routeVerdict({ url: request.url(), navigation: request.isNavigationRequest(), mainFrame: frame.parentFrame() === null, pageUrl: frame.page().url() || undefined, allowed: this.#loopback });
      const mainNavigation = request.isNavigationRequest() && frame.parentFrame() === null;
      let final: RouteVerdict = verdict;
      if (final.allow && isLoopbackUrl(request.url())) final = await this.#loopbackVerdict(request, frame, mainNavigation ? owner : undefined);
      if (final.allow && mainNavigation) final = await this.#listedVerdict(request, frame.page(), owner);
      if (final.allow) { await route.continue(); return; }
      if (owner && mainNavigation) owner.refusal = final.reason;
      await route.abort('blockedbyclient');
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  }

  // ループバックへの要求の出どころを確かめる（副の守り。判定は route.ts の loopbackVerdict）
  async #loopbackVerdict(request: Request, frame: Frame, owner: PlaywrightPage | undefined): Promise<RouteVerdict> {
    const navigation = request.isNavigationRequest();
    const redirectedFrom = navigation ? request.redirectedFrom()?.url() : undefined;
    const source = redirectedFrom === undefined ? await frameSource(frame) : undefined;
    return loopbackVerdict({ url: request.url(), navigation, frameUrl: source, redirectedFrom, sourceUrl: source, entryUrl: owner?.entry, allowed: this.#loopback });
  }

  // 一覧のサイトへの、確かめを出せない遷移（リダイレクト・一覧外のページからの移動）を断る。判定は route.ts の listedNavigationVerdict
  async #listedVerdict(request: Request, page: Page, owner: PlaywrightPage | undefined): Promise<RouteVerdict> {
    const sites = this.#sites();
    if (sites.length === 0) return { allow: true };
    const redirectedFrom = request.redirectedFrom()?.url();
    let sourceUrl: string | undefined;
    if (redirectedFrom === undefined) {
      sourceUrl = page.url();
      // 開いたばかりの窓（まだ空）は、開いた元のページを遷移元とする
      if (sourceUrl === '' || sourceUrl === 'about:blank') sourceUrl = (await page.opener().catch(() => null))?.url();
    }
    return listedNavigationVerdict({ url: request.url(), redirectedFrom, sourceUrl, entryUrl: owner?.entry, sites });
  }

  async newPage(): Promise<PageHandle> {
    this.#creating += 1;
    try {
      const page = await this.#context.newPage();
      this.#own.add(page);
      this.#undecided.delete(page);
      return this.wrap(page);
    } finally {
      this.#creating -= 1;
      if (this.#creating === 0) {
        // 自分の窓でなかったもの（noopener の popup など）は、popup として知らせる
        const rest = [...this.#undecided];
        this.#undecided.clear();
        for (const page of rest) this.#onPage?.(this.wrap(page));
      }
    }
  }

  pages(): PageHandle[] { return this.#context.pages().map(page => this.wrap(page)); }
  onPage(cb: (page: PageHandle) => void): void { this.#onPage = cb; }
  onDisconnected(cb: () => void): void { this.#context.on('close', cb); }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); timer.unref(); });
    try { await Promise.race([this.#context.close(), limit]); } finally { if (timer) clearTimeout(timer); }
  }
}

// 起動を試す channel の順。自動は Chrome だけ（Edge は試さない）。executablePath があればそれを使う（channel は付けない）
export function launchAttempts(options: Pick<LaunchOptions, 'channel' | 'executablePath'>): Array<LaunchOptions['channel']> {
  return options.channel || options.executablePath ? [options.channel] : ['chrome'];
}

export class PlaywrightDriver implements BrowserDriver {
  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    // 設定の検証をすり抜けても、Edge の実行ファイルは起動しない（プロファイルの準備・playwright の読み込みより前に断る）
    if (options.executablePath && isEdgeExecutable(options.executablePath)) throw new BrowserFailure('no_browser', 'browser.edge_refused');
    let chromium: typeof import('playwright-core').chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { throw new BrowserFailure('launch_failed', 'browser.launch_failed'); }
    seedPreferences(options.profileDir);
    const attempts = launchAttempts(options);
    let failure: BrowserFailure | undefined;
    for (const channel of attempts) {
      try {
        const context = await chromium.launchPersistentContext(options.profileDir, playwrightOptions({ ...options, channel }));
        context.setDefaultTimeout(options.actionTimeoutMs);
        const browser = new PlaywrightBrowser(context, options.sites);
        try { await browser.install(); } catch (e) { await context.close().catch(() => undefined); throw e; }
        return browser;
      } catch (e) {
        failure = e instanceof BrowserFailure ? e : classifyLaunchError(e);
        if (failure.code !== 'no_browser') break;
      }
    }
    throw failure ?? new BrowserFailure('launch_failed', 'browser.launch_failed');
  }

  // 作業用のブラウザ: プロファイルを残さない chromium.launch。起動の引数・子の環境・Edge を断る・channel の試し方は持ち主のものと同じ。
  // 起動のときは土台の中継（文脈の外の通信もそのまま外へ出さない）。会話ごとの文脈は newContext で、その文脈だけの中継を付ける
  async launchWork(options: WorkLaunchOptions): Promise<WorkBrowserHandle> {
    if (options.executablePath && isEdgeExecutable(options.executablePath)) throw new BrowserFailure('no_browser', 'browser.edge_refused');
    let chromium: typeof import('playwright-core').chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { throw new BrowserFailure('launch_failed', 'browser.launch_failed'); }
    let failure: BrowserFailure | undefined;
    for (const channel of launchAttempts(options)) {
      try {
        return new PlaywrightWorkBrowser(await chromium.launch(browserLaunchOptions({ ...options, channel })));
      } catch (e) {
        failure = e instanceof BrowserFailure ? e : classifyLaunchError(e);
        if (failure.code !== 'no_browser') break;
      }
    }
    throw failure ?? new BrowserFailure('launch_failed', 'browser.launch_failed');
  }
}

class PlaywrightWorkBrowser implements WorkBrowserHandle {
  readonly #browser: Browser;
  constructor(browser: Browser) { this.#browser = browser; }

  async newContext(options: WorkContextOptions): Promise<BrowserHandle> {
    const context = await this.#browser.newContext(workContextOptions(options));
    try {
      context.setDefaultTimeout(options.actionTimeoutMs);
      const handle = new PlaywrightBrowser(context, options.sites, options.loopback);
      await handle.install();
      return handle;
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
  }

  onDisconnected(cb: () => void): void { this.#browser.on('disconnected', cb); }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); timer.unref(); });
    try { await Promise.race([this.#browser.close(), limit]); } finally { if (timer) clearTimeout(timer); }
  }
}
