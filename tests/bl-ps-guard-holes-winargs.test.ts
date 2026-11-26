import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { refusedKeysOf } from '../src/tools/hooks/decision-order.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { PendingStore } from '../src/pending/store.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// L188: Windows PowerShell 5.1 は、外のプログラムへ引数を渡すとき中の " を落とす。powershell -Command '"Remove-Item victim.txt"' は、
// ガードには「文字列を出すだけ」に見えるが、子の powershell には Remove-Item victim.txt の命令として渡る。本物の 5.1 で確かめ、powershell / pwsh・conhost・Start-Process の引数に " があれば断る

const psAvailable = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';
const SKIP = !psAvailable && 'Windows の PowerShell が無い';

const HIDDEN = `powershell -NoProfile -Command '"Remove-Item victim.txt"'`;

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
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const judged: string[] = [];
  const call = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, {
    registry, approvals, pending, db, emit: () => undefined, conversationTainted: () => false, lastUserRequest: () => 'list the files',
    autoClassify: async prompt => { judged.push(prompt.user); return `{"decision":"${judge}","reason":"it only prints a string"}`; },
  });
  const file = (name: string) => join(paths.workspace, name);
  const victim = () => { writeFileSync(file('victim.txt'), 'x'); return file('victim.txt'); };
  return { call, file, victim, judged, cwd: paths.workspace };
}

test('実機（Windows PowerShell 5.1）: 外のプログラムへ渡す引数の中の " は落ちる。\'"Remove-Item victim.txt"\' は子の powershell で命令として動き、単引用符の文字列にした対照は動かない', { skip: SKIP }, t => {
  const s = setup(t, 'ask');
  const run = (command: string) => spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: s.cwd, encoding: 'utf8' });
  const victim = s.victim();
  const control = run(`powershell -NoProfile -Command "'Remove-Item victim.txt'"`);
  assert.equal(control.status, 0, control.stderr);
  assert.ok(existsSync(victim), '対照: 単引用符の文字列は命令にならない');
  const ran = run(HIDDEN);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(victim), false, '" が落ちて、文字列のはずの Remove-Item victim.txt が命令として動いた');
});

// 同じ穴の別の通り道（本物の 5.1 で確かめた）。cmd.exe を挟む形・括弧で包んだ引数・Start-Process の @( ) 配列・空白を含んで末尾が \ の引数
const CMD_C = `cmd /c powershell -NoProfile -Command '"Remove-Item victim.txt"'`;
const CMD_START = `cmd /c start /wait powershell -NoProfile -Command '"Remove-Item victim.txt"'`;
const PAREN = `powershell -NoProfile -Command ('"Remove-Item victim.txt"')`;
const SAPS_ARRAY = `Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-c','"Remove-Item victim.txt"') -Wait -NoNewWindow`;
const BACKSLASH = `powershell -NoProfile -Command 'Write-Output a\\' 'x'' \\' '; Remove-Item victim.txt ; ''' '''#'''`;

test('実機（Windows PowerShell 5.1）: cmd.exe を挟む形・括弧で包んだ引数・@( ) 配列も、" が落ちて子の powershell で命令として動く（前の版の穴）', { skip: SKIP }, t => {
  const s = setup(t, 'ask');
  for (const command of [CMD_C, CMD_START, PAREN, SAPS_ARRAY]) {
    const victim = s.victim();
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: s.cwd, encoding: 'utf8' });
    assert.equal(ran.status, 0, `${command}: ${ran.stderr}`);
    assert.equal(existsSync(victim), false, `${command}: 動いて victim.txt が消えるはず`);
  }
  const victim = s.victim();
  writeFileSync(s.file('run.ps1'), BACKSLASH);
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-File', s.file('run.ps1')], { cwd: s.cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(victim), false, '空白を含んで末尾が \\ の引数のあとの ; が命令として動いた');
});

test('実機（Windows PowerShell 5.1）: 子の powershell に隠れた命令が渡る形は、判定役が「許す」と答えても動かさずに断る（victim.txt が残る）', { skip: SKIP }, async t => {
  const s = setup(t, 'allow');
  const QUOTE = /write the argument without a double quote inside it \(use single quotes\)/u;
  const shapes: ReadonlyArray<readonly [string, RegExp]> = [
    [HIDDEN, QUOTE], [`powershell.exe -NoProfile -c '"Remove-Item victim.txt"'`, QUOTE], [`& powershell -NoProfile -Command '"Remove-Item victim.txt"'`, QUOTE],
    [`powershell -NoProfile -Command """Remove-Item victim.txt"""`, QUOTE], [`powershell -NoProfile -Command 'Write-Output "x"; Remove-Item victim.txt'`, QUOTE],
    [CMD_C, QUOTE], [CMD_START, QUOTE], [SAPS_ARRAY, /worked out when the command runs/u], [PAREN, /worked out when the command runs/u],
    [BACKSLASH, /ends with a backslash/u],
  ];
  for (const [command, hint] of shapes) {
    const victim = s.victim();
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, /rules for passing them to a program on Windows/u, command);
    assert.match(outcome.output.content, hint, `${command}: 断る文に、書き直す案内がある`);
    assert.ok(existsSync(victim), `${command}: victim.txt が消えた（動いてしまった）`);
  }
  assert.deepEqual(s.judged, [], '断った形は判定役に回さない');
});

