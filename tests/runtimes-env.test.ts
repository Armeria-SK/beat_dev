import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEPT_ENV, keepRuntimeNames, ProcessManager, runtimeEnv } from '../src/runtimes/process-manager.ts';
import { FAKE_RUNTIME_SCRIPT } from './helpers/fake-runtime.ts';
import { tempDir } from './helpers.ts';

// 親の環境に入れる、落ちるべき名前（値は、出力に漏れたらすぐ分かる目印）
const DROPPED: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
  ANTHROPIC_BASE_URL: 'sentinel-anthropic-url',
  ANTHROPIC_AUTH_TOKEN: 'sentinel-anthropic-token',
  CLAUDECODE: 'sentinel-claudecode',
  CLAUDE_CODE_ENTRYPOINT: 'sentinel-entrypoint',
  CLAUDE_CODE_USE_BEDROCK: 'sentinel-bedrock',
  CODEX_API_KEY: 'sentinel-codex-key',
  CODEX_SANDBOX_NETWORK_DISABLED: 'sentinel-codex-sandbox',
  OPENAI_API_KEY: 'sentinel-openai-key',
  OPENAI_BASE_URL: 'sentinel-openai-url',
  GITHUB_TOKEN: 'sentinel-github',
  AWS_SECRET_ACCESS_KEY: 'sentinel-aws',
};
const KEPT: Record<string, string> = {
  CLAUDE_CONFIG_DIR: 'C:/Users/someone/.claude',
  CODEX_HOME: 'C:/Users/someone/.codex',
  CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
};
// 試験を動かしている環境そのものに CLAUDE_* などが入っていることがある（Claude Code の中で動かすとき）。親の環境は、基本の名前だけ借りて作る
const BASICS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles'];
const sourceWith = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...Object.fromEntries(BASICS.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), ...extra });

test('runtimeEnv drops every key-like name and every CLAUDE / ANTHROPIC_ / CODEX_ / OPENAI_ name, and keeps exactly the three runtime names', () => {
  const { env, dropped } = runtimeEnv(sourceWith({ ...DROPPED, ...KEPT }));
  for (const name of Object.keys(DROPPED)) assert.equal(Object.keys(env).some(key => key.toUpperCase() === name), false, `${name} must not reach the child`);
  assert.deepEqual(Object.keys(env).filter(name => /^(CLAUDE|ANTHROPIC_|CODEX_|OPENAI_)/iu.test(name)).sort(), [...KEPT_ENV].sort(), 'exactly three runtime names remain');
  for (const [name, value] of Object.entries(KEPT)) assert.equal(env[name], value, `${name} is kept with its value`);
  assert.deepEqual(KEPT_ENV, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_GIT_BASH_PATH']);
  assert.deepEqual(dropped, Object.keys(DROPPED).sort(), 'every dropped name is listed, the kept three are not');
  assert.equal(Object.values(env).some(value => value.startsWith('sentinel-')), false);
});

test('runtimeEnv does not invent a kept name that the parent does not have', () => {
  const source = sourceWith({ CLAUDE_CONFIG_DIR: 'C:/x/.claude' });
  delete source.CODEX_HOME;
  delete source.CLAUDE_CODE_GIT_BASH_PATH;
  const { env } = runtimeEnv(source);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:/x/.claude');
  assert.equal('CODEX_HOME' in env, false);
  assert.equal('CLAUDE_CODE_GIT_BASH_PATH' in env, false);
});

test('the prefixes are matched without regard to case, and a wider scrubbed environment still loses every other runtime name', () => {
  const wide = { PATH: '/bin', claude_foo: '1', Anthropic_Base_Url: '2', codex_x: '3', OpenAI_Org: '4', CLAUDECODE: '5', CODEX_HOME: 'h', CLAUDE_CONFIG_DIR: 'c', CLAUDE_CODE_GIT_BASH_PATH: 'g', UNRELATED: 'u' };
  assert.deepEqual(keepRuntimeNames(wide), { PATH: '/bin', CODEX_HOME: 'h', CLAUDE_CONFIG_DIR: 'c', CLAUDE_CODE_GIT_BASH_PATH: 'g', UNRELATED: 'u' });
});

test('a child started through the process manager sees none of the dropped names and the three kept ones; the log names the dropped names without their values', async t => {
  const lines: string[] = [];
  const processes = new ProcessManager({ log: line => lines.push(line), env: sourceWith({ ...DROPPED, ...KEPT }) });
  const dir = tempDir(t);
  const scope = await processes.open();
  const child = scope.spawn({ file: process.execPath, args: [FAKE_RUNTIME_SCRIPT], cwd: dir });
  child.writeLine(JSON.stringify({ type: 'env' }));
  let seen: Record<string, string> = {};
  for await (const line of child.lines()) { seen = JSON.parse(line).env; break; }
  await scope.finish();
  for (const name of Object.keys(DROPPED)) assert.equal(Object.keys(seen).some(key => key.toUpperCase() === name), false, `${name} reached the child`);
  for (const [name, value] of Object.entries(KEPT)) assert.equal(seen[name], value);
  const started = lines.find(line => line.includes('runtime process started'));
  assert.ok(started, lines.join('\n'));
  for (const name of Object.keys(DROPPED)) assert.ok(started.includes(name), `${name} is named in the log`);
  assert.equal(lines.some(line => line.includes('sentinel-')), false, 'no value is logged');
  assert.deepEqual(child.record.droppedEnv, Object.keys(DROPPED).sort());
  assert.deepEqual([...child.record.keptEnv].sort(), [...KEPT_ENV].sort());
});
