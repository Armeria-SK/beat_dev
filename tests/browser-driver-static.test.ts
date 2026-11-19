import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { browserLaunchOptions, childEnv, launchArgs, playwrightOptions, workContextOptions, type LaunchOptions } from '../src/tools/browser/driver.ts';

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

test('持ち主のブラウザは永続のプロファイル（launchPersistentContext）。chromium.launch は作業用の 1 か所だけで、固定の起動の選択を通す。launchServer は使わない', () => {
  const driver = sources.find(s => s.rel === 'tools/browser/driver.ts')!.text;
  assert.match(driver, /launchPersistentContext\(/u);
  assert.deepEqual([...driver.matchAll(/\.launch\(([^\n]*)/gu)].map(m => m[1]!.trim()), ['browserLaunchOptions({ ...options, channel })));']);
  assert.ok(!/launchServer/u.test(driver));
});

test('作業用の文脈の選択: 持ち主と同じ固定の守り（ダウンロード・service worker・権限・証明書）に、文脈だけの中継と <-loopback> を足す', () => {
  const work = workContextOptions({ proxy: { server: 'http://127.0.0.1:7', username: 'w', password: 'q' }, viewport: { width: 1280, height: 800 }, locale: 'ja-JP', actionTimeoutMs: 10_000 });
  assert.deepEqual(work.proxy, { server: 'http://127.0.0.1:7', username: 'w', password: 'q', bypass: '<-loopback>' });
  assert.equal(work.acceptDownloads, false);
  assert.equal(work.serviceWorkers, 'block');
  assert.equal(work.ignoreHTTPSErrors, false);
  assert.equal(work.bypassCSP, false);
  assert.deepEqual(work.permissions, []);
  const launch = browserLaunchOptions({ channel: 'chrome', executablePath: undefined, headless: true, proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' } }, { PATH: 'C:\\bin' });
  assert.deepEqual(launch.args, launchArgs());
  assert.deepEqual(launch.env, { PATH: 'C:\\bin' });
  assert.equal('profileDir' in launch, false);
});

const options: LaunchOptions = {
  profileDir: 'C:\\p', channel: 'chrome', executablePath: undefined, headless: true,
  proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' }, viewport: { width: 1280, height: 800 }, locale: 'ja-JP', actionTimeoutMs: 10_000,
};

test('起動の引数: ループバックも中継へ・QUIC 無し・WebRTC は直接出ない・デバッグのポートは開かない', () => {
  const args = launchArgs();
  for (const required of ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']) assert.ok(args.includes(required), required);
  assert.ok(!args.some(a => /remote-debugging|--proxy-server|--no-sandbox|--disable-web-security/u.test(a)));
  assert.deepEqual(playwrightOptions(options).args, args);
});

test('起動の引数: --disable-features は 1 つだけで、Playwright の既定（MediaRouter・OptimizationHints など）を含む。あとから付けた引数が既定を潰さない', () => {
  const features = launchArgs().filter(a => a.startsWith('--disable-features='));
  assert.equal(features.length, 1);
  const names = new Set(features[0]!.slice('--disable-features='.length).split(','));
  // Playwright の既定の一覧（版ごとに変わる。読めなければ、読み方を直す）
  const bundle = readFileSync(join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8');
  const start = bundle.indexOf('disabledFeatures = [');
  assert.ok(start >= 0, 'Playwright の既定の無効な機能の一覧が見つからない');
  const defaults = [...bundle.slice(start, bundle.indexOf('].filter(Boolean)', start)).matchAll(/^\s*"([A-Za-z0-9]+)",?\s*$/gmu)].map(m => m[1]!);
  assert.ok(defaults.includes('MediaRouter') && defaults.includes('OptimizationHints'), defaults.join(','));
  const missing = defaults.filter(name => !names.has(name));
  assert.deepEqual(missing, [], `Playwright の既定のうち、固定の引数に無い: ${missing.join(',')}`);
  // 固定の 2 つも残る
  for (const own of ['PasswordManagerOnboarding', 'AutofillServerCommunication']) assert.ok(names.has(own), own);
});

test('起動の選択: ダウンロードを受けない・service worker を止める・証明書の誤りを許さない・権限を与えない', () => {
  const o = playwrightOptions(options);
  assert.equal(o.acceptDownloads, false);
  assert.equal(o.serviceWorkers, 'block');
  assert.equal(o.bypassCSP, false);
  assert.equal(o.ignoreHTTPSErrors, false);
  assert.deepEqual(o.permissions, []);
  assert.equal(o.channel, 'chrome');
  assert.deepEqual(o.proxy, { server: 'http://127.0.0.1:9', username: 'u', password: 'p' });
  const driver = sources.find(s => s.rel === 'tools/browser/driver.ts')!.text;
  assert.match(driver, /acceptDownloads: false/u);
  assert.match(driver, /serviceWorkers: 'block'/u);
});

test('子プロセスの環境変数に .env の鍵・トークンが入らない（許可リストだけ）', () => {
  const env = childEnv({
    ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', BEAT_TOKEN: 'tok', GITHUB_TOKEN: 'ghp', NODE_OPTIONS: '--inspect',
    PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', LOCALAPPDATA: 'C:\\l',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP']);
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.equal(playwrightOptions(options, env).env, env);
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-live-test';
  try { assert.ok(!('ANTHROPIC_API_KEY' in childEnv())); } finally { delete process.env['ANTHROPIC_API_KEY']; }
});
