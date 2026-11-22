import { BrowserFailure, REFUSAL_KEYS, type BrowserDriver, type ActionEvents, type BrowserHandle, type ElementDetail, type ElementState, type ElementTarget, type LaunchOptions, type PageHandle, type WorkBrowserHandle, type WorkContextOptions, type WorkLaunchOptions } from '../../src/tools/browser/driver.ts';
import type { RouteRefusal, SubmitPermit } from '../../src/tools/browser/route.ts';

// 試験用の偽のブラウザ。ページの URL・題・本文・ariaSnapshot の文・要素の状態を持ち、開いた記録を残す

// 押した（または Enter を送った）ときにページ側で起きること
export interface FakeEffect {
  // 別の URL へ移る（FakeBrowserDriver.site に登録があれば、その中身になる）
  navigate?: string;
  // 開く窓の数
  popups?: number;
  dialogs?: number;
  downloads?: number;
  fileChoosers?: number;
  // 送信の守り（D-8）が断った要求の数（本物では横取りが数える）
  blocked?: number;
  // 操作が失敗する（隠れている・重なっているなど）
  fail?: 'act_failed' | 'timeout';
}

export interface FakeRow {
  // 要素の消えない ID（本物の要素の同一性の代わり）。省くと「役割・名前・何番目か」が同じなら同じ要素とみなす（鍵の無い一覧の作り直しと同じ形）。
  // 本物と同じく、名前が変わると別の印になる
  id?: string;
  role: string;
  name: string;
  state?: ElementState;
  // 要素の type 属性（password など）と autocomplete 属性
  type?: string;
  autocomplete?: string;
  // 押すとフォームを送る部品か（本物では elementFacts が要素から読む）
  submits?: boolean;
  effect?: FakeEffect;
}

export interface FakeAct { kind: 'click' | 'fill'; role: string; name: string; nth: number; text?: string; submit?: boolean; permit?: SubmitPermit | undefined }

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
  rows?: FakeRow[];
  png?: Buffer;
}

