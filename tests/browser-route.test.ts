import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeVerdict, type RouteRequest } from '../src/tools/browser/route.ts';

// T-11: ブラウザの要求の横取りの判定（純関数）。副の守り（本体は中継）

const sub = (url: string, extra: Partial<RouteRequest> = {}): RouteRequest => ({ url, navigation: false, mainFrame: false, pageUrl: 'https://example.com/', ...extra });
const nav = (url: string, pageUrl: string | null = 'https://example.com/', extra: Partial<RouteRequest> = {}): RouteRequest => ({ url, navigation: true, mainFrame: true, pageUrl: pageUrl ?? undefined, ...extra });

test('ページの部品（画像・script・fetch）は http / https / ws / wss / data / blob を通す', () => {
  for (const url of ['https://cdn.example.net/a.png', 'http://example.net/a.css', 'wss://example.net/socket', 'ws://example.net/socket', 'data:image/png;base64,AAAA', 'blob:https://example.com/abc']) {
    assert.deepEqual(routeVerdict(sub(url)), { allow: true }, url);
  }
});

test('許さないスキームは、部品でも遷移でも断る（file / chrome / edge / about / javascript / view-source / devtools / ftp / chrome-extension）', () => {
  const urls = ['file:///C:/Windows/win.ini', 'chrome://settings', 'edge://settings', 'about:blank', 'javascript:alert(1)', 'view-source:https://example.com/', 'devtools://devtools/bundled/inspector.html', 'ftp://example.net/a', 'chrome-extension://abc/index.html', 'filesystem:https://example.com/temporary/a'];
  for (const url of urls) {
    assert.deepEqual(routeVerdict(sub(url)), { allow: false, reason: 'scheme' }, `sub ${url}`);
    assert.equal(routeVerdict(nav(url)).allow, false, `nav ${url}`);
  }
  assert.deepEqual(routeVerdict(sub('not a url')), { allow: false, reason: 'scheme' });
  assert.deepEqual(routeVerdict(sub('')), { allow: false, reason: 'scheme' });
});

test('ページの遷移としての data: と blob: は断る（main frame でも iframe でも）', () => {
  for (const url of ['data:text/html,<script>alert(1)</script>', 'data:text/html;base64,PGgxPmhpPC9oMT4=', 'blob:https://example.com/abc']) {
    assert.deepEqual(routeVerdict(nav(url)), { allow: false, reason: 'navigation' }, `main ${url}`);
    assert.deepEqual(routeVerdict({ ...nav(url), mainFrame: false }), { allow: false, reason: 'navigation' }, `frame ${url}`);
  }
});

test('main frame の遷移は pageUrl を通るものだけ（内向きの名前・IP・ポート・userinfo は断る）', () => {
  const refused = ['http://localhost/', 'https://127.0.0.1/', 'http://192.168.0.1/', 'http://10.0.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://user@example.net/', 'https://example.net:8443/', 'http://intranet/', 'https://printer.local/', 'http://x.internal/'];
  for (const url of refused) assert.deepEqual(routeVerdict(nav(url, null)), { allow: false, reason: 'navigation' }, url);
  for (const url of ['https://example.net/', 'http://example.net/a?b=1', 'https://sub.example.net/path#frag']) assert.deepEqual(routeVerdict(nav(url, null)), { allow: true }, url);
});

test('iframe の遷移は pageUrl までは見ない（部品と同じ。中継が番地を守る）が、スキームは見る', () => {
  assert.deepEqual(routeVerdict({ ...nav('https://ads.example.net/frame'), mainFrame: false }), { allow: true });
  assert.deepEqual(routeVerdict({ ...nav('file:///C:/x.html'), mainFrame: false }), { allow: false, reason: 'scheme' });
});

test('https のページから http への main frame の遷移は断る。http → http、http → https、https → https は通す', () => {
  assert.deepEqual(routeVerdict(nav('http://example.net/', 'https://example.com/')), { allow: false, reason: 'downgrade' });
  assert.deepEqual(routeVerdict(nav('http://example.net/', 'http://example.com/')), { allow: true });
  assert.deepEqual(routeVerdict(nav('https://example.net/', 'http://example.com/')), { allow: true });
  assert.deepEqual(routeVerdict(nav('https://example.net/', 'https://example.com/')), { allow: true });
  assert.deepEqual(routeVerdict(nav('http://example.net/', null)), { allow: true }, '最初の遷移（元のページが無い）');
  assert.deepEqual(routeVerdict(nav('http://example.net/', 'about:blank')), { allow: true }, 'about:blank からは通す');
});

test('部品の http は、https のページからでも判定の対象にしない（ブラウザの混在コンテンツの規則に任せる）', () => {
  assert.deepEqual(routeVerdict(sub('http://example.net/a.png')), { allow: true });
});
