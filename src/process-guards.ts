import { redactSecrets } from './shared/redaction.ts';

// main.ts の「止める」と「受け口」を、本物の process に触れずに試せる形に切り出したもの。
// 記録の文は英語の決め打ち（main.ts の [INFO] / [WARN] / [ERROR] の行と同じ）

/** 受け口を付ける相手。本物の `process` がそのまま入る（試験ではにせのものを渡す） */
export interface GuardProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ShutdownSteps {
  readonly log: (line: string) => void;
  /** 待ち受けを閉じる */
  readonly closeWeb: () => void;
  /** 外の MCP サーバーの子のプロセスを閉じる（終わるまでを `mcpWaitMs` だけ待つ） */
  readonly stopMcp: () => Promise<unknown>;
  readonly closeApp: () => void;
  readonly exit: (code: number) => void;
  readonly mcpWaitMs?: number;
}

export interface Shutdown {
  /** SIGINT / SIGTERM。1 回目は順に閉じる。2 回目からは MCP の待ちを飛ばして、すぐ app.close() を通って終わる */
  signal(): void;
  /** 捕まえていない例外。終了コード 1 で、1 回目と同じ順に閉じる（すでに閉じている最中なら、待ちは飛ばさない） */
  fail(): void;
}

export function createShutdown(steps: ShutdownSteps): Shutdown {
  const { log } = steps;
  let closing = false;
  let finished = false;
  let exitCode = 0;
  let timer: NodeJS.Timeout | undefined;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // 受け口を付けたあとは、ここで投げて終われないと、止めかけた beat が動き続けてしまう。閉じるのに失敗しても必ず終わる
    try { steps.closeApp(); } catch (error) { log(`[ERROR] Failed to close beat cleanly: ${(error as Error).message}`); } finally { steps.exit(exitCode); }
  };

  const begin = (): void => {
    closing = true;
    log('[INFO] Shutting down…');
    steps.closeWeb();
    const wait = new Promise<void>(resolve => { timer = setTimeout(resolve, steps.mcpWaitMs ?? 5000); });
    void Promise.race([steps.stopMcp(), wait]).catch(() => undefined).finally(finish);
  };

  return {
    signal() {
      if (!closing) { begin(); return; }
      if (finished) return;
      log('[WARN] Shutting down now, without waiting for the external MCP servers');
      finish();
    },
    fail() {
      exitCode = 1;
      if (!closing) begin();
    },
  };
}

function describe(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
}

export interface GuardOptions {
  readonly proc: GuardProcess;
  readonly log: (line: string) => void;
  readonly shutdown: Shutdown;
  /** 設定の鍵の値そのもの。記録に出す文から伏せる */
  readonly secrets?: () => readonly string[];
}

export function installProcessGuards(options: GuardOptions): void {
  const { proc, log, shutdown } = options;
  const redact = (reason: unknown): string => {
    try { return redactSecrets(describe(reason), options.secrets?.() ?? []); } catch { return redactSecrets(describe(reason)); }
  };
  // 投げっぱなしの promise の失敗 1 つで beat 全体を止めない。見えるように記録に出して動き続ける
  proc.on('unhandledRejection', reason => { log(`[ERROR] Unhandled promise rejection: ${redact(reason)}`); });
  // 捕まえていない例外は、どこが壊れたか分からない。記録に出して、いまの止め方で終わる
  proc.on('uncaughtException', error => {
    log(`[ERROR] Uncaught exception: ${redact(error)}`);
    shutdown.fail();
  });
  proc.on('SIGINT', () => { shutdown.signal(); });
  proc.on('SIGTERM', () => { shutdown.signal(); });
}
