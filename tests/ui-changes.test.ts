import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '../web/src/api.ts';
import { changePicks, changeTotals, diffLines, matchChange, refusalText, scopeOf } from '../web/src/ui/changes.ts';
import { t } from '../web/src/i18n/index.ts';
import { editPath } from '../web/src/ui/tool-row.ts';

// beat 8-5b: Changes の欄の決まり（画面を持たない所）。差分の行の符号・測る点の選び方・Edit の行のパスから欄のファイルを見つける

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: 'modified', added: 1, removed: 1, hunks: null, hidden: false, undo: true, ...over });

test('ui/changes: 差分の行は足した行に +、消した行に −（U+2212）、前後の行は符号なしの空き。塊の見出しは出さず、塊のあいだに … の行', () => {
  const lines = diffLines([
    ['@@ -1,3 +1,3 @@', ' a', '-b', '+c'],
    ['@@ -10,1 +10,2 @@', ' x', '+y'],
  ]);
  assert.deepEqual(lines, [
    { kind: 'same', text: '  a' },
    { kind: 'del', text: '− b' },
    { kind: 'add', text: '+ c' },
    { kind: 'gap', text: '…' },
    { kind: 'same', text: '  x' },
    { kind: 'add', text: '+ y' },
  ]);
  assert.deepEqual(diffLines([]), []);
});

test('ui/changes: 合計はファイルの数と + − の和', () => {
  assert.deepEqual(changeTotals([file('a', { added: 12, removed: 3 }), file('b', { added: 9, removed: 0 })]), { files: 2, added: 21, removed: 3 });
  assert.deepEqual(changeTotals([]), { files: 0, added: 0, removed: 0 });
});

test('ui/changes: 選べる測る点は、選べる元だけ（Build の控えがあるときだけ build、git でなければ記録、会話があれば「この会話」）', () => {
  assert.deepEqual(changePicks({ isGit: true, hasBuild: true, conversation: 'c1' }), ['build', 'commit', 'conversation']);
  assert.deepEqual(changePicks({ isGit: true, hasBuild: false, conversation: 'c1' }), ['commit', 'conversation']);
  assert.deepEqual(changePicks({ isGit: true, hasBuild: false, conversation: undefined }), ['commit']);
  assert.deepEqual(changePicks({ isGit: false, hasBuild: false, conversation: 'c1' }), ['records', 'conversation']);
  assert.deepEqual(changePicks({ isGit: false, hasBuild: true, conversation: undefined }), ['records'], 'git でない製品に build は出さない');
});

test('ui/changes: 選んだ点から口の問いを作る。選ぶ前はサーバーの既定、「この会話」は records と会話の id', () => {
  assert.deepEqual(scopeOf(null, 'c1'), {});
  assert.deepEqual(scopeOf('build', 'c1'), { base: 'build' });
  assert.deepEqual(scopeOf('commit', undefined), { base: 'commit' });
  assert.deepEqual(scopeOf('conversation', 'c1'), { base: 'records', conversation: 'c1' });
});

test('ui/changes: Edit の行のパスから欄のファイルを見つける。相対は製品の中の場所としてそのまま、絶対は製品の場所の下のときだけ。外の同じ名前・名前の終わりだけ同じものは選ばない', () => {
  const files = [file('src/upload/queue.ts'), file('queue.ts'), file('test/queue.test.ts')];
  const root = 'D:\\work\\uploader';
  assert.equal(matchChange(files, 'src/upload/queue.ts', root)?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, './src/upload/queue.ts', root)?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, 'src\\upload\\queue.ts', null)?.path, 'src/upload/queue.ts', '相対なら製品の場所が分からなくても合わせる');
  assert.equal(matchChange(files, 'D:\\work\\uploader\\src\\upload\\queue.ts', root)?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, 'D:/work/uploader/queue.ts', `${root}\\`)?.path, 'queue.ts', '製品の場所の終わりの区切りは問わない');
  assert.equal(matchChange(files, 'D:\\work\\uploader\\SRC\\Upload\\Queue.ts', root)?.path, 'src/upload/queue.ts', '大文字小文字は問わない');
  assert.equal(matchChange(files, 'X:\\elsewhere\\src\\upload\\queue.ts', root), undefined, '製品の外の同じ名前のファイルには合わせない');
  assert.equal(matchChange(files, 'D:\\work\\uploader-old\\queue.ts', root), undefined, '名前の頭だけ同じ別のフォルダは外');
  assert.equal(matchChange(files, '/home/me/uploader/queue.ts', '/home/me/uploader')?.path, 'queue.ts');
  assert.equal(matchChange(files, '/home/me/uploader/queue.ts', null), undefined, '製品の場所が分からないときの絶対パスは合わせない');
  assert.equal(matchChange(files, 'upload/queue.ts', root), undefined, '名前の終わりが同じだけでは合わせない');
  assert.equal(matchChange(files, 'src/other.ts', root), undefined);
  assert.equal(matchChange(files, '  ', root), undefined);
});

test('ui/tool-row: editPath は書く道具（file_write・file_edit・table_write）の path だけを返す', () => {
  assert.equal(editPath('file_edit', JSON.stringify({ path: 'src/a.ts', old: 'x', new: 'y' })), 'src/a.ts');
  assert.equal(editPath('file_write', JSON.stringify({ path: ' D:\\p\\b.ts ', content: '' })), 'D:\\p\\b.ts');
  assert.equal(editPath('table_write', JSON.stringify({ path: 'data/t.csv', rows: [] })), 'data/t.csv');
  assert.equal(editPath('file_read', JSON.stringify({ path: 'src/a.ts' })), null);
  assert.equal(editPath('file_edit', '{"path": "src/a'), null, '途中で切れた入力からは出さない');
  assert.equal(editPath('file_edit', JSON.stringify({ path: '' })), null);
});

test('ui/changes: 断られた理由は、どの理由にも文がある（辞書の項目を文字のまま書く）。3 件まで見せて、残りは数', () => {
  const reasons = ['not_changed', 'hidden', 'unsafe_path', 'link', 'not_kept', 'too_large', 'cannot_keep', 'same_file', 'changed', 'failed'] as const;
  for (const reason of reasons) {
    const text = refusalText(t, [{ path: 'a.ts', reason }]);
    assert.ok(text.startsWith('a.ts: ') && text.length > 'a.ts: '.length && !text.includes('ui.changes'), reason);
  }
  const many = refusalText(t, reasons.slice(0, 5).map((reason, i) => ({ path: `f${i}`, reason })));
  assert.equal(many.split(' · ').length, 4);
});
