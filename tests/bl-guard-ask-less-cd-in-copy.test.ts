import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { WT_MAIN_PATH, WT_OPAQUE, worktreeGitRefusal } from '../src/tools/hooks/worktree-git.ts';
import { tempDir } from './helpers.ts';

// L184（作業コピーの中で cd して戻る形を断らない）は未着手。ここでは、作業コピーの外へ出る cd・行き先が決まらない cd を、今までどおり断ることを固定する。
// cd -P / cd -L は見張り（allowlist-tools.ts）が行き先を決めない、という締め直しも固定する

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

test('L184 の目標（未着手: 作業コピーの中で cd して戻る形を断らない。見張りの cd の追跡は、リンク・パイプ・変数・set -P などの抜け道を塞ぎきれず、専用の計画が要る）: cd web && … && cd ..・pushd / popd は wt.opaque で断らない', { todo: 'L184 は専用の計画が要る（見張りが cd のあとの作業フォルダを null にするのを、作業コピーの中だけ追う形に緩める）' }, t => {
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

test('L184 の周り: 作業コピーの外へ出る cd・行き先を決められない cd・ほかの形は、今までどおり断る', t => {
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

test('L184 の周り: 作業コピーの外を指す入口（junction・symlink のフォルダ）への cd は、中の名前に見えても断る', t => {
  const { base, ws, refusal } = fixture(t);
  symlinkSync(join(base, 'elsewhere'), join(ws, 'link'), 'junction');
  for (const shell of SHELLS) {
    assert.ok(refusal('cd link && npm test && cd ..', shell)?.key !== undefined, `${shell}: cd link`);
    assert.ok(refusal('pushd link; npm test; popd', shell)?.key !== undefined, `${shell}: pushd link`);
  }
});

test('L184 の周り: リンク・ジャンクションをまたぐ cd、名前のあとの ..、行き先の無い .. の cd は、文字だけで解けないので断る（bash はリンクの先の親へ移りうる）', t => {
  const { base, ws, refusal } = fixture(t);
  symlinkSync(ws, join(ws, 'self'), 'junction');
  mkdirSync(join(base, 'sib'));
  const refused = ['cd self/../sib && npm test', 'cd self/../sib && git status', 'cd self; cd ../sib; npm test', 'cd self && rm self && cd .. && npm test', 'cd self; npm test; cd ..; cd ..; npm test'];
  for (const command of refused) assert.ok(refusal(command)?.key !== undefined, command);
  // シェルの最初のフォルダが作業コピーの中の web のとき、ひとつ上の self（根へのジャンクション）を消して .. へ戻ると、bash は実体の親（コピーの外）へ移る
  assert.ok(refusal('cd ../self && rm self && cd .. && npm test', 'bash', 'web')?.key !== undefined, '兄弟のフォルダのリンク（web から ../self）');
  assert.ok(refusal('cd web/../missing && npm test')?.key !== undefined, '名前のあとの .. （リンクが無くても読まない）');
  assert.ok(refusal('cd ../missing && npm test', 'bash', 'web')?.key !== undefined, '先頭の .. でも、行き先が無ければ読まない');
});

test('L184 の周り: パイプ（|& も）の中の cd は子のシェルで動くので、そのあとの文も断る', t => {
  const { refusal } = fixture(t);
  for (const command of ['cd web |& cat; cd ..; npm test', 'cd web |& cat; cd ..; rm -rf x', 'cd web | cat; cd ..; npm test']) assert.ok(refusal(command)?.key !== undefined, command);
});

test('cd -P / cd -L は、link/.. の .. の解き方が変わるので、見張りは行き先を決められないものとして断る（allowlist-tools.ts の締め直し）', t => {
  const { ws, refusal, statementsOf } = fixture(t);
  symlinkSync(ws, join(ws, 'self'), 'junction');
  for (const command of ['cd -P self/.. && npm test', 'cd -L web && npm test && cd .. && npm run build', 'cd -P web && npm test && cd .. && npm run build']) assert.ok(refusal(command)?.key !== undefined, command);
  const after = statementsOf('cd -P web; npm test');
  assert.equal(after[1]?.cwd, null, 'cd -P のあとの文の作業フォルダは決まらない');
  assert.equal(statementsOf('cd -L web; npm test')[1]?.cwd, null, 'cd -L のあとの文の作業フォルダも決まらない');
  assert.notEqual(statementsOf('cd web; npm test')[1]?.cwd, null, '旗の無い cd は今までどおり決まる');
});
