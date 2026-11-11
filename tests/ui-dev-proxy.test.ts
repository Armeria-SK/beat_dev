import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// 画面だけの開発サーバー（npm run dev:web）の /api の転送先。新しい画面（VITE_BEAT_UI=1）は、試しのサーバー（4797）にしかつながない。
// 持ち主のサーバー（4777。本物のデータと .env）へは、転送が Origin を書き換えるので、サーバーの認証を通ってしまう。

const CONFIG = pathToFileURL(join(import.meta.dirname, '..', 'web', 'vite.config.mjs')).href;

function proxyTarget(env: Record<string, string>): { target?: string; error?: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLIVE_PORT' && k !== 'VITE_BEAT_UI')) as Record<string, string>;
  const script = `const c = (await import(${JSON.stringify(CONFIG)})).default; console.log(c.server.proxy['/api'].target);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000 });
  return run.status === 0 ? { target: run.stdout.trim() } : { error: run.stderr };
}

test('VITE_BEAT_UI=1 で CLIVE_PORT が無いときの転送先は 4797（4777 ではない）', () => {
  assert.deepEqual(proxyTarget({ VITE_BEAT_UI: '1' }), { target: 'http://127.0.0.1:4797' });
  assert.deepEqual(proxyTarget({ VITE_BEAT_UI: '1', CLIVE_PORT: '4797' }), { target: 'http://127.0.0.1:4797' });
});

test('VITE_BEAT_UI=1 で CLIVE_PORT が 4797 以外なら、設定を読む時点で止まる', () => {
  for (const port of ['4777', '1234']) {
    const result = proxyTarget({ VITE_BEAT_UI: '1', CLIVE_PORT: port });
    assert.equal(result.target, undefined, port);
    assert.match(result.error ?? '', /only talks to the preview server on 4797/u, port);
  }
});

test('今の画面（VITE_BEAT_UI なし）の転送先は今までどおり（既定 4777、CLIVE_PORT で変えられる）', () => {
  assert.deepEqual(proxyTarget({}), { target: 'http://127.0.0.1:4777' });
  assert.deepEqual(proxyTarget({ CLIVE_PORT: '4790' }), { target: 'http://127.0.0.1:4790' });
});
