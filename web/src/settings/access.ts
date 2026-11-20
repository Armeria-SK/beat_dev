import { allowEntryRunsCode } from '../../../src/tools/hooks/listed-commands.ts';
import { DEFAULT_SEARCH_ENGINES } from '../../../src/shared/search-engines.ts';
import { defaultPolicy, isLooser, isPolicyable, isToolPolicy, type ToolPolicy } from '../../../src/tools/tool-policy.ts';
import { deepEqual } from './merge.ts';
import type { Config } from './model.ts';
import { foldersFromConfig, wideningChanges, type Widening } from '../skills-meta.ts';

// 設定の保存で、beat が触れられる範囲・動かせるもの・外から届く範囲が広がる変更を、そのまま並べるための部分。
// フォルダ（触れないパスを外す・フォルダを足す・読み書きにする）は、スキル・ツールの画面と同じ `wideningChanges` をそのまま使う。
// 狭くなる変更や、広がりに関わらない変更は含めない。

export type HookStage = 'preToolUse' | 'postToolUse';
export interface HookSummary { matcher: string; command: string[] }

export type Access =
  | Widening
  | { kind: 'shell-enabled' }
  // runsCode: 項目のとおりのコマンドは一覧に無いので、足すと beat も書き換えられるコード（スクリプト・scripts・テストなど）を確かめずに動かすことになる
  | { kind: 'shell-allow-added'; command: string; runsCode: boolean }
  | { kind: 'shell-ask-removed'; command: string }
  | { kind: 'shell-deny-removed'; command: string }
  | { kind: 'shell-env-added'; name: string }
  | { kind: 'outside-loosened' }
  | { kind: 'web-fetch-on' }
  | { kind: 'web-search-on' }
  // 検索の問いを送る先（tools.web.engines）を足す。外す・並べ替えるだけなら数えない
  | { kind: 'web-search-engine-added'; engine: string }
  | { kind: 'judge-off' }
  | { kind: 'skills-auto-register' }
  | { kind: 'hook-added'; stage: HookStage; hook: HookSummary }
  | { kind: 'hook-edited'; stage: HookStage; hook: HookSummary }
  | { kind: 'hook-removed'; stage: HookStage; hook: HookSummary }
  | { kind: 'hook-disabled'; stage: HookStage; hook: HookSummary }
  | { kind: 'origin-added'; origin: string }
  | { kind: 'login-added'; login: string }
  | { kind: 'logins-cleared' }
  | { kind: 'host-exposed'; host: string }
  | { kind: 'provider-url'; id: string; url: string }
  | { kind: 'provider-key'; id: string; env: string }
  // 画面で入れる鍵を、この PC の外のアドレスへ送る
  | { kind: 'provider-key-send'; id: string; url: string }
  // 道具ごとの方針を緩める（止める → 承認を求める / 承認なし、承認を求める → 承認なし）
  | { kind: 'tool-policy-loosened'; tool: string; from: ToolPolicy; to: ToolPolicy }
  // 外への通知（webhook）: 送り先を足す・変える / 本文も送る / 送る種類を増やす / 止めていたものを動かす / 通知の中のリンクの宛先を決める
  | { kind: 'notify-channel-added'; id: string }
  | { kind: 'notify-channel-target'; id: string }
  | { kind: 'notify-channel-body'; id: string }
  | { kind: 'notify-channel-kinds'; id: string; kinds: string[] }
  | { kind: 'notify-channel-enabled'; id: string }
  | { kind: 'notify-public-url'; url: string }
  // 外の MCP サーバー: 足す / 宛先（プログラム・作業フォルダ・URL）を変える / 渡す欄（環境変数・見出し）を足す・変える / 秘密の値を入れる / 止めていたものを動かす
  | { kind: 'mcp-server-added'; id: string; transport: string; target: string }
  | { kind: 'mcp-server-target'; id: string; target: string }
  | { kind: 'mcp-server-env'; id: string; names: string[] }
  | { kind: 'mcp-server-secret'; id: string; name: string }
  | { kind: 'mcp-server-enabled'; id: string }
  // 道具: 登録する道具を足す / 止めていた道具を動かす / 申告（読むだけ・送らない・消さない）を緩める
  | { kind: 'mcp-tool-added'; id: string; tool: string }
  | { kind: 'mcp-tool-enabled'; id: string; tool: string }
  | { kind: 'mcp-tool-loosened'; id: string; tool: string }
  // 歯止めの数（notify.limits / mcp.limits）を、緩む向きに変える
  | { kind: 'limit-raised'; key: string; from: number; to: number }
  // ブラウザ（AU-6）: 使えるようにする / 操作（押す・入れる）してよいサイトを足す / 「そのホストだけ」を「サブドメインも」に広げる
  | { kind: 'browser-enabled' }
  | { kind: 'browser-site-added'; site: string }
  | { kind: 'browser-site-widened'; site: string }
