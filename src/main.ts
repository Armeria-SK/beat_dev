import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { App } from './app.ts';
import { providerModels } from './config/schema.ts';
import { ConfigError } from './config/store.ts';
import { acquireInstanceLock, releaseOnExit } from './instance-lock.ts';
import { enterKillOnCloseJob } from './os/win-job.ts';
import { loadEnvFile, resolvePaths } from './paths.ts';
import { createShutdown, installProcessGuards } from './process-guards.ts';
import { serverHostProblem } from './shared/url.ts';
import { createWebServer } from './web/server.ts';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

async function start(): Promise<void> {
  // node src/main.ts [--data-dir <dir>]（--data-dir は環境変数 BEAT_DATA_DIR より優先）
  const { values: args } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
  const dataDir = args['data-dir'] ?? process.env.BEAT_DATA_DIR;
  const job = await enterKillOnCloseJob();
  if (job.state === 'failed') log(`[WARN] Could not put beat in a job object: ${job.reason}`);
  loadEnvFile();
  const paths = resolvePaths(dataDir);
  mkdirSync(paths.data, { recursive: true });
  const lock = acquireInstanceLock(paths.data);
  if (!lock.held) {
    process.stderr.write(`Could not start: another beat (pid ${lock.pid}) is using this data folder. Stop it first, or delete ${lock.path} if no beat is running\n`);
    process.exitCode = 1;
    return;
  }
  releaseOnExit(lock);
  const app = new App({ paths, log });
  const config = app.config();
  // 待ち受けと認証は、起動したときの値（app.bootServer）で決める。起動の準備のあいだに設定ファイルが変わっても、反映は画面の「再起動する」から
  const boot = app.bootServer;
  const hostProblem = serverHostProblem(boot.host);
  if (hostProblem) throw new ConfigError(hostProblem);
  if (!providerModels(config).length) log('[WARN] No model is set up yet. Add one in "First-run setup" on the screen (until then, sending and the worker do not run)');
  else log('[INFO] Checking the context length of the models…');
  const results = await app.status.probeAll(config);
  for (const r of results) log(`[${r.status === 'ok' ? 'INFO' : 'WARN'}] ${r.modelId}: ${r.status} — ${r.message}`);
  const web = createWebServer(app);
  await web.listen();
  app.settleStaleNotifications(); // 待ち受けが取れてから（同じデータで 2 つ目を起こしたとき、動いている方の知らせを触らない）
  // 外の MCP サーバーへのつなぎ（待たない。つながらなくても beat は動く）
  void app.mcp.start().catch(error => log('[ERROR] Failed to start MCP: ' + (error as Error).message));
  // 入っている外の実行役の確かめ（待たない。終わるまで、その実行役のモデルは「確かめていない」）
  void app.checkRuntimes().catch(error => log('[ERROR] Failed to check the runtimes: ' + (error as Error).message));
  log(`[INFO] beat started: http://${boot.host}:${boot.port}/`);
  log('[INFO] There is no login. Anyone who can open this URL (including other programs on this PC) can operate beat');
  app.worker.start();
  log(`[INFO] Worker: ${config.worker.enabled ? 'running' : 'own work off (worker.enabled = false); Builds and tasks you start still run'}`);
  const shutdown = createShutdown({
    log,
    closeWeb: () => { web.close(); },
    // 外の MCP サーバーの子のプロセスを閉じる（最大 5 秒待つ。2 回目の Ctrl+C はその待ちを飛ばす）
    stopMcp: () => app.mcp.stop(),
    closeApp: () => { app.close(); },
    exit: code => process.exit(code),
    secrets: () => app.registry.secrets(),
  });
  // 投げっぱなしの失敗は記録に出して動き続ける。捕まえていない例外と Ctrl+C・終了の合図は、同じ止め方で終わる
  installProcessGuards({ proc: process, log, shutdown, secrets: () => app.registry.secrets() });
}

try {
  await start();
} catch (error) {
  if (error instanceof ConfigError) process.stderr.write(`Settings error: ${error.message}\n`);
  else if ((error as NodeJS.ErrnoException | undefined)?.code?.startsWith('ERR_PARSE_ARGS')) process.stderr.write(`Could not start: ${String(error).replace(/\s*\n\s*/gu, ' ')}\n`);
  else process.stderr.write(`Could not start: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
}
