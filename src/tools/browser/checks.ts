// browser_click / browser_type の事前の判定と、実行の直前の探し直し（同じ判定を 2 回通す）。
// 守り（どれも、方針が allow でも・「この会話では許可」でも外れない。preCheck が deny を返し、execute も同じ判定をもう一度通す）:
//   - 押せるのは、そのタブで許されたページ（公開のページ、または作業用のタブで許しのある実行の許されたループバック）だけ
//   - 番号は、読んだときのページ（URL が同じ表）のものだけ。移動のあとの古い番号は拒否
//   - 実行の直前に、役割・名前・nth で探し直し、数が読んだときと同じで、見えていて、有効でなければ実行しない
//   - browser_type は、パスワード・認証コード・カード番号の欄（type=password・autocomplete・名前）に入れない
// 通り方（9-1b。PLAN Approach 4 の順）: 秘密に見える文を入れる → 公開のページ・開発サーバーでないループバックは断る、開発サーバーは判定役 /
//   その実行の開発サーバー（持ち主が書いたループバックのポート・この会話かタスクの裏のコマンドが出力に出したポート）→ 判定役なし（送信も）/
//   送信 → 送る（会話は Pending、会話の外は断る）/ 一覧のサイト → 判定役なし / 持ち主が書いた URL のホスト → 判定役なし / ほか → 判定役。
//   開発サーバーでない許されたループバックは、一覧外の公開のサイトと同じ（送信は送る、ほかは判定役）
// Pending で承認された呼び出しは、再実行の前に preCheck をもう一度走らせ、bind が変わっていたら実行しない（src/pending/replay.ts）
import { languageOf } from '../../shared/language.ts';
import { sanitizeModelInputText } from '../../shared/redaction.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { PreCheck, ToolContext } from '../types.ts';
import { pageUrl } from '../web/public-page.ts';
import { BrowserFailure, type ElementDetail, type ElementTarget } from './driver.ts';
import type { ListedElement } from './elements.ts';
import { allowedLoopbackUrl, grantOf, isLoopbackUrl } from './loopback.ts';
import type { BrowserApi, BrowserSession, BrowserTab } from './session.ts';
import { ownerHostAllows, ownerLoopbackPorts, siteAllows } from './sites.ts';
import type { Language } from '../../config/schema.ts';

export const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
export const TYPE_TEXT_MAX = 2000;
const NAME_SHOWN = 120;
const SECRET_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);
// ページが付けた名前が、秘密の欄だと言っているもの（属性で区別できない欄の安全側の追加）
const SECRET_NAME = /password|passcode|passwd|パスワード|暗証|one[- ]?time|verification code|認証コード|card number|カード番号|cvc|cvv|security code|セキュリティコード/iu;

export interface ActInput { tab?: string | undefined; ref: string; text?: string | undefined; submit?: boolean | undefined }

// place: ページが公開のページか、その実行に許されたループバック（製品の開発サーバー）か。submits: この操作がフォームを送るか（D-5）
export type Inspected =
  | { ok: true; tab: BrowserTab; pageUrl: string; item: ListedElement; target: ElementTarget; detail: ElementDetail; place: 'public' | 'loopback'; submits: boolean }
  | { ok: false; reason: string };

const refuse = (reason: string): Inspected => ({ ok: false, reason });

function hostOf(url: string): string | undefined {
  try { return new URL(url).host.toLowerCase(); } catch { return undefined; }
}

export function isSecretField(detail: ElementDetail, name: string): boolean {
  if (detail.type === 'password') return true;
  for (const token of (detail.autocomplete ?? '').split(/\s+/u)) {
    if (SECRET_AUTOCOMPLETE.has(token) || token.startsWith('cc-')) return true;
  }
  return SECRET_NAME.test(name);
}

// ページの置き場所: そのタブで許されたループバック、公開のページ、またはどちらでもない（押さない）
function placeOf(tab: BrowserTab, api: BrowserApi, url: string, denied: ReadonlySet<number>): 'public' | 'loopback' | undefined {
  if (isLoopbackUrl(url)) return tab.kind === 'work' && api.grant.loopback && allowedLoopbackUrl(url, denied) ? 'loopback' : undefined;
  try { pageUrl(url); return 'public'; } catch { return undefined; }
}