| { kind: 'browser-executable' };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);
const added = (before: readonly string[], after: readonly string[]): string[] => after.filter(x => !before.includes(x));
const removed = (before: readonly string[], after: readonly string[]): string[] => before.filter(x => !after.includes(x));
const obj = (value: unknown): Record<string, any> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : {});

// アドレス（URL か、host の名前）の host の部分。読み取れなければ、そのままの文字（内向きと見分けられないので、外向きとして扱う）。
function hostOf(address: unknown): string | null {
  if (typeof address !== 'string' || address.trim() === '') return null;
  const text = address.trim();
  try { return new URL(text).hostname.replace(/^\[|\]$/gu, '').toLowerCase(); } catch { return text.replace(/^\[|\]$/gu, '').toLowerCase(); }
}
// この PC の中だけに届くアドレス（127.x.x.x・localhost・::1）。同じ LAN の 192.168.x.x なども、この PC の外として数える。
const isLoopbackHost = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);

// プロバイダが使うキーの環境変数の名前（Anthropic で書いていなければ ANTHROPIC_API_KEY）。
const keyEnvOf = (provider: Record<string, any>): string | undefined => (typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== '' ? provider.apiKeyEnv : provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined);

// プロバイダの外向きの広がり: 送り先（baseUrl）が、この PC の外のアドレスに変わる / 足される・使うキー（apiKeyEnv）が増える / 変わる。
// 送り先を変えて同じキーを使わせると、キーがその送り先へ出ていくので、両方を並べる。名前だけを付け替えた（送り先もキーも同じ）ものは数えない。
function providerChanges(before: Config, after: Config): Access[] {
  const list = (config: Config): Array<Record<string, any>> => (Array.isArray(config.providers) ? config.providers.filter((x): x is Record<string, any> => typeof x === 'object' && x !== null) : []);
  const old = list(before);
  const kept = new Set(list(after).map(p => p.id));
  const out: Access[] = [];
  for (const provider of list(after)) {
    const id = String(provider.id ?? '');
    const host = hostOf(provider.baseUrl);
    const env = keyEnvOf(provider);
    const same = old.find(p => p.id === provider.id)
      ?? old.find(p => !kept.has(p.id) && hostOf(p.baseUrl) === host && keyEnvOf(p) === env && p.kind === provider.kind);
    if (host !== null && !isLoopbackHost(host) && host !== (same ? hostOf(same.baseUrl) : null)) out.push({ kind: 'provider-url', id, url: String(provider.baseUrl) });
    if (env !== undefined && env !== (same ? keyEnvOf(same) : undefined)) out.push({ kind: 'provider-key', id, env });
  }
  return out;
}

// プロバイダに API キーを入れる（設定の保存とは別の操作）ときの確かめ。鍵はそのプロバイダの送り先（baseUrl）へ送られるので、この PC の外のアドレスなら並べて確かめる。
// baseUrl を書いていない Anthropic の既定の宛先は、鍵を入れる目的そのものなので確かめない。読めないアドレスは外として扱う
export function keyEntryAccess(provider: Record<string, any>): Access[] {
  const host = hostOf(provider.baseUrl);
  if (host === null || isLoopbackHost(host)) return [];
  return [{ kind: 'provider-key-send', id: String(provider.id ?? ''), url: String(provider.baseUrl) }];
}

