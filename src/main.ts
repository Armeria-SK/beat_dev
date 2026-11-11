import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { App } from './app.ts';
import { ConfigError } from './config/store.ts';
import { loadEnvFile, resolvePaths } from './paths.ts';
import { serverHostProblem } from './shared/url.ts';
import { isEdgeExecutable } from './shared/browser-path.ts';
import { locateBrowser } from './tools/browser/locate.ts';
import { createWebServer } from './web/server.ts';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

// node src/main.ts [doctor] [--data-dir <dir>]（--data-dir は環境変数 CLIVE_DATA_DIR より優先）
const { values: args, positionals } = parseArgs({ options: { 'data-dir': { type: 'string' } }, allowPositionals: true });
const dataDir = args['data-dir'] ?? process.env.CLIVE_DATA_DIR;

async function start(): Promise<void> {
  loadEnvFile();
  const paths = resolvePaths(dataDir);
  mkdirSync(paths.data, { recursive: true });
  const app = new App({ paths, log });
  const config = app.config();
  // 待ち受けと認証は、起動したときの値（app.bootServer）で決める。起動の準備のあいだに設定ファイルが変わっても、反映は画面の「再起動する」から
  const boot = app.bootServer;
  const hostProblem = serverHostProblem(boot.host);
  if (hostProblem) throw new ConfigError(hostProblem);
  if (!config.models.length) log('[WARN] No model is set up yet. Add one in "First-run setup" on the screen (until then, sending and the worker do not run)');
  else log('[INFO] Checking the context length of the models…');
  const results = await app.status.probeAll(config);
  for (const r of results) log(`[${r.status === 'ok' ? 'INFO' : 'WARN'}] ${r.modelId}: ${r.status} — ${r.message}`);
  const web = createWebServer(app);
  await web.listen();
  app.settleStaleNotifications(); // 待ち受けが取れてから（同じデータで 2 つ目を起こしたとき、動いている方の知らせを触らない）
  // 外の MCP サーバーへのつなぎ（待たない。つながらなくても Clive は動く。doctor ではつながない）
  void app.mcp.start().catch(error => log('[ERROR] Failed to start MCP: ' + (error as Error).message));
  log(`[INFO] Clive started: http://${boot.host}:${boot.port}/`);
  log('[INFO] There is no login. Anyone who can open this URL (including other programs on this PC) can operate Clive');
  app.worker.start();
  log(`[INFO] Worker: ${config.worker.enabled ? `running (autonomy: ${config.worker.autonomy ? 'on' : 'off'})` : 'stopped (worker.enabled = false)'}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log('[INFO] Shutting down…');
    web.close();
    // 外の MCP サーバーの子のプロセスを閉じる（最大 5 秒待つ）
    void Promise.race([app.mcp.stop(), new Promise(resolve => setTimeout(resolve, 5000))]).catch(() => undefined).finally(() => {
      app.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function doctor(): Promise<number> {
  loadEnvFile();
  const paths = resolvePaths(dataDir);
  const app = new App({ paths, log: () => undefined });
  try {
    const config = app.config();
    process.stdout.write(`設定ファイル: ${paths.config}（OK）\n`);
    const results = await app.status.probeAll(config);
    let bad = 0;
    for (const r of results) {
      const used = config.routing.chat.includes(r.modelId) || config.routing.background.includes(r.modelId);
      const mark = r.status === 'ok' ? 'OK ' : used ? 'NG ' : '-- ';
      if (r.status !== 'ok' && used) bad++;
      process.stdout.write(`${mark} ${r.modelId}: ${r.message}${r.hint ? `\n     直し方: ${r.hint}` : ''}\n`);
    }
    if (!config.models.length) { process.stdout.write('NG  モデルがまだ設定されていません（画面の「はじめの設定」で足してください）\n'); bad++; }
    else if (!config.routing.chat.some(id => app.status.usable(id))) { process.stdout.write('NG  チャットで使えるモデルがありません\n'); bad++; }
    // ブラウザの道具が有効なときだけ、使うブラウザの実行ファイルが見つかるか（起動はしない）
    const browser = config.tools.browser;
    if (browser.enabled) {
      const found = locateBrowser({ channel: browser.channel, executablePath: browser.executablePath });
      if (found) process.stdout.write(`OK  ブラウザ: ${found.path}\n`);
      else if (browser.channel === 'path' && isEdgeExecutable(browser.executablePath)) { process.stdout.write('NG  指定のブラウザは Microsoft Edge です（Edge ではブラウザの操作をしません）\n     直し方: 設定の「ブラウザ」で、Google Chrome か、ほかの Chromium 系ブラウザの実行ファイルを指定してください\n'); bad++; }
      else { process.stdout.write('NG  ブラウザの実行ファイルが見つかりません\n     直し方: Google Chrome を入れるか、設定の「ブラウザ」で「パスを指定」して Chromium 系ブラウザの実行ファイルを指定してください\n'); bad++; }
    }
    return bad ? 1 : 0;
  } finally { app.close(); }
}

const command = positionals[0];
try {
  if (command === 'doctor') process.exitCode = await doctor();
  else await start();
} catch (error) {
  if (error instanceof ConfigError) process.stderr.write(`Settings error: ${error.message}\n`);
  else process.stderr.write(`Could not start: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
}
