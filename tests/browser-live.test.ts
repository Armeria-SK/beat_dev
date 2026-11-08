import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LAUNCH_TIMEOUT_MS, PlaywrightDriver, localeFor, playwrightOptions, seedPreferences, type LaunchOptions } from '../src/tools/browser/driver.ts';
import { startEgressProxy } from '../src/tools/browser/egress-proxy.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { testConfig } from './helpers.ts';

// T-44: 本物の Edge / Chrome で動かす。ふだんは飛ばす（CLIVE_BROWSER_LIVE=1 のときだけ）。
// 中継の外を通る道が増えていないかを、Playwright や Chromium の版を上げるたびに確かめる（README「版を上げたら」）。
// 外のネットワーク（https://example.com/）が要る
const live = process.env.CLIVE_BROWSER_LIVE === '1';
const options = { skip: live ? false : 'CLIVE_BROWSER_LIVE=1 のときだけ動かす（本物のブラウザと外のネットワークが要る）', timeout: 180_000 };

// この計算機のブラウザのコマンド行のうち、プロファイルの置き場を含むもの
function commandLines(marker: string): string[] {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker.replace(/'/gu, "''")}') } | ForEach-Object { $_.CommandLine }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    return out.stdout.split(/\r?\n/u).filter(line => line.trim() && !line.includes('Get-CimInstance'));
  }
  const out = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(line => line.includes(marker));
}

function tmpDir(t: { after: (fn: () => void) => void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `clive-live-${name}-`));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 閉じ遅れ */ } });
  return dir;
}

test('T-44(2): ページの中から 127.0.0.1 への画像・fetch・WebSocket・フォームが 1 回も届かない', options, async t => {
  const hits: string[] = [];
  const sink = createServer((req: IncomingMessage, res) => { hits.push(`${req.method} ${req.url}`); res.end('hit'); });
  sink.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => { sink.close(); });
  const port = (sink.address() as AddressInfo).port;

  const profileDir = tmpDir(t, 'leak');
  const proxy = await startEgressProxy({ username: 'clive', password: 'x'.repeat(48) });
  t.after(() => proxy.close());
  const { chromium } = await import('playwright-core');
  const launch: LaunchOptions = {
    profileDir, channel: undefined, executablePath: undefined, headless: true,
    proxy: { server: `http://${proxy.host}:${proxy.port}`, username: 'clive', password: 'x'.repeat(48) },
    viewport: { width: 1280, height: 800 }, locale: localeFor('ja'), actionTimeoutMs: 10_000,
  };
  seedPreferences(profileDir);
  let context;
  for (const channel of ['msedge', 'chrome'] as const) {
    try { context = await chromium.launchPersistentContext(profileDir, playwrightOptions({ ...launch, channel })); break; } catch { /* 次を試す */ }
  }
  assert.ok(context, 'Edge も Chrome も起動できなかった');
  t.after(() => context!.close());
  const page = await context.newPage();
  const target = `http://127.0.0.1:${port}`;
  await page.setContent(`<img src="${target}/img.png"><form id="f" method="post" action="${target}/form"><input name="a"></form><script>document.getElementById('f').submit()</script>`);
  const result = await page.evaluate(async (base: string) => {
    const outcome: Record<string, string> = {};
    try { await fetch(`${base}/fetch`, { mode: 'no-cors' }); outcome.fetch = 'reached'; } catch { outcome.fetch = 'failed'; }
    outcome.ws = await new Promise<string>(resolve => {
      try {
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
        ws.onopen = () => resolve('opened'); ws.onerror = () => resolve('failed'); ws.onclose = () => resolve('closed');
      } catch { resolve('failed'); }
    });
    const image = new Image();
    outcome.img = await new Promise<string>(resolve => { image.onload = () => resolve('loaded'); image.onerror = () => resolve('failed'); image.src = `${base}/img2.png`; });
    return outcome;
  }, target).catch(() => ({ navigated: 'form submit replaced the page' }));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.deepEqual(hits, [], `受け口に届いた: ${hits.join(', ')}`);
  // fetch(no-cors) は、中継の 403 を「不透明な応答」として受けて成功に見えるため、答えの形は見ない（受け口に届いたかだけを見る）
  assert.notEqual((result as Record<string, string>).ws, 'opened');
  assert.ok(proxy.stats().blocked >= 1, '中継が断った記録がある');
});

test('T-44(1)(3)(4): example.com を開いて本文が読め、押せて、起動したブラウザに --remote-debugging-port が無い', options, async t => {
  const profileDir = tmpDir(t, 'session');
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.sites = ['example.com', 'iana.org'];
  const session = new BrowserSession({ driver: new PlaywrightDriver(), config: () => config, paths: { browserProfile: profileDir } });
  t.after(() => session.close());
  const call = { conversationId: 'live', signal: new AbortController().signal };

  const read = await session.run(call, async api => {
    const tab = await api.openTab();
    await tab.page.goto('https://example.com/', LAUNCH_TIMEOUT_MS);
    return { url: tab.page.url(), text: await tab.page.text(5000), links: await tab.page.countRole('link', 'Learn more') };
  });
  assert.match(read.url, /^https:\/\/example\.com\//u);
  assert.match(read.text, /documentation examples/u);
  assert.equal(read.links, 1, '「Learn more」のリンクが見える');

  // 起動したブラウザのコマンド行（プロファイルの置き場で選ぶ）
  const lines = commandLines(profileDir);
  assert.ok(lines.length > 0, '起動したブラウザのコマンド行が見つからない');
  for (const line of lines) {
    assert.doesNotMatch(line, /--remote-debugging-port/u, line.slice(0, 300));
  }
  const main = lines.filter(line => !line.includes('--type='));
  assert.ok(main.length > 0, '本体のプロセスが見つからない');
  for (const line of main) assert.match(line, /--proxy-server=/u, '中継を指定して起動している');

  // 押す（リンク先へ移る）
  const clicked = await session.run(call, async api => {
    const tab = api.tab();
    const events = await tab.page.click({ role: 'link', name: 'Learn more', nth: 0, count: 1 }, 10_000);
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { events, url: tab.page.url(), refused: tab.page.lastRefusal() };
  });
  assert.deepEqual(clicked.events, { dialogs: 0, downloads: 0, fileChoosers: 0 });
  assert.match(clicked.url, /iana\.org/u, `押したあとのページ: ${clicked.url}（拒否: ${String(clicked.refused)}）`);
});
