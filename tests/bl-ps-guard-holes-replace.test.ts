import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// L176: PowerShell の PS_METHOD_OK（src/tools/hooks/shell-lex.ts）は replace を「文字列の道具」として通していたので、ファイルの .Replace(先, 控え)（先を上書きして元を消す。控えが $null の形は 5.1 では失敗するので、控えの名前を書く形）が聞かれずに動いた。
// shell-lex.ts の chain は、呼ぶ先の値が文字列と分かるときだけ Replace を通す。ここでは、通る形（文字列の Replace）・聞く形（静的な [IO.File]::Replace と、値が文字列か分からない Replace）を試験にする

const psAvailable = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';
const SKIP = !psAvailable && 'Windows の PowerShell が無い';

function setup(t: { after: (fn: () => void) => void }, judge: 'allow' | 'ask') {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config: AppConfig = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.tools.shell.shell = 'powershell';
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, {
    registry, approvals, pending, db, emit: () => undefined, conversationTainted: () => false, lastUserRequest: () => 'list the files',
    autoClassify: async () => `{"decision":"${judge}","reason":"not sure"}`,
  });
  const file = (name: string) => join(paths.workspace, name);
  const seed = () => { writeFileSync(file('src.txt'), 'S'); writeFileSync(file('dest.txt'), 'D'); };
  return { call, file, seed, cwd: paths.workspace };
}

const verdictOf = (command: string, shell: 'powershell' | 'pwsh', t: { after: (fn: () => void) => void }) => {
  const ws = realish(join(tempDir(t), 'workspace'));
  mkdirSync(ws, { recursive: true });
  const v = checkShellCommand(command, ws, { policy: { roots: [{ path: ws, mode: 'write' }], deny: [] }, outsideRoots: 'ask', shell, windows: true });
  return { decision: v.decision, keys: v.reasonKeys };
};

const THE_FILE_OP = `Get-ChildItem src.txt | ForEach-Object { $_.Replace('dest.txt', 'dest.bak') }`;

test('実機（Windows PowerShell 5.1）: ファイルの .Replace(先, 控え) は、先を元の中身で上書きして元のファイルを消す（文字列の Replace とは別物）。控えが $null の形は 5.1 では空の文字になって失敗する', { skip: SKIP }, t => {
  const s = setup(t, 'ask');
  s.seed();
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-Command', THE_FILE_OP], { cwd: s.cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(s.file('src.txt')), false, '元のファイルが消えた');
  assert.equal(readFileSync(s.file('dest.txt'), 'utf8'), 'S', '先が元の中身で上書きされた');
  assert.equal(readFileSync(s.file('dest.bak'), 'utf8'), 'D', '先の元の中身は控えに移った');
  const sub = join(s.cwd, 'n');
  mkdirSync(sub);
  writeFileSync(join(sub, 'src.txt'), 'S');
  writeFileSync(join(sub, 'dest.txt'), 'D');
  const nulled = spawnSync('powershell.exe', ['-NoProfile', '-Command', THE_FILE_OP.replace("'dest.bak'", '$null')], { cwd: sub, encoding: 'utf8' });
  assert.match(nulled.stderr, /not of a legal form/u, '控えが $null の形は 5.1 では動かない（空の文字になる）');
  assert.ok(existsSync(join(sub, 'src.txt')) && readFileSync(join(sub, 'dest.txt'), 'utf8') === 'D');
  const text = spawnSync('powershell.exe', ['-NoProfile', '-Command', `'dest.txt'.Replace('t', 'T')`], { cwd: s.cwd, encoding: 'utf8' });
  assert.equal(text.stdout.trim(), 'desT.TxT', '対照: 文字列の Replace は文字を置き換えるだけ');
});

// 毎日の形: 文字列と分かる値の Replace。直る前も直ったあとも、確かめなしで通る（前の版で実測）
const TEXT_REPLACE: readonly string[] = [
  `Get-ChildItem | ForEach-Object { $_.Name.Replace('a','b') }`,
  `Get-ChildItem | ForEach-Object { $_.FullName.Replace('\\','/') }`,
  `Get-ChildItem | ForEach-Object { $_.BaseName.ToLower().Replace(' ','_') }`,
  `Get-ChildItem | ForEach-Object { $_.Name.Trim().Replace('a','b').Replace('c','d') }`,
  `'a-b'.Replace('-','_')`,
  `"a-b".Replace('-','_')`,
  `'a b'.Replace(' ','').Replace('a','b')`,
  `(Get-Date).ToString('yyyy-MM-dd').Replace('-','/')`,
  `(Get-Item a.txt).Name.Replace('a','b')`,
  `$x.ToString().Replace('a','b')`,
  `Write-Output ('a-b'.Replace('-','_'))`,
];

