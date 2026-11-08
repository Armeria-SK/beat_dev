// ブラウザの driver。playwright-core を import するのはこのファイルだけ（動的 import。無効のあいだは読み込まない）。
// 試験は偽の driver（tests/helpers/fake-browser.ts）を使う。本物は CLIVE_BROWSER_LIVE=1 のときだけ動かす
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright-core';
import type { Language } from '../../config/schema.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';
import { routeVerdict, type RouteRefusal } from './route.ts';

export type BrowserFailureCode =
  | 'disabled' | 'no_browser' | 'launch_failed' | 'profile_busy' | 'paused' | 'tab_limit' | 'no_tab'
  | 'timeout' | 'aborted' | 'lost' | 'blocked' | 'nav_failed' | 'page_changed';

// ブラウザの道具の失敗。key と params からアプリの決まった文を作る（nav_failed だけ、相手・Playwright の文字が params に入る）
export class BrowserFailure extends Error {
  readonly code: BrowserFailureCode;
  readonly key: ToolMessageKey;
  readonly params: MessageParams;
  constructor(code: BrowserFailureCode, key: ToolMessageKey, params: MessageParams = {}) {
    super(toolText('ja', key, params));
    this.code = code; this.key = key; this.params = params;
  }

  text(language: Language): string { return toolText(language, this.key, this.params); }
  // 文が全部アプリの決まった文か（そうなら、外から読んだ内容を含まない）
  get appTextOnly(): boolean { return this.code !== 'nav_failed'; }
}

export const REFUSAL_KEYS: Record<RouteRefusal, ToolMessageKey> = {
  scheme: 'browser.blocked_scheme',
  navigation: 'browser.blocked_navigation',
  downgrade: 'browser.blocked_downgrade',
};

export interface LaunchOptions {
  profileDir: string;
  // どちらも undefined なら自動（Edge、無ければ Chrome）
  channel: 'msedge' | 'chrome' | undefined;
  executablePath: string | undefined;
  headless: boolean;
  proxy: { server: string; username: string; password: string };
  viewport: { width: number; height: number };
  locale: string;
  actionTimeoutMs: number;
}

export interface ElementState { visible: boolean; enabled: boolean }

export interface PageHandle {
  url(): string;
  title(): Promise<string>;
  // 見えている本文（innerText 相当）。maxChars を超える分は切る
  text(maxChars: number): Promise<string>;
  // ariaSnapshot（elements.ts が読む）
  snapshot(): Promise<string>;
  goto(url: string, timeoutMs: number): Promise<{ status: number | undefined }>;
  // 役割と名前（完全一致）に当たる要素の数 / その nth 番目の状態（無ければ undefined）
  countRole(role: string, name: string): Promise<number>;
  stateOf(role: string, name: string, nth: number): Promise<ElementState | undefined>;
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
    '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication',
  ];
}

// Playwright の起動の選択（固定。設定で変えられるのは headless・channel・executablePath だけ）
export function playwrightOptions(o: LaunchOptions, env: Record<string, string> = childEnv()) {
  return {
    ...(o.channel ? { channel: o.channel } : {}),
    ...(o.executablePath ? { executablePath: o.executablePath } : {}),
    headless: o.headless,
    proxy: { server: o.proxy.server, username: o.proxy.username, password: o.proxy.password },
    viewport: { width: o.viewport.width, height: o.viewport.height },
    locale: o.locale,
    args: launchArgs(),
    env,
    acceptDownloads: false,
    serviceWorkers: 'block' as const,
    bypassCSP: false,
    javaScriptEnabled: true,
    permissions: [] as string[],
    ignoreHTTPSErrors: false,
    timeout: LAUNCH_TIMEOUT_MS,
  };
}

export function localeFor(language: Language): string { return language === 'ja' ? 'ja-JP' : 'en-US'; }

