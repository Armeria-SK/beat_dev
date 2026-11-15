import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { DIALOG_ARGS, type DialogChild, type FolderDialogOptions } from '../src/projects/folder-dialog.ts';
import { startApp, waitFor } from './app-setup.ts';
import { tempDir } from './helpers.ts';

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
  const s = await startApp(t, { folderDialog: { platform: 'win32', spawn: fake.spawn, ...options } });
  const pick = (body: unknown = {}) => s.json('/api/folders/pick', 'POST', body);
  return { ...s, fake, pick };
}

function tailnetCall(port: number, method: string, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/folders/pick', method, headers: {
      host: TAILNET, origin: `https://${TAILNET}`, 'tailscale-user-login': 'me@example.com', 'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('folder dialog: the chosen folder comes back as an absolute path; the start folder goes by environment, never in the command', async t => {
  const s = await setup(t);
  const start = tempDir(t as never);
  const pending = s.pick({ path: start });
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  const call = s.fake.calls[0]!;
  assert.match(call.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
  assert.deepEqual(call.args, DIALOG_ARGS);
  assert.ok(!call.args.some(arg => arg.includes(start)), 'the owner text is not in the command');
  assert.equal(call.env.BEAT_PICK_START, start);
  const script = Buffer.from(DIALOG_ARGS.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /IFileOpenDialog/u);
  assert.match(script, /FOS_PICKFOLDERS/u);
  assert.match(script, /TopMost = true/u);
  call.child.answer(ok('C:\\Work\\Shop ä'));
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { path: 'C:\\Work\\Shop ä' });
  assert.equal(s.app.folderDialog.open, false);
});

test('folder dialog: a start that is not an existing folder starts at home', async t => {
  const s = await setup(t);
  for (const [i, start] of ['not a path', '\\\\server\\share', '//server/share'].entries()) {
    const pending = s.pick({ path: start });
    await waitFor(() => s.fake.calls.length === i + 1, 'spawned');
    assert.equal(s.fake.calls[i]!.env.BEAT_PICK_START, homedir(), start);
    s.fake.calls[i]!.child.answer('CANCEL');
    assert.deepEqual((await pending).body, { cancelled: true });
  }
});

test('folder dialog: closing the window answers cancelled', async t => {
  const s = await setup(t);
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  s.fake.calls[0]!.child.answer('CANCEL');
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { cancelled: true });
});

test('folder dialog: an answer that is not an absolute path is a failure, not a path', async t => {
  const s = await setup(t);
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  s.fake.calls[0]!.child.answer(ok('relative\\folder'));
  const done = await pending;
  assert.equal(done.status, 500);
  assert.equal(done.body.error, 'folder_dialog_failed');
});

test('folder dialog: after the time limit the window is killed and the answer is cancelled', async t => {
  const s = await setup(t, { timeoutMs: 50 });
  const pending = s.pick();
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  const done = await pending;
  assert.deepEqual(done.body, { cancelled: true });
  assert.equal(s.fake.calls[0]!.child.killed, 1);
  assert.equal(s.app.folderDialog.open, false);
});

test('folder dialog: one window at a time (a second request gets 409), and the next one opens after the first closes', async t => {
  const s = await setup(t);
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

test('folder dialog: closing the app kills an open window', async t => {
  const s = await setup(t);
  void s.pick().catch(() => undefined);
  await waitFor(() => s.fake.calls.length === 1, 'spawned');
  s.app.folderDialog.stop();
  assert.equal(s.fake.calls[0]!.child.killed, 1);
  await waitFor(() => !s.app.folderDialog.open, 'closed');
});

test('folder dialog: refused for a page opened from another device (Tailscale), and offered only on this PC', async t => {
  const s = await setup(t, { timeoutMs: 200 });
  s.web.setOrigins([s.origin, `https://${TAILNET}`]);
  const port = Number(new URL(s.origin).port);
  const remote = await tailnetCall(port, 'POST', '{}');
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error, 'folder_dialog_not_local');
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual((await tailnetCall(port, 'GET')).body, { available: false });
  assert.deepEqual((await s.json('/api/folders/pick', 'GET')).body, { available: true });
});

test('folder dialog: needs the same Origin as the other write routes', async t => {
  const s = await setup(t);
  const res = await fetch(`${s.origin}/api/folders/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(s.fake.calls.length, 0);
});

test('folder dialog: not Windows answers 501 and is not offered', async t => {
  const s = await setup(t, { platform: 'linux' });
  const done = await s.pick();
  assert.equal(done.status, 501);
  assert.equal(done.body.error, 'folder_dialog_unsupported');
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual((await s.json('/api/folders/pick', 'GET')).body, { available: false });
});
