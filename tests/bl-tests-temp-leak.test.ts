import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.ts';

// backlog 379: 同期の試験は `tempDir({ after: () => undefined })` と書くので、後片付けが登録されず beat-test-* が OS の一時置き場にたまっていた。
// tempDir は、プロセスが終わるときに、後片付けが済んでいないフォルダを消す。ここでは本物の子のプロセスを私用の一時置き場で動かして確かめる

const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const CHILD = fileURLToPath(new URL('./helpers/temp-leak-child.ts', import.meta.url));

type Report = { forgotten: string; forgottenEmpty: string; tidied: string; existsBeforeExit: { forgotten: boolean; forgottenEmpty: boolean; tidied: boolean } };

function runChild(t: Parameters<typeof tempDir>[0], mode: 'natural' | 'process-exit') {
  const priv = tempDir(t);
  const ran = spawnSync(process.execPath, ['--import', LOADER, CHILD, mode], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, TEMP: priv, TMP: priv, TMPDIR: priv },
  });
  assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
  const report = JSON.parse(ran.stdout.trim().split('\n').at(-1)!) as Report;
  return { priv, report };
}

for (const mode of ['natural', 'process-exit'] as const) {
  test(`tempDir（${mode === 'natural' ? '子のプロセスが自然に終わる' : '子が process.exit で終わる'}）: 後片付けを登録しなかったフォルダは、プロセスが終わるときに消え、一時置き場に beat-test-* を残さない`, t => {
    const { priv, report } = runChild(t, mode);
    assert.deepEqual(report.existsBeforeExit, { forgotten: true, forgottenEmpty: true, tidied: false }, '前提: 終わる直前、忘れたフォルダはまだあり、後片付け済みのフォルダは無い');
    assert.equal(existsSync(report.forgotten), false, '中にファイルがあるフォルダも消える');
    assert.equal(existsSync(report.forgottenEmpty), false, '空のフォルダも消える');
    assert.equal(existsSync(report.tidied), false);
    assert.deepEqual(readdirSync(priv).filter(name => name.startsWith('beat-test-')), [], '私用の一時置き場に beat-test-* が残らない');
  });
}