// 1x1 の PNG
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export class FakePage implements PageHandle {
  readonly browser: FakeBrowser;
  readonly gotos: string[] = [];
  closed = false;
  // 押した・入れた記録
  readonly acts: FakeAct[] = [];
  #url = 'about:blank';
  #site: FakeSite | undefined;
  #refusal: RouteRefusal | undefined;
  // いまの送信の許し（permitSubmits）
  permit: SubmitPermit | undefined;
  // 数を確かめてから要素をつかむまでのあいだに呼ぶ（その隙にページが変わった、を作る）
  beforePin: (() => void) | undefined;
  // 文書の代（移動・再読み込みで進む。本物は主フレームの framenavigated）
  #document = 1;
  // この文書で要素に振った印の数と、要素の鍵 → 印の数
  #ids = new Map<string, number>();
  // 最後に撮った表の印 → 要素の鍵（本物の getByRef と同じく、最後の表に無い印は 0 件）
  #lastRefs = new Map<string, string>();
  constructor(browser: FakeBrowser) { this.browser = browser; }

  url(): string { return this.#url; }
  async title(): Promise<string> { return this.#site?.title ?? ''; }
  async text(maxChars: number): Promise<string> { return (this.#site?.text ?? '').slice(0, maxChars); }
  documentId(): number { return this.#document; }

  // 本物の ai の形をまねて、番号を振る役割の行に [ref=…] を付ける（印は文書ごと・要素ごとに 1 つ。iframe の中も付ける）
  async snapshot(): Promise<string> {
    const raw = this.#site?.snapshot ?? '';
    const seen = new Map<string, number>();
    this.#lastRefs = new Map();
    return raw.split('\n').map(line => {
      const m = /^( *- ([a-z]+) "((?:[^"\\]|\\.)*)"(?: \[[^\]]*\])*)(.*)$/u.exec(line);
      if (!m || line.includes('[ref=')) return line;
      const role = m[2]!;
      let name: string;
      try { name = JSON.parse(`"${m[3]!}"`) as string; } catch { return line; }
      const group = `${role}\u0000${name}`;
      const nth = seen.get(group) ?? 0;
      seen.set(group, nth + 1);
      const key = this.#keyOf(role, name, nth);
      const ref = this.#refOf(key);
      this.#lastRefs.set(ref, key);
      return `${m[1]!} [ref=${ref}]${m[4]!}`;
    }).join('\n');
  }

  #keyOf(role: string, name: string, nth: number): string {
    const row = this.#rows(role, name)[nth];
    return row?.id !== undefined ? `id\u0000${row.id}\u0000${role}\u0000${name}` : `at\u0000${role}\u0000${name}\u0000${nth}`;
  }

  #refOf(key: string): string {
    let id = this.#ids.get(key);
    if (id === undefined) { id = this.#ids.size + 1; this.#ids.set(key, id); }
    return `f${this.#document}e${id}`;
  }

  // 印 → いまの要素（と、同じ役割・名前の何番目か）。最後の表に無い印・いまは無い要素は undefined
  #resolve(ref: string): { row: FakeRow; nth: number } | undefined {
    const key = this.#lastRefs.get(ref);
    if (key === undefined) return undefined;
    for (const row of this.#site?.rows ?? []) {
      const rows = this.#rows(row.role, row.name);
      const nth = rows.indexOf(row);
      if (this.#keyOf(row.role, row.name, nth) === key) return { row, nth };
    }
    return undefined;
  }

  // 試験から表を撮らずに直接押すための印（その要素の印を、最後の表に入れたことにする）
  refFor(role: string, name: string, nth = 0): string {
    const key = this.#keyOf(role, name, nth);
    const ref = this.#refOf(key);
    this.#lastRefs.set(ref, key);
    return ref;
  }

  #newDocument(): void { this.#document += 1; this.#ids = new Map(); this.#lastRefs = new Map(); }
  // 同じ URL のまま新しい文書になった（再読み込み・POST の結果）
  reload(site?: FakeSite): void { if (site) this.#site = site; this.#newDocument(); }
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
    this.#newDocument();
    return { status: site ? 200 : 404 };
  }

  // 次の読みのために、ページの中身を差し替える（ページが変わった、を作る）
  mutate(site: FakeSite): void { this.#site = site; }
  navigateTo(url: string): void { this.#url = url; this.#newDocument(); }

  #rows(role: string, name: string): FakeRow[] { return (this.#site?.rows ?? []).filter(r => r.role === role && r.name === name); }

  async locate(target: ElementTarget): Promise<ElementDetail | undefined> {
    const row = this.#resolve(target.ref)?.row;
    if (row === undefined) return undefined;
    return { ...(row.state ?? { visible: true, enabled: true }), type: row.type, autocomplete: row.autocomplete, form: { inForm: row.submits === true, submits: row.submits === true } };
  }

  async #act(kind: 'click' | 'fill', target: ElementTarget, extra: Pick<FakeAct, 'text' | 'submit'>, submit: boolean): Promise<ActionEvents> {
    // 本物と同じ: 印が引けなければ触らない。つかんだあとの確かめ（verify）が false でも、確かめのあとに印が引けなくなっても触らない
    // （偽のブラウザの要素は鍵で決まるので、引き直した要素がつかんだ要素と違う形は、本物の driver の試験 browser-driver-locator で見る）
    if (this.#resolve(target.ref) === undefined) throw new BrowserFailure('page_changed', 'browser.page_changed');
    this.beforePin?.();
    if (target.verify !== undefined && !(await target.verify().catch(() => false))) throw new BrowserFailure('page_changed', 'browser.page_changed');
    const found = this.#resolve(target.ref);
    if (found === undefined) throw new BrowserFailure('page_changed', 'browser.page_changed');
    const { row, nth } = found;
    const effect = kind === 'click' || submit ? row.effect : undefined;
    this.acts.push({ kind, role: row.role, name: row.name, nth, ...extra, permit: this.permit });
    if (effect?.fail === 'act_failed') throw new BrowserFailure('act_failed', 'browser.act_failed');
    if (effect?.fail === 'timeout') throw new BrowserFailure('timeout', 'browser.timeout', { sec: 1 });
    if (effect?.navigate !== undefined) {
      this.#site = this.browser.driver.sites.get(effect.navigate);
      this.#url = effect.navigate;
      this.#newDocument();
    }
    for (let i = 0; i < (effect?.popups ?? 0); i++) this.browser.popup();
    return { dialogs: effect?.dialogs ?? 0, downloads: effect?.downloads ?? 0, fileChoosers: effect?.fileChoosers ?? 0, blocked: effect?.blocked ?? 0 };
  }

  async click(target: ElementTarget, _timeoutMs: number): Promise<ActionEvents> {
    return this.#act('click', target, {}, false);
  }

  async fill(target: ElementTarget, text: string, submit: boolean, _timeoutMs: number): Promise<ActionEvents> {
    return this.#act('fill', target, { text, submit }, submit);
  }

  permitSubmits(permit: SubmitPermit | undefined): void { this.permit = permit; }
  async screenshot(): Promise<Buffer> { return this.#site?.png ?? TINY_PNG; }
  async close(): Promise<void> { this.closed = true; this.browser.pageList = this.browser.pageList.filter(p => p !== this); }
}

export class FakeBrowser implements BrowserHandle {
  readonly driver: FakeBrowserDriver;
  readonly options: LaunchOptions;
  // 作業用の文脈のときだけ: newContext に渡された選択（loopback の許しなど）
  contextOptions: WorkContextOptions | undefined;
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

// 作業用のブラウザ（会話ごとの文脈を作る）。文脈は FakeBrowser（options は起動の形に寄せた写し、contextOptions が渡された文脈の選択）
export class FakeWorkBrowser implements WorkBrowserHandle {
  readonly driver: FakeBrowserDriver;
  readonly options: WorkLaunchOptions;
  readonly contexts: FakeBrowser[] = [];
  closed = false;
  #onDisconnected: (() => void) | undefined;
  constructor(driver: FakeBrowserDriver, options: WorkLaunchOptions) { this.driver = driver; this.options = options; }

  async newContext(options: WorkContextOptions): Promise<BrowserHandle> {
    const failure = this.driver.contextFailures.shift();
    if (failure) throw failure;
    const context = new FakeBrowser(this.driver, { ...this.options, profileDir: '', viewport: options.viewport, locale: options.locale, actionTimeoutMs: options.actionTimeoutMs, proxy: options.proxy, sites: options.sites });
    context.contextOptions = options;
    this.contexts.push(context);
    return context;
  }

  onDisconnected(cb: () => void): void { this.#onDisconnected = cb; }
  async close(): Promise<void> { this.closed = true; for (const context of this.contexts) await context.close(); }
  crash(): void { this.closed = true; for (const context of this.contexts) context.crash(); this.#onDisconnected?.(); }
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly sites = new Map<string, FakeSite>();
  readonly browsers: FakeBrowser[] = [];
  readonly workBrowsers: FakeWorkBrowser[] = [];
  // 起動を失敗させる回数（先頭から）。BrowserFailure を渡せばその失敗になる。持ち主のブラウザと作業用のブラウザで共有
  failures: Array<Error | undefined> = [];
  // 作業用の文脈づくり（newContext）を失敗させる回数（先頭から）
  contextFailures: Array<Error | undefined> = [];
  launchGate: Promise<void> | undefined;
  launches = 0;
  workLaunches = 0;

  site(url: string, site: FakeSite = {}): this { this.sites.set(url, site); return this; }
  get current(): FakeBrowser | undefined { return this.browsers.at(-1); }
  get work(): FakeWorkBrowser | undefined { return this.workBrowsers.at(-1); }
  // いちばん新しい作業用の文脈
  get context(): FakeBrowser | undefined { return this.work?.contexts.at(-1); }

  async launch(options: LaunchOptions): Promise<BrowserHandle> {
    this.launches += 1;
    if (this.launchGate) await this.launchGate;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const browser = new FakeBrowser(this, options);
    this.browsers.push(browser);
    return browser;
  }

  async launchWork(options: WorkLaunchOptions): Promise<WorkBrowserHandle> {
    this.workLaunches += 1;
    if (this.launchGate) await this.launchGate;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const browser = new FakeWorkBrowser(this, options);
    this.workBrowsers.push(browser);
    return browser;
  }
}
