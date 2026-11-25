import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers.ts';

// tests/bl-tests-temp-leak.test.ts が子のプロセスとして動かす。tempDir を 3 通りに使い、終わる直前の様子を 1 行の JSON で出す。
// 後片付けを登録しない呼び方（同期の試験の `tempDir({ after: () => undefined })`）の 2 つは、プロセスが終わるときに消えているはず

const mode = process.argv[2] === 'process-exit' ? 'process-exit' : 'natural';
const afters: Array<() => void | Promise<void>> = [];

const never = { after: () => undefined };
const forgotten = tempDir(never);
writeFileSync(join(forgotten, 'file.txt'), 'x');
const forgottenEmpty = tempDir(never);

const tidied = tempDir({ after: fn => { afters.push(fn); } });
writeFileSync(join(tidied, 'file.txt'), 'x');
for (const fn of afters) await fn();

console.log(JSON.stringify({
  forgotten,
  forgottenEmpty,
  tidied,
  existsBeforeExit: { forgotten: existsSync(forgotten), forgottenEmpty: existsSync(forgottenEmpty), tidied: existsSync(tidied) },
}));
if (mode === 'process-exit') process.exit(0);
