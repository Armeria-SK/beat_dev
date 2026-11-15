import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { DIALOG_ARGS, type DialogChild, type FolderDialogOptions } from '../src/projects/folder-dialog.ts';
import { startApp, waitFor } from './app-setup.ts';
import { tempDir, testConfig } from './helpers.ts';

const TAILNET = 'beat.tail1234.ts.net';

class FakeChild extends EventEmitter implements DialogChild {
  readonly stdout = new EventEmitter();
  killed = 0;
  kill(): boolean { this.killed += 1; setImmediate(() => this.emit('close', null)); return true; }
  answer(text: string): void { this.stdout.emit('data', Buffer.from(text)); this.emit('close', 0); }
}

function fakeSpawner() {
  const calls: Array<{ command: string; args: readonly string[]; env: Record<string, string>; child: FakeChild }> = [];
  const spawn: FolderDialogOptions['spawn'] = (command, args, env) => { const child = new FakeChild(); calls.push({ command, args, env, child }); return child; };
  return { calls, spawn };
}

const ok = (path: string) => `OK:${Buffer.from(path, 'utf8').toString('base64')}`;

async function setup(t: Parameters<typeof startApp>[0], options: FolderDialogOptions = {}) {
  const fake = fakeSpawner();
  const logs: string[] = [];
  const s = await startApp(t, { folderDialog: { platform: 'win32', spawn: fake.spawn, log: line => { logs.push(line); }, ...options } });
  const pick = (body: unknown = {}) => s.json('/api/folders/pick', 'POST', body);
  return { ...s, fake, pick, dialogLogs: logs };
}

function rawCall(port: number, method: string, headers: Record<string, string>, body?: string): { done: Promise<{ status: number; body: any }>; cut: () => void } {
  let cut = () => undefined as void;
  const done = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/folders/pick', method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    cut = () => { req.destroy(); };
    req.end(body);
  });
  return { done, cut };
}

const tailnet = { host: TAILNET, origin: `https://${TAILNET}`, 'tailscale-user-login': 'me@example.com', 'sec-fetch-site': 'same-origin' };

test('フォルダを選ぶ窓: 選んだフォルダは絶対パスで返る。出発点は環境変数で渡し、命令には入れない。窓の題は beat のもの', async t => {
  const s = await setup(t);
  const start = realpathSync.native(tempDir(t as never));
  const pending = s.pick({ path: start });
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  const call = s.fake.calls[0]!;
  assert.match(call.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
  assert.deepEqual(call.args, DIALOG_ARGS);
  assert.ok(!call.args.some(arg => arg.includes(start)), '持ち主の文は命令に入らない');
  assert.equal(call.env.BEAT_PICK_START, start);
  const script = Buffer.from(DIALOG_ARGS.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /IFileOpenDialog/u);
  assert.match(script, /FOS_PICKFOLDERS/u);
  assert.match(script, /TopMost = true/u);
  assert.match(script, /SetTitle\("beat — Choose a product folder"\)/u);
  call.child.answer(ok('C:\\Work\\Shop ä'));
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { path: 'C:\\Work\\Shop ä' });
  assert.equal(s.app.folderDialog.open, false);
});

test('フォルダを選ぶ窓: 出発点はリンクをたどった先の実体（ほかのフォルダの確かめと同じ歩き方）。フォルダでない・ネットワークのパスはホーム', async t => {
  const s = await setup(t);
  const base = realpathSync.native(tempDir(t as never));
  const target = join(base, 'target');
  mkdirSync(target);
  symlinkSync(target, join(base, 'jump'), 'junction');
  const starts = [join(base, 'jump'), 'not a path', '\\\\server\\share', '//server/share'];
  for (const [i, start] of starts.entries()) {
    const pending = s.pick({ path: start });
    await waitFor(() => s.fake.calls.length === i + 1, 'spawned');
    assert.equal(s.fake.calls[i]!.env.BEAT_PICK_START, i === 0 ? target : homedir(), start);
    s.fake.calls[i]!.child.answer('CANCEL');
    assert.deepEqual((await pending).body, { cancelled: true });
  }
});

test('フォルダを選ぶ窓: 閉じたら cancelled', async t => {
  const s = await setup(t);
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  s.fake.calls[0]!.child.answer('CANCEL');
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { cancelled: true });
});

test('フォルダを選ぶ窓: 絶対パスでない答えは、パスではなく失敗', async t => {
  const s = await setup(t);
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  s.fake.calls[0]!.child.answer(ok('relative\\folder'));
  const done = await pending;
  assert.equal(done.status, 500);
  assert.equal(done.body.error, 'folder_dialog_failed');
});

