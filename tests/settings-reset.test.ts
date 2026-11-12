import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import { accessWidening } from '../web/src/settings/access.ts';
import { startApp } from './app-setup.ts';

const KEY = 'Zk3qP9xW7mB2vN8cLd5Tq1';
const ENV_TEXT = `# my keys\nFAKE_KEY=${KEY}\nOTHER=1\n`;

async function start(t: Parameters<typeof startApp>[0]) {
  const s = await startApp(t, {
    env: { FAKE_KEY: KEY },
    configure: c => {
      c.server.origins = ['https://me.example.ts.net'];
      c.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
      c.tools.deny = [...c.tools.deny, '~/private'];
      c.tools.hooks.preToolUse = [{ matcher: 'shell_run', command: ['node', 'guard.js'], timeoutMs: 1000, onError: 'deny' }];
      c.tools.policies = { file_write: 'ask' };
      c.tools.shell.deny = ['rm *'];
      c.profile.name = 'Mine';
    },
  });
  writeFileSync(s.paths.env, ENV_TEXT);
  const backups = () => readdirSync(dirname(s.paths.config)).filter(name => name.includes('.reset-'));
  return { ...s, backups };
}

test('Reset: 設定ファイルの控えを書いてから既定に戻し、控えの名前を返す。フォルダ・サーバー・鍵・会話は残す', async t => {
  const s = await start(t);
  const conversation = s.app.conversations.create({ title: 'kept' });
  const before = readFileSync(s.paths.config, 'utf8');
  const was = s.app.config();

  const done = await s.json('/api/settings/reset', 'POST', {});
  assert.equal(done.status, 200);
  assert.match(done.body.backup, /^config\.json\.reset-\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/u);
  assert.deepEqual(s.backups(), [done.body.backup]);
  assert.equal(readFileSync(join(dirname(s.paths.config), done.body.backup), 'utf8'), before, '控えは戻す前の設定ファイルそのまま');

  const now = s.app.config();
  const fresh = defaultConfig();
  assert.deepEqual(now.models, []);
  assert.deepEqual(now.providers, fresh.providers);
  assert.deepEqual(now.routing, fresh.routing);
  assert.deepEqual(now.tools.hooks, { preToolUse: [], postToolUse: [] });
  assert.deepEqual(now.tools.policies, {});
  assert.deepEqual(now.tools.shell, fresh.tools.shell);
  assert.deepEqual(now.profile, fresh.profile);
  assert.deepEqual(now.tools.roots, was.tools.roots, 'フォルダは残す');
  assert.deepEqual(now.tools.deny, was.tools.deny, '触れないパスは残す');
  assert.deepEqual(now.server, was.server, '待ち受けと認証は残す');
  assert.deepEqual(JSON.parse(readFileSync(s.paths.config, 'utf8')), now, 'ファイルにも書かれている');
  assert.deepEqual(done.body.config, now);
  assert.deepEqual(done.body.models, []);

  assert.equal(readFileSync(s.paths.env, 'utf8'), ENV_TEXT, '.env は触らない');
  assert.equal(s.app.env.FAKE_KEY, KEY, '動いている環境の鍵も残る');
  assert.equal(s.app.conversations.get(conversation.id)?.title, 'kept');
  assert.equal(JSON.stringify(done.body).includes(KEY), false);
});

test('Reset の下見（GET）: 戻したあとの設定を返すだけで、何も書かない。広がる変更（フックが外れる・方針が緩む）を画面が数えられる', async t => {
  const s = await start(t);
  const before = readFileSync(s.paths.config, 'utf8');
  const preview = await s.json('/api/settings/reset', 'GET');
  assert.equal(preview.status, 200);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before);
  assert.deepEqual(s.backups(), []);
  const kinds = accessWidening(s.app.config(), preview.body.config).map(a => a.kind);
  assert.deepEqual(kinds.sort(), ['hook-removed', 'provider-key', 'shell-deny-removed', 'tool-policy-loosened'], '試験の設定には Anthropic が無いので、既定のプロバイダが戻るのも並ぶ');
  const done = await s.json('/api/settings/reset', 'POST', {});
  assert.deepEqual(done.body.config, preview.body.config, '下見と実際は同じ');
});

test('Reset: 控えを書けないときは戻さない（409）。Origin の無い要求は届かない', async t => {
  const s = await start(t);
  const before = readFileSync(s.paths.config, 'utf8');
  s.app.configStore.backup = () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); };
  const refused = await s.json('/api/settings/reset', 'POST', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'reset_no_backup');
  assert.match(refused.body.message, /EACCES/u);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before);
  assert.equal(s.app.config().models.length, 2);

  const noOrigin = await fetch(`${s.origin}/api/settings/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
});

test('Reset: 同じ時刻の控えがすでにあれば上書きしない', async t => {
  const s = await start(t);
  const name = s.app.configStore.backup(1_800_000_000_000);
  assert.throws(() => s.app.configStore.backup(1_800_000_000_000), { code: 'EEXIST' });
  assert.deepEqual(s.backups(), [name]);
});