test('L176: 文字列と分かる値の Replace（Name・FullName・引用符の文字列・ToString() などのあと）は確かめなしで通る（5.1・7）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of TEXT_REPLACE) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'allow') wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('L176: 静的な [IO.File]::Replace は今も聞く（shape.static）', t => {
  for (const command of [`[IO.File]::Replace('src.txt','dest.txt',$null)`, `[System.IO.File]::Replace('src.txt','dest.txt',$null)`]) {
    const v = verdictOf(command, 'powershell', t);
    assert.equal(v.decision, 'ask', command);
    assert.ok(v.keys.includes('shape.static'), `${command}: ${v.keys.join(',')}`);
  }
});

// 値が文字列か分からない Replace（変数・括弧の結果・ハッシュの中身）は、ファイルの Replace かもしれないので聞く
const MAYBE_FILE_REPLACE: readonly string[] = [
  THE_FILE_OP,
  `Get-ChildItem | ForEach-Object { $_.Replace('victim.txt', 'victim.bak') }`,
  `Get-ChildItem | ForEach-Object { $_.Replace('victim.txt', $null) }`,
  `Get-ChildItem | ForEach-Object { $_.Replace("victim.txt", 'victim.bak', $true) }`,
  `(Get-Item a.txt).Replace('victim.txt', 'victim.bak')`,
  `(gi a.txt).Replace('victim.txt','victim.bak')`,
  `$f = Get-Item a.txt; $f.Replace('victim.txt', 'victim.bak')`,
  `foreach ($f in Get-ChildItem) { $f.Replace('victim.txt', 'victim.bak') }`,
  `Get-ChildItem | ForEach-Object { $_.psbase.Replace('victim.txt', 'victim.bak') }`,
  `@{Name=(Get-Item a.txt)}.Name.Replace('victim.txt', 'victim.bak')`,
];

