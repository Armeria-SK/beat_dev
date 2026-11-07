import type { App } from '../app.ts';
import type { AppConfig, NotifyChannelConfig } from '../config/schema.ts';
import { ConfigError, parseConfig } from '../config/store.ts';
import { envFileValue, EnvFileError, removeEnvValue, setEnvValue } from '../env-file.ts';
import { isAutoNotifyEnv, notifyEnvName, secretProblem, type NotifySecretField } from '../shared/secret-slots.ts';
import { takenKeyEnvs, isSecretEnvName, MAX_KEY_CHARS } from '../shared/provider-key.ts';
import { configProblem, HttpProblem, problem, readJson, requireObject, type Router, sendJson } from './http.ts';

// 外の送り先（webhook）の管理（画面専用。モデルの道具には足さない）。URL・token は .env にだけ書き、応答・ログ・DB・SSE のどこにも出さない（返すのは「入っているか」だけ）。
// 環境変数の名前はサーバーが決める（クライアントからは受け取らない）。ほかの書き込みと同じ Host・Origin・Sec-Fetch-Site の確かめを通った要求だけが届く。
// 設定と .env を変えるところは、await を挟まずに「検査 → .env → 設定の反映」と進める（二つの要求が、古い設定を読んだまま上書きし合わないように）

function envProblem(error: unknown): never {
  if (error instanceof EnvFileError && error.reason === 'value') throw problem(400, 'invalid_field', 'notify_secret_unsupported', { field: 'value' });
  if (error instanceof EnvFileError) throw problem(409, 'env_unwritable', 'notify_env_unwritable', { params: { reason: error.message } });
  throw error;
}