// フックは id が無いので、同じ中身のものは変わっていないとみなし、残りを前から順に組にして「編集」、余りを「追加」「削除」とする。
// 削除は、使う前（preToolUse = 実行を止められるほう）だけを広がりとして数える。
function hookChanges(before: Config, after: Config, stage: HookStage): Access[] {
  const rawOf = (config: Config) => (Array.isArray(obj(obj(config.tools).hooks)[stage]) ? obj(obj(config.tools).hooks)[stage] as unknown[] : []);
  const oldHooks = [...rawOf(before)];
  const changed: unknown[] = [];
  for (const hook of rawOf(after)) {
    const same = oldHooks.findIndex(h => deepEqual(h, hook));
    if (same >= 0) oldHooks.splice(same, 1); else changed.push(hook);
  }
  const summary = (hook: unknown): HookSummary => ({ matcher: String(obj(hook).matcher ?? ''), command: typeof obj(hook).builtin === 'string' ? [String(obj(hook).builtin)] : strings(obj(hook).command) });
  const on = (hook: unknown): boolean => obj(hook).enabled !== false;
  const body = (hook: unknown): unknown => { const { enabled: _enabled, ...rest } = obj(hook); return rest; };
  const guardOff = (was: unknown, now: unknown): boolean => stage === 'preToolUse' && on(was) && !on(now);
  const covers = (was: unknown, now: unknown): boolean => { const kept = new Set(strings(now)); return strings(was).every(p => kept.has(p)); };
  const onlyProtectsMore = (was: unknown, now: unknown): boolean => {
    const a = obj(was);
    const b = obj(now);
    return a.builtin === 'protect-files' && !(on(was) && !on(now)) && covers(a.always, b.always) && covers(a.afterOutside, b.afterOutside)
      && deepEqual(body({ ...b, always: a.always, afterOutside: a.afterOutside }), body(was));
  };
  const out: Access[] = [];
  const newHooks: unknown[] = [];
  for (const hook of changed) {
    const same = oldHooks.findIndex(h => deepEqual(body(h), body(hook)));
    const stronger = same < 0 ? oldHooks.findIndex(h => onlyProtectsMore(h, hook)) : -1;
    if (stronger >= 0) { oldHooks.splice(stronger, 1); continue; }
    if (same < 0) { newHooks.push(hook); continue; }
    if (guardOff(oldHooks[same], hook)) out.push({ kind: 'hook-disabled', stage, hook: summary(hook) });
    oldHooks.splice(same, 1);
  }
  newHooks.forEach((hook, i) => {
    out.push({ kind: i < oldHooks.length ? 'hook-edited' : 'hook-added', stage, hook: summary(hook) });
  });
  // 書き換えたフックは、どれがどれだったかを決められない。オンだった「使う前」のフックが残っていて、書き換えたあとにオフのものがあれば、オフにしたものとして並べる
  if (stage === 'preToolUse' && oldHooks.some(on)) {
    for (const hook of newHooks) if (!on(hook)) out.push({ kind: 'hook-disabled', stage, hook: summary(hook) });
  }
  if (stage === 'preToolUse') for (const hook of oldHooks.slice(newHooks.length)) out.push({ kind: 'hook-removed', stage, hook: summary(hook) });
  return out;
}

// 道具ごとの方針の変更のうち、緩めるもの。方針を持てない道具（サーバーが無視する）と、読めない値（allow 扱い）は、サーバーの読み方に合わせる
export function toolPolicyLoosened(tool: string, from: unknown, to: unknown): Access | null {
  if (!isPolicyable(tool)) return null;
  const before: ToolPolicy = isToolPolicy(from) ? from : defaultPolicy(tool);
  const after: ToolPolicy = isToolPolicy(to) ? to : defaultPolicy(tool);
  return isLooser(before, after) ? { kind: 'tool-policy-loosened', tool, from: before, to: after } : null;
}

