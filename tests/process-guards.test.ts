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
  // 本物の Node と同じく、受け口が投げたら uncaughtException に回す。uncaughtException の受け口が投げたら、そのまま外へ出す（本物は終了コード 7 で落ちる）
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(...args); } catch (error) {
        if (event === 'uncaughtException') throw error;
        this.emit('uncaughtException', error);
      }
    }
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

interface RigOptions {
  mcpWaitMs?: number;
  /** closeApp が投げる中身（Error の文） */
  closeAppError?: string;
  closeWebThrows?: boolean;
  stopMcpThrows?: boolean;
  secrets?: string[];
  /** 設定の鍵を読む関数が投げる */
  secretsThrow?: boolean;
}

function rig(options: RigOptions = {}): Rig {
  const proc = new FakeProcess();
  const lines: string[] = [];
  const calls: string[] = [];
  const exits: number[] = [];
  let finishMcp = (): void => undefined;
  const secretsOf = (): string[] => {
    if (options.secretsThrow) throw new Error('registry is not ready');
    return options.secrets ?? [];
  };
  const shutdown = createShutdown({
    log: line => { lines.push(line); },
    closeWeb: () => {
      calls.push('web');
      if (options.closeWebThrows) throw new Error('server was never listening');
    },
    stopMcp: () => {
      calls.push('mcp');
      if (options.stopMcpThrows) throw new Error('mcp manager is gone');
      return new Promise<void>(resolve => { finishMcp = resolve; });
    },
    closeApp: () => {
      calls.push('app');
      if (options.closeAppError !== undefined) throw new Error(options.closeAppError);
    },
    exit: code => { exits.push(code); },
    mcpWaitMs: options.mcpWaitMs ?? 60_000,
    secrets: secretsOf,
  });
  installProcessGuards({ proc, log: line => { lines.push(line); }, shutdown, secrets: secretsOf });
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
  const r = rig({ closeAppError: 'db is already closed' });
  r.proc.emit('SIGINT');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [0]);
  assert.ok(r.lines.some(line => line.startsWith('[ERROR]') && line.includes('db is already closed')));
});

// ── レビューの指摘（1〜4）──
test('指摘1: closeWeb が投げても、MCP を閉じて app.close() を通り、終了コード 0 で終わる（止めかけのまま動き続けない）', async () => {
  const r = rig({ closeWebThrows: true, mcpWaitMs: 15 });
  r.proc.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [0]);
  assert.ok(r.lines.some(line => line.startsWith('[ERROR]') && line.includes('server was never listening')), '失敗は記録に出る');
});