// パスワードを覚えさせない・自動で入れさせない（プロファイルの Default/Preferences。ブラウザが閉じているあいだに書く）
export function seedPreferences(profileDir: string): void {
  const dir = join(profileDir, 'Default');
  mkdirSync(dir, { recursive: true });
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

class PlaywrightPage implements PageHandle {
  readonly page: Page;
  refusal: RouteRefusal | undefined;
  constructor(page: Page) { this.page = page; }

  url(): string { return this.page.url(); }
  title(): Promise<string> { return this.page.title(); }
  async text(maxChars: number): Promise<string> {
    const text = await this.page.locator('body').innerText();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  snapshot(): Promise<string> { return this.page.locator('body').ariaSnapshot(); }

  async goto(url: string, timeoutMs: number): Promise<{ status: number | undefined }> {
    this.refusal = undefined;
    try {
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { status: response?.status() };
    } catch (e) {
      if (this.refusal) throw new BrowserFailure('blocked', REFUSAL_KEYS[this.refusal]);
      const message = e instanceof Error ? e.message : String(e);
      if ((e as { name?: string }).name === 'TimeoutError') throw new BrowserFailure('timeout', 'browser.timeout', { sec: Math.round(timeoutMs / 1000) });
      throw new BrowserFailure('nav_failed', 'browser.nav_failed', { reason: clipLine(message.replace(/^page\.goto:\s*/iu, ''), 200) });
    }
  }

  async countRole(role: string, name: string): Promise<number> {
    return this.page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true }).count();
  }

  async stateOf(role: string, name: string, nth: number): Promise<ElementState | undefined> {
    const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true });
    if (nth >= await locator.count()) return undefined;
    const one = locator.nth(nth);
    return { visible: await one.isVisible(), enabled: await one.isEnabled() };
  }

  screenshot(): Promise<Buffer> { return this.page.screenshot({ type: 'png', fullPage: false }); }
  lastRefusal(): RouteRefusal | undefined { return this.refusal; }
  async close(): Promise<void> { await this.page.close({ runBeforeUnload: false }); }
}

class PlaywrightBrowser implements BrowserHandle {
  readonly #context: BrowserContext;
  readonly #wrappers = new WeakMap<Page, PlaywrightPage>();
  readonly #own = new WeakSet<Page>();
  #onPage: ((page: PageHandle) => void) | undefined;

  constructor(context: BrowserContext) { this.#context = context; }

  wrap(page: Page): PlaywrightPage {
    let wrapper = this.#wrappers.get(page);
    if (!wrapper) { wrapper = new PlaywrightPage(page); this.#wrappers.set(page, wrapper); }
    return wrapper;
  }

  async install(): Promise<void> {
    await this.#context.route('**/*', route => this.#intercept(route));
    this.#context.on('page', page => { if (!this.#own.has(page)) this.#onPage?.(this.wrap(page)); });
  }

  // 副の守り。判定できないものは断る（本体は中継）
  async #intercept(route: Route): Promise<void> {
    try {
      const request = route.request();
      const frame = request.frame();
      const owner = this.#wrappers.get(frame.page());
      const verdict = routeVerdict({ url: request.url(), navigation: request.isNavigationRequest(), mainFrame: frame.parentFrame() === null, pageUrl: frame.page().url() || undefined });
      if (verdict.allow) { await route.continue(); return; }
      if (owner && request.isNavigationRequest() && frame.parentFrame() === null) owner.refusal = verdict.reason;
      await route.abort('blockedbyclient');
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  }

  async newPage(): Promise<PageHandle> {
    const page = await this.#context.newPage();
    this.#own.add(page);
    return this.wrap(page);
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

export class PlaywrightDriver implements BrowserDriver {
  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    let chromium: typeof import('playwright-core').chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { throw new BrowserFailure('launch_failed', 'browser.launch_failed'); }
    seedPreferences(options.profileDir);
    // 自動: Edge、無ければ Chrome
    const attempts: Array<LaunchOptions['channel']> = options.channel || options.executablePath ? [options.channel] : ['msedge', 'chrome'];
    let failure: BrowserFailure | undefined;
    for (const channel of attempts) {
      try {
        const context = await chromium.launchPersistentContext(options.profileDir, playwrightOptions({ ...options, channel }));
        context.setDefaultTimeout(options.actionTimeoutMs);
        const browser = new PlaywrightBrowser(context);
        try { await browser.install(); } catch (e) { await context.close().catch(() => undefined); throw e; }
        return browser;
      } catch (e) {
        failure = e instanceof BrowserFailure ? e : classifyLaunchError(e);
        if (failure.code !== 'no_browser') break;
      }
    }
    throw failure ?? new BrowserFailure('launch_failed', 'browser.launch_failed');
  }
}
