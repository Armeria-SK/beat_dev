import { inspect } from 'node:util';
import { redactSecrets } from './shared/redaction.ts';

// main.ts の「止める」と「受け口」を、本物の process に触れずに試せる形に切り出したもの。
// 記録の文は英語の決め打ち（main.ts の [INFO] / [WARN] / [ERROR] の行と同じ）

/** 受け口を付ける相手。本物の `process` がそのまま入る（試験ではにせのものを渡す） */
export interface GuardProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type Secrets = (() => readonly string[]) | undefined;

// 記録の 1 件の文の長さの上限（字）。伏せたあとの文に対して、「… (N more characters)」の分も入れて数える
const MAX_TEXT = 20_000;

// 投げられたもの（Error・文字列・素の object・prototype の無い object・stack が文字でない Error）を、投げずに 1 つの文にする。
// stack: Error の stack をそのまま使った（複数行のまま出す）。配列は 100 件まで（Node の既定値と同じ。固定しているだけ）。文字列の長さでは inspect に切らせない: 切ると、鍵が切れ目にまたがったとき伏せる前に頭だけ残るため（長さの上限は伏せたあとにかける）
function describe(reason: unknown): { text: string; stack: boolean } {
  try {
    if (reason instanceof Error) {
      const { stack } = reason;
      return typeof stack === 'string' && stack !== '' ? { text: stack, stack: true } : { text: `${String(reason.name)}: ${String(reason.message)}`, stack: false };
    }
    return { text: typeof reason === 'string' ? reason : inspect(reason, { depth: 3, breakLength: Infinity, maxArrayLength: 100, maxStringLength: Infinity }), stack: false };
  } catch { return { text: '(a value that could not be printed)', stack: false }; }
}

// 改行をふくむ空白の列（前後の空白ごと）を空白 1 つにする。受け口は同期で動くので、列の長さに対して 1 回なめるだけの形にする
// （`\s*[\r\n]\s*` の形は、改行の無い長い空白の列で 2 次の時間になった）
const LINE_BREAK = /[\r\n\p{Zl}\p{Zp}]/u;
const oneLine = (text: string): string => text.replace(/\s+/gu, run => (LINE_BREAK.test(run) ? ' ' : run));

// 伏せたあとの文を MAX_TEXT 字（付ける一言も入れて）までにする。伏せる前に切ると、切れ目の鍵の頭が残る
function capped(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const more = (count: number): string => `… (${count} more characters)`;
  const keep = MAX_TEXT - more(text.length).length;
  return `${text.slice(0, keep)}${more(text.length - keep)}`;
}

// 記録に出す文は、必ずここを通す（秘密を伏せる → Error の stack でなければ 1 行にする → 長さを切る、の順）。鍵を読む関数が投げても、形で見つかる鍵は伏せる。伏せること自体が失敗したら、文は出さない
function printable(reason: unknown, secrets: Secrets): string {
  const { text, stack } = describe(reason);
  let redacted: string;
  try { redacted = redactSecrets(text, secrets?.() ?? []); } catch {
    /* 鍵の値なしで伏せ直す */
    try { redacted = redactSecrets(text); } catch { return '(text withheld: it could not be redacted)'; }
  }
  return capped(stack ? redacted : oneLine(redacted));
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
  // 記録の出口が壊れていても、受け口は投げない（投げると uncaughtException に回って、投げっぱなしの失敗 1 つで beat が止まる）
  proc.on('unhandledRejection', reason => {
    try { log(`[ERROR] Unhandled promise rejection: ${printable(reason, secrets)}`); } catch { /* 記録の出口が壊れている */ }
  });
  // 捕まえていない例外は、どこが壊れたか分からない。記録に出して、いまの止め方で終わる（記録に出せなくても止める）
  proc.on('uncaughtException', error => {
    try { log(`[ERROR] Uncaught exception: ${printable(error, secrets)}`); } catch { /* 記録の出口が壊れている */ }
    shutdown.fail();
  });
  proc.on('SIGINT', () => { shutdown.signal(); });
  proc.on('SIGTERM', () => { shutdown.signal(); });
}
