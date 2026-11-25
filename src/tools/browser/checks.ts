// browser_click / browser_type の事前の判定と、実行の直前の探し直し（同じ判定を 2 回通す）。browser_act（P5）は step ごとに、同じ探し直しと通り方をその時点のページで通す。
// 守り（どれも、方針が allow でも・「この会話では許可」でも外れない。preCheck が deny を返し、execute も同じ判定をもう一度通す）:
//   - 押せるのは、そのタブで許されたページ（公開のページ、または作業用のタブで許しのある実行の許されたループバック）だけ
//   - 番号は、読んだときのページ（URL が同じ表）のものだけ。移動のあとの古い番号は拒否。
//     番号は、判定のたびにその場で取り直した表から引く（要素が変わった・中身が変わって使えなくなった番号、モデルに見せていない番号は拒否。elements.ts）
//   - 実行の直前に、番号が結ぶ Playwright の印で要素を引き直し、1 つの主フレームの要素で、見えていて、有効でなければ実行しない
//   - browser_type は、カード番号の欄（cc-* の autocomplete・名前）に入れない。パスワード・認証コードの欄（type=password・autocomplete・名前）には text では入れず、
//     password の引数で試しの値だけを、beat が自分で起動して動いている開発サーバーのページ（そのポートの待ち受けがこの会話・タスクの裏のコマンドの入れ物の中）にだけ入れる（P7）。
//     この入力は、方針・フックが ask でも承認待ち・判定役に回さず断る（web.password_input は拒否の印）
// 通り方（9-1b。PLAN Approach 4 の順）: 秘密に見える文を入れる → 公開のページ・開発サーバーでないループバックは断る、開発サーバーは判定役 /
//   その実行の開発サーバー（持ち主が書いたループバックのポート・この会話かタスクの裏のコマンドが出力に出したポート）→ 判定役なし（送信も）/
//   送信 → 送る（会話は Pending、会話の外は断る）/ 一覧のサイト → 判定役なし / 持ち主が書いた URL のホスト → 判定役なし / ほか → 判定役。
//   開発サーバーでない許されたループバックは、一覧外の公開のサイトと同じ（送信は送る、ほかは判定役）。
//   ただし、そのポートがこの会話・タスクの止まった（自分で終わった）裏のコマンドのものなら、判定役に回さず断る（#56）
// Pending で承認された呼び出しは、再実行の前に preCheck をもう一度走らせ、bind が変わっていたら実行しない（src/pending/replay.ts）
import { languageOf } from '../../shared/language.ts';
import { redactExact, sanitizeModelInputText } from '../../shared/redaction.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { PreCheck, ToolContext } from '../types.ts';
import { pageUrl } from '../web/public-page.ts';
import { BrowserFailure, until, type ElementDetail, type ElementTarget, type FocusFacts } from './driver.ts';
import { readElements, retiredRef, shownRef, type ElementTable, type ListedElement, type Numbering } from './elements.ts';
import { allowedLoopbackUrl, grantOf, isLoopbackUrl } from './loopback.ts';
import type { BrowserApi, BrowserSession, BrowserTab } from './session.ts';
import { ownerHostAllows, ownerLoopbackPorts, siteAllows } from './sites.ts';
import type { Language } from '../../config/schema.ts';
import type { StoppedPort } from '../shell/background.ts';

export const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
// 本物の <select> の役割（1 つ選ぶ = combobox、複数・表示行数が 2 以上 = listbox）。役割だけでは自前の部品と見分けられないので、要素のタグも見る
export const SELECT_ROLES: ReadonlySet<string> = new Set(['combobox', 'listbox']);
export const TYPE_TEXT_MAX = 2000;
const NAME_SHOWN = 120;
const PASSWORD_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);
// ページが付けた名前が、暗証番号の欄・カードの欄だと言っているもの（属性で区別できない欄の安全側の追加）
const PASSWORD_NAME = /password|passcode|passwd|パスワード|暗証|one[- ]?time|verification code|認証コード/iu;
const CARD_NAME = /card number|カード番号|cvc|cvv|security code|セキュリティコード/iu;

// password は、暗証番号・認証コードの欄。P7 で、password の引数で試しの値を入れてよい（自分の開発サーバーだけ）。card はカード番号の欄で、どこでも断る
export type FieldKind = 'ordinary' | 'password' | 'card';

