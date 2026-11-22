// 材料の依頼アプリ（ブラウザの確かめの物差し用。追加部品なし）
// 起動: node app.mjs   （PORT が無ければ 3456）
// 管理画面の暗証番号（試しの値）: 2468
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3456;
const PIN = '2468';
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, '.bench');
const LOG = join(LOG_DIR, 'events.jsonl');
mkdirSync(LOG_DIR, { recursive: true });
const record = (kind, data = {}) => appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), kind, ...data })}\n`);

const requests = [
  { id: 1, site: '山田邸', material: '石膏ボード 9.5mm', qty: 20, date: '2026-11-20', ordered: false },
  { id: 2, site: '佐藤ビル', material: '合板 12mm', qty: 15, date: '2026-11-21', ordered: true },
  { id: 3, site: '山田邸', material: 'ビス 41mm', qty: 5, date: '2026-11-21', ordered: false },
];
let nextId = 4;
const sessions = new Set();

const page = (title, body, script = '') => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 640px; padding: 16px; }
nav a { margin-right: 12px; }
.screen { display: none; } .screen.on { display: block; }
button { font-size: 16px; padding: 8px 14px; margin: 4px 4px 4px 0; }
input { font-size: 16px; padding: 6px; }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; }
.done { color: #2a7; font-weight: bold; } .err { color: #c33; }
</style></head><body>
<nav><a href="/">依頼する</a><a href="/list">依頼の一覧</a><a href="/admin">事務の画面</a></nav>
${body}
<script>
const ev = (kind, data) => fetch('/api/ev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...data }) }).catch(() => {});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
${script}
</script></body></html>`;

const wizard = page('材料の依頼', `
<h1>材料の依頼</h1>
<p id="step">1 / 5</p>
<section class="screen on" data-n="1"><h2>どの現場ですか</h2>
  <label>現場の名前 <input id="site" name="site"></label>
  <p><button data-next>つぎへ</button></p></section>
<section class="screen" data-n="2"><h2>どの材料ですか</h2>
  <label>材料 <input id="material" name="material"></label>
  <p><button data-back>もどる</button><button data-next>つぎへ</button></p></section>
<section class="screen" data-n="3"><h2>いくつ要りますか</h2>
  <label>数量 <input id="qty" name="qty" type="number" min="0" value="0"></label>
  <p><button id="plus1">+1</button><button id="plus10">+10</button></p>
  <p><button data-back>もどる</button><button data-next>つぎへ</button></p></section>
<section class="screen" data-n="4"><h2>いつ要りますか</h2>
  <p><button id="today">今日</button><button id="tomorrow">明日</button></p>
  <label>日付 <input id="date" name="date" type="date"></label>
  <p><button data-back>もどる</button><button data-next>つぎへ</button></p></section>
<section class="screen" data-n="5"><h2>この内容で送りますか</h2>
  <ul id="summary"></ul>
  <p><button data-back>もどる</button><button id="send">送る</button></p></section>
<p id="msg" role="status"></p>
`, `
let n = 1;
const show = k => { n = k; document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', Number(s.dataset.n) === n)); document.getElementById('step').textContent = n + ' / 5'; document.getElementById('msg').textContent = '';
  if (n === 5) document.getElementById('summary').innerHTML = ['現場: ' + site.value, '材料: ' + material.value, '数量: ' + qty.value, '日付: ' + date.value].map(t => '<li>' + esc(t) + '</li>').join(''); };
const need = { 1: () => site.value.trim(), 2: () => material.value.trim(), 3: () => Number(qty.value) > 0, 4: () => date.value };
document.querySelectorAll('[data-next]').forEach(b => b.onclick = () => { if (!need[n]()) { document.getElementById('msg').textContent = '入力してください'; return; } show(n + 1); });
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show(n - 1));
plus1.onclick = () => { qty.value = Number(qty.value || 0) + 1; };
plus10.onclick = () => { const before = Number(qty.value || 0); qty.value = before + 10; ev('plus10', { before, after: before + 10 }); };
const day = d => { const t = new Date(Date.now() + d * 86400000 + 9 * 3600000); return t.toISOString().slice(0, 10); };
today.onclick = () => { date.value = day(0); ev('date_button', { which: 'today', value: date.value }); };
tomorrow.onclick = () => { date.value = day(1); ev('date_button', { which: 'tomorrow', value: date.value }); };
send.onclick = async () => {
  const r = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: site.value, material: material.value, qty: Number(qty.value), date: date.value }) });
  const j = await r.json();
  if (!r.ok) { document.getElementById('msg').textContent = j.error; return; }
  site.value = ''; material.value = ''; qty.value = '0'; date.value = '';
  show(1);
  document.getElementById('msg').innerHTML = '<span class="done">送りました（受付番号 ' + j.id + '）</span>';
};
`);