function toolPolicyChanges(before: Config, after: Config): Access[] {
  const was = obj(obj(before.tools).policies);
  const now = obj(obj(after.tools).policies);
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
  return names.flatMap(name => toolPolicyLoosened(name, was[name], now[name]) ?? []);
}

// 通知の送り先の変更のうち、広がるもの。ID で突き合わせる。送り先は、URL と token の環境変数名・種類（kind）が変わったときに数える（値そのものは設定に無い）
function notifyChanges(before: Config, after: Config): Access[] {
  const list = (config: Config): Array<Record<string, any>> => {
    const channels = obj(config.notify).channels;
    return Array.isArray(channels) ? channels.filter((x): x is Record<string, any> => typeof x === 'object' && x !== null) : [];
  };
  const old = new Map(list(before).map(c => [String(c.id), c]));
  const out: Access[] = [];
  for (const channel of list(after)) {
    const id = String(channel.id ?? '');
    const was = old.get(id);
    if (!was) {
      // 足すときも、本文を送る・送る種類は並べて見せる（足した先へ何が行くかを確かめられるように）
      out.push({ kind: 'notify-channel-added', id });
      if (channel.includeBody === true) out.push({ kind: 'notify-channel-body', id });
      const first = strings(channel.kinds);
      if (first.length > 0) out.push({ kind: 'notify-channel-kinds', id, kinds: first });
      continue;
    }
    if (channel.urlEnv !== was.urlEnv || channel.tokenEnv !== was.tokenEnv || channel.kind !== was.kind) out.push({ kind: 'notify-channel-target', id });
    if ((was.includeBody ?? false) === false && (channel.includeBody ?? false) === true) out.push({ kind: 'notify-channel-body', id });
    const kinds = added(strings(was.kinds), strings(channel.kinds));
    if (kinds.length > 0) out.push({ kind: 'notify-channel-kinds', id, kinds });
    if ((was.enabled ?? true) === false && (channel.enabled ?? true) === true) out.push({ kind: 'notify-channel-enabled', id });
  }
  const url = obj(after.notify).publicBaseUrl;
  if (typeof url === 'string' && url !== '' && url !== obj(before.notify).publicBaseUrl) out.push({ kind: 'notify-public-url', url });
  return out;
}

// MCP サーバーの変更のうち、広がるもの。ID で突き合わせる。値（秘密）は設定に無いので、環境変数の名前の参照が変わったかで見る
// 画面に出す「起動する先」。作業フォルダがあれば添える
const mcpTarget = (server: Record<string, any>): string => {
  if (server.transport === 'http') return String(server.url ?? '');
  const cwd = typeof server.cwd === 'string' && server.cwd !== '' ? ` (cwd: ${server.cwd})` : '';
  return strings(server.command).join(' ') + cwd;
};
// 同じ先かどうかの比べ。引数の区切りが変わる（["a b"] と ["a","b"]）のも違いとして見る
const mcpTargetKey = (server: Record<string, any>): string => JSON.stringify([server.transport ?? 'stdio', server.url ?? '', strings(server.command), server.cwd ?? '']);
function mcpChanges(before: Config, after: Config): Access[] {
  const list = (config: Config): Array<Record<string, any>> => {
    const servers = obj(config.mcp).servers;
    return Array.isArray(servers) ? servers.filter((x): x is Record<string, any> => typeof x === 'object' && x !== null) : [];
  };
  const old = new Map(list(before).map(s => [String(s.id), s]));
  const out: Access[] = [];
  for (const server of list(after)) {
    const id = String(server.id ?? '');
    const was = old.get(id);
    if (!was) out.push({ kind: 'mcp-server-added', id, transport: String(server.transport ?? 'stdio'), target: mcpTarget(server) });
    else if (mcpTargetKey(server) !== mcpTargetKey(was)) out.push({ kind: 'mcp-server-target', id, target: mcpTarget(server) });
    // 渡す欄（子の環境変数・HTTP の見出し）。足した・参照先が変わった名前を並べる
    const names: string[] = [];
    for (const field of ['env', 'headers']) {
      const now = obj(server[field]);
      const prev = obj(was?.[field]);
      for (const name of Object.keys(now).sort()) if (prev[name] !== now[name]) names.push(name);
    }
    if (names.length > 0) out.push({ kind: 'mcp-server-env', id, names });
    if (was && (was.enabled ?? true) === false && (server.enabled ?? true) === true) out.push({ kind: 'mcp-server-enabled', id });
    const prevTools = obj(was?.tools);
    const tools = obj(server.tools);
    for (const tool of Object.keys(tools).sort()) {
      const entry = obj(tools[tool]);
      const had = Object.hasOwn(prevTools, tool);
      const prev = obj(prevTools[tool]);
      const on = entry.enabled !== false;
      if (on && !had) out.push({ kind: 'mcp-tool-added', id, tool });
      else if (on && prev.enabled === false) out.push({ kind: 'mcp-tool-enabled', id, tool });
      // 申告の緩み。申告が無い道具は「外へ出る・送りうる」として確かめられるので、そこから申告のある側へ動くのも緩み
      const effectLoosened = entry.effect === 'read' && prev.effect !== 'read';
      const sendsLoosened = entry.sends === false && prev.sends !== false;
      const removesLoosened = prev.removes === true && entry.removes !== true;
      if (effectLoosened || sendsLoosened || removesLoosened) out.push({ kind: 'mcp-tool-loosened', id, tool });
    }
  }
  return out;
}

