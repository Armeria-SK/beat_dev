import { readFileSync } from 'node:fs';
import { ProcessManager } from '../../src/runtimes/process-manager.ts';
import { FAKE_RUNTIME_SCRIPT } from './fake-runtime.ts';

// tests/runtimes-process.test.ts が子のプロセスとして動かす、beat の代わり。にせの実行役を起こし、孫まで起こさせてから、
// 自分が（外から）止められるのを待つ。入れ物を閉じずに落ちたとき、実行役とその孫が残らないことを見るための持ち主
const pidFile = process.argv[2]!;
const manager = new ProcessManager({});
const scope = await manager.open();
const child = scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT, '--stubborn'], cwd: process.cwd() });
// 入れ物に入ったあとで孫を起こさせる（入る前の数ミリ秒に起こされた孫は入れ物の外になる。src/os/run-job.ts の「残る穴」）
await new Promise(resolve => setTimeout(resolve, 1500));
child.writeLine(JSON.stringify({ type: 'grandchild', file: pidFile, exit: false }));
for await (const line of child.lines()) { if (JSON.parse(line).type === 'grandchild') break; }
console.log(JSON.stringify({ owner: process.pid, child: child.pid, grandchild: Number(readFileSync(pidFile, 'utf8')) }));
setInterval(() => {}, 1000);