// タブ・ページ・番号・探し直しを確かめる。ブラウザの呼び出しの中（run のロックの下）で呼ぶ
export async function inspectAct(api: BrowserApi, kind: 'click' | 'type', input: ActInput, language: Language, denied: ReadonlySet<number>): Promise<Inspected> {
  let tab: BrowserTab;
  try { tab = api.tab(input.tab); } catch (thrown) {
    if (thrown instanceof BrowserFailure) return refuse(thrown.text(language));
    throw thrown;
  }
  const pageUrl = tab.page.url();
  const place = placeOf(tab, api, pageUrl, denied);
  if (place === undefined) return refuse(guardText(language, 'browser.act.not_allowed_page'));
  const table = tab.table;
  if (table === undefined) return refuse(guardText(language, 'browser.act.no_table'));
  if (table.url !== pageUrl) return refuse(guardText(language, 'browser.act.stale'));
  const item = table.items.find(e => e.ref === input.ref);
  if (item === undefined) return refuse(guardText(language, 'browser.act.no_ref', { ref: input.ref }));
  if (item.frameUrl !== undefined && hostOf(item.frameUrl) !== hostOf(pageUrl)) return refuse(guardText(language, 'browser.act.frame', { ref: input.ref }));
  if (kind === 'type' && !TEXT_ROLES.has(item.role)) return refuse(guardText(language, 'browser.act.not_text', { ref: input.ref, role: item.role }));
  const target: ElementTarget = { role: item.role, name: item.name, nth: item.nth, count: item.count };
  const detail = await tab.page.locate(target);
  // 探し直せない（数が違う・無い）、属性が読めないものは、実行しない
  if (detail === undefined) return refuse(guardText(language, 'browser.act.changed', { ref: input.ref }));
  if (!detail.visible) return refuse(guardText(language, 'browser.act.hidden', { ref: input.ref }));
  if (!detail.enabled) return refuse(guardText(language, 'browser.act.disabled', { ref: input.ref }));
  if (kind === 'type' && isSecretField(detail, item.name)) return refuse(guardText(language, 'browser.act.secret_field', { ref: input.ref }));
  // 入れるは submit（Enter）のときだけ送信。押すは要素で決める
  const submits = kind === 'type' ? input.submit === true : detail.form.submits;
  return { ok: true, tab, pageUrl, item, target, detail, place, submits };
}

// 通り方（Approach 4 の順 2〜6）。loopback: 許されたループバック（送信も判定役なし）/ submit: フォームの送信（送る）/
// listed: 聞かずに通す一覧のサイト / owner_url: 持ち主が会話・タスクに書いた URL のホスト / judge: 判定役へ
export type ActRoute = 'loopback' | 'submit' | 'listed' | 'owner_url' | 'judge';

export function actRoute(found: { place: 'public' | 'loopback'; submits: boolean; pageUrl: string }, sites: readonly string[], ownerTexts: readonly string[], devServer: boolean): ActRoute {
  if (found.place === 'loopback' && devServer) return 'loopback';
  if (found.submits) return 'submit';
  if (found.place === 'loopback') return 'judge';
  if (siteAllows(sites, found.pageUrl)) return 'listed';
  if (ownerHostAllows(ownerTexts, found.pageUrl)) return 'owner_url';
  return 'judge';
}

// その実行の開発サーバーのページか（R-8）: ポートが、持ち主が書いたループバックのポートか、この会話・このタスクの動いている裏のコマンドが出力に出したポート
export function devServerPage(pageUrl: string, ctx: Pick<ToolContext, 'ownerText' | 'services' | 'conversationId' | 'task' | 'parent'>): boolean {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return false; }
  if (!isLoopbackUrl(pageUrl)) return false;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (ownerLoopbackPorts(ownerTextsOf(ctx)).has(port)) return true;
  try {
    return ctx.services?.background?.printedPorts({ conversationId: ctx.conversationId, taskId: ctx.task?.id ?? ctx.parent?.taskId }).has(port) === true;
  } catch { return false; }
}

// 入れる文が API の鍵・トークンに見えるか（web_fetch と同じ見分け）
export const secretText = (kind: 'click' | 'type', input: ActInput): boolean => kind === 'type' && sanitizeModelInputText(input.text ?? '').redaction_count > 0;

// 持ち主が書いた文の束。読めないときは空（判定役へ行く側）
export function ownerTextsOf(ctx: Pick<ToolContext, 'ownerText'>): string[] {
  try { return ctx.ownerText?.() ?? []; } catch { return []; }
}

const flat = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
const shownName = (name: string): string => { const one = flat(name); return one.length > NAME_SHOWN ? `${one.slice(0, NAME_SHOWN)}…` : one; };