test('実機（Windows PowerShell 5.1）: 引数に " の無い子の powershell は今までどおり。判定役が許せば本物の子が動く（Get-Date）', { skip: SKIP }, async t => {
  const s = setup(t, 'allow');
  const outcome = await s.call(`powershell -NoProfile -Command 'Get-Date -Format yyyy'`);
  assert.equal(outcome.decision, 'allow', outcome.output.content);
  assert.equal(outcome.output.isError, false, outcome.output.content);
  assert.match(outcome.output.content, /20[0-9]{2}/u);
  assert.equal(s.judged.length, 1, '今までどおり判定役の段');
});

const verdictOf = (command: string, shell: 'powershell' | 'pwsh', t: { after: (fn: () => void) => void }) => {
  const ws = realish(join(tempDir(t), 'workspace'));
  mkdirSync(ws, { recursive: true });
  const v = checkShellCommand(command, ws, { policy: { roots: [{ path: ws, mode: 'write' }], deny: [] }, outsideRoots: 'ask', shell, windows: true });
  return { decision: v.decision, keys: v.reasonKeys, refused: refusedKeysOf(v.reasonKeys) };
};

// 前の版では ask（list.command・code.*。判定役が許す・判定役を切ると動く）。今は list.winargs で断る。5.1 の外側（powershell）でも pwsh の外側でも同じ
const NOW_DENIED: readonly string[] = [
  HIDDEN,
  `pwsh -NoProfile -Command '"Remove-Item victim.txt"'`,
  `powershell.exe -NoProfile -c '"Remove-Item victim.txt"'`,
  `PowerShell.EXE -NoProfile -Command '"Remove-Item victim.txt"'`,
  `POWERSHELL -NoProfile -Command '"Remove-Item victim.txt"'`,
  `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command '"Remove-Item victim.txt"'`,
  `& powershell -NoProfile -Command '"Remove-Item victim.txt"'`,
  `& 'powershell' -NoProfile -Command '"Remove-Item victim.txt"'`,
  `powershell -NoProfile -Command """Remove-Item victim.txt"""`,
  `powershell -NoProfile -Command 'Write-Output "x"; Remove-Item victim.txt'`,
  `powershell -NoProfile -Command 'Write-Output "a;b"'`,
  `powershell -NoProfile -File x.ps1 'a "b" c'`,
  `Get-ChildItem | ForEach-Object { powershell -NoProfile -Command '"Remove-Item victim.txt"' }`,
  `if ($true) { powershell -NoProfile -Command '"Remove-Item victim.txt"' }`,
  `iex 'powershell -NoProfile -Command ''"Remove-Item victim.txt"'''`,
  `conhost powershell -NoProfile -Command '"Remove-Item victim.txt"'`,
  `conhost.exe --headless pwsh -NoProfile -Command '"Remove-Item victim.txt"'`,
  `conhost powershell -NoProfile -Command '"Remove-Item victim.txt"' $x`,
  `powershell -NoProfile -Command '"Remove-Item victim.txt"' $x`,
  `Start-Process powershell -ArgumentList '-NoProfile','-Command','"Remove-Item victim.txt"' -Wait`,
  `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','"Remove-Item victim.txt"'`,
  `saps pwsh -ArgumentList '-NoProfile','-Command','"Remove-Item victim.txt"'`,
  CMD_C,
  `cmd.exe /c pwsh -NoProfile -Command '"Remove-Item victim.txt"'`,
  `cmd /c start powershell -NoProfile -Command '"Remove-Item victim.txt"'`,
  CMD_START,
  `conhost cmd /c powershell -NoProfile -Command '"Remove-Item victim.txt"'`,
  `Start-Process cmd -ArgumentList '/c','powershell','-NoProfile','-Command','"Remove-Item victim.txt"' -Wait`,
  `Start-Process cmd -ArgumentList '/c powershell -NoProfile -Command "Remove-Item victim.txt"' -Wait`,
  PAREN,
  `powershell -NoProfile -Command $('"Remove-Item victim.txt"')`,
  `pwsh -NoProfile -Command (Get-Content s.ps1 -Raw)`,
  SAPS_ARRAY,
  `Start-Process powershell -ArgumentList @('-NoProfile','-Command','Get-Date') -Wait`,
  BACKSLASH,
  `powershell -NoProfile -Command 'a b\\'`,
  `Start-Process powershell -ArgumentList '-NoProfile','-Command','a b\\' -Wait`,
];

