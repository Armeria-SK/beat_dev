import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConfigStore } from '../src/config/store.ts';
import { judgeOff } from '../src/tools/pipeline.ts';
import { startApp } from './app-setup.ts';

// J-4: 設定ファイルを外から書き換えて読み直しても、判定なしのモードは On にはなるが Off にはならない。Off にできるのは画面の設定（applyConfig）と、起動し直したときだけ

function editFile(path: string, edit: (raw: any) => void): void {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  edit(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2));
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
}

test('J-4 読み直し: 設定ファイルを外から Off に書き換えても On のまま。警告を記録し、持ち主に知らせる。同じ書き換えのほかの項目は効く', async t => {
  const s = await startApp(t);
  assert.equal(judgeOff(s.app.config()), false);
  assert.equal(s.app.notifications.list().some(n => n.dedup_key === 'judge-off-start'), false, 'On で起動したときは知らせない');
  editFile(s.paths.config, raw => { raw.routing.judgeMode = 'off'; raw.routing.retriesPerModel = 2; });
  const config = s.app.config();
  assert.equal(config.routing.retriesPerModel, 2, 'ほかの項目は読み直される');
  assert.equal(judgeOff(config), false, 'Off にはならない');
  assert.equal(judgeOff(s.app.config()), false, 'もう一度読んでも On のまま');
  assert.ok(s.logs.some(line => line.startsWith('[WARN]') && /judge/iu.test(line)), s.logs.join('\n'));
  const notes = s.app.notifications.list().filter(n => n.dedup_key === 'judge-off-file');
  assert.equal(notes.length, 1, JSON.stringify(s.app.notifications.list()));
  assert.equal(notes[0]!.kind, 'health_alert');
  assert.equal(notes[0]!.link, '#/settings');
});

test('J-4 読み直し: 画面の設定（PUT /api/settings）からは Off にできる。そのあとファイルを On に書き換えると、その場で On', async t => {
  const s = await startApp(t);
  const config = s.app.config();
  const put = await s.json('/api/settings', 'PUT', { config: { ...config, routing: { ...config.routing, judgeMode: 'off' } } });
  assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));
  assert.equal(judgeOff(s.app.config()), true);
  assert.equal(s.app.notifications.list().some(n => n.dedup_key === 'judge-off-file'), false, '画面からの Off は知らせない');
  editFile(s.paths.config, raw => { raw.routing.judgeMode = 'on'; });
  assert.equal(judgeOff(s.app.config()), false);
  editFile(s.paths.config, raw => { raw.routing.judgeMode = 'off'; });
  assert.equal(judgeOff(s.app.config()), false, 'ファイルからは Off に戻せない');
});

test('J-4 読み直し: Off で起動すると、警告を記録して持ち主に知らせる（知らせの仕組みができる前の読み込みでも落ちない）。そのあとファイルの書き換えで鍵を消すと On（鍵が無い = On）', async t => {
  const s = await startApp(t, { configure: c => { c.routing.judgeMode = 'off'; } });
  assert.equal(judgeOff(s.app.config()), true);
  assert.equal(s.logs.filter(line => line.startsWith('[WARN] Started without the judge')).length, 1, s.logs.join('\n'));
  const started = s.app.notifications.list().filter(n => n.dedup_key === 'judge-off-start');
  assert.equal(started.length, 1);
  assert.equal(started[0]!.kind, 'health_alert');
  editFile(s.paths.config, raw => { delete raw.routing.judgeMode; });
  assert.equal(judgeOff(s.app.config()), false);
});

test('J-4 読み直し: 起動し直すと、ファイルの Off に従う（起動の読み込みは持ち主が起動したときだけ）', async t => {
  const s = await startApp(t);
  editFile(s.paths.config, raw => { raw.routing.judgeMode = 'off'; });
  assert.equal(judgeOff(s.app.config()), false);
  const fresh = new ConfigStore(s.paths.config);
  assert.equal(judgeOff(fresh.current()), true);
  assert.equal(fresh.takeStartedOff(), true, '起動の読み込みが Off なら、警告の印が立つ');
  assert.equal(fresh.takeStartedOff(), false, '印は 1 回だけ');
});