export function registerNotifyRoutes(router: Router, app: App): void {
  const channelOf = (id: string): { config: AppConfig; channel: NotifyChannelConfig } => {
    const config = app.config();
    const channel = config.notify.channels.find(c => c.id === id);
    if (!channel) throw problem(404, 'not_found', 'notify_channel_missing', { params: { id } });
    return { config, channel };
  };
  const view = () => ({ channels: app.channels.status(), limits: app.config().notify.limits, publicBaseUrl: app.config().notify.publicBaseUrl });
  const fromOs = (name: string): boolean => {
    const value = app.env[name]?.trim();
    return Boolean(value) && value !== envFileValue(app.paths.env, name)?.trim();
  };
  // 設定の検査（通らなければ 400）。通ったものを返す
  const checked = (next: AppConfig): AppConfig => {
    try { return parseConfig(structuredClone(next)); }
    catch (error) { if (error instanceof ConfigError) throw configProblem(error); throw error; }
  };
  // .env の変更を、設定の反映が失敗したときに元へ戻せるようにする。changes: 名前 → 新しい値（undefined は消す）
  const applyWithEnv = async (next: AppConfig, changes: ReadonlyMap<string, string | undefined>): Promise<void> => {
    const before = new Map<string, { file: string | undefined; run: string | undefined }>();
    const restore = (): void => {
      for (const [name, prev] of before) {
        try { if (prev.file === undefined) removeEnvValue(app.paths.env, name); else setEnvValue(app.paths.env, name, prev.file); } catch { /* 戻せなくても、元の失敗を返す */ }
        if (prev.run === undefined) delete app.env[name]; else app.env[name] = prev.run;
      }
    };
    try {
      for (const [name, value] of changes) {
        before.set(name, { file: envFileValue(app.paths.env, name), run: app.env[name] });
        if (value === undefined) { removeEnvValue(app.paths.env, name); delete app.env[name]; }
        else { setEnvValue(app.paths.env, name, value); app.env[name] = value; }
      }
    } catch (error) { restore(); envProblem(error); }
    try { await app.applyConfig(next, { probe: false }); }
    catch (error) {
      restore();
      if (error instanceof ConfigError) throw configProblem(error);
      throw error;
    }
  };
  const secretValue = (body: Record<string, unknown>, field: NotifySecretField, key = 'value'): string => {
    const value = body[key];
    const bad = typeof value === 'string' ? secretProblem(field, value) : 'empty';
    if (typeof value !== 'string' || bad) {
      const code = ({ empty: 'notify_secret_empty', chars: 'notify_secret_chars', padded: 'notify_secret_padded', too_long: 'notify_secret_too_long', bad_url: 'notify_bad_url' } as const)[bad ?? 'empty'];
      throw problem(400, 'invalid_field', code, { field: key, ...(bad === 'too_long' ? { params: { max: MAX_KEY_CHARS } } : {}) });
    }
    return value;
  };
  // 秘密を入れる環境変数の名前は、鍵の名前（KEY・TOKEN・SECRET…）だけ。ほかの欄・プロバイダの鍵と重ならないこと
  const guardEnvName = (config: AppConfig, name: string, own: { id: string; field: 'urlEnv' | 'tokenEnv' }): void => {
    if (!isSecretEnvName(name)) throw problem(409, 'conflict', 'notify_env_unsafe', { params: { env: name } });
    const taken = takenKeyEnvs(config.providers, '');
    taken.add('ANTHROPIC_API_KEY');
    const clash = taken.has(name) || config.notify.channels.some(c => (c.id !== own.id && (c.urlEnv === name || c.tokenEnv === name)) || (c.id === own.id && own.field === 'urlEnv' && c.tokenEnv === name) || (c.id === own.id && own.field === 'tokenEnv' && c.urlEnv === name));
    if (clash) throw problem(409, 'conflict', 'notify_env_conflict', { params: { env: name } });
  };
  const stringList = (value: unknown, field: string): NotifyChannelConfig['kinds'] => {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw problem(400, 'invalid_field', 'invalid_body', { field });
    return value as NotifyChannelConfig['kinds'];
  };
  const boolField = (value: unknown, field: string): boolean => {
    if (typeof value !== 'boolean') throw problem(400, 'invalid_field', 'invalid_body', { field });
    return value;
  };

  router.add('GET', '/api/notify/channels', ({ res }) => sendJson(res, 200, view()));

  router.add('POST', '/api/notify/channels', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const id = body.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/u.test(id)) throw problem(400, 'invalid_field', 'notify_bad_id', { field: 'id' });
    const url = secretValue(body, 'url', 'url');
    const token = body.token === undefined || body.token === '' ? undefined : secretValue(body, 'token', 'token');
    // ここから反映し終えるまで await を挟まない
    const config = app.config();
    if (config.notify.channels.some(c => c.id === id)) throw problem(409, 'conflict', 'notify_channel_exists', { params: { id } });
    if (config.notify.channels.length >= config.notify.limits.maxChannels) throw problem(409, 'conflict', 'notify_channel_limit', { params: { max: config.notify.limits.maxChannels } });
    const urlEnv = notifyEnvName(id, 'url');
    const tokenEnv = token === undefined ? undefined : notifyEnvName(id, 'token');
    guardEnvName(config, urlEnv, { id, field: 'urlEnv' });
    if (tokenEnv) guardEnvName(config, tokenEnv, { id, field: 'tokenEnv' });
    const channel: Record<string, unknown> = { id, kind: 'webhook', urlEnv, ...(tokenEnv ? { tokenEnv } : {}) };
    if (body.kinds !== undefined) channel.kinds = stringList(body.kinds, 'kinds');
    if (body.includeBody !== undefined) channel.includeBody = boolField(body.includeBody, 'includeBody');
    const next = checked({ ...config, notify: { ...config.notify, channels: [...config.notify.channels, channel as unknown as NotifyChannelConfig] } });
    await applyWithEnv(next, new Map<string, string | undefined>([[urlEnv, url], ...(tokenEnv ? [[tokenEnv, token] as [string, string | undefined]] : [])]));
    sendJson(res, 201, view());
  });

  router.add('PATCH', '/api/notify/channels/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const { config } = channelOf(params[0]!);
    const patch: Partial<Pick<NotifyChannelConfig, 'enabled' | 'kinds' | 'includeBody'>> = {};
    if (body.enabled !== undefined) patch.enabled = boolField(body.enabled, 'enabled');
    if (body.kinds !== undefined) patch.kinds = stringList(body.kinds, 'kinds');
    if (body.includeBody !== undefined) patch.includeBody = boolField(body.includeBody, 'includeBody');
    const next = checked({ ...config, notify: { ...config.notify, channels: config.notify.channels.map(c => (c.id === params[0] ? { ...c, ...patch } : c)) } });
    await applyWithEnv(next, new Map());
    sendJson(res, 200, view());
  });

  router.add('DELETE', '/api/notify/channels/:id', async ({ res, params }) => {
    const { config, channel } = channelOf(params[0]!);
    const next = checked({ ...config, notify: { ...config.notify, channels: config.notify.channels.filter(c => c.id !== channel.id) } });
    await applyWithEnv(next, new Map());
    // 自動で付けた名前で、ほかの欄から指されていない秘密だけを .env から消す（持ち主が自分で書いた名前は残す）
    const stillUsed = (name: string): boolean => next.notify.channels.some(c => c.urlEnv === name || c.tokenEnv === name) || next.providers.some(p => p.apiKeyEnv === name);
    const owned: string[] = [];
    if (isAutoNotifyEnv(channel.id, 'url', channel.urlEnv)) owned.push(channel.urlEnv);
    if (channel.tokenEnv && isAutoNotifyEnv(channel.id, 'token', channel.tokenEnv)) owned.push(channel.tokenEnv);
    for (const name of owned) {
      if (stillUsed(name)) continue;
      const osValue = fromOs(name);
      try { removeEnvValue(app.paths.env, name); if (!osValue) delete app.env[name]; }
      catch { app.log(`[WARN] 通知の送り先「${channel.id}」の秘密（${name}）を .env から消せませんでした。.env を直接開いて消してください`); }
    }
    app.kv.delete(`notify:channel:${channel.id}`);
    sendJson(res, 200, view());
  });

  router.add('PUT', '/api/notify/channels/:id/secrets/:field', async ({ req, res, params }) => {
    const field = params[1];
    if (field !== 'url' && field !== 'token') throw problem(404, 'not_found', 'notify_channel_missing', { params: { id: params[0]! } });
    const body = requireObject(await readJson(req));
    const value = secretValue(body, field);
    // 環境変数の名前は、クライアントから受け取らない（body の name などは無視する）
    const { config, channel } = channelOf(params[0]!);
    if (field === 'url') {
      if (!isAutoNotifyEnv(channel.id, 'url', channel.urlEnv)) throw problem(409, 'conflict', 'notify_env_manual', { params: { env: channel.urlEnv } });
      guardEnvName(config, channel.urlEnv, { id: channel.id, field: 'urlEnv' });
      await applyWithEnv(config, new Map([[channel.urlEnv, value]]));
      sendJson(res, 200, { set: true });
      return;
    }
    const tokenEnv = channel.tokenEnv ?? notifyEnvName(channel.id, 'token');
    if (!isAutoNotifyEnv(channel.id, 'token', tokenEnv)) throw problem(409, 'conflict', 'notify_env_manual', { params: { env: tokenEnv } });
    guardEnvName(config, tokenEnv, { id: channel.id, field: 'tokenEnv' });
    const next = channel.tokenEnv ? config : checked({ ...config, notify: { ...config.notify, channels: config.notify.channels.map(c => (c.id === channel.id ? { ...c, tokenEnv } : c)) } });
    await applyWithEnv(next, new Map([[tokenEnv, value]]));
    sendJson(res, 200, { set: true });
  });

  router.add('DELETE', '/api/notify/channels/:id/secrets/:field', async ({ res, params }) => {
    if (params[1] === 'url') throw problem(409, 'conflict', 'notify_url_required');
    if (params[1] !== 'token') throw problem(404, 'not_found', 'notify_channel_missing', { params: { id: params[0]! } });
    const { config, channel } = channelOf(params[0]!);
    const tokenEnv = channel.tokenEnv;
    if (!tokenEnv) { sendJson(res, 200, { set: false }); return; }
    const next = checked({ ...config, notify: { ...config.notify, channels: config.notify.channels.map(c => { if (c.id !== channel.id) return c; const { tokenEnv: _drop, ...rest } = c; return rest; }) } });
    await applyWithEnv(next, new Map());
    let state: { set: boolean; source?: 'os' } = { set: false };
    if (isAutoNotifyEnv(channel.id, 'token', tokenEnv)) {
      // OS の環境変数から来た値は、ここでは消せない（消したと言わない）。判定は .env から消す前に行う
      const osValue = fromOs(tokenEnv);
      try { removeEnvValue(app.paths.env, tokenEnv); } catch (error) { envProblem(error); }
      if (osValue) state = { set: true, source: 'os' }; else delete app.env[tokenEnv];
    }
    sendJson(res, 200, state);
  });

  router.add('POST', '/api/notify/channels/:id/test', async ({ res, params }) => {
    const result = await app.channels.test(params[0]!);
    if (!result) throw problem(404, 'not_found', 'notify_channel_missing', { params: { id: params[0]! } });
    sendJson(res, 200, result);
  });

  router.add('PATCH', '/api/notify', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const config = app.config();
    const notify = { ...config.notify };
    if (body.publicBaseUrl !== undefined) {
      if (typeof body.publicBaseUrl !== 'string') throw problem(400, 'invalid_field', 'invalid_body', { field: 'publicBaseUrl' });
      notify.publicBaseUrl = body.publicBaseUrl.trim();
    }
    if (body.limits !== undefined) {
      const limits = requireObject(body.limits);
      // 範囲の検査は設定の検査（parseConfig）に任せる。知らない名前もそこで断る
      notify.limits = { ...config.notify.limits, ...limits } as AppConfig['notify']['limits'];
    }
    await applyWithEnv(checked({ ...config, notify }), new Map());
    sendJson(res, 200, view());
  });
}

export type { HttpProblem };