// 前の版でも断っていた形（path で書いた名前を実在の .exe と確かめられないとき、& | < > ^ % ! の引数は list.winargs）。子の powershell の見張りを足したあとも、緩めずに断る
const STILL_DENIED: readonly string[] = [
  `conhost C:\\nope\\powershell.exe -NoProfile -Command 'Get-Date & whoami'`,
  `conhost .\\powershell.exe -NoProfile -Command 'Get-Date | whoami'`,
  `Set-Content x.txt y; conhost C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command 'a & b'`,
  `conhost C:\\nope\\pwsh.exe -NoProfile -Command 'Get-Date ^ whoami'`,
];

test('前の版でも list.winargs で断っていた conhost 経由の path 付きの子 powershell は、今も断る（緩めない）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of STILL_DENIED) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'deny' || !v.refused.includes('list.winargs')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

test('子の powershell / pwsh・conhost・Start-Process の引数に " があれば list.winargs で断る（持ち主の許可でも外せない一覧）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const command of NOW_DENIED) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== 'deny' || !v.refused.includes('list.winargs')) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')}`);
  }
  assert.deepEqual(wrong, []);
});

// 今までと変わらない形（毎日の読むだけの PowerShell と、子の powershell の引数に " の無い形）。前の版で実測した判定のとおり
const UNCHANGED: ReadonlyArray<readonly [string, 'allow' | 'ask', string]> = [
  ['Get-Date', 'allow', ''],
  ['Get-ChildItem | ForEach-Object { $_.Name.Replace(\'a\',\'b\') }', 'allow', ''],
  ['Get-ChildItem *.log | ForEach-Object { $_.Name }', 'allow', ''],
  [`Write-Output "a b"`, 'allow', ''],
  [`Write-Output 'a "b" c'`, 'allow', ''],
  [`Get-ChildItem | Where-Object { $_.Name -like "*.md" }`, 'allow', ''],
  [`powershell -NoProfile -Command 'Get-Date'`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -Command Get-Date`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -Command "Get-ChildItem | Where-Object { $_.Name -like '*.txt' }"`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -File x.ps1`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -Command 'Remove-Item victim.txt'`, 'ask', 'list.command,list.ps_write,code.powershell'],
  [`powershell -NoProfile -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAdgBpAGMAdABpAG0ALgB0AHgAdAA=`, 'ask', 'list.command,list.ps_write,code.powershell'],
  [`powershell -NoProfile -Command $c`, 'ask', 'list.command,code.powershell'],
  [`& powershell -NoProfile -Command 'Get-Date'`, 'ask', 'list.command,code.powershell'],
  [`conhost.exe powershell -NoProfile -Command 'Get-Date'`, 'ask', 'list.command,list.command,code.powershell'],
  [`Start-Process powershell -ArgumentList '-NoProfile','-Command','Get-Date' -Wait`, 'ask', 'list.command,list.command,code.powershell,code.spawn'],
  [`cmd /c powershell -NoProfile -Command 'Get-Date'`, 'ask', 'list.command,list.command,code.powershell'],
  [`foo.exe '"x"'`, 'ask', 'list.command'],
  [`$c = '"Remove-Item victim.txt"'; powershell -NoProfile -Command $c`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -Command { Get-Date }`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -Command { "Write-Output hi" }`, 'ask', 'list.command,code.powershell'],
  [`powershell -NoProfile -File 'C:\\a b\\x.ps1'`, 'ask', 'list.command,code.powershell'],
  [`Start-Process powershell -ArgumentList '-NoProfile','-Command','Get-Date' -Wait`, 'ask', 'list.command,list.command,code.powershell,code.spawn'],
];

test('毎日の読むだけの形と、" の無い子の powershell は、判定が変わらない（allow は allow、ask は同じ理由の ask）', t => {
  const wrong: string[] = [];
  for (const shell of ['powershell', 'pwsh'] as const) for (const [command, want, keys] of UNCHANGED) {
    const v = verdictOf(command, shell, t);
    if (v.decision !== want || (keys !== '' && v.keys.join(',') !== keys)) wrong.push(`${shell}: ${command} -> ${v.decision} ${v.keys.join(',')} (want ${want} ${keys})`);
  }
  assert.deepEqual(wrong, []);
});
