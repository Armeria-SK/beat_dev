import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { App } from '../app.ts';
import { PROJECT_ID } from '../projects/store.ts';
import { BrowserFailure } from '../tools/browser/driver.ts';
import type { MirrorConversation } from '../tools/browser/session.ts';
import { HttpProblem, problem, sendJson, type Router } from './http.ts';

// ブラウザの管理（画面専用。モデルの道具には足さない）。ほかの書き込みと同じ Host・Origin・Sec-Fetch-Site の確かめを通った要求だけが届く。
// ログイン用の窓は持ち主が自分で操作する見えるブラウザ。ログイン情報は beat 専用のプロファイルに残る（ふだんのブラウザのものは使わない）

// BrowserFailure を、画面にそのまま見せられる 409 にする
function failureProblem(error: unknown): unknown {
  if (!(error instanceof BrowserFailure)) return error;
  return new HttpProblem(409, { error: 'conflict', message: error.text('en'), code: `tool.${error.key}` }, language => error.text(language));
}

const TAB_ID = /^t\d{1,9}$/u;
const SEQ = /^\d{1,15}$/u;

export function registerBrowserRoutes(router: Router, app: App): void {
  router.add('GET', '/api/browser/status', ({ res }) => sendJson(res, 200, app.browser.status()));

  // ---- Browser の欄（9-2a）。製品の ID は DB の製品だけ。タブはその製品の会話（DB の会話の製品で照らす）のものだけ ----
  const productOf = (raw: string | null): string | undefined => {
    if (raw === null || !PROJECT_ID.test(raw)) throw problem(400, 'invalid_id', 'invalid_id');
    return app.projects.get(raw)?.id;
  };
  const conversationsOf = (productId: string): MirrorConversation => id => {
    const row = app.conversations.get(id);
    if (!row || row.project_id !== productId) return undefined;
    return { attended: row.kind === 'chat' && row.parent_run_id === null };
  };
  // だれのタブか（欄の下の 1 行。D-10）
  const ownerOf = (conversationId: string) => {
    const task = app.tasks.byConversation(conversationId);
    if (task) return { kind: 'task' as const, id: task.id, title: task.title };
    const row = app.conversations.get(conversationId);
    return { kind: row?.parent_run_id ? 'agent' as const : 'conversation' as const, id: conversationId, title: row?.title ?? null };
  };

  router.add('GET', '/api/browser/view', ({ res, url }) => {
    const productId = productOf(url.searchParams.get('product'));
    if (productId === undefined) { sendJson(res, 404, { error: 'not_found' }); return; }
    const view = app.browser.view(productId, conversationsOf(productId));
    sendJson(res, 200, { view: view && { ...view, by: ownerOf(view.conversationId) } });
  });

  // 最後の画像。seq が今と同じなら 304（中身なし）
  router.add('GET', '/api/browser/frame', ({ res, url }) => {
    const productId = productOf(url.searchParams.get('product'));
    const tab = url.searchParams.get('tab');
    const seq = url.searchParams.get('seq');
    if (tab === null || !TAB_ID.test(tab) || (seq !== null && !SEQ.test(seq))) throw problem(400, 'invalid_id', 'invalid_id');
    const frame = productId === undefined ? undefined : app.browser.frame(tab, productId, conversationsOf(productId));
    if (!frame) { sendJson(res, 404, { error: 'not_found' }); return; }
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Seq': String(frame.seq), 'X-Frame-At': String(frame.at) };
    if (seq !== null && Number(seq) === frame.seq) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': frame.mediaType, 'Content-Length': String(frame.data.length) });
    res.end(frame.data);
  });

  router.add('POST', '/api/browser/login', async ({ res }) => {
    try { await app.browser.openLogin(); } catch (error) { throw failureProblem(error); }
    sendJson(res, 200, app.browser.status());
  });

  router.add('POST', '/api/browser/close', async ({ res }) => {
    await app.browser.closeAll();
    sendJson(res, 200, app.browser.status());
  });

  // ログイン情報（beat 専用のプロファイル）を消す。ブラウザを止めてから、置き場所を確かめて消す
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
        app.log(`[WARN] Could not delete the browser profile: ${error instanceof Error ? error.message : String(error)}`);
        throw problem(500, 'internal', 'browser_reset_failed', { params: { reason: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unknown' } });
      }
    });
    sendJson(res, 200, app.browser.status());
  });
}
