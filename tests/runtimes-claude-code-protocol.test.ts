import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { answerFor, claudeMode, disallowedTools, secretDenyRules, sessionOnlyUpdates, STOPPED_ANSWER } from '../src/runtimes/claude-code/permissions.ts';
import { apiKeyInUse, EventTranslator, failureKind, versionAtLeast, type TranslatorOptions } from '../src/runtimes/claude-code/protocol.ts';
import { PERMISSIONS } from '../src/runtimes/types.ts';
import { SECRET_GLOBS } from '../src/tools/hooks/scope.ts';
import { initMessage, resultMessage, sdkMessage, textMessage } from './helpers/fake-claude-sdk.ts';

function translator(over: Partial<TranslatorOptions> = {}) {
  const sessions: string[] = [];
  const translate = new EventTranslator({ expectedMode: 'default', interrupted: () => false, onSession: id => sessions.push(id), ...over });
  return { sessions, translate };
}

const stream = (event: object, over: Record<string, unknown> = {}) => sdkMessage({ type: 'stream_event', parent_tool_use_id: null, event, ...over });
const failed = (events: ReturnType<EventTranslator['translate']>) => events.find(event => event.type === 'failed');

test('versionAtLeast compares numbers, not text, and treats an unreadable version as too old', () => {
  for (const version of ['2.1.296', '2.1.331', '2.2.0', '3.0.0', '2.10.0', '10.0.0', '2.1.296 (Claude Code)']) assert.equal(versionAtLeast(version), true, version);
  for (const version of ['2.1.295', '2.0.999', '1.99.99', '2.1.29', 'garbage', '', undefined]) assert.equal(versionAtLeast(version), false, String(version));
});

test('the API key source: only "none" or nothing is acceptable', () => {
  assert.equal(apiKeyInUse(undefined), false);
  assert.equal(apiKeyInUse('none'), false);
  for (const source of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper', 'project', '/login managed key', '']) assert.equal(apiKeyInUse(source), true, source);
});

test('failure kinds: login problems are auth, limits are rate_limit, everything else is process', () => {
  for (const error of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']) assert.equal(failureKind(error), 'auth', error);
  for (const error of ['rate_limit', 'billing_error', 'overloaded']) assert.equal(failureKind(error), 'rate_limit', error);
  for (const error of ['server_error', 'unknown', 'something-new', undefined]) assert.equal(failureKind(error), 'process', String(error));
});

test('text that was streamed in pieces is not repeated by the finished message; text that was not streamed is shown once; sub-agent text is left out', () => {
  const { translate } = translator();
  translate.translate(initMessage());
  const streamed = [
    stream({ type: 'message_start', message: { id: 'm1' } }),
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }),
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }),
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }),
    stream({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } }),
    textMessage('m1', 'Hello'),
  ].flatMap(message => translate.translate(message));
  assert.deepEqual(streamed, [{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }]);
  assert.deepEqual(translate.translate(textMessage('m2', 'Whole')), [{ type: 'text', delta: 'Whole' }]);
  assert.deepEqual(translate.translate(textMessage('m3', 'inner', { parent_tool_use_id: 'toolu_x' })), []);
  assert.deepEqual(translate.translate(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'inner' } }, { parent_tool_use_id: 'toolu_x' })), []);
});

test('tool use becomes tool_start, and a tool result becomes tool_end with its error flag; images are not copied', () => {
  const { translate } = translator();
  const start = translate.translate(sdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }] } }));
  assert.deepEqual(start, [{ type: 'tool_start', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }]);
  const content = [{ type: 'text', text: 'line one' }, { type: 'image', source: { data: 'AAAA' } }];
  const end = translate.translate(sdkMessage({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, is_error: true }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'plain' }] } }));
  assert.deepEqual(end, [{ type: 'tool_end', id: 'toolu_1', output: 'line one\n[image]', isError: true }, { type: 'tool_end', id: 'toolu_2', output: 'plain', isError: false }]);
  assert.deepEqual(translate.translate(sdkMessage({ type: 'user', message: { content: 'a plain string' } })), []);
});