const list = page('依頼の一覧', `
<h1>依頼の一覧</h1>
<table><thead><tr><th>番号</th><th>現場</th><th>材料</th><th>数量</th><th>日付</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<p id="detail" role="status"></p>
`, `
fetch('/api/requests?from=list').then(r => r.json()).then(j => {
  rows.innerHTML = j.requests.map(x => '<tr><td>' + x.id + '</td><td>' + esc(x.site) + '</td><td>' + esc(x.material) + '</td><td>' + x.qty + '</td><td>' + x.date + '</td><td><button data-id="' + x.id + '">詳しく</button></td></tr>').join('');
  rows.querySelectorAll('button').forEach(b => b.onclick = () => { const x = j.requests.find(r => r.id === Number(b.dataset.id)); detail.textContent = '番号 ' + x.id + ': ' + x.site + ' / ' + x.material + ' / ' + x.qty + ' / ' + x.date + ' / ' + (x.ordered ? '発注済み' : '未発注'); });
});
`);

const admin = page('事務の画面', `
<h1>事務の画面</h1>
<section id="login"><label>暗証番号 <input id="pin" type="password" autocomplete="current-password"></label> <button id="enter">ログイン</button></section>
<section id="office" hidden><p><button id="logout">ログアウト</button></p>
<table><thead><tr><th>番号</th><th>現場</th><th>材料</th><th>数量</th><th>状態</th><th></th></tr></thead><tbody id="rows"></tbody></table></section>
<p id="msg" role="status"></p>
`, `
const load = async () => {
  const r = await fetch('/api/admin/requests');
  if (r.status === 401) { login.hidden = false; office.hidden = true; return; }
  const j = await r.json(); login.hidden = true; office.hidden = false;
  rows.innerHTML = j.requests.map(x => '<tr><td>' + x.id + '</td><td>' + esc(x.site) + '</td><td>' + esc(x.material) + '</td><td>' + x.qty + '</td><td>' + (x.ordered ? '発注済み' : '未発注') + '</td><td>' + (x.ordered ? '' : '<button data-id="' + x.id + '">発注済みにする</button>') + '</td></tr>').join('');
  rows.querySelectorAll('button').forEach(b => b.onclick = async () => { await fetch('/api/admin/requests/' + b.dataset.id + '/ordered', { method: 'POST' }); msg.textContent = '番号 ' + b.dataset.id + ' を発注済みにしました'; load(); });
};
enter.onclick = async () => { const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: pin.value }) }); pin.value = ''; msg.textContent = r.ok ? '' : '暗証番号がちがいます'; load(); };
logout.onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); msg.textContent = 'ログアウトしました'; load(); };
load();
`);

const cookieSession = req => /(?:^|;\s*)sid=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
const readBody = req => new Promise(done => { let s = ''; req.on('data', c => { s += c; if (s.length > 10000) req.destroy(); }); req.on('end', () => { try { done(JSON.parse(s || '{}')); } catch { done({}); } }); });
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); };
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/') return html(res, wizard);
  if (req.method === 'GET' && path === '/list') return html(res, list);
  if (req.method === 'GET' && path === '/admin') return html(res, admin);
  if (req.method === 'GET' && path === '/api/requests') {
    if (url.searchParams.get('from') === 'list') record('list_view', { ids: requests.map(r => r.id), added: requests.filter(r => r.id >= 4).map(r => r.id) });
    return json(res, 200, { requests });
  }
  if (req.method === 'POST' && path === '/api/requests') {
    const b = await readBody(req);
    if (!String(b.site ?? '').trim() || !String(b.material ?? '').trim() || !(Number(b.qty) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? ''))) return json(res, 400, { error: '入力が足りません' });
    const row = { id: nextId++, site: String(b.site).slice(0, 100), material: String(b.material).slice(0, 100), qty: Math.trunc(Number(b.qty)), date: String(b.date), ordered: false };
    requests.push(row);
    record('submit', { id: row.id, site: row.site, material: row.material, qty: row.qty, date: row.date });
    return json(res, 201, { id: row.id });
  }
  if (req.method === 'POST' && path === '/api/ev') {
    const b = await readBody(req);
    if (b.kind === 'plus10') record('plus10', { before: Number(b.before), after: Number(b.after) });
    if (b.kind === 'date_button') record('date_button', { which: String(b.which), value: String(b.value) });
    return json(res, 204, {});
  }
  if (req.method === 'POST' && path === '/api/admin/login') {
    const b = await readBody(req);
    if (String(b.pin ?? '') !== PIN) { record('admin_login', { ok: false }); return json(res, 401, { error: 'bad_pin' }); }
    const sid = randomBytes(16).toString('hex');
    sessions.add(sid);
    record('admin_login', { ok: true });
    return json(res, 200, { ok: true }, { 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
  }
  const sid = cookieSession(req);
  const authed = sid !== undefined && sessions.has(sid);
  if (path.startsWith('/api/admin/') && !authed) return json(res, 401, { error: 'login' });
  if (req.method === 'GET' && path === '/api/admin/requests') return json(res, 200, { requests });
  const ordered = /^\/api\/admin\/requests\/(\d+)\/ordered$/.exec(path);
  if (req.method === 'POST' && ordered) {
    const row = requests.find(r => r.id === Number(ordered[1]));
    if (!row) return json(res, 404, { error: 'not_found' });
    row.ordered = true;
    record('mark_ordered', { id: row.id });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/admin/logout') {
    sessions.delete(sid);
    record('logout', {});
    return json(res, 200, { ok: true }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
  }
  json(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1', () => {
  record('start', { port: PORT });
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`admin PIN (test value): ${PIN}`);
});
