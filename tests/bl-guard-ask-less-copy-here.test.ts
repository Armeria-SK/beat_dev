import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BuiltinHookConfig } from '../src/config/schema.ts';
import type { HookPayload } from '../src/tools/hooks/command-hook.ts';
import { DEFAULT_PROTECT_FILES, runProtectFiles } from '../src/tools/hooks/protect-files.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { hookPaths } from '../src/tools/pipeline.ts';
import type { PreCheck, ToolDef } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// L158: 守る名前を含むフォルダへの「cp 元 .」「mv 元 .」を、できる名前が守る一覧に当たらないときは聞かない。当たるもの・フォルダごと消す／作る書き込みは今までどおり聞く

type Shell = 'bash' | 'powershell';

const LISTED: BuiltinHookConfig = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**', 'package.json'] };

function fixture(t: Parameters<typeof tempDir>[0]) {
  const ws = realish(join(tempDir(t), 'prod'));
  mkdirSync(join(ws, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, 'x', 'workflows'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), '{}');
  writeFileSync(join(ws, 'a.txt'), 'x');
  writeFileSync(join(ws, 'src', 'b.ts'), 'x');
  writeFileSync(join(ws, '.github', 'workflows', 'ci.yml'), 'x');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(ws, 'skills') };
  const check = (command: string, shell: Shell): PreCheck => {
    const verdict = checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', language: 'en' });
    return { decision: verdict.decision, reasons: verdict.reasons, writes: verdict.writes, paths: verdict.paths } as unknown as PreCheck;
  };
  const payloadOf = (command: string, shell: Shell, tool = 'shell_run'): HookPayload => ({
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: ws, run_id: 'r', conversation_id: 'c', project_root: ws,
    paths: hookPaths({ effect: 'exec' } as unknown as ToolDef, check(command, shell)),
  });
  const decide = (command: string, shell: Shell = 'bash', hook: BuiltinHookConfig = LISTED): string | undefined => runProtectFiles(hook, payloadOf(command, shell)).decision;
  return { ws, decide, payloadOf };
}

test('L158: cp / mv / Copy-Item で今のフォルダ（.）や .github に置くだけで、できる名前が守る一覧に当たらなければ聞かない', t => {
  const { decide } = fixture(t);
  for (const command of ['cp a.txt .', 'cp src/b.ts .', 'mv a.txt .', 'cp -r src .', 'cp -r src/ .', 'cp a.txt .github', 'cp src/b.ts .github/', 'mv src .github', 'cp -r .github/workflows .', 'cp .github/workflows/ci.yml .', 'cp -f a.txt src/b.ts .']) {
    assert.equal(decide(command), undefined, command);
  }
  for (const command of ['Copy-Item a.txt .', 'Copy-Item -Recurse src .', 'Move-Item a.txt .', 'Copy-Item a.txt .github']) {
    assert.equal(decide(command, 'powershell'), undefined, `powershell: ${command}`);
  }
  assert.equal(decide('cp a.txt .', 'bash', DEFAULT_PROTECT_FILES), undefined, '既定の一覧（.github/workflows/**）でも同じ');
});

test('L158 対照: できる名前が守る一覧に当たるもの・フォルダごと書き換えるもの・読めない書き方は、今までどおり聞く', t => {
  const { decide } = fixture(t);
  const asks = [
    'cp a.txt package.json', 'cp a.txt ./package.json', 'mv a.txt package.json', 'cp a.txt .github/workflows', 'cp a.txt .github/workflows/', 'cp a.txt .github/workflows/ci.yml',
    'cp -r .github .', 'cp -r x/workflows .github', 'cp -r x/workflows .github/', 'mv x/workflows .github',
    'mv .github/workflows/ci.yml .', 'mv .github/workflows .', 'mv package.json src', 'mv package.json .', 'mv .github/workflows/ci.yml src',
    'rm -rf .github', 'rm -rf .', 'mkdir .github', 'echo x > package.json', 'git checkout -- .', 'cp * .', 'ln a.txt .',
    'cp a.txt . ; rm -rf .github', 'cp a.txt . && rm -rf .', 'cp a.txt "." ', 'cp $F .',
  ];
  for (const command of asks) assert.equal(decide(command), 'ask', command);
  for (const command of ['Copy-Item a.txt package.json', 'Copy-Item a.txt .github\\workflows\\ci.yml', 'Remove-Item -Recurse .github', 'Copy-Item -Recurse .github .']) {
    assert.equal(decide(command, 'powershell'), 'ask', `powershell: ${command}`);
  }
  assert.equal(decide('cp a.txt .github/workflows/ci.yml', 'bash', DEFAULT_PROTECT_FILES), 'ask', '既定の一覧でも workflows の中は聞く');
});

test('L158 対照: 書き込みの一覧が、コマンドの文字から作れる名前をすべて含まないとき（作られた入力）は、フォルダを外さず聞く', t => {
  const { ws, payloadOf } = fixture(t);
  const forged = (paths: NonNullable<HookPayload['paths']>, tool = 'shell_run', command = 'cp a.txt .'): string | undefined => runProtectFiles(LISTED, { ...payloadOf(command, 'bash', tool), paths }).decision;
  const folder = { path: ws, write: true, dir: true };
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }]), undefined, '前提: 一覧にできる名前がそろっていれば外す');
  assert.equal(forged([folder]), 'ask', 'できる名前が一覧に無い');
  assert.equal(forged([folder, { path: join(ws, 'other.txt'), write: true }]), 'ask', '別の名前しか無い');
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }], 'file_write'), 'ask', 'shell_run 以外の道具');
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }], 'shell_run', 'cp a.txt . ; rm -rf .'), 'ask', 'つなぎのある文');
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }], 'shell_run', 'rm -rf .'), 'ask', 'cp / mv でない文');
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }], 'shell_run', 'cp a.txt'), 'ask', '元だけで先が無い');
  assert.equal(forged([folder, { path: join(ws, 'a.txt'), write: true }], 'shell_run', 'cp --target-directory=. a.txt'), 'ask', '値を取る旗');
});