test('a message of a kind we do not know is kept as unknown with secrets removed; known side messages are dropped', () => {
  const { translate } = translator();
  const events = translate.translate(sdkMessage({ type: 'brand_new_kind', note: 'key sk-ant-api03-ABCDEFGHIJKLMNOP' }));
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'unknown' && events[0].raw.includes('brand_new_kind') && !events[0].raw.includes('ABCDEFGHIJKLMNOP'));
  const long = translate.translate(sdkMessage({ type: 'another', blob: 'x'.repeat(10_000) }));
  assert.ok(long[0]?.type === 'unknown' && long[0].raw.length <= 4001);
  for (const type of ['rate_limit_event', 'tool_progress', 'auth_status', 'tool_use_summary', 'prompt_suggestion', 'keep_alive']) assert.deepEqual(translate.translate(sdkMessage({ type })), [], type);
  assert.deepEqual(translate.translate(sdkMessage({ type: 'system', subtype: 'status' })), []);
});

test('the first message: a login with no API key passes; an API key or a different permission mode stops the reply', () => {
  const ok = translator();
  assert.deepEqual(ok.translate.translate(initMessage({ session_id: 'abc' })), []);
  assert.equal(ok.translate.guarded, false);
  assert.deepEqual(ok.sessions, ['abc']);
  const missing = translator();
  assert.deepEqual(missing.translate.translate(initMessage({ apiKeySource: undefined })), []);

  const key = translator();
  const keyEvents = key.translate.translate(initMessage({ apiKeySource: 'ANTHROPIC_API_KEY' }));
  assert.ok(failed(keyEvents)?.type === 'failed' && (failed(keyEvents) as { kind: string }).kind === 'auth');
  assert.equal(key.translate.guarded, true);

  const mode = translator({ expectedMode: 'default' });
  const modeEvents = mode.translate.translate(initMessage({ permissionMode: 'bypassPermissions' }));
  assert.equal((failed(modeEvents) as { kind: string }).kind, 'process');
  assert.equal(mode.translate.guarded, true);
  const edits = translator({ expectedMode: 'acceptEdits' });
  assert.deepEqual(edits.translate.translate(initMessage({ permissionMode: 'acceptEdits' })), []);
  assert.equal(edits.translate.guarded, false);
  assert.equal((failed(edits.translate.translate(initMessage({ permissionMode: 'default' }))) as { kind: string }).kind, 'process', 'a mode that is narrower than asked for is also not what was asked');
});

