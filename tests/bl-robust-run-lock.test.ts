import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import { acquireInstanceLock, LOCK_FILE, releaseOnExit } from '../src/instance-lock.ts';
import { tempDir } from './helpers.ts';

const lockText = (dir: string): string => readFileSync(join(dir, LOCK_FILE), 'utf8');
const lockPid = (dir: string): string => lockText(dir).split('\n')[0]!;

async function liveProcess(t: Parameters<typeof tempDir>[0]): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill(); });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child.pid!;
}

// 終わったあとの pid（本物の「もう動いていない beat」の代わり）
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(done.status, 0);
  return done.pid!;
}

test('錠: 起動のはじめに data/beat.lock を作って pid を書き、終わるときの release で消える', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const lock = acquireInstanceLock(dir);
  assert.equal(lock.held, true);
  assert.equal(lockPid(dir), String(process.pid));
  if (lock.held) lock.release();
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test('錠: 生きている別の beat が持っていれば、取らずにその pid を返し、錠は書き換えない', async t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const owner = await liveProcess(t);
  writeFileSync(join(dir, LOCK_FILE), `${owner}\n`);
  const lock = acquireInstanceLock(dir);
  assert.deepEqual(lock, { held: false, path: join(dir, LOCK_FILE), pid: owner });
  assert.equal(lockPid(dir), String(owner));
});

test('錠: 持ち主の pid が動いていない錠（窓を閉じた・落ちたあとに残った分）は取り直す', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_FILE), `${deadPid()}\n`);
  const lock = acquireInstanceLock(dir);
  assert.equal(lock.held, true);
  assert.equal(lockPid(dir), String(process.pid));
});

test('錠: 読めない・空の錠、自分の pid が書かれた錠（コンテナの再起動で同じ pid になる）も取り直す', t => {
  for (const content of ['', 'not a pid', '0', '-5', `${process.pid}\n`]) {
    const dir = tempDir(t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LOCK_FILE), content);
    const lock = acquireInstanceLock(dir, { isAlive: () => true });
    assert.equal(lock.held, true, JSON.stringify(content));
    assert.equal(lockPid(dir), String(process.pid), JSON.stringify(content));
  }
});

test('錠: release は自分が書いた錠だけを消す（取り直されたあとの、ほかの beat の錠は消さない）', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const lock = acquireInstanceLock(dir, { pid: 4100, isAlive: () => false });
  assert.equal(lock.held, true);
  const taken = acquireInstanceLock(dir, { pid: 4200, isAlive: () => false });
  assert.equal(taken.held, true);
  if (lock.held) lock.release();
  assert.equal(lockPid(dir), '4200', '古い持ち主の release が、新しい持ち主の錠を消さない');
  if (taken.held) taken.release();
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test('錠: 同時に起動したとき、作られたばかりで pid がまだ書かれていない（空の）錠を古い錠と見て消さない。少し待って読み直し、生きている持ち主を尊重する', async t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const owner = await liveProcess(t);
  const file = join(dir, LOCK_FILE);
  writeFileSync(file, '');
  const writer = spawn(process.execPath, ['-e', "console.log('ready'); setTimeout(() => require('fs').writeFileSync(process.argv[1], process.argv[2]), 60)", file, String(owner)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { writer.kill(); });
  await new Promise<void>(resolve => { writer.stdout.once('data', () => resolve()); });
  const lock = acquireInstanceLock(dir);
  assert.deepEqual(lock, { held: false, path: file, pid: owner }, '空の錠を消して、自分の錠にしてしまわない');
  assert.equal(lockPid(dir), String(owner));
});

test('錠: pid のあとに、PC の起動の時刻を書く', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const before = Date.now() - uptime() * 1000;
  assert.equal(acquireInstanceLock(dir).held, true);
  const [pid, boot, rest] = lockText(dir).split('\n');
  assert.equal(pid, String(process.pid));
  assert.ok(Math.abs(Number(boot) - before) < 5000, `起動の時刻 ${boot}（今の見積もり ${Math.round(before)}）`);
  assert.equal(rest, '');
});

