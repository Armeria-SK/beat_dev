import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShutdown, installProcessGuards, type GuardProcess } from '../src/process-guards.ts';

// 受け口を、にせの process で試す。本物の process に付けると、試験の実行そのものが止まる
class FakeProcess implements GuardProcess {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

interface Rig {
  readonly proc: FakeProcess;
  readonly lines: string[];
  readonly calls: string[];
  readonly exits: number[];
  /** 外の MCP サーバーを閉じる待ちを終わらせる */
  finishMcp(): void;
}

function rig(options: { mcpWaitMs?: number; mcpNeverEnds?: boolean; closeAppThrows?: boolean; secrets?: string[] } = {}): Rig {
  const proc = new FakeProcess();
  const lines: string[] = [];
  const calls: string[] = [];
  const exits: number[] = [];
  let finishMcp = (): void => undefined;
  const shutdown = createShutdown({
    log: line => { lines.push(line); },
    closeWeb: () => { calls.push('web'); },
    stopMcp: () => {
      calls.push('mcp');
      return new Promise<void>(resolve => { finishMcp = resolve; });
    },
    closeApp: () => {
      calls.push('app');
      if (options.closeAppThrows) throw new Error('db is already closed');
    },
    exit: code => { exits.push(code); },
    mcpWaitMs: options.mcpWaitMs ?? 60_000,
  });
  installProcessGuards({ proc, log: line => { lines.push(line); }, shutdown, secrets: () => options.secrets ?? [] });
  return { proc, lines, calls, exits, finishMcp: () => finishMcp() };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('A1: 投げっぱなしの promise の失敗は [ERROR] を 1 行出して、動き続ける（止めない）', async () => {
  const r = rig();
  r.proc.emit('unhandledRejection', new Error('boom in a background job'));
  await tick();
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0]!, /^\[ERROR\] /u);
  assert.match(r.lines[0]!, /boom in a background job/u);
  assert.deepEqual(r.calls, [], '止め方（shutdown）は通らない');
  assert.deepEqual(r.exits, []);
});

test('A1: Error でないもの（文字列・undefined）が投げられても 1 行で出る', () => {
  const r = rig();
  r.proc.emit('unhandledRejection', 'plain string');
  r.proc.emit('unhandledRejection', undefined);
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[0]!, /^\[ERROR\] .*plain string/u);
  assert.match(r.lines[1]!, /^\[ERROR\] /u);
  assert.deepEqual(r.exits, []);
});

test('A1: 記録に出るスタックから秘密が伏せられる（形で見つかる鍵・設定の鍵の値そのもの）', async () => {
  const r = rig({ secrets: ['hunter2-exact-secret'] });
  r.proc.emit('unhandledRejection', new Error('call failed with key sk-ant-test-0000000000000000 and hunter2-exact-secret'));
  r.proc.emit('uncaughtException', new Error('again sk-ant-test-0000000000000000'));
  const text = r.lines.join('\n');
  assert.doesNotMatch(text, /sk-ant-test-0000000000000000/u);
  assert.doesNotMatch(text, /hunter2-exact-secret/u);
  assert.match(text, /call failed with key/u);
  r.finishMcp(); // 待ちの時計を残さない
  await tick();
});

test('A1: 捕まえていない例外は [ERROR] を出し、いまの止め方を通って終了コード 1 で終わる', async () => {
  const r = rig();
  r.proc.emit('uncaughtException', new Error('thrown from a timer'));
  assert.match(r.lines[0]!, /^\[ERROR\] .*thrown from a timer/u);
  assert.match(r.lines.join('\n'), /Shutting down/u, '止め方の 1 行が出る');
  assert.deepEqual(r.calls, ['web', 'mcp'], '先に画面側と MCP を閉じにいく');
  assert.deepEqual(r.exits, [], 'MCP を閉じ終わるまでは終わらない');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [1]);
});

test('A1: 止めている途中でまた例外が出ても、MCP の待ちを飛ばさない（記録だけ増える）', async () => {
  const r = rig();
  r.proc.emit('uncaughtException', new Error('first'));
  r.proc.emit('uncaughtException', new Error('second'));
  assert.equal(r.lines.filter(line => line.startsWith('[ERROR]')).length, 2);
  assert.deepEqual(r.calls, ['web', 'mcp']);
  assert.deepEqual(r.exits, []);
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [1]);
});

test('A2: 1 回目の SIGINT は今までどおり（Shutting down… → MCP を閉じる → app.close() → 終了コード 0）', async () => {
  const r = rig();
  r.proc.emit('SIGINT');
  assert.match(r.lines.join('\n'), /Shutting down/u);
  assert.deepEqual(r.calls, ['web', 'mcp']);
  assert.deepEqual(r.exits, []);
  r.finishMcp();
  await tick();
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
});

test('A2: SIGTERM も SIGINT と同じ止め方になる', async () => {
  const r = rig();
  r.proc.emit('SIGTERM');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
});

test('A2: MCP を閉じる待ちの間の 2 回目の SIGINT は、待ちを飛ばして app.close() を 1 回だけ呼んでから終わる', async () => {
  const r = rig();
  r.proc.emit('SIGINT');
  assert.deepEqual(r.exits, []);
  r.proc.emit('SIGINT');
  assert.deepEqual(r.calls, ['web', 'mcp', 'app'], 'MCP が閉じ終わっていなくても app.close() を通る');
  assert.deepEqual(r.exits, [0]);
  // 3 回目と、遅れて閉じ終わった MCP の待ちは、何も足さない
  r.proc.emit('SIGINT');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
});

test('A2: SIGINT のあとの SIGTERM（種類がちがっても 2 回目）も待ちを飛ばす', () => {
  const r = rig();
  r.proc.emit('SIGINT');
  r.proc.emit('SIGTERM');
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
});

test('A2: 2 回目が来なくても、MCP の待ちは決めた時間で切れて終わる', async () => {
  const r = rig({ mcpWaitMs: 15 });
  r.proc.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
});

test('app.close() が投げても、終了は止まらない（受け口を付けたあとは、投げっぱなしだと動き続けてしまう）', async () => {
  const r = rig({ closeAppThrows: true });
  r.proc.emit('SIGINT');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [0]);
  assert.ok(r.lines.some(line => line.startsWith('[ERROR]') && line.includes('db is already closed')));
});
