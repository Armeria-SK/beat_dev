// AR-3 のにせの外の実行役。1 行 1 JSON を標準入力から読み、1 行 1 JSON を標準出力へ返す小さな node のスクリプト（本物の Claude Code・Codex は起こさない）。
// 使い方: node fake-runtime-script.mjs [--permission <値>] [--eof-marker <ファイル>] [--stubborn]
// 入力の行: {"type":"user","text":"..."} → text と done / {"type":"models"} / {"type":"probe"} / {"type":"env"} / {"type":"argv"} /
//          {"type":"grandchild","file":"<pid を書く場所>","exit":true|false}（孫を起こす。exit なら自分は終わる）/
//          {"type":"long-line","bytes":N} / {"type":"flood","bytes":N} / {"type":"unknown"}（知らない出来事を返す）
// --stubborn: 入力が閉じられても自分では終わらない（「閉じる → 待つ → 木ごと止める」の試験用）
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (flag('stubborn')) setInterval(() => {}, 1000);

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { out({ type: 'failed', kind: 'process', message: 'not json' }); return; }
  switch (message.type) {
    case 'user':
      out({ type: 'text', delta: `echo: ${message.text}` });
      out({ type: 'done' });
      break;
    case 'models': out({ type: 'models', models: [{ id: 'fake-large', label: 'Fake large', efforts: ['low', 'high'] }, { id: 'fake-small' }] }); break;
    case 'probe': out({ type: 'status', installed: true, version: '0.0.0-fake', auth: 'ok' }); break;
    case 'env': out({ type: 'env', env: process.env, pid: process.pid }); break;
    case 'argv': out({ type: 'argv', argv: process.argv.slice(2) }); break;
    case 'grandchild': {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
      grandchild.unref();
      writeFileSync(message.file, String(grandchild.pid));
      if (message.exit) process.exit(0);
      out({ type: 'grandchild', pid: grandchild.pid });
      break;
    }
    case 'long-line': process.stdout.write(`${'x'.repeat(message.bytes)}\n`); out({ type: 'after-long-line' }); break;
    case 'flood': { const piece = `${'y'.repeat(99)}\n`; let sent = 0; while (sent < message.bytes) { process.stdout.write(piece); sent += piece.length; } break; }
    case 'unknown': out({ type: 'something-new-in-a-later-version', detail: 1 }); break;
    default: out({ type: 'failed', kind: 'process', message: `unknown input ${String(message.type)}` });
  }
});
reader.on('close', () => {
  const marker = option('eof-marker');
  if (marker) writeFileSync(marker, String(Date.now()));
  if (!flag('stubborn')) process.exit(0);
});
