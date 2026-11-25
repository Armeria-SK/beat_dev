import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { WT_MAIN_PATH, WT_OPAQUE, worktreeGitRefusal } from '../src/tools/hooks/worktree-git.ts';
import { tempDir } from './helpers.ts';

// L184: 作業コピーの中で `cd web && … && cd ..`・pushd / popd をしただけの並びを、読めない形（wt.opaque）として断らない。
// 作業コピーの外へ出る cd・行き先が決まらない cd は、今までどおり断る

type Shell = 'bash' | 'powershell';

function fixture(t: Parameters<typeof tempDir>[0]) {
  const base = tempDir(t);
  const ws = realish(join(base, 'copy'));
  mkdirSync(join(ws, 'web', 'sub'), { recursive: true });
  mkdirSync(join(base, 'elsewhere'), { recursive: true });
  writeFileSync(join(ws, 'web', 'package.json'), '{}');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(ws, 'skills') };
  const productRoot = join(base, 'main');
  // PowerShell 5.1 は && と || を読めない（見張りが文を 0 個にして deny するので、断るかどうかの確かめにならない）。&& は ; に替え、|| と裏に回す & は PowerShell では試さない
  const asShell = (given: string, shell: Shell): string => (shell === 'powershell' ? given.replaceAll(' && ', '; ') : given);
  const parses = (given: string, shell: Shell = 'bash'): boolean => checkShellCommand(asShell(given, shell), ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', language: 'en' }).statements.length > 0;
  const refusal = (given: string, shell: Shell = 'bash', cwdRel = '') => {
    const command = asShell(given, shell);
    const cwd = cwdRel ? join(ws, cwdRel) : ws;
    const verdict = checkShellCommand(command, cwd, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', language: 'en' });
    return worktreeGitRefusal(verdict.statements, { worktree: ws, productRoot, cwd, command, powershell: shell === 'powershell', remotes: () => ['origin'], sharedConfig: () => '' });
  };
  const statementsOf = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false, language: 'en' }).statements;
  return { base, ws, refusal, parses, statementsOf };
}

const SHELLS: Shell[] = ['bash', 'powershell'];

test('L184: 作業コピーの中だけを動く cd（cd web && … && cd ..）は wt.opaque で断らない', t => {
  const { refusal, parses } = fixture(t);
  const everyday = [
    'cd web && npm test && cd .. && npm run build',
    'cd web; npm test; cd ..; npm run build',
    'cd web && npm test && cd ..',
    'cd web/sub && npm test && cd ../..',
    'cd ./web && npm test && cd ../ && npm run build',
    'cd missing && npm test && cd ..',
    'pushd web; npm test; popd; npm run build',
    'cd web && git status && cd ..',
    'cd web && npm test && cd .. && git status',
  ];
  for (const shell of SHELLS) {
    for (const command of everyday) {
      assert.ok(parses(command, shell), `${shell}: 見張りが文を読めた: ${command}`);
      assert.equal(refusal(command, shell)?.key, undefined, `${shell}: ${command}`);
    }
  }
  for (const command of ['Set-Location web; npm test; Set-Location ..', 'Push-Location web; npm test; Pop-Location; npm run build']) {
    assert.ok(parses(command, 'powershell'), `powershell: 見張りが文を読めた: ${command}`);
    assert.equal(refusal(command, 'powershell')?.key, undefined, `powershell: ${command}`);
  }
  assert.equal(refusal('cd .. && npm test', 'bash', 'web')?.key, undefined, 'web の中から .. へ出て作業コピーの直下に戻るのも中');
});