test('L176: 値が文字列か分からない Replace（変数・括弧の結果・ハッシュの中身・$_）は聞く（shape.method）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of MAYBE_FILE_REPLACE) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'ask' || !v.keys.includes('shape.method')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

// 添字 [ ] のあとは、値の種類が分からなくなる（.Name が辞書で、['k'] がファイルのこともある）。lexer の chain が [ のあとで文字列の印を外す
const AFTER_INDEX: readonly string[] = [
  `Get-ChildItem | ForEach-Object { $_.Name['k'].Replace('victim.txt', 'victim.bak') }`,
  `$d = @{ Name = @{ k = (Get-Item a.txt) } }; $d.Name['k'].Replace('victim.txt', 'victim.bak')`,
  `('a-b')[0].Replace('victim.txt', 'victim.bak')`,
];

test('L176: 添字 [ ] のあとの .Replace( は、文字列の Name や括弧のあとでも、値の種類が分からないので聞く（shape.method）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of AFTER_INDEX) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'ask' || !v.keys.includes('shape.method')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('実機（Windows PowerShell 5.1）L176: 辞書の中のファイルを $d.Name[\'k\'].Replace(先, 控え) で呼ぶと、元のファイルが消える。判定役が聞くと答えれば動かさない', { skip: SKIP }, async t => {
  const s = setup(t, 'ask');
  s.seed();
  const form = `$d = @{ Name = @{ k = (Get-Item src.txt) } }; $d.Name['k'].Replace('dest.txt', 'dest.bak')`;
  const parked = await s.call(form);
  assert.equal(parked.decidedBy, 'pending', parked.output.content);
  assert.ok(existsSync(s.file('src.txt')), '元のファイルが消えた（動いてしまった）');
  assert.equal(readFileSync(s.file('dest.txt'), 'utf8'), 'D', '先が上書きされた（動いてしまった）');
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-Command', form], { cwd: s.cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(s.file('src.txt')), false, '前提: 本物の 5.1 ではこの形でファイルの Replace が動く');
  assert.equal(readFileSync(s.file('dest.txt'), 'utf8'), 'S');
});

// 文字列と分からない値は、今も聞く（括弧の結果・変数・文字列を返さない呼び出しのあと）。.Replace は文字列の道具なので、文字列と分かる値にだけ許す
const STILL_ASK: readonly string[] = [
  `$PWD.Path.Replace('\\','/')`,
  `(Get-Location).Path.Replace('\\','/')`,
  `$d = @{Path=(Get-Item a.txt)}; $d.Path.Replace('victim.txt','victim.bak')`,
  `$s.Replace('a','b')`,
  `(Get-Content a.txt -Raw).Replace('a','b')`,
  `$x.Split(',').Replace('a','b')`,
  `'a,b'.Split(',').Replace('a','b')`,
  `$env:Path.Split(';').Replace('a','b')`,
  `$env:Path.Trim().Split(';').Replace('a','b')`,
  `$env:Path[0].Replace('a','b')`,
  `(Get-Item a.txt).Replace('victim.txt','victim.bak')`,
  `(Get-Item $env:TEMP\\a.txt).Replace('victim.txt','victim.bak')`,
  `$f = Get-Item $env:TEMP\\a.txt; $f.Replace('victim.txt','victim.bak')`,
  `Get-ChildItem $env:TEMP | ForEach-Object { $_.Replace('victim.txt','victim.bak') }`,
  `$env:TEMP.Replace('victim.txt','victim.bak'); (Get-Item a.txt).Replace('victim.txt','victim.bak')`,
];

test('L176: $PWD.Path・(Get-Location).Path・変数・括弧の結果・Split() など文字列と分からない値のあとの Replace は聞く（shape.method）。変数に入れたハッシュの Path がファイルのこともある。$env: を通しても、この形は今のまま', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of STILL_ASK) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'ask' || !v.keys.includes('shape.method')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

// $env:名前 の値はいつも文字列。.Path は通さない（変数に入れたハッシュの Path がファイルのことがあり、値の種類が分からない）
const ENV_TEXT: readonly string[] = [
  `$env:USERPROFILE.Replace('\\','/')`,
  `$env:Path.Replace(';', ',')`,
  `$env:Path.Trim().Replace(';', ',')`,
  `$env:Path.ToLower().Replace(';', ',')`,
  `$ENV:TEMP.Replace('\\','/')`,
  `Write-Output $env:USERPROFILE.Replace('\\','/')`,
];

test('L176: $env:名前（値がいつも文字列）のあとの Replace は確かめなしで通る（5.1・7）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of ENV_TEXT) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'allow') wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('L176: $env: を通しても、同じ文にあるファイルの Replace・動的な呼び出し・削除の引数は今も聞く', t => {
  const asks: readonly string[] = [
    `$env:Path.Replace('a','b'); (Get-Item a.txt).Replace('victim.txt','victim.bak')`,
    `& $env:Path.Replace('a','b')`,
    `Remove-Item $env:Path.Replace('a','b')`,
  ];
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of asks) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'ask') wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('実機（Windows PowerShell 5.1）L176: 通すことにした $env:名前 は System.String で、Replace は文字を置き換えるだけ（ファイルは何も変わらない）。変数に入れたハッシュの Path は FileInfo で、Replace がファイルの Replace になる', { skip: SKIP }, t => {
  const s = setup(t, 'ask');
  s.seed();
  const before = readdirSync(s.cwd).sort().join(',');
  const run = (command: string) => spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: s.cwd, encoding: 'utf8', env: { ...process.env, BL_PROBE: 'a\\b;c' } });
  const typed = run(`$env:BL_PROBE.GetType().FullName`);
  assert.equal(typed.stdout.trim(), 'System.String', typed.stderr);
  const replaced = run(`$env:BL_PROBE.Replace('\\','/')`);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(replaced.stdout.split(/\r?\n/u)[0], 'a/b;c');
  const held = run(`$d = @{Path=(Get-Item src.txt)}; $d.Path.GetType().FullName`);
  assert.equal(held.stdout.trim(), 'System.IO.FileInfo', `前提: 変数に入れたハッシュの Path はファイルのことがある。${held.stderr}`);
  assert.equal(readdirSync(s.cwd).sort().join(','), before, '文字の置き換えだけで、フォルダの中は何も変わらない');
  assert.equal(readFileSync(s.file('src.txt'), 'utf8'), 'S');
  assert.equal(readFileSync(s.file('dest.txt'), 'utf8'), 'D');
});

test('実機（Windows PowerShell 5.1）L176: ファイルの .Replace(先, 控え) は判定役が聞くと答えれば動かさず、文字列の Replace は動く', { skip: SKIP }, async t => {
  const s = setup(t, 'ask');
  s.seed();
  const parked = await s.call(THE_FILE_OP);
  assert.equal(parked.decidedBy, 'pending', parked.output.content);
  assert.match(parked.output.content, /It has NOT run/u);
  assert.ok(existsSync(s.file('src.txt')), '元のファイルが消えた（動いてしまった）');
  assert.equal(readFileSync(s.file('dest.txt'), 'utf8'), 'D', '先が上書きされた（動いてしまった）');
  assert.equal(existsSync(s.file('dest.bak')), false, '控えができた（動いてしまった）');
  const names = await s.call(`Get-ChildItem *.txt | ForEach-Object { $_.Name.Replace('t', 'T') }`);
  assert.equal(names.decision, 'allow', names.output.content);
  assert.match(names.output.content, /desT\.TxT/u);
});
