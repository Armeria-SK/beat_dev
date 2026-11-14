import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { editListItem } from '../web/src/ui/settings/commit.ts';

// Settings › Hooks の行は、画面に出ているフックそのものを直す・消す（番号だけで当てない。backlog 188）。

const a = { matcher: '.*', command: ['node', 'a.js'], timeoutMs: 1000, onError: 'deny' };
const b = { matcher: 'shell', command: ['node', 'b.js'], timeoutMs: 1000, onError: 'deny' };
const c = { matcher: '.*', command: ['node', 'c.js'], timeoutMs: 1000, onError: 'ask' };

test('Settings › Hooks: 別のタブで並びが変わっていても、出ていたフックを直す・消す（同じ番号の別のフックに当てない）', () => {
  const off = (h: typeof a) => ({ ...h, enabled: false });
  assert.deepEqual(editListItem([a, b], 1, b, off), [a, off(b)], 'ふだんは番号どおり');
  assert.deepEqual(editListItem([b, a], 1, b, off), [off(b), a], '並びが入れ替わっていたら、出ていたフックを探して直す');
  assert.deepEqual(editListItem([c, b, a], 0, a, () => null), [c, b], '消すのも出ていたフックだけ');
  assert.equal(editListItem([c, b], 0, a, off), null, '出ていたフックがもう無い（別のタブで消された・変えられた）なら、何も当てない');
  assert.equal(editListItem([], 0, a, () => null), null);
});

test('Settings › Hooks の配線: 行の編集と削除は editListItem を通し、当たらなければ保存せず知らせて読み直す', () => {
  const source = readFileSync(new URL('../web/src/ui/settings/computer.tsx', import.meta.url), 'utf8');
  const row = source.slice(source.indexOf('function HookRow('), source.indexOf('function AddHook('));
  assert.ok(row.includes('editListItem(hooksOf(c, stage), index, hook, make)'), '出ていたフック（hook）で当てる');
  assert.ok(!/hooksOf\(c, stage\)\.(map|filter)\(/u.test(row), '番号だけで map / filter しない');
  assert.ok(row.includes("t('ui.set.hooks.moved')") && row.includes('ctx.reload()'), '当たらなければ知らせて一覧を読み直す');
  assert.equal(typeof en['ui.set.hooks.moved'], 'string');
});

test('Settings › Hooks の配線: 当たらなかったときだけ知らせて読み直す（gone の向き。レビューの直し）', () => {
  const source = readFileSync(new URL('../web/src/ui/settings/computer.tsx', import.meta.url), 'utf8');
  const row = source.slice(source.indexOf('function HookRow('), source.indexOf('function AddHook('));
  assert.ok(row.includes('gone = next === null;'), '当たらないときが gone');
  assert.ok(row.includes('return next === null ? c : setHooks(c, stage, next);'), '当たらなければ書かない');
  assert.ok(/\.then\(\(\) => \{ if \(gone\) \{ toast\(/u.test(row), '知らせるのは gone のときだけ');
});