test('L184 対照: 作業コピーの外へ出る cd・行き先を決められない cd・ほかの形は、今までどおり断る', t => {
  const { refusal, parses } = fixture(t);
  const away = [
    'cd .. && cd ..',
    'cd .. && npm test',
    'cd ../web && npm test',
    'cd ../.. && npm test',
    'cd web && npm test && cd .. && cd .. && npm run build',
    'cd web && cd ../.. && npm test',
    'cd $X && npm test',
    'cd "$PWD/web" && npm test',
    'cd $PWD/web && npm test && cd ..',
    'cd web && npm test && cd $OLDPWD && npm run build',
    'cd web; npm test; cd -; npm run build',
    'cd web; npm test; cd ~; npm run build',
    'cd; npm test',
    'cd web && cd; npm test',
    'popd; npm test',
    'pushd web; popd; popd; npm test',
    'pushd; npm test',
    'pushd ..; npm test; popd; npm test',
    'cd..; npm test',
    'cd /tmp && npm test',
    'cd web && npm test || cd ..; npm run build',
    'cd web || cd sub; cd ..; cd ..; npm test',
    'cd web && cd sub || x; cd ..; cd ..; cd ..; npm test',
    'npm test && cd web; cd ..; cd ..; npm run build',
    'mkdir out && cd out && npm test && cd ..',
    'cd web && (npm test; cd ..); cd ..; cd ..; npm run build',
    'cd web && npm test | cat; cd ..; cd ..; npm run build',
    'cd web |& cat; cd ..; npm test',
    'cd web; npm test & cd ../..; npm run build',
    'for d in web; do cd $d && npm test && cd ..; done',
    'cd web; if ($?) { npm test }; cd ..; cd ..; npm run build',
    'foreach ($d in "web") { cd $d; npm test; cd .. }',
    'cd web; try { npm test } finally { cd .. }; cd ..; npm run build',
  ];
  const notRefused: string[] = [];
  for (const shell of SHELLS) {
    for (const command of away) {
      // |& は bash の書き方（PowerShell のパイプは同じセッションで動くので、cd は変わる）
      if (!parses(command, shell) || (shell === 'bash' && /\$\?|foreach|try \{/u.test(command)) || (shell === 'powershell' && command.includes('|&'))) continue;
      const key = refusal(command, shell)?.key;
      if (key !== WT_OPAQUE && key !== WT_MAIN_PATH) notRefused.push(`${shell}: ${command} => ${String(key)}`);
    }
  }
  assert.deepEqual(notRefused, []);
  assert.ok(away.filter(c => parses(c, 'bash')).length >= 22 && away.filter(c => parses(c, 'powershell')).length >= 20, '読めた形が十分ある（読めないだけで断った扱いにならない）');
  for (const command of ['cd web && npm test && cd .. && cd .. && git status', 'cd .. && git status']) {
    assert.ok(refusal(command)?.key !== undefined, `${command}: 外へ出たあとの git も断る`);
  }
});

test('L184 対照: 作業コピーの外を指す入口（junction・symlink のフォルダ）への cd は、中の名前に見えても断る', t => {
  const { base, ws, refusal } = fixture(t);
  symlinkSync(join(base, 'elsewhere'), join(ws, 'link'), 'junction');
  for (const shell of SHELLS) {
    assert.ok(refusal('cd link && npm test && cd ..', shell)?.key !== undefined, `${shell}: cd link`);
    assert.ok(refusal('pushd link; npm test; popd', shell)?.key !== undefined, `${shell}: pushd link`);
  }
  assert.equal(refusal('cd web && npm test && cd ..')?.key, undefined, '同じ形で中のフォルダなら通る');
});

test('L184 対照: 動いたあとに git の別の入口（-C ..・環境の変数）を足す形は、cd を許しても断る', t => {
  const { refusal } = fixture(t);
  for (const command of ['cd web && npm test && cd .. && git -C .. status', 'cd web && git -C ../.. status && cd ..', 'cd web && GIT_DIR=../../.git git status && cd ..', 'cd web && git stash && cd ..']) {
    assert.ok(refusal(command)?.key !== undefined, command);
  }
});

test('L184 対照（審査の指摘）: リンク・ジャンクションをまたぐ cd、名前のあとの ..、行き先の無い .. の cd は、文字だけで解けないので断る（bash はリンクの先の親へ移りうる）', t => {
  const { base, ws, refusal } = fixture(t);
  symlinkSync(ws, join(ws, 'self'), 'junction');
  mkdirSync(join(base, 'sib'));
  const refused = ['cd self/../sib && npm test', 'cd self/../sib && git status', 'cd self; cd ../sib; npm test', 'cd self && rm self && cd .. && npm test', 'cd self; npm test; cd ..; cd ..; npm test'];
  for (const command of refused) assert.ok(refusal(command)?.key !== undefined, command);
  assert.ok(refusal('cd web/../missing && npm test')?.key !== undefined, '名前のあとの .. （リンクが無くても読まない）');
  assert.ok(refusal('cd ../missing && npm test', 'bash', 'web')?.key !== undefined, '先頭の .. でも、行き先が無ければ読まない');
  assert.equal(refusal('cd web && npm test && cd ..')?.key, undefined, '同じ形で中のフォルダなら通る');
  assert.equal(refusal('cd ../web && npm test && cd ..', 'bash', 'web')?.key, undefined, '先頭の .. で、行き先がある中のフォルダなら通る');
});

test('L184 対照（審査の指摘）: パイプ（|& も）の中の cd は子のシェルで動くので追わない。見張りの数えたフォルダ（cwds）に外が入っていれば、追跡の結果があっても断る', t => {
  const { ws, refusal, statementsOf } = fixture(t);
  for (const command of ['cd web |& cat; cd ..; npm test', 'cd web |& cat; cd ..; rm -rf x', 'cd web | cat; cd ..; npm test']) assert.ok(refusal(command)?.key !== undefined, command);
  const command = 'cd web && npm test && cd .. && npm run build';
  const statements = statementsOf(command);
  assert.equal(worktreeGitRefusal(statements, { worktree: ws, productRoot: join(ws, '..', 'main'), cwd: ws, command, remotes: () => ['origin'], sharedConfig: () => '' })?.key, undefined, '前提: そのままなら通る');
  assert.ok(statements.some(st => st.cwd === null), '前提: 見張りが決められない文がある');
  const widened = statements.map(st => (st.cwd === null ? { ...st, cwds: [...(st.cwds ?? []), join(ws, '..')] } : st));
  assert.ok(worktreeGitRefusal(widened, { worktree: ws, productRoot: join(ws, '..', 'main'), cwd: ws, command, remotes: () => ['origin'], sharedConfig: () => '' })?.key !== undefined, 'cwds に外のフォルダがあれば断る');
});

test('L184 対照（審査の指摘）: cd -P / cd -L は、link/.. の .. の解き方が変わるので、行き先を決められないものとして断る', t => {
  const { ws, refusal, statementsOf } = fixture(t);
  symlinkSync(ws, join(ws, 'self'), 'junction');
  for (const command of ['cd -P self/.. && npm test', 'cd -L web && npm test && cd .. && npm run build', 'cd -P web && npm test && cd .. && npm run build']) assert.ok(refusal(command)?.key !== undefined, command);
  const after = statementsOf('cd -P web; npm test');
  assert.equal(after[1]?.cwd, null, 'cd -P のあとの文の作業フォルダは決まらない');
  assert.notEqual(statementsOf('cd web; npm test')[1]?.cwd, null, '旗の無い cd は今までどおり決まる');
});
