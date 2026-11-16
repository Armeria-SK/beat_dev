import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const [role, mode, failAt, haltAfter, timeoutMs] = process.argv.slice(2);
const say = line => process.stdout.write(`${line}\n`);
const idle = () => setInterval(() => {}, 1000);

if (role === 'grand') {
  say(`GRAND ${process.pid}`);
  idle();
} else if (role === 'child') {
  say(`CHILD ${process.pid}`);
  spawn(process.execPath, [self, 'grand'], { stdio: 'inherit', windowsHide: true });
  idle();
} else {
  let result = null;
  if (mode === 'job') {
    const { enterKillOnCloseJob } = await import('../../src/os/win-job.ts');
    result = await enterKillOnCloseJob({ failAt: Number(failAt) || undefined, haltAfter: Number(haltAfter) || undefined, timeoutMs: Number(timeoutMs) || undefined });
  }
  say(`RESULT ${JSON.stringify(result)}`);
  const shell = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${self}" child"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true });
  say(`SHELL ${shell.pid}`);
  idle();
}
