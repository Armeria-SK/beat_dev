import { inspect } from 'node:util';
import { redactSecrets } from './shared/redaction.ts';

// main.ts の「止める」と「受け口」を、本物の process に触れずに試せる形に切り出したもの。
// 記録の文は英語の決め打ち（main.ts の [INFO] / [WARN] / [ERROR] の行と同じ）

/** 受け口を付ける相手。本物の `process` がそのまま入る（試験ではにせのものを渡す） */
export interface GuardProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type Secrets = (() => readonly string[]) | undefined;

// 投げられたもの（Error・文字列・素の object・prototype の無い object・stack が文字でない Error）を、投げずに 1 つの文にする
function describe(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const { stack } = reason;
      return typeof stack === 'string' && stack !== '' ? stack : `${String(reason.name)}: ${String(reason.message)}`;
    }
    return typeof reason === 'string' ? reason : inspect(reason, { depth: 3, breakLength: Infinity });
  } catch { return '(a value that could not be printed)'; }
}

// 記録に出す文は、必ずここを通す（秘密を伏せる）。鍵を読む関数が投げても、形で見つかる鍵は伏せる。伏せること自体が失敗したら、文は出さない
function printable(reason: unknown, secrets: Secrets): string {
  const text = describe(reason);
  try { return redactSecrets(text, secrets?.() ?? []); } catch { /* 下で、鍵の値なしで伏せ直す */ }
  try { return redactSecrets(text); } catch { return '(text withheld: it could not be redacted)'; }
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
  /** 設定の鍵の値そのもの。失敗の行から伏せる */
  readonly secrets?: () => readonly string[];
}

export interface Shutdown {
  /** SIGINT / SIGTERM。1 回目は順に閉じる。2 回目からは MCP の待ちを飛ばして、すぐ app.close() を通って終わる */
  signal(): void;
  /** 捕まえていない例外。終了コード 1 で、1 回目と同じ順に閉じる（すでに閉じている最中なら、待ちは飛ばさない） */
  fail(): void;
}

export function createShutdown(steps: ShutdownSteps): Shutdown {
  // 記録に出せなくても、止める手順は進める
  const log = (line: string): void => { try { steps.log(line); } catch { /* 記録の出口が壊れている */ } };
  let closing = false;
  let finished = false;
  let exitCode = 0;
  let timer: NodeJS.Timeout | undefined;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // 受け口を付けたあとは、ここで投げて終われないと、止めかけた beat が動き続ける。閉じるのに失敗しても必ず終わる
    try { steps.closeApp(); } catch (error) { log(`[ERROR] Failed to close beat cleanly: ${printable(error, steps.secrets)}`); } finally { steps.exit(exitCode); }
  };

  const begin = (): void => {
    closing = true;
    // どの段で投げても、MCP の待ちの時計が切れるか、MCP が閉じ終わるかで finish に着く
    const wait = new Promise<void>(resolve => { timer = setTimeout(resolve, steps.mcpWaitMs ?? 5000); });
    log('[INFO] Shutting down…');
    try { steps.closeWeb(); } catch (error) { log(`[ERROR] Failed to close the web server: ${printable(error, steps.secrets)}`); }
    // stopMcp が同期で投げたときも、待ちが失敗した扱い（= すぐ finish）になる
    const stopped = new Promise<unknown>(resolve => { resolve(steps.stopMcp()); });
    void Promise.race([stopped, wait]).catch(() => undefined).finally(finish);
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

export interface GuardOptions {
  readonly proc: GuardProcess;
  readonly log: (line: string) => void;
  readonly shutdown: Shutdown;
  /** 設定の鍵の値そのもの。記録に出す文から伏せる */
  readonly secrets?: () => readonly string[];
}

export function installProcessGuards(options: GuardOptions): void {
  const { proc, log, shutdown, secrets } = options;
  // 投げっぱなしの promise の失敗 1 つで beat 全体を止めない。見えるように記録に出して動き続ける
  proc.on('unhandledRejection', reason => { log(`[ERROR] Unhandled promise rejection: ${printable(reason, secrets)}`); });
  // 捕まえていない例外は、どこが壊れたか分からない。記録に出して、いまの止め方で終わる（記録に出せなくても止める）
  proc.on('uncaughtException', error => {
    try { log(`[ERROR] Uncaught exception: ${printable(error, secrets)}`); } catch { /* 記録の出口が壊れている */ }
    shutdown.fail();
  });
  proc.on('SIGINT', () => { shutdown.signal(); });
  proc.on('SIGTERM', () => { shutdown.signal(); });
}