// 承認の札に出す中身と、承認のあとに比べる指紋
export function actPreview(kind: 'click' | 'type', input: ActInput, found: Extract<Inspected, { ok: true }>, language: Language): { preview: NonNullable<PreCheck['preview']>; bind: string } {
  const lines = [
    guardText(language, 'browser.act.preview_target', { role: found.item.role, name: shownName(found.item.name), note: guardText(language, 'browser.act.page_name') }),
  ];
  if (kind === 'type') {
    const text = input.text ?? '';
    lines.push(guardText(language, 'browser.act.preview_text', { count: [...text].length }), text);
    lines.push(guardText(language, input.submit === true ? 'browser.act.preview_submit' : 'browser.act.preview_no_submit'));
  }
  // 札を出したときのページ・タブ・要素。承認のあとに同じ判定をもう一度走らせて、これが変わっていたら実行しない（別のページ・別の要素に押さない）
  const bind = JSON.stringify([found.tab.id, found.pageUrl, found.item.role, found.item.name, found.item.nth, found.item.frameUrl ?? null]);
  return { preview: [{ path: guardText(language, 'browser.act.preview_page', { url: found.pageUrl }), text: lines.join('\n'), truncated: false }], bind };
}

// 道具の preCheck。ブラウザが無効・タブが無いときはブラウザを起動しない
export async function browserActCheck(kind: 'click' | 'type', input: ActInput, ctx: ToolContext): Promise<PreCheck> {
  const language = languageOf(ctx.config);
  const browser: BrowserSession | undefined = ctx.services?.browser;
  if (!ctx.config.tools.browser.enabled || browser === undefined) return { decision: 'deny', reasons: [guardText(language, 'browser.off')] };
  const grant = grantOf(ctx);
  if (grant === undefined) return { decision: 'deny', reasons: [guardText(language, 'browser.no_grant')] };
  if (kind === 'type' && (input.text ?? '').length > TYPE_TEXT_MAX) return { decision: 'deny', reasons: [guardText(language, 'browser.act.too_long', { max: TYPE_TEXT_MAX })] };
  if (browser.tabCount(ctx.conversationId) === 0) {
    const failure = input.tab === undefined ? new BrowserFailure('no_tab', 'browser.no_tabs') : new BrowserFailure('no_tab', 'browser.no_tab', { tab: input.tab });
    return { decision: 'deny', reasons: [failure.text(language)] };
  }
  try {
    return await browser.run({ grant, signal: ctx.signal }, async api => {
      const found = await inspectAct(api, kind, input, language, browser.loopbackDenied());
      if (!found.ok) return { decision: 'deny', reasons: [found.reason] } satisfies PreCheck;
      const { preview, bind } = actPreview(kind, input, found, language);
      const devServer = found.place === 'loopback' && devServerPage(found.pageUrl, ctx);
      // 秘密に見える文: 公開のページ（と開発サーバーでないループバック）へは断る（順 1。web.secret_text は拒否の印）。開発サーバーへは判定役に見せる
      if (secretText(kind, input)) {
        return devServer
          ? { decision: 'ask', reasons: [guardText(language, 'web.secret_text')], askKinds: ['web'], bind, preview, fetched: true } satisfies PreCheck
          : { decision: 'ask', reasons: [guardText(language, 'web.secret_text')], reasonKeys: ['web.secret_text'], askKinds: ['web'], bind, preview, fetched: true } satisfies PreCheck;
      }
      switch (actRoute(found, api.config.sites, ownerTextsOf(ctx), devServer)) {
        case 'submit':
          return { decision: 'ask', reasons: [guardText(language, 'browser.act.reason')], askKinds: ['web'], sends: true, submits: true, bind, preview, fetched: true } satisfies PreCheck;
        case 'judge':
          return { decision: 'ask', reasons: [guardText(language, 'browser.act.judge')], askKinds: ['web'], bind, preview, fetched: true } satisfies PreCheck;
        default:
          return { decision: 'allow', reasons: [], bind, fetched: true } satisfies PreCheck;
      }
    });
  } catch (thrown) {
    // 起動できない・時間切れなどは、アプリの決まった文だけで断る
    if (thrown instanceof BrowserFailure) return { decision: 'deny', reasons: [thrown.appTextOnly ? thrown.text(language) : guardText(language, 'browser.act.changed', { ref: input.ref })] };
    return { decision: 'deny', reasons: [new BrowserFailure('lost', 'browser.lost').text(language)] };
  }
}