test('フォルダを選ぶ窓: 時間切れで窓を止め、cancelled を返す', async t => {
  const s = await setup(t, { timeoutMs: 50 });
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  const done = await pending;
  assert.deepEqual(done.body, { cancelled: true });
  assert.equal(s.fake.calls[0]!.child.killed, 1);
  assert.equal(s.app.folderDialog.open, false);
});

test('フォルダを選ぶ窓: 同時に 1 つだけ（2 つ目は 409）。1 つ目を閉じたら次を開ける', async t => {
  const s = await setup(t, { timeoutMs: 5000 });
  const first = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  const second = await s.pick();
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'folder_dialog_busy');
  assert.match(second.body.message, /already open/u);
  assert.equal(s.fake.calls.length, 1);
  s.fake.calls[0]!.child.answer('CANCEL');
  await first;
  const third = s.pick();
  await waitFor(() => s.fake.calls.length === 2, 'spawned again');
  s.fake.calls[1]!.child.answer('CANCEL');
  assert.equal((await third).status, 200);
});

test('フォルダを選ぶ窓: 画面が要求を切ったら（タブを閉じた・画面を離れた）窓を止める', async t => {
  const s = await setup(t, { timeoutMs: 4000 });
  const port = Number(new URL(s.origin).port);
  const call = rawCall(port, 'POST', { host: `127.0.0.1:${port}`, origin: s.origin }, '{}');
  call.done.catch(() => undefined);
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  call.cut();
  await waitFor(() => s.fake.calls[0]!.child.killed === 1, 'killed');
  await waitFor(() => !s.app.folderDialog.open, 'closed');
  assert.deepEqual(s.dialogLogs, [], '失敗として記録しない');
});

test('フォルダを選ぶ窓: アプリを閉じると開いている窓を止め、待っている要求は cancelled（失敗の記録は残さない）', async t => {
  const fake = fakeSpawner();
  const logs: string[] = [];
  const paths = resolvePaths(tempDir(t as never));
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, folderDialog: { platform: 'win32', spawn: fake.spawn, timeoutMs: 3000 } });
  const pending = app.folderDialog.pick(undefined);
  assert.equal(fake.calls.length, 1);
  app.close();
  assert.equal(fake.calls[0]!.child.killed, 1, '閉じたその場で止める（時間切れを待たない）');
  assert.equal(app.folderDialog.open, false);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(logs.filter(line => line.includes('folder window')).length, 0);
});

test('フォルダを選ぶ窓: Tailscale（別の端末）から開いたページには出さず、口も 403。この PC だけ', async t => {
  const s = await setup(t, { timeoutMs: 200 });
  s.web.setOrigins([s.origin, `https://${TAILNET}`]);
  const port = Number(new URL(s.origin).port);
  const remote = await rawCall(port, 'POST', tailnet, '{}').done;
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error, 'folder_dialog_not_local');
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual((await rawCall(port, 'GET', tailnet).done).body, { available: false });
  assert.deepEqual((await s.json('/api/folders/pick', 'GET')).body, { available: true });
});

test('フォルダを選ぶ窓: 転送された要求が Host を 127.0.0.1 にしてこの PC のふりをしても断る（ログイン名の一覧に無い人も・ログイン名の無い要求も）', async t => {
  const s = await setup(t, { timeoutMs: 200 });
  s.web.setOrigins([s.origin, `https://${TAILNET}`]);
  const port = Number(new URL(s.origin).port);
  const local = { host: `127.0.0.1:${port}`, origin: s.origin, 'sec-fetch-site': 'same-origin' };
  for (const extra of [{ 'tailscale-user-login': 'stranger@evil.com', 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https' }, { 'x-forwarded-for': '100.64.0.9' }, { 'tailscale-funnel-request': '?1' }, { forwarded: 'for=100.64.0.9' }]) {
    const posted = await rawCall(port, 'POST', { ...local, ...extra }, '{}').done;
    assert.deepEqual([posted.status, posted.body.reason], [403, 'forwarded'], JSON.stringify(extra));
    const asked = await rawCall(port, 'GET', { ...local, ...extra }).done;
    assert.equal(asked.status, 403, JSON.stringify(extra));
  }
  assert.equal(s.fake.calls.length, 0);
});

test('フォルダを選ぶ窓: ほかの書き込みの口と同じく Origin が要る', async t => {
  const s = await setup(t);
  const res = await fetch(`${s.origin}/api/folders/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(s.fake.calls.length, 0);
});

test('フォルダを選ぶ窓: Windows でなければ 501 で、画面にも出さない', async t => {
  const s = await setup(t, { platform: 'linux' });
  const done = await s.pick();
  assert.equal(done.status, 501);
  assert.equal(done.body.error, 'folder_dialog_unsupported');
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual((await s.json('/api/folders/pick', 'GET')).body, { available: false });
});
