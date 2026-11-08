import { BrowserFailure, REFUSAL_KEYS, type BrowserDriver, type BrowserHandle, type ElementState, type LaunchOptions, type PageHandle } from '../../src/tools/browser/driver.ts';
import type { RouteRefusal } from '../../src/tools/browser/route.ts';

// 試験用の偽のブラウザ。ページの URL・題・本文・ariaSnapshot の文・要素の状態を持ち、開いた記録を残す

export interface FakeSite {
  title?: string;
  text?: string;
  snapshot?: string;
  // 開く（goto）が、この Promise が終わるまで待つ（呼び出しの重なりを試すため）
  gate?: Promise<void>;
  // 要求の横取りが断ったことにする
  refuse?: RouteRefusal;
  // 開けなかったことにする（net::ERR_... のような文）
  fail?: string;
  // 開いたあとの URL（リダイレクト）
  finalUrl?: string;
  // 役割・名前ごとの状態（無ければ、見える・有効）。数は snapshot ではなくここで決まる
  rows?: Array<{ role: string; name: string; state?: ElementState }>;
  png?: Buffer;
}

// 1x1 の PNG
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export class FakePage implements PageHandle {
  readonly browser: FakeBrowser;
  readonly gotos: string[] = [];
  closed = false;
  #url = 'about:blank';
  #site: FakeSite | undefined;
  #refusal: RouteRefusal | undefined;
  constructor(browser: FakeBrowser) { this.browser = browser; }

  url(): string { return this.#url; }
  async title(): Promise<string> { return this.#site?.title ?? ''; }
  async text(maxChars: number): Promise<string> { return (this.#site?.text ?? '').slice(0, maxChars); }
  async snapshot(): Promise<string> { return this.#site?.snapshot ?? ''; }
  lastRefusal(): RouteRefusal | undefined { return this.#refusal; }

  async goto(url: string, _timeoutMs: number): Promise<{ status: number | undefined }> {
    this.gotos.push(url);
    this.#refusal = undefined;
    const site = this.browser.driver.sites.get(url.replace(/#.*$/u, ''));
    if (site?.gate) await site.gate;
    if (this.closed) throw new Error('page closed');
    if (site?.refuse) { this.#refusal = site.refuse; throw new BrowserFailure('blocked', REFUSAL_KEYS[site.refuse]); }
    if (site?.fail) throw new BrowserFailure('nav_failed', 'browser.nav_failed', { reason: site.fail });
    this.#site = site;
    this.#url = site?.finalUrl ?? url.replace(/#.*$/u, '');
    return { status: site ? 200 : 404 };
  }

  // 次の読みのために、ページの中身を差し替える（ページが変わった、を作る）
  mutate(site: FakeSite): void { this.#site = site; }
  navigateTo(url: string): void { this.#url = url; }

  async countRole(role: string, name: string): Promise<number> { return (this.#site?.rows ?? []).filter(r => r.role === role && r.name === name).length; }
  async stateOf(role: string, name: string, nth: number): Promise<ElementState | undefined> {
    const row = (this.#site?.rows ?? []).filter(r => r.role === role && r.name === name)[nth];
    return row === undefined ? undefined : row.state ?? { visible: true, enabled: true };
  }

  async screenshot(): Promise<Buffer> { return this.#site?.png ?? TINY_PNG; }
  async close(): Promise<void> { this.closed = true; this.browser.pageList = this.browser.pageList.filter(p => p !== this); }
}

export class FakeBrowser implements BrowserHandle {
  readonly driver: FakeBrowserDriver;
  readonly options: LaunchOptions;
  pageList: FakePage[] = [];
  closed = false;
  closeCalls = 0;
  #onPage: ((page: PageHandle) => void) | undefined;
  #onDisconnected: (() => void) | undefined;
  constructor(driver: FakeBrowserDriver, options: LaunchOptions) { this.driver = driver; this.options = options; }

  async newPage(): Promise<PageHandle> {
    const page = new FakePage(this);
    this.pageList.push(page);
    return page;
  }

  pages(): PageHandle[] { return [...this.pageList]; }
  onPage(cb: (page: PageHandle) => void): void { this.#onPage = cb; }
  onDisconnected(cb: () => void): void { this.#onDisconnected = cb; }
  async close(): Promise<void> { this.closeCalls += 1; this.closed = true; this.pageList = []; }

  // ページ側が窓を開いた
  popup(): FakePage {
    const page = new FakePage(this);
    this.pageList.push(page);
    this.#onPage?.(page);
    return page;
  }

  // ブラウザが落ちた
  crash(): void { this.closed = true; this.pageList = []; this.#onDisconnected?.(); }
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly sites = new Map<string, FakeSite>();
  readonly browsers: FakeBrowser[] = [];
  // 起動を失敗させる回数（先頭から）。BrowserFailure を渡せばその失敗になる
  failures: Array<Error | undefined> = [];
  launchGate: Promise<void> | undefined;
  launches = 0;

  site(url: string, site: FakeSite = {}): this { this.sites.set(url, site); return this; }
  get current(): FakeBrowser | undefined { return this.browsers.at(-1); }

  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    this.launches += 1;
    if (this.launchGate) await this.launchGate;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const browser = new FakeBrowser(this, options);
    this.browsers.push(browser);
    return browser;
  }
}