// limits の数が増える = 歯止めが緩む（failsBeforeAlert も、増えると警告が遅れるので緩む向き）。両方に数があるものだけ比べる
function limitChanges(before: Config, after: Config): Access[] {
  const out: Access[] = [];
  const roots: Array<[string, (config: Config) => unknown]> = [
    ['notify', config => config.notify],
    ['mcp', config => config.mcp],
    ['tools.browser', config => obj(config.tools).browser],
  ];
  for (const [root, pick] of roots) {
    const was = obj(obj(pick(before)).limits);
    const now = obj(obj(pick(after)).limits);
    for (const name of Object.keys(now).sort()) {
      if (typeof was[name] === 'number' && typeof now[name] === 'number' && now[name] > was[name]) out.push({ kind: 'limit-raised', key: `${root}.${name}`, from: was[name], to: now[name] });
    }
  }
  return out;
}

// ブラウザ: 無効 → 有効、操作してよいサイトの追加。「=ホスト」（そのホストだけ）が外れて「ホスト」（サブドメインも）が入るのは、広げる変更として別に出す。
// サイトを消す・「ホスト」を「=ホスト」に狭める・無効にする・見えるブラウザにするのは、広がりではない
function browserChanges(before: Config, after: Config): Access[] {
  const bb = obj(obj(before.tools).browser);
  const ab = obj(obj(after.tools).browser);
  const out: Access[] = [];
  if ((bb.enabled ?? false) === false && (ab.enabled ?? false) === true) out.push({ kind: 'browser-enabled' });
  const was = strings(bb.sites);
  for (const site of added(was, strings(ab.sites))) {
    // 前から入っている「ホスト」が、新しい「=ホスト」をすでに含んでいる（狭めただけ）なら、広がりではない
    if (site.startsWith('=') && was.includes(site.slice(1))) continue;
    out.push(!site.startsWith('=') && was.includes(`=${site}`) ? { kind: 'browser-site-widened', site } : { kind: 'browser-site-added', site });
  }
  // 起動するブラウザの実行ファイル: channel を path にする、executablePath を足す・変える。beat が起動する実行ファイルを持ち主以外の指定で替えられるので、確かめに出す。
  // channel を auto / chrome に戻す・executablePath を空にするのは、広がりではない（1 回の変更で 1 行）
  const was2 = typeof bb.executablePath === 'string' ? bb.executablePath : '';
  const now2 = typeof ab.executablePath === 'string' ? ab.executablePath : '';
  const becamePath = ab.channel === 'path' && bb.channel !== 'path';
  if (becamePath || (now2 !== '' && now2 !== was2)) out.push({ kind: 'browser-executable' });
  return out;
}

