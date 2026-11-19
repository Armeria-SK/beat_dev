import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '../web/src/api.ts';
import { changePicks, changeTotals, diffLines, matchChange, scopeOf } from '../web/src/ui/changes.ts';
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

test('ui/changes: Edit の行のパス（相対・絶対・\\ 区切り）から欄のファイルを見つける。名前の終わりが同じだけのものは選ばず、長く合うほうを選ぶ', () => {
  const files = [file('src/upload/queue.ts'), file('queue.ts'), file('test/queue.test.ts')];
  assert.equal(matchChange(files, 'src/upload/queue.ts')?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, './src/upload/queue.ts')?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, 'D:\\work\\uploader\\src\\upload\\queue.ts')?.path, 'src/upload/queue.ts');
  assert.equal(matchChange(files, '/home/me/uploader/queue.ts')?.path, 'queue.ts');
  assert.equal(matchChange(files, 'D:\\work\\uploader\\SRC\\Upload\\Queue.ts')?.path, 'src/upload/queue.ts', '大文字小文字は問わない');
  assert.equal(matchChange(files, 'myqueue.ts'), undefined, '/ の区切りでないところでは合わせない');
  assert.equal(matchChange(files, 'src/other.ts'), undefined);
  assert.equal(matchChange(files, '  '), undefined);
});

test('ui/tool-row: editPath は書く道具（file_write・file_edit・table_write）の path だけを返す', () => {
  assert.equal(editPath('file_edit', JSON.stringify({ path: 'src/a.ts', old: 'x', new: 'y' })), 'src/a.ts');
  assert.equal(editPath('file_write', JSON.stringify({ path: ' D:\\p\\b.ts ', content: '' })), 'D:\\p\\b.ts');
  assert.equal(editPath('table_write', JSON.stringify({ path: 'data/t.csv', rows: [] })), 'data/t.csv');
  assert.equal(editPath('file_read', JSON.stringify({ path: 'src/a.ts' })), null);
  assert.equal(editPath('file_edit', '{"path": "src/a'), null, '途中で切れた入力からは出さない');
  assert.equal(editPath('file_edit', JSON.stringify({ path: '' })), null);
});
