import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// L176: PowerShell の PS_METHOD_OK（src/tools/hooks/shell-lex.ts:692）は replace を「文字列の道具」として通すので、ファイルの .Replace(先, 控え)（先を上書きして元を消す。控えが $null の形は 5.1 では失敗するので、控えの名前を書く形）が聞かれずに動く。
// 直す場所は shell-lex.ts の chain（呼ぶ先の値が文字列と分かるときだけ通す）で、この束の持ち場の外。ここでは、今の線（通る形・聞く形）と、直ったあとの目標を試験にしておく

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

test('L176 の今の線と、直っても変わらない形: 文字列と分かる値の Replace は確かめなしで通る（5.1・7）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of TEXT_REPLACE) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'allow') wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('L176 の今の線: 静的な [IO.File]::Replace は今も聞く（shape.static）', t => {
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

test('L176 の目標（未着手: 根は shell-lex.ts の chain で、この束の持ち場の外）: 値が文字列か分からない Replace は聞く（shape.method）', { todo: 'この束の持ち場の外: src/tools/hooks/shell-lex.ts:692 の PS_METHOD_OK が replace を文字列の道具として通し、chain（:1049）は呼ぶ先の値の種類を見ない' }, t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of MAYBE_FILE_REPLACE) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'ask' || !v.keys.includes('shape.method')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('実機（Windows PowerShell 5.1）L176 の目標（未着手: 根は shell-lex.ts で、この束の持ち場の外）: ファイルの .Replace(先, 控え) は判定役が聞くと答えれば動かさず、文字列の Replace は動く', { skip: SKIP, todo: 'この束の持ち場の外: src/tools/hooks/shell-lex.ts:692' }, async t => {
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
