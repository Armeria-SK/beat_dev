import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationTarget } from '../web/src/ui/notifications.ts';
import { parseRoute, routeHash } from '../web/src/ui/routes.ts';

// 会話の経路は、その発言の番号も持てる（#/c/<id>/m/<発言>）。受け入れの「Show in conversation」などが、会話を開くだけでなくその発言まで飛ぶために使う。

test('bl-ui-conversation/routes: #/c/<id>/m/<発言> は会話と発言の番号に読め、書き戻すと同じハッシュになる', () => {
  assert.deepEqual(parseRoute('#/c/abc/m/12'), { view: 'chat', id: 'abc', messageId: 12 });
  assert.equal(routeHash({ view: 'chat', id: 'abc', messageId: 12 }), '#/c/abc/m/12');
  assert.equal(routeHash(parseRoute('#/c/abc/m/12')), '#/c/abc/m/12');
  assert.deepEqual(parseRoute('#/c/a%20b/m/3'), { view: 'chat', id: 'a b', messageId: 3 }, '会話の ID は符号化して書き、読むときに戻す');
  assert.equal(routeHash({ view: 'chat', id: 'a b', messageId: 3 }), '#/c/a%20b/m/3');
});

test('bl-ui-conversation/routes: 発言の印が無い・形が合わない経路は、今までどおり会話だけ（書き戻すと印は落ちる）', () => {
  assert.deepEqual(parseRoute('#/c/abc'), { view: 'chat', id: 'abc' });
  assert.equal(routeHash({ view: 'chat', id: 'abc' }), '#/c/abc');
  for (const tail of ['m', 'm/', 'm/0', 'm/-1', 'm/abc', 'm/1.5', 'm/01x', 'm/99999999999999999999', 'x/3']) {
    const route = parseRoute(`#/c/abc/${tail}`);
    assert.deepEqual(route, { view: 'chat', id: 'abc' }, tail);
    assert.equal(routeHash(route), '#/c/abc', tail);
  }
});

test('bl-ui-conversation/routes: 通知の飛び先も発言の印を残す', () => {
  assert.deepEqual(notificationTarget('#/c/abc/m/7'), { hash: '#/c/abc/m/7', view: 'chat' });
  assert.deepEqual(notificationTarget('#/c/abc'), { hash: '#/c/abc', view: 'chat' });
});