test('a result is judged by is_error, not by its subtype; the failure kind comes from the error seen just before', () => {
  const login = translator();
  login.translate.translate(initMessage());
  login.translate.translate(sdkMessage({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm1', content: [{ type: 'text', text: 'Not logged in' }] } }));
  const authFailed = login.translate.translate(resultMessage({ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' }));
  assert.deepEqual(authFailed, [{ type: 'failed', kind: 'auth', message: 'Not logged in · Please run /login' }]);

  const limit = translator();
  limit.translate.translate(initMessage());
  limit.translate.translate(sdkMessage({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }));
  assert.equal((failed(limit.translate.translate(resultMessage({ is_error: true, result: 'slow down' }))) as { kind: string }).kind, 'rate_limit');

  const plain = translator();
  plain.translate.translate(initMessage());
  assert.deepEqual(plain.translate.translate(resultMessage({ is_error: true, subtype: 'error_max_turns', errors: ['too many turns', 'second'] })), [{ type: 'failed', kind: 'process', message: 'too many turns; second' }]);
  const empty = plain.translate.translate(resultMessage({ is_error: true, subtype: 'error_during_execution', errors: [] }));
  assert.ok(empty[0]?.type === 'failed' && empty[0].message.length > 0);
  const secret = translator();
  secret.translate.translate(initMessage());
  const redacted = secret.translate.translate(resultMessage({ is_error: true, result: `bad ${'x'.repeat(5000)} sk-ant-api03-ABCDEFGHIJKLMNOP` }));
  assert.ok(redacted[0]?.type === 'failed' && redacted[0].message.length <= 2001 && !redacted[0].message.includes('ABCDEFGHIJKLMNOP'));

  assert.deepEqual(translator().translate.translate(resultMessage()), [{ type: 'failed', kind: 'process', message: 'Claude Code ended the reply before it reported how it started.' }], 'a reply that never reported how it started is not a success');
  const fine = translator();
  fine.translate.translate(initMessage());
  assert.deepEqual(fine.translate.translate(resultMessage()), [{ type: 'done' }]);
});

test('an error result after we asked to stop is done, not a failure', () => {
  let stopping = false;
  const { translate } = translator({ interrupted: () => stopping });
  translate.translate(initMessage());
  stopping = true;
  assert.deepEqual(translate.translate(resultMessage({ is_error: true, subtype: 'error_during_execution', errors: [] })), [{ type: 'done' }]);
});

test('claudeMode keeps the two allowed values and turns everything else into default', () => {
  assert.deepEqual([...PERMISSIONS['claude-code']], ['default', 'acceptEdits']);
  assert.equal(claudeMode('default'), 'default');
  assert.equal(claudeMode('acceptEdits'), 'acceptEdits');
  for (const value of ['bypassPermissions', 'plan', 'auto', 'dontAsk', 'workspace-write', 'read-only', 'acceptedits', '', undefined]) assert.equal(claudeMode(value), 'default', String(value));
});

test('deny rules cover every secret path for both Read and Edit, and the question tool is off', () => {
  const rules = secretDenyRules();
  assert.equal(rules.length, SECRET_GLOBS.length * 2);
  for (const glob of SECRET_GLOBS) assert.ok(rules.includes(`Read(${glob})`) && rules.includes(`Edit(${glob})`), glob);
  assert.deepEqual(disallowedTools(), ['AskUserQuestion', ...rules]);
});

const update = (over: object): PermissionUpdate => over as PermissionUpdate;

test('only suggestions that stay inside this process (session) and only allow rules or the two allowed modes are kept', () => {
  const rule = update({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }], behavior: 'allow', destination: 'session' });
  const mode = update({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
  const defaultMode = update({ type: 'setMode', mode: 'default', destination: 'session' });
  const rejected = [
    ...['localSettings', 'projectSettings', 'userSettings', 'cliArg'].map(destination => update({ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination })),
    ...['localSettings', 'userSettings'].map(destination => update({ type: 'setMode', mode: 'acceptEdits', destination })),
    update({ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }),
    update({ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'ask', destination: 'session' }),
    ...['bypassPermissions', 'plan', 'auto', 'dontAsk'].map(modeName => update({ type: 'setMode', mode: modeName, destination: 'session' })),
    update({ type: 'addDirectories', directories: ['/x'], destination: 'session' }),
    update({ type: 'removeDirectories', directories: ['/x'], destination: 'session' }),
    update({ type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }),
    update({ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }),
  ];
  assert.deepEqual(sessionOnlyUpdates([...rejected, rule, mode, defaultMode]), [rule, mode, defaultMode]);
  assert.deepEqual(sessionOnlyUpdates(rejected), []);
  assert.deepEqual(sessionOnlyUpdates(undefined), []);
});

test('answers: accept keeps the input as it is; accept_for_reply adds only the session-only updates; the rest are denials', () => {
  const input = { command: 'echo hi' };
  const rule = update({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }], behavior: 'allow', destination: 'session' });
  const local = update({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }], behavior: 'allow', destination: 'localSettings' });
  assert.deepEqual(answerFor('accept', input, [rule, local]), { behavior: 'allow', updatedInput: input });
  assert.deepEqual(answerFor('accept_for_reply', input, [local, rule]), { behavior: 'allow', updatedInput: input, updatedPermissions: [rule] });
  assert.deepEqual(answerFor('accept_for_reply', input, [local]), { behavior: 'allow', updatedInput: input });
  assert.deepEqual(answerFor('accept_for_reply', input, undefined), { behavior: 'allow', updatedInput: input });
  assert.deepEqual(answerFor('decline', input, [rule]), { behavior: 'deny', message: 'The owner declined this request.' });
  assert.deepEqual(answerFor('cancel', input, [rule]), { behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true });
  assert.deepEqual(answerFor('anything-else' as 'decline', input, [rule]), { behavior: 'deny', message: 'The owner declined this request.' });
  assert.deepEqual(STOPPED_ANSWER, { behavior: 'deny', message: 'The owner stopped the reply.', interrupt: true });
});