test('指摘1: 捕まえていない例外の止め方で closeWeb が投げても、終了コード 1 で終わる', async () => {
  const r = rig({ closeWebThrows: true, mcpWaitMs: 15 });
  r.proc.emit('uncaughtException', new Error('first'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(r.calls, ['web', 'mcp', 'app']);
  assert.deepEqual(r.exits, [1]);
});

test('指摘1: stopMcp が同期で投げても、待ちを待たずに app.close() を通って終わる', async () => {
  const r = rig({ stopMcpThrows: true });
  r.proc.emit('SIGINT');
  await tick();
  await tick();
  assert.deepEqual(r.calls, ['web', 'mcp', 'app'], 'mcpWaitMs（60 秒）を待たない');
  assert.deepEqual(r.exits, [0]);
});

test('指摘2: 投げられたものが何であっても、[ERROR] を 1 行出し、受け口は投げない（止めない）', () => {
  const r = rig();
  const stackless = new Error('stack is not text');
  Object.defineProperty(stackless, 'stack', { value: {} });
  assert.doesNotThrow(() => {
    r.proc.emit('unhandledRejection', Object.create(null));
    r.proc.emit('unhandledRejection', stackless);
    r.proc.emit('unhandledRejection', { code: 'E', message: 'm' });
  });
  assert.equal(r.lines.length, 3, '1 つずつ 1 回の記録');
  for (const line of r.lines) assert.match(line, /^\[ERROR\] Unhandled promise rejection: /u);
  assert.match(r.lines[1]!, /stack is not text/u, 'stack が文字でない Error は、名前と文で出す');
  assert.match(r.lines[2]!, /code.*E/u);
  assert.match(r.lines[2]!, /message.*m/u, '素の object は [object Object] にしない');
  assert.deepEqual(r.exits, []);
});

test('指摘2: 受け口の中で何かが投げても、記録の行は必ず 1 行出る（uncaughtException でも止め方に進む）', async () => {
  const r = rig();
  const hostile = { get message(): string { throw new Error('getter blew up'); }, get name(): string { throw new Error('getter blew up'); } };
  Object.setPrototypeOf(hostile, Error.prototype);
  assert.doesNotThrow(() => { r.proc.emit('uncaughtException', hostile); });
  assert.match(r.lines[0]!, /^\[ERROR\] Uncaught exception: /u);
  assert.deepEqual(r.calls, ['web', 'mcp'], '止め方には進む');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [1]);
});

test('指摘2: 素の object の中の鍵も伏せる（形で見つかる鍵・設定の鍵の値そのもの。入れ子の中も）', () => {
  const r = rig({ secrets: ['hunter2-exact-secret'] });
  r.proc.emit('unhandledRejection', { code: 'E', headers: { authorization: 'Bearer abcdef0123456789abcdef' }, detail: { key: 'sk-ant-test-0000000000000000', other: 'hunter2-exact-secret' } });
  r.proc.emit('unhandledRejection', Object.assign(Object.create(null), { token: 'sk-ant-test-0000000000000000' }));
  const text = r.lines.join('\n');
  assert.doesNotMatch(text, /sk-ant-test-0000000000000000/u);
  assert.doesNotMatch(text, /hunter2-exact-secret/u);
  assert.doesNotMatch(text, /abcdef0123456789abcdef/u);
  assert.equal(r.lines.length, 2);
});

test('指摘3: app.close() の失敗の行からも秘密が伏せられる', async () => {
  const r = rig({ closeAppError: 'close failed with sk-ant-test-0000000000000000 and hunter2-exact-secret', secrets: ['hunter2-exact-secret'] });
  r.proc.emit('SIGINT');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [0]);
  const failure = r.lines.filter(line => line.startsWith('[ERROR]'));
  assert.equal(failure.length, 1);
  assert.match(failure[0]!, /close failed with/u);
  assert.doesNotMatch(r.lines.join('\n'), /sk-ant-test-0000000000000000|hunter2-exact-secret/u);
});

test('指摘4: 設定の鍵を読む関数が投げても、記録は出て、形で見つかる鍵は伏せられる', async () => {
  const r = rig({ secretsThrow: true });
  assert.doesNotThrow(() => {
    r.proc.emit('unhandledRejection', new Error('boom with sk-ant-test-0000000000000000'));
    r.proc.emit('uncaughtException', new Error('again with sk-ant-test-0000000000000000'));
  });
  r.finishMcp();
  await tick();
  assert.equal(r.lines.filter(line => line.startsWith('[ERROR]')).length, 2);
  const text = r.lines.join('\n');
  assert.match(text, /boom with/u);
  assert.match(text, /again with/u);
  assert.doesNotMatch(text, /sk-ant-test-0000000000000000/u);
  assert.deepEqual(r.exits, [1]);
});

test('指摘3 と 4: 鍵を読む関数が投げているときの app.close() の失敗の行も、形で見つかる鍵は伏せられる', async () => {
  const r = rig({ secretsThrow: true, closeAppError: 'close failed with sk-ant-test-0000000000000000' });
  r.proc.emit('SIGINT');
  r.finishMcp();
  await tick();
  assert.deepEqual(r.exits, [0]);
  const failure = r.lines.filter(line => line.startsWith('[ERROR]'));
  assert.equal(failure.length, 1);
  assert.match(failure[0]!, /close failed with/u);
  assert.doesNotMatch(failure[0]!, /sk-ant-test-0000000000000000/u);
});
