import type { App } from '../app.ts';
import { RUNTIME_KINDS, type AppConfig, type RuntimeConfig, type RuntimeKind } from '../config/schema.ts';
import { usableCheck, type RuntimeCheck, type RuntimeCheckFailure } from '../runtimes/checks.ts';
import { PERMISSIONS, permissionFor, type RuntimeIssue } from '../runtimes/types.ts';
import { problem, type Router, sendJson } from './http.ts';

// 外の実行役（Claude Code・Codex）の状態を読む・確かめる・モデルの一覧を読み込む（AR-6）。
// 入れる・切る・許可の設定の変更は、ほかの設定と同じ PUT /api/settings を通る（ここでは設定を書かない）。
// 確かめとモデルの読み込みは POST（実行役の本体を 1 回きり起こすため、書き込みと同じ Host・Origin の確かめを通った要求だけが届く）。発言は送らない

export interface RuntimeView {
  id: string;
  kind: RuntimeKind;
  // 設定にある行か（false = まだ設定に無い種類。入れると設定に足される）
  configured: boolean;
  enabled: boolean;
  // 起こすときに効く許可の設定（設定の値を、選べる一覧に通したもの）と、選べる一覧
  permission: string;
  permissions: readonly string[];
  check: null | {
    checkedAt: number;
    installed: boolean;
    version: string | null;
    verified: boolean;
    auth: 'ok' | 'login_required' | 'unknown';
    login: 'subscription' | 'other' | null;
    issues: readonly RuntimeIssue[];
    stop: RuntimeIssue | null;
    usable: boolean;
  };
  models: ReadonlyArray<{ id: string; label: string; efforts: readonly string[] }> | null;
}

function checkView(check: RuntimeCheck | undefined): RuntimeView['check'] {
  if (!check) return null;
  const { status } = check;
  return {
    checkedAt: check.checkedAt, installed: status.installed, version: status.version ?? null, verified: status.verified === true, auth: status.auth, login: status.login ?? null,
    issues: status.issues ?? [], stop: check.stop, usable: usableCheck(status),
  };
}

export function runtimeView(app: App, config: Pick<AppConfig, 'runtimes'>, runtime: Pick<RuntimeConfig, 'id' | 'kind'> & Partial<Pick<RuntimeConfig, 'enabled' | 'permission'>>, configured: boolean): RuntimeView {
  const on = runtime.enabled === true;
  const check = on ? app.runtimeChecks.get(runtime.id) : undefined;
  const list = on ? app.runtimeChecks.models(runtime.id) : null;
  return {
    id: runtime.id, kind: runtime.kind, configured, enabled: runtime.enabled === true,
    permission: permissionFor(runtime.kind, runtime.permission), permissions: PERMISSIONS[runtime.kind],
    check: checkView(check),
    models: list ? list.map(model => ({ id: model.id, label: model.label ?? model.id, efforts: model.efforts ?? [] })) : null,
  };
}

// 設定にある実行役に、まだ設定に無い種類を足した一覧（種類ごとに少なくとも 1 行）
export function runtimeViews(app: App, config: Pick<AppConfig, 'runtimes'>): RuntimeView[] {
  const rows = (config.runtimes ?? []).map(runtime => runtimeView(app, config, runtime, true));
  const missing = RUNTIME_KINDS.filter(kind => !rows.some(row => row.kind === kind));
  return [...rows, ...missing.map(kind => runtimeView(app, config, { id: kind, kind }, false))];
}

const REASON_KEY = { unknown: 'runtime_missing', disabled: 'runtime_off', not_built: 'runtime_not_built', failed: 'runtime_check_failed', check_failed: 'runtime_check_failed' } as const satisfies Record<RuntimeCheckFailure, string>;

const statusOf = (reason: RuntimeCheckFailure): number => (reason === 'unknown' ? 404 : reason === 'check_failed' || reason === 'failed' ? 502 : 409);

// 確かめ・読み込みを待っているあいだに、実行役が切られた・入れる先が変えられたかもしれない。待ったあとの設定で結果を整理し（古い結果は捨てる）、その設定で答える
function settle(app: App, id: string): RuntimeView {
  const config = app.config();
  app.status.refreshRuntimes(config);
  const runtime = config.runtimes?.find(candidate => candidate.id === id);
  if (!runtime || !runtime.enabled) throw problem(409, 'runtime_unavailable', 'runtime_off', { params: { id, reason: '' } });
  return runtimeView(app, config, runtime, true);
}

export function registerRuntimeRoutes(router: Router, app: App): void {
  router.add('GET', '/api/runtimes', ({ res }) => sendJson(res, 200, { runtimes: runtimeViews(app, app.config()) }));

  router.add('POST', '/api/runtimes/:id/check', async ({ res, params }) => {
    const id = params[0]!;
    const config = app.config();
    const outcome = await app.runtimeChecks.check(config, id);
    if (!outcome.ok) throw problem(statusOf(outcome.reason), 'runtime_unavailable', REASON_KEY[outcome.reason], { params: { id, reason: outcome.detail } });
    sendJson(res, 200, settle(app, id));
  });

  router.add('POST', '/api/runtimes/:id/models', async ({ res, params }) => {
    const id = params[0]!;
    const config = app.config();
    const outcome = await app.runtimeChecks.loadModels(config, id);
    if (!outcome.ok) throw problem(statusOf(outcome.reason), 'runtime_unavailable', outcome.reason === 'check_failed' ? 'runtime_models_failed' : REASON_KEY[outcome.reason], { params: { id, reason: outcome.detail } });
    sendJson(res, 200, settle(app, id));
  });
}
