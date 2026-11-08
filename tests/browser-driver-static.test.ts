import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { childEnv, launchArgs, playwrightOptions, type LaunchOptions } from '../src/tools/browser/driver.ts';

// T-03: ブラウザの driver の「固定の守り」を、ソースと純粋な関数で確かめる（本物のブラウザは起動しない）

const SRC = resolve(import.meta.dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : /\.(ts|tsx|mts)$/u.test(entry.name) ? [path] : [];
});
const sources = files(SRC).map(path => ({ rel: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));

test('connectOverCDP は src のどこにも無い（動いている別のブラウザへ入らない）', () => {
  assert.ok(sources.length > 50);
  assert.deepEqual(sources.filter(s => s.text.includes('connectOverCDP')).map(s => s.rel), []);
});

test('playwright-core を import するのは driver.ts だけ', () => {
  const users = sources.filter(s => /['"]playwright-core['"]/u.test(s.text)).map(s => s.rel);
  assert.deepEqual(users, ['tools/browser/driver.ts']);
  // 値の import は動的だけ（無効のあいだは読み込まない）
  const driver = sources.find(s => s.rel === 'tools/browser/driver.ts')!.text;
  assert.ok(!/^import\s+(?!type\b)[^;]*from\s+['"]playwright-core['"]/mu.test(driver), '静的な値の import が無い');
  assert.match(driver, /import\('playwright-core'\)/u);
});

test('永続のプロファイルで起動する（launchPersistentContext）。launch / launchServer は使わない', () => {
  const driver = sources.find(s => s.rel === 'tools/browser/driver.ts')!.text;
  assert.match(driver, /launchPersistentContext\(/u);
  assert.ok(!/\.launch\(/u.test(driver) && !/launchServer/u.test(driver));
});

const options: LaunchOptions = {
  profileDir: 'C:\\p', channel: 'msedge', executablePath: undefined, headless: true,
  proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' }, viewport: { width: 1280, height: 800 }, locale: 'ja-JP', actionTimeoutMs: 10_000,
};

test('起動の引数: ループバックも中継へ・QUIC 無し・WebRTC は直接出ない・デバッグのポートは開かない', () => {
  const args = launchArgs();
  for (const required of ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']) assert.ok(args.includes(required), required);
  assert.ok(!args.some(a => /remote-debugging|--proxy-server|--no-sandbox|--disable-web-security/u.test(a)));
  assert.deepEqual(playwrightOptions(options).args, args);
});

test('起動の選択: ダウンロードを受けない・service worker を止める・証明書の誤りを許さない・権限を与えない', () => {
  const o = playwrightOptions(options);
  assert.equal(o.acceptDownloads, false);
  assert.equal(o.serviceWorkers, 'block');
  assert.equal(o.bypassCSP, false);
  assert.equal(o.ignoreHTTPSErrors, false);
  assert.deepEqual(o.permissions, []);
  assert.equal(o.channel, 'msedge');
  assert.deepEqual(o.proxy, { server: 'http://127.0.0.1:9', username: 'u', password: 'p' });
  const driver = sources.find(s => s.rel === 'tools/browser/driver.ts')!.text;
  assert.match(driver, /acceptDownloads: false/u);
  assert.match(driver, /serviceWorkers: 'block'/u);
});

test('子プロセスの環境変数に .env の鍵・トークンが入らない（許可リストだけ）', () => {
  const env = childEnv({
    ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', CLIVE_TOKEN: 'tok', GITHUB_TOKEN: 'ghp', NODE_OPTIONS: '--inspect',
    PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', LOCALAPPDATA: 'C:\\l',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP']);
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.equal(playwrightOptions(options, env).env, env);
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-live-test';
  try { assert.ok(!('ANTHROPIC_API_KEY' in childEnv())); } finally { delete process.env['ANTHROPIC_API_KEY']; }
});
