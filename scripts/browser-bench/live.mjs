// 段ごとの実機の確かめ用の画面（browser-rethink の P3a・P4・P6）。物差しの app.mjs とは別のアプリで、物差しの数には使わない
// 起動: node live.mjs   （PORT が無ければ 3457）
//   /rows    同じ名前の「削除」が行ごとに並ぶ一覧。「並べ替え」「つぎのページ」も同じ URL のまま（P3a）
//   /many    触れるものが 350 個ある画面（P4 の browser_find）
//   /select  <select> の選択の欄（P6）
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 3457;

const page = (title, body, script = '') => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 640px; padding: 16px; } button { margin: 2px; }</style></head><body>
<nav><a href="/rows">行の一覧</a> <a href="/many">多い画面</a> <a href="/select">選ぶ欄</a></nav>
${body}<script>${script}</script></body></html>`;

const rows = page('行の一覧', `
<h1>行の一覧</h1>
<p><button id="sort">並べ替え</button><button id="next">つぎのページ</button></p>
<table><tbody id="list"></tbody></table><p id="msg" role="status"></p>`, `
const all = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: '材料 ' + (i + 1) }));
let start = 0, asc = true;
const draw = () => {
  const view = (asc ? all : [...all].reverse()).slice(start, start + 5);
  list.innerHTML = view.map(x => '<tr><td>' + x.name + '</td><td><button data-id="' + x.id + '">削除</button></td></tr>').join('');
  list.querySelectorAll('button').forEach(b => b.onclick = () => { const i = all.findIndex(x => x.id === Number(b.dataset.id)); const [gone] = all.splice(i, 1); msg.textContent = gone.name + ' を消しました'; draw(); });
};
sort.onclick = () => { asc = !asc; draw(); };
next.onclick = () => { start = start + 5 >= all.length ? 0 : start + 5; draw(); };
draw();`);

const many = page('多い画面', `<h1>多い画面</h1><div id="grid"></div><p id="msg" role="status"></p>`, `
grid.innerHTML = Array.from({ length: 350 }, (_, i) => '<button data-n="' + (i + 1) + '">品番 ' + String(i + 1).padStart(3, '0') + '</button>').join('');
grid.querySelectorAll('button').forEach(b => b.onclick = () => { msg.textContent = '品番 ' + b.dataset.n + ' を選びました'; });`);

const select = page('選ぶ欄', `<h1>選ぶ欄</h1>
<label>単位 <select id="unit"><option value="">選んでください</option><option>枚</option><option>本</option><option>箱</option></select></label>
<p id="msg" role="status"></p>`, `unit.onchange = () => { msg.textContent = '単位: ' + unit.value; };`);

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const body = { '/rows': rows, '/many': many, '/select': select, '/': rows }[path];
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log(`listening on http://localhost:${PORT}`));