// MCP サーバーの秘密（子の環境変数・HTTP の見出し）の値を入れる・変える（設定の保存とは別の操作）ときの確かめ。値は、そのサーバーへ渡される
export function mcpSecretAccess(slot: { id: string; kind: 'env' | 'header'; name: string }, config: Config): Access[] {
  const servers = obj(config.mcp).servers;
  return Array.isArray(servers) && servers.some(s => obj(s).id === slot.id) ? [{ kind: 'mcp-server-secret', id: slot.id, name: slot.name }] : [];
}

export function accessWidening(before: Config, after: Config): Access[] {
  const out: Access[] = [...wideningChanges(foldersFromConfig(before), foldersFromConfig(after))];
  const bt = obj(before.tools);
  const at = obj(after.tools);
  const bs = obj(bt.shell);
  const as = obj(at.shell);

  if ((bs.enabled ?? true) === false && (as.enabled ?? true) === true) out.push({ kind: 'shell-enabled' });
  for (const command of added(strings(bs.allow), strings(as.allow))) out.push({ kind: 'shell-allow-added', command, runsCode: allowEntryRunsCode(command) });
  for (const command of removed(strings(bs.ask), strings(as.ask))) out.push({ kind: 'shell-ask-removed', command });
  for (const command of removed(strings(bs.deny), strings(as.deny))) out.push({ kind: 'shell-deny-removed', command });
  for (const name of added(strings(bs.envAllow), strings(as.envAllow))) out.push({ kind: 'shell-env-added', name });
  if ((bt.outsideRoots ?? 'ask') === 'deny' && (at.outsideRoots ?? 'ask') === 'ask') out.push({ kind: 'outside-loosened' });
  if ((obj(bt.web).fetch ?? true) === false && (obj(at.web).fetch ?? true) === true) out.push({ kind: 'web-fetch-on' });
  if ((obj(bt.web).search ?? 'auto') === 'off' && (obj(at.web).search ?? 'auto') !== 'off') out.push({ kind: 'web-search-on' });
  const engines = (web: unknown): string[] => (Array.isArray(obj(web).engines) ? strings(obj(web).engines) : [...DEFAULT_SEARCH_ENGINES]);
  for (const engine of added(engines(bt.web), engines(at.web))) out.push({ kind: 'web-search-engine-added', engine });
  if (obj(before.skills).askBeforeRegister !== false && obj(after.skills).askBeforeRegister === false) out.push({ kind: 'skills-auto-register' });
  if (obj(before.routing).judgeMode !== 'off' && obj(after.routing).judgeMode === 'off') out.push({ kind: 'judge-off' });
  out.push(...hookChanges(before, after, 'preToolUse'), ...hookChanges(before, after, 'postToolUse'));
  out.push(...providerChanges(before, after));
  out.push(...toolPolicyChanges(before, after));
  out.push(...notifyChanges(before, after), ...mcpChanges(before, after), ...browserChanges(before, after), ...limitChanges(before, after));

  const bv = obj(before.server);
  const av = obj(after.server);
  for (const origin of added(strings(bv.origins), strings(av.origins))) out.push({ kind: 'origin-added', origin });
  const beforeLogins = strings(bv.tailscaleLogins);
  const afterLogins = strings(av.tailscaleLogins);
  if (beforeLogins.length > 0 && afterLogins.length === 0) out.push({ kind: 'logins-cleared' });
  else if (beforeLogins.length > 0) for (const login of added(beforeLogins, afterLogins)) out.push({ kind: 'login-added', login }); // 空のときは「同じ tailnet の誰でも」なので、足すと狭くなる
  const host = String(av.host ?? '127.0.0.1');
  if (host !== String(bv.host ?? '127.0.0.1') && !isLoopbackHost(hostOf(host) ?? host)) out.push({ kind: 'host-exposed', host });
  return out;
}

// 同じ確認を、保存し直すときに数え直して見比べるための印。
export const accessKey = (items: readonly Access[]): string => JSON.stringify(items);

