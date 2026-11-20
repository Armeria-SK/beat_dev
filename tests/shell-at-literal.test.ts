import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatements, noRepo } from '../src/tools/hooks/allowlist.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';

// 実機の会話 85ab1ade: `npm view @types/three version` が splatting として断られた。PowerShell 5.1 の Parser は、引数の位置の @名前 のすぐあとが
// / - \ = + @ ! % * ~ ^ なら @ ごと 1 つの語（Generic）と読み、$types があっても文字のまま渡す（tests/shell-lex-real.test.ts で本物と比べる）。
// splatting のまま断る: 空白・終わり・; | & ( ) { } , . [ : のあと（本物も splatting か構文エラー）、文の頭・式の位置（本物も splatting）、
// $ ` " ' < > # のあと（本物は語と読むが、展開や引用符・コメントと混ざるので、守りとして断ったまま）
const splatOrStop = (command: string): boolean => {
  const lexed = lexShell(command, 'powershell');
  return !lexed.ok || lexed.statements.some(s => s.shapes.includes('splat'));
};

const words = (command: string): string[] => {
  const lexed = lexShell(command, 'powershell');
  assert.ok(lexed.ok, `${command}: ${lexed.ok ? '' : lexed.fail.code}`);
  return lexed.statements.filter(s => s.kind === 'command').flatMap(s => s.words.map(w => w.text));
};

test('PowerShell: 引数の位置の @名前/… などは splatting ではなく、@ ごと 1 つの語（npm の scope 付きの名前）', () => {
  assert.deepEqual(words('npm view @types/three version'), ['npm', 'view', '@types/three', 'version']);
  assert.deepEqual(words('npm i @fontsource/noto-sans-jp'), ['npm', 'i', '@fontsource/noto-sans-jp']);
  assert.deepEqual(words('npm i -D @types/node@24'), ['npm', 'i', '-D', '@types/node@24']);
  for (const arg of ['@a/b', '@a\\b', '@a-b', '@a=b', '@a+b', '@a@b', '@a!b', '@a%b', '@a*b', '@a~b', '@a^b', '@1/x', '@é/x', '@a?/x', '@a/b@c', '@my-org/pkg']) {
    const command = `Write-Output ${arg}`;
    assert.equal(splatOrStop(command), false, command);
    assert.deepEqual(words(command), ['Write-Output', arg], command);
  }
  assert.equal(splatOrStop('Write-Output -p @a/b'), false);
  for (const shell of ['powershell', 'pwsh'] as const) {
    const keys = classifyStatements('npm view @types/three version', { shell, windows: true, repo: noRepo, selfHosts: [] }).results.flatMap(r => r.reasons.map(x => x.key));
    assert.ok(!keys.includes('shape.splat'), `${shell}: ${keys.join(',')}`);
  }
});

test('PowerShell: 本当の splatting と境目の形は今までどおり splatting として扱う（または読まずに止める）', () => {
  const rows = [
    // 本物の Parser でも splatting
    'f @args', 'f @PSBoundParameters', '(f @h)', 'f @h;', 'f @h; ls', 'f @h|x', '{f @h}', 'f @h)', 'f @h}', 'f @a(1)', 'f @a{x}', 'f @a\tx', 'f @a ', 'irm @p', 'Get-ChildItem @p -Recurse',
    'f @_', 'f @_x', 'f @1', 'f @é', 'f @a?b', 'f @a:b', 'f @env:x', 'f @a:',
    // 本物は構文エラー（splatting のあとに . [ , & && ::）
    'f @a.b', 'f @a.Count', 'f @a.b/c', 'f @a[0]', 'f @a,b', 'f @a&', 'f @a&&b', 'f @a::b', 'f @a.', 'f @a..',
    // 本物は語と読むが、守りとして断ったまま
    'f @a$b', 'f @a`b', 'f @a"b"', "f @a'b'", 'f @a<x', 'f @a>x', 'f @a#b',
    // 文の頭・式の位置は本物も splatting
    '@a/b', 'x; @a/b', '& @a/b', '$r = @a/b', '$r=@a-b', '@{ k = @a/b }', 'f (@a/b)',
  ];
  const wrong = rows.filter(row => !splatOrStop(row));
  assert.deepEqual(wrong, []);
  for (const shell of ['powershell', 'pwsh'] as const) {
    const keys = classifyStatements('Get-ChildItem @p', { shell, windows: true, repo: noRepo, selfHosts: [] }).results.flatMap(r => r.reasons.map(x => x.key));
    assert.ok(keys.includes('shape.splat'), `${shell}: ${keys.join(',')}`);
  }
});