// password は text ではなく専用の欄で渡す。text は引数のまま、password は伏せて記録に出る欄
export interface ActInput { tab?: string | undefined; ref: string; text?: string | undefined; password?: string | undefined; submit?: boolean | undefined }

// place: ページが公開のページか、その実行に許されたループバック（製品の開発サーバー）か。submits: この操作がフォームを送るか（D-5）
// shape: 探し直しに使った表の、画面のまとめ（ActPick.shape を渡したときだけ）
export type Inspected =
  | { ok: true; tab: BrowserTab; pageUrl: string; item: ListedElement; target: ElementTarget; detail: ElementDetail; field: FieldKind; place: 'public' | 'loopback'; submits: boolean; shape?: string | undefined }
  | { ok: false; reason: string };

// 名前で指した目標（browser_act の step。P5）。nth は表の並び（木の順）で数え、1 が最初
export interface NamedTarget { role: string; name: string; nth?: number | undefined }

// browser_act の step の探し直しに足すもの。
// named: 番号の代わりに、その場で取り直した表から役割と名前（完全一致）で探す。allowed が true を返すページでだけ（その実行の開発サーバー）。
//   このとき input.ref は断る文に出す呼び名（「the element named in step 3」。ページの文も、モデルが書いた名前も入れない）
// shape: 画面のまとめも返す
export interface ActPick {
  named?: { target: NamedTarget; allowed: (pageUrl: string, place: 'public' | 'loopback') => boolean } | undefined;
  shape?: boolean | undefined;
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function hostOf(url: string): string | undefined {
  try { return new URL(url).host.toLowerCase(); } catch { return undefined; }
}

// 欄の種類。カードに当たるもの（cc-* の autocomplete・カードの名前）は、暗証番号にも当たってもカード（type=password と cc-csc の欄はカード）
export function fieldKind(detail: { type?: string | null | undefined; autocomplete?: string | null | undefined }, name: string): FieldKind {
  let password = detail.type === 'password' || PASSWORD_NAME.test(name);
  let card = CARD_NAME.test(name);
  for (const token of (detail.autocomplete ?? '').split(/\s+/u)) {
    if (token.startsWith('cc-')) card = true;
    else if (PASSWORD_AUTOCOMPLETE.has(token)) password = true;
  }
  return card ? 'card' : password ? 'password' : 'ordinary';
}

// 暗証番号・カードのどちらでも true（選ぶ・キーを送るは、どちらの欄にも今までどおり断る）
export function isSecretField(detail: { type?: string | null | undefined; autocomplete?: string | null | undefined }, name: string): boolean {
  return fieldKind(detail, name) !== 'ordinary';
}

// ページの置き場所: そのタブで許されたループバック、公開のページ、またはどちらでもない（押さない）
function placeOf(tab: BrowserTab, api: BrowserApi, url: string, denied: ReadonlySet<number>): 'public' | 'loopback' | undefined {
  if (isLoopbackUrl(url)) return tab.kind === 'work' && api.grant.loopback && allowedLoopbackUrl(url, denied) ? 'loopback' : undefined;
  try { pageUrl(url); return 'public'; } catch { return undefined; }
}

// タブの表をその場で撮り直して番号の対応を更新する。撮るあいだに URL か文書が変わったら undefined（古い表として断る側）。
// numbering は既定で check（新しい番号を振らず、前の番号のうちまだ使えるものだけ残す）。見せる表を作るときだけ show
export async function rereadTab(tab: BrowserTab, pageUrl: string, signal: AbortSignal, numbering: Numbering = { kind: 'check' }): Promise<ElementTable | undefined> {
  const document = tab.page.documentId();
  const snapshot = await until(tab.page.snapshot(), signal);
  if (tab.page.url() !== pageUrl || tab.page.documentId() !== document) return undefined;
  const table = readElements(snapshot, pageUrl, tab.refs, document, numbering);
  tab.table = table;
  return table;
}

// 表を取り直すが、読んでいないページの表を「読んだ表」にはしない（browser_act の名前で探す取り直しと、画面のまとめ。番号の step は今までどおり、読み直すまで断る）
export async function peekTab(tab: BrowserTab, pageUrl: string, signal: AbortSignal, numbering: Numbering): Promise<ElementTable | undefined> {
  const before = tab.table;
  const table = await rereadTab(tab, pageUrl, signal, numbering);
  if (before?.url !== pageUrl) tab.table = before;
  return table;
}

// 名前で指した目標を、named つきで取り直した表から選ぶ。複数当たって nth が無ければ many、無ければ undefined
export function namedItem(table: ElementTable, target: NamedTarget): ListedElement | 'many' | undefined {
  const found = table.named ?? [];
  if (target.nth === undefined && found.length > 1) return 'many';
  return found[(target.nth ?? 1) - 1];
}

// タブ・ページ・番号・探し直しを確かめる。ブラウザの呼び出しの中（run のロックの下）で呼ぶ
export async function inspectAct(api: BrowserApi, kind: 'click' | 'type' | 'select', input: ActInput, language: Language, denied: ReadonlySet<number>, pick: ActPick = {}): Promise<Inspected> {
  let tab: BrowserTab;
  try { tab = api.tab(input.tab); } catch (thrown) {
    if (thrown instanceof BrowserFailure) return refuse(thrown.text(language));
    throw thrown;
  }
  const pageUrl = tab.page.url();
  const place = placeOf(tab, api, pageUrl, denied);
  if (place === undefined) return refuse(guardText(language, 'browser.act.not_allowed_page'));
  const named = pick.named;
  const before = tab.table;
  if (named === undefined) {
    if (before === undefined) return refuse(guardText(language, 'browser.act.no_table'));
    if (before.url !== pageUrl) return refuse(guardText(language, 'browser.act.stale'));
  } else if (!named.allowed(pageUrl, place)) return refuse(guardText(language, 'browser.act.named_page'));
  // 番号は、いつもその場で取り直した表から引く（読んだあとに要素が作り直された・中身が入れ替わった番号は、ここで使えなくなる）
  const table = await (named === undefined ? rereadTab : peekTab)(tab, pageUrl, api.signal, { kind: 'check', named: named?.target, shape: pick.shape });
  if (table === undefined) return refuse(guardText(language, 'browser.act.stale'));
  let item: ListedElement | undefined;
  if (named === undefined) {
    item = table.items.find(e => e.ref === input.ref);
    // 使えなくなった番号には、新しい番号を添えない（周りを見ずに並びで選び直させない）。読み直させる。見せていない番号は無い番号と同じ
    if (item === undefined || !shownRef(tab.refs, item.ref)) return refuse(guardText(language, retiredRef(tab.refs, input.ref) ? 'browser.act.retired' : 'browser.act.no_ref', { ref: input.ref }));
  } else {
    // 名前で指した目標: その場の表の並びで数える。複数当たって nth が無ければ選ばない。印の無い（引けない）要素は押さない。
    // モデルが表で見ていない要素でもよい（番号の「見せた」の決まりは当てない。だから開発サーバーのページだけ）
    const picked = namedItem(table, named.target);
    if (picked === 'many') return refuse(guardText(language, 'browser.act.named_many', { ref: input.ref, count: table.named?.length ?? 0 }));
    if (picked === undefined) return refuse(guardText(language, 'browser.act.named_none', { ref: input.ref }));
    if (picked.pwRef === '') return refuse(guardText(language, 'browser.act.changed', { ref: input.ref }));
    item = picked;
  }
  if (item.frameUrl !== undefined && hostOf(item.frameUrl) !== hostOf(pageUrl)) return refuse(guardText(language, 'browser.act.frame', { ref: input.ref }));
  if (kind === 'type' && !TEXT_ROLES.has(item.role)) return refuse(guardText(language, 'browser.act.not_text', { ref: input.ref, role: item.role }));
  if (kind === 'select' && !SELECT_ROLES.has(item.role)) return refuse(guardText(language, 'browser.act.not_select', { ref: input.ref, role: item.role }));
  const target: ElementTarget = { ref: item.pwRef, role: item.role, name: item.name };
  const detail = await tab.page.locate(target);
  // 引き直せない（印が無い・主フレームでない）、属性が読めないものは、実行しない
  if (detail === undefined) return refuse(guardText(language, 'browser.act.changed', { ref: input.ref }));
  if (!detail.visible) return refuse(guardText(language, 'browser.act.hidden', { ref: input.ref }));
  if (!detail.enabled) return refuse(guardText(language, 'browser.act.disabled', { ref: input.ref }));
  if (kind === 'select' && detail.tag !== 'select') return refuse(guardText(language, 'browser.act.not_select', { ref: input.ref, role: item.role }));
  if (kind === 'type') {
    // カードの欄は、どの引数でも断る。暗証番号の欄は password の引数だけ（そのページの確かめは passwordRefusal）。ふつうの欄に password は入れない
    const field = fieldKind(detail, item.name);
    if (field === 'card') return refuse(guardText(language, 'browser.act.secret_field', { ref: input.ref }));
    if (input.password !== undefined && field !== 'password') return refuse(guardText(language, 'browser.act.password_not_secret', { ref: input.ref }));
    if (input.password === undefined && field === 'password') return refuse(guardText(language, 'browser.act.password_use_field', { ref: input.ref }));
  }
  if (kind === 'select' && isSecretField(detail, item.name)) return refuse(guardText(language, 'browser.act.secret_select', { ref: input.ref }));
  // 入れるは submit（Enter）のときだけ送信。押すは要素で決める。選ぶは <select> で、送信の部品ではない（change が送ろうとするのは、送信の守りが断る）
  const submits = kind === 'type' ? input.submit === true : detail.form.submits;
  return { ok: true, tab, pageUrl, item, target, detail, field: fieldKind(detail, item.name), place, submits, ...(table.shape !== undefined ? { shape: table.shape } : {}) };
}

// press（P6）の探し直し: 押す先は番号の要素でなく、いまキーボードの焦点がある要素。ページの置き場所を同じ決まりで確かめ、焦点を読んで、枠の中・秘密に見える欄なら鍵を送らない。
// read（呼び出す側が決める。開発サーバー以外）が true なら、鍵は読んだページにだけ送る: そのタブの表が、いまの URL を読んだものであること（click・type・select と同じ）。
// そのとき shape（いまの画面のまとめ）も返し、呼び出す側が 2 つ目からの step で、呼び出しの始めの画面と同じかを見る。
// 読んだ焦点の事実は、押す直前に driver がもう一度読んで比べる（判定したときと違えば押さない）。そのとき比べるページ（URL と文書の代）も、ここで読んだもの
export type InspectedPress =
  | { ok: true; tab: BrowserTab; pageUrl: string; documentId: number; place: 'public' | 'loopback'; focus: FocusFacts; read: boolean; shape?: string | undefined }
  | { ok: false; reason: string };

export async function inspectPress(api: BrowserApi, input: { tab?: string | undefined }, language: Language, denied: ReadonlySet<number>, mustHaveRead: (pageUrl: string, place: 'public' | 'loopback') => boolean): Promise<InspectedPress> {
  let tab: BrowserTab;
  try { tab = api.tab(input.tab); } catch (thrown) {
    if (thrown instanceof BrowserFailure) return refuse(thrown.text(language));
    throw thrown;
  }
  const pageUrl = tab.page.url();
  const place = placeOf(tab, api, pageUrl, denied);
  if (place === undefined) return refuse(guardText(language, 'browser.act.not_allowed_page'));
  const read = mustHaveRead(pageUrl, place);
  let shape: string | undefined;
  if (read) {
    const before = tab.table;
    if (before === undefined) return refuse(guardText(language, 'browser.act.no_table'));
    if (before.url !== pageUrl) return refuse(guardText(language, 'browser.act.stale'));
    const table = await rereadTab(tab, pageUrl, api.signal, { kind: 'check', shape: true });
    if (table === undefined) return refuse(guardText(language, 'browser.act.stale'));
    shape = table.shape;
  }
  const document = tab.page.documentId();
  const focus = await until(tab.page.focus(), api.signal);
  if (tab.page.url() !== pageUrl || tab.page.documentId() !== document) return refuse(guardText(language, 'browser.act.stale'));
  if (focus.where === 'frame') return refuse(guardText(language, 'browser.act.press_frame'));
  if (focus.where === 'element' && isSecretField(focus, focus.hint)) return refuse(guardText(language, 'browser.act.press_secret'));
  return { ok: true, tab, pageUrl, documentId: document, place, focus, read, shape };
}

// 通り方（Approach 4 の順 2〜6）。loopback: 許されたループバック（送信も判定役なし）/ submit: フォームの送信（送る）/
// listed: 聞かずに通す一覧のサイト / owner_url: 持ち主が会話・タスクに書いた URL のホスト / judge: 判定役へ
export type ActRoute = 'loopback' | 'submit' | 'listed' | 'owner_url' | 'judge';

export function actRoute(found: { place: 'public' | 'loopback'; submits: boolean; pageUrl: string }, sites: readonly string[], ownerTexts: readonly string[], devServer: boolean): ActRoute {
  if (found.place === 'loopback' && devServer) return 'loopback';
  if (found.submits) return 'submit';
  // 127.0.0.10 のようなループバックはホストの決めに残るので、一覧・持ち主の URL より前で止める
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

// 開発サーバーでないループバックのページで、ポートがこの会話・このタスクの止まった裏のコマンドのもの（判定役に回さず断る。動いている方が勝つので devServerPage のあとに見る）
export function stoppedServerText(pageUrl: string, ctx: Pick<ToolContext, 'services' | 'conversationId' | 'task' | 'parent'>, language: Language): string | undefined {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return undefined; }
  if (!isLoopbackUrl(pageUrl)) return undefined;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let stopped: StoppedPort | undefined;
  try { stopped = ctx.services?.background?.stoppedPort({ conversationId: ctx.conversationId, taskId: ctx.task?.id ?? ctx.parent?.taskId }, port); } catch { return undefined; }
  if (stopped === undefined) return undefined;
  return guardText(language, stopped.stoppedBy === 'owner' ? 'browser.act.server_stopped_owner' : 'browser.act.server_ended', { port: stopped.port, job: stopped.jobId });
}

// 暗証番号の欄に入れてよいページ（P7）: 開発サーバーのページ（devServerPage）で、そのポートで待ち受けているプロセスが、この会話・タスクの動いている裏のコマンドの入れ物（Job Object）の中にいること。
// 出力にポートが出ただけ・持ち主が書いただけでは足りない（beat が自分で起動して、いま動いている証拠にならない）。確かめられない（Windows 以外・問い合わせの失敗）ときは入れない
export async function ownDevServer(pageUrl: string, ctx: Pick<ToolContext, 'ownerText' | 'services' | 'conversationId' | 'task' | 'parent'>): Promise<boolean> {
  if (!devServerPage(pageUrl, ctx)) return false;
  let url: URL;
  try { url = new URL(pageUrl); } catch { return false; }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  try {
    return await ctx.services?.background?.ownsPort?.({ conversationId: ctx.conversationId, taskId: ctx.task?.id ?? ctx.parent?.taskId }, port) === true;
  } catch { return false; }
}

// 暗証番号を入れてよい場所かの断る文（無ければ入れてよい）。止めた開発サーバーは止めた理由、公開のページ・自分の開発サーバーでないページは「自分の開発サーバーだけ」
export async function passwordRefusal(found: Pick<Extract<Inspected, { ok: true }>, 'place' | 'pageUrl'>, ctx: Pick<ToolContext, 'ownerText' | 'services' | 'conversationId' | 'task' | 'parent'>, language: Language): Promise<string | undefined> {
  if (found.place === 'loopback' && await ownDevServer(found.pageUrl, ctx)) return undefined;
  const stopped = found.place === 'loopback' && !devServerPage(found.pageUrl, ctx) ? stoppedServerText(found.pageUrl, ctx, language) : undefined;
  return stopped ?? guardText(language, 'browser.act.password_own_only');
}

// 入れる文が API の鍵・トークンに見えるか（web_fetch と同じ見分け）
export const secretText = (kind: 'click' | 'type' | 'select', input: ActInput): boolean => kind === 'type' && sanitizeModelInputText(input.text ?? '').redaction_count > 0;

// 入れる値の形の断り: text と password はどちらか 1 つ。password が API の鍵・トークンに見えたら（本物の鍵を入れさせない）、判定役に見せずに断る
export function typedInputRefusal(kind: 'click' | 'type' | 'select', input: Pick<ActInput, 'text' | 'password'>, language: Language): string | undefined {
  if (kind !== 'type') return undefined;
  if ((input.text === undefined) === (input.password === undefined)) return guardText(language, 'browser.act.text_or_password');
  if (input.password !== undefined && sanitizeModelInputText(input.password).redaction_count > 0) return guardText(language, 'browser.act.password_key_like');
  return undefined;
}

// 持ち主が書いた文の束。読めないときは空（判定役へ行く側）
export function ownerTextsOf(ctx: Pick<ToolContext, 'ownerText'>): string[] {
  try { return ctx.ownerText?.() ?? []; } catch { return []; }
}

const flat = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
const shownName = (name: string, secrets: readonly string[]): string => { const one = redactExact(flat(name), secrets); return one.length > NAME_SHOWN ? `${one.slice(0, NAME_SHOWN)}…` : one; };

// 承認の札に出す中身と、承認のあとに比べる指紋。札に出すページの名前・URL は、この会話で入れた値（secrets）を伏せる（指紋は伏せない）
export function actPreview(kind: 'click' | 'type', input: ActInput, found: Extract<Inspected, { ok: true }>, language: Language, secrets: readonly string[] = []): { preview: NonNullable<PreCheck['preview']>; bind: string } {
  const lines = [
    guardText(language, 'browser.act.preview_target', { role: found.item.role, name: shownName(found.item.name, secrets), note: guardText(language, 'browser.act.page_name') }),
  ];
  if (kind === 'type') {
    if (input.password !== undefined) {
      // 暗証番号は値も字数も札に出さない（札を出す前に断る呼び出しだが、出る形になっても値は載せない）
      lines.push(guardText(language, 'browser.act.preview_password'));
    } else {
      const text = input.text ?? '';
      lines.push(guardText(language, 'browser.act.preview_text', { count: [...text].length }), text);
    }
    lines.push(guardText(language, input.submit === true ? 'browser.act.preview_submit' : 'browser.act.preview_no_submit'));
  }
  // 札を出したときのページ・タブ・要素。承認のあとに同じ判定をもう一度走らせて、これが変わっていたら実行しない（別のページ・別の要素に押さない）
  // 要素の番号は、同じ要素で中身も変わっていないあいだだけ生きているので、それ自体が指紋。
  // タブの番号と要素の番号は beat を起動し直すと振り直すので、起動ごとの印（instance）も入れる（起動し直す前の承認は、あとの起動では押さない）
  const bind = JSON.stringify([found.tab.instance, found.tab.id, found.pageUrl, found.item.ref, found.item.role, found.item.name]);
  return { preview: [{ path: guardText(language, 'browser.act.preview_page', { url: redactExact(found.pageUrl, secrets) }), text: lines.join('\n'), truncated: false }], bind };
}

// 道具の preCheck。ブラウザが無効・タブが無いときはブラウザを起動しない
export async function browserActCheck(kind: 'click' | 'type', input: ActInput, ctx: ToolContext): Promise<PreCheck> {
  const language = languageOf(ctx.config);
  const browser: BrowserSession | undefined = ctx.services?.browser;
  if (!ctx.config.tools.browser.enabled || browser === undefined) return { decision: 'deny', reasons: [guardText(language, 'browser.off')] };
  const grant = grantOf(ctx);
  if (grant === undefined) return { decision: 'deny', reasons: [guardText(language, 'browser.no_grant')] };
  const badInput = typedInputRefusal(kind, input, language);
  if (badInput !== undefined) return { decision: 'deny', reasons: [badInput] };
  if (kind === 'type' && (input.text ?? input.password ?? '').length > TYPE_TEXT_MAX) return { decision: 'deny', reasons: [guardText(language, 'browser.act.too_long', { max: TYPE_TEXT_MAX })] };
  if (browser.tabCount(ctx.conversationId) === 0) {
    const failure = input.tab === undefined ? new BrowserFailure('no_tab', 'browser.no_tabs') : new BrowserFailure('no_tab', 'browser.no_tab', { tab: input.tab });
    return { decision: 'deny', reasons: [failure.text(language)] };
  }
  try {
    return await browser.run({ grant, signal: ctx.signal }, async api => {
      const found = await inspectAct(api, kind, input, language, browser.loopbackDenied());
      if (!found.ok) return { decision: 'deny', reasons: [found.reason] } satisfies PreCheck;
      const { preview, bind } = actPreview(kind, input, found, language, browser.secretsFor(ctx.conversationId));
      if (kind === 'type' && input.password !== undefined) {
        // 暗証番号は、自分で起動して動いている開発サーバーだけ。通すときも、聞く形（方針の ask・フックの ask）になったら断る鍵（web.password_input）を付け、値を判定役・Pending に回さない
        const refused = await passwordRefusal(found, ctx, language);
        if (refused !== undefined) return { decision: 'deny', reasons: [refused] } satisfies PreCheck;
        return { decision: 'allow', reasons: [guardText(language, 'web.password_input')], reasonKeys: ['web.password_input'], bind, fetched: true } satisfies PreCheck;
      }
      const devServer = found.place === 'loopback' && devServerPage(found.pageUrl, ctx);
      const stopped = found.place === 'loopback' && !devServer ? stoppedServerText(found.pageUrl, ctx, language) : undefined;
      if (stopped !== undefined) return { decision: 'deny', reasons: [stopped] } satisfies PreCheck;
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
