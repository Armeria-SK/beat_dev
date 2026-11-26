import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexConnection, type ConnectionHandlers } from '../src/runtimes/codex/app-server.ts';
import type { RuntimeProcess } from '../src/runtimes/process-manager.ts';

const SECRET = 'sk-ant-abcdefgh12345678';
const ODD = `broken‮\u0007line ${SECRET} end`;

function fakeProcess(lines: () => AsyncIterable<string>): RuntimeProcess {
  const exited = Promise.resolve({ code: 0, signal: null, stderr: '' });
  return { pid: undefined, record: {}, stdout: undefined, exited, containReason: undefined, lines, writeLine: () => true, closeInput() {}, stop: () => exited, kill() {} } as unknown as RuntimeProcess;
}

async function logsOf(lines: () => AsyncIterable<string>, handlers: Partial<ConnectionHandlers> = {}): Promise<string[]> {
  const log: string[] = [];
  await new Promise<void>(resolve => {
    new CodexConnection(fakeProcess(lines), { notification() {}, serverRequest() {}, unreadable() {}, ended: () => resolve(), ...handlers }, line => log.push(line));
  });
  return log;
}

const plain = (line: string | undefined): string => {
  assert.ok(line, 'the line was logged');
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(line), JSON.stringify(line));
  assert.ok(!line.includes('abcdefgh12345678'), 'the secret is hidden');
  assert.ok(line.includes('broken??line'), `the control and direction characters are replaced with ?: ${line}`);
  return line;
};

test('a handler that throws is logged with control and direction characters replaced, secrets hidden and the length cut (the text can carry a piece of an unreadable Codex line)', async () => {
  const log = await logsOf(async function* () { yield '{"method":"x"}'; }, { notification() { throw new Error(`${ODD} ${'z'.repeat(1000)}`); } });
  const line = plain(log.find(entry => entry.includes('Codex message handler failed')));
  assert.ok(line.startsWith('[ERROR] Codex message handler failed: '), line);
  assert.ok(line.length <= '[ERROR] Codex message handler failed: '.length + 300, `the message is cut: ${line.length}`);
});

test('output that could not be read is logged with control and direction characters replaced, secrets hidden and the length cut', async () => {
  const log = await logsOf(async function* () { yield* []; throw new Error(`${ODD} ${'z'.repeat(1000)}`); });
  const line = plain(log.find(entry => entry.includes('Codex output could not be read')));
  assert.ok(line.startsWith('[WARN] Codex output could not be read: '), line);
  assert.ok(line.length <= '[WARN] Codex output could not be read: '.length + 300, `the message is cut: ${line.length}`);
});