test('錠: 別の起動のときに書かれた錠は、pid が生きていても取り直す（PC を入れ直して pid が別のプログラムに使われている）。同じ起動の中の時計のずれは許す', async t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const other = await liveProcess(t);
  const BOOT = 1_800_000_000_000;
  assert.equal(acquireInstanceLock(dir, { pid: other, bootTime: () => BOOT }).held, true);
  assert.deepEqual(acquireInstanceLock(dir, { bootTime: () => BOOT + 5000 }), { held: false, path: join(dir, LOCK_FILE), pid: other }, '同じ起動（数秒のずれ）は、動いている beat の錠');
  const later = acquireInstanceLock(dir, { bootTime: () => BOOT + 3_600_000 });
  assert.equal(later.held, true, '1 時間あとの起動なら、前の起動の錠');
  assert.equal(lockText(dir).split('\n')[0], String(process.pid));
});

test('錠: 終わるとき（exit）と、窓を閉じたとき（SIGHUP）に錠を消す。SIGHUP は消してすぐ終わる', t => {
  for (const event of ['exit', 'SIGHUP'] as const) {
    const dir = tempDir(t);
    mkdirSync(dir, { recursive: true });
    const lock = acquireInstanceLock(dir);
    if (!lock.held) assert.fail('取れるはず');
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    releaseOnExit(lock, { on: (name, listener) => { listeners.set(name, listener); }, exit: code => { exits.push(code); } });
    assert.deepEqual([...listeners.keys()].sort(), ['SIGHUP', 'exit']);
    assert.equal(existsSync(join(dir, LOCK_FILE)), true);
    listeners.get(event)!();
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, event);
    assert.deepEqual(exits, event === 'SIGHUP' ? [129] : [], event);
  }
});

const root = new URL('..', import.meta.url);
// 設定の誤り（ループバックでない host）で、待ち受けの前に止まるようにする（試験がポートを開かず、4777 番にも触らない）
const stopsAtSettings = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig(), server: { host: '0.0.0.0', port: 4777 } }));
};
const startMain = (dir: string) => spawnSync(process.execPath, ['src/main.ts', '--data-dir', dir], { cwd: root, encoding: 'utf8', timeout: 60_000 });

test('起動: 同じデータのフォルダで生きている beat があれば、使っている pid を 1 行出して終了コード 1 で止まる（DB も開かない）', async t => {
  const dir = tempDir(t);
  stopsAtSettings(dir);
  const owner = await liveProcess(t);
  writeFileSync(join(dir, LOCK_FILE), `${owner}\n`);
  const run = startMain(dir);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `Could not start: another beat (pid ${owner}) is using this data folder. Stop it first, or delete ${join(dir, LOCK_FILE)} if no beat is running\n`);
  assert.equal(run.stdout, '', '起動のログを出さない');
  assert.deepEqual(readdirSync(dir).sort(), ['beat.lock', 'config.json'], '動いている方の錠はそのまま。DB も作らない');
  assert.equal(lockPid(dir), String(owner));
});

test('起動: 前の beat が残した古い錠は取り直して起動を続け、終われば錠が消える（設定の誤りで止まる起動でも）', t => {
  const fresh = tempDir(t);
  stopsAtSettings(fresh);
  const first = startMain(fresh);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /^Settings error: /u, '錠を越えて、設定の確かめまで進む');
  assert.equal(existsSync(join(fresh, LOCK_FILE)), false, '終わった起動は錠を残さない');
  assert.equal(existsSync(join(fresh, 'beat.db')), true);

  const stale = tempDir(t);
  stopsAtSettings(stale);
  writeFileSync(join(stale, LOCK_FILE), `${deadPid()}\n`);
  const second = startMain(stale);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /^Settings error: /u, '古い錠に止められない');
  assert.equal(existsSync(join(stale, LOCK_FILE)), false);
});
