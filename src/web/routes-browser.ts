import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { App } from '../app.ts';
import { BrowserFailure } from '../tools/browser/driver.ts';
import { HttpProblem, problem, sendJson, type Router } from './http.ts';

// ブラウザの管理（画面専用。モデルの道具には足さない）。ほかの書き込みと同じ Host・Origin・Sec-Fetch-Site の確かめを通った要求だけが届く。
// ログイン用の窓は持ち主が自分で操作する見えるブラウザ。ログイン情報は Clive 専用のプロファイルに残る（ふだんのブラウザのものは使わない）

// BrowserFailure を、画面にそのまま見せられる 409 にする
function failureProblem(error: unknown): unknown {
  if (!(error instanceof BrowserFailure)) return error;
  return new HttpProblem(409, { error: 'conflict', message: error.text('ja'), code: `tool.${error.key}` }, language => error.text(language));
}

export function registerBrowserRoutes(router: Router, app: App): void {
  router.add('GET', '/api/browser/status', ({ res }) => sendJson(res, 200, app.browser.status()));

  router.add('POST', '/api/browser/login', async ({ res }) => {
    try { await app.browser.openLogin(); } catch (error) { throw failureProblem(error); }
    sendJson(res, 200, app.browser.status());
  });

  router.add('POST', '/api/browser/close', async ({ res }) => {
    await app.browser.closeAll();
    sendJson(res, 200, app.browser.status());
  });

  // ログイン情報（Clive 専用のプロファイル）を消す。ブラウザを止めてから、置き場所を確かめて消す
  router.add('POST', '/api/browser/profile/reset', async ({ res }) => {
    await app.browser.withStopped(async () => {
      const profile = resolve(app.paths.browserProfile);
      const data = resolve(app.paths.data);
      // データの置き場所そのもの・その外・ドライブの根は消さない
      if (profile === data || !profile.startsWith(data.endsWith(sep) ? data : data + sep)) {
        throw problem(409, 'conflict', 'browser_reset_unsafe');
      }
      try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (error) {
        app.log(`[WARN] ブラウザのプロファイルを消せませんでした: ${error instanceof Error ? error.message : String(error)}`);
        throw problem(500, 'internal', 'browser_reset_failed', { params: { reason: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unknown' } });
      }
    });
    sendJson(res, 200, app.browser.status());
  });
}
