import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFor, ApprovalTable, requestIdFor, type ApprovalKind } from '../src/runtimes/codex/approvals.ts';
import { CodexRefused } from '../src/runtimes/codex/app-server.ts';
import type { ApprovalDecision } from '../src/runtimes/types.ts';

const KINDS: ApprovalKind[] = ['command', 'writeStdin', 'fileChange', 'permissions'];
const DECISIONS: ApprovalDecision[] = ['accept', 'accept_for_reply', 'decline', 'decline_by_beat', 'cancel'];
const REQUESTED = { network: { enabled: true }, fileSystem: { read: null, write: ['D:\\other'] }, extra: 'never copied' };

test('every answer beat can give is one of the closed set, for every kind and decision', () => {
  const allowedDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
  for (const kind of KINDS) {
    for (const decision of DECISIONS) {
      const answer = answerFor(kind, decision, REQUESTED);
      if (kind === 'permissions') {
        const permissions = answer as { permissions: Record<string, unknown>; scope: string };
        assert.equal(permissions.scope, 'turn', 'never session');
        assert.deepEqual(Object.keys(answer).sort(), ['permissions', 'scope']);
        assert.ok(Object.keys(permissions.permissions).every(key => key === 'network' || key === 'fileSystem'), 'nothing but what can be asked for');
        assert.equal('extra' in permissions.permissions, false);
      } else {
        assert.deepEqual(Object.keys(answer), ['decision']);
        assert.ok(allowedDecisions.has((answer as { decision: string }).decision), `${kind}/${decision}`);
      }
    }
  }
});

test('a decision that is not accept never grants anything; accept grants exactly what was asked and nothing more', () => {
  for (const decision of ['decline', 'decline_by_beat', 'cancel'] as const) assert.deepEqual(answerFor('permissions', decision, REQUESTED), { permissions: {}, scope: 'turn' });
  assert.deepEqual(answerFor('permissions', 'accept', REQUESTED), { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['D:\\other'] } }, scope: 'turn' });
  assert.deepEqual(answerFor('permissions', 'accept', { network: { enabled: 'yes' } }), { permissions: {}, scope: 'turn' }, 'a malformed ask grants nothing');
  assert.deepEqual(answerFor('permissions', 'accept', undefined), { permissions: {}, scope: 'turn' });
});

test('answers that rewrite the owner\'s settings or rules cannot be produced: unknown decisions are refused', () => {
  for (const decision of ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment', 'acceptForSession', 'approved', 'session', '', 'toString', '__proto__', undefined, null, 1]) {
    for (const kind of KINDS) assert.throws(() => answerFor(kind, decision as never, REQUESTED), (error: unknown) => error instanceof CodexRefused && error.reason === 'protocol', `${kind}/${String(decision)}`);
  }
});

test('request ids from the server cannot collide across number and string', () => {
  assert.notEqual(requestIdFor(1), requestIdFor('1'));
  const table = new ApprovalTable();
  const first = table.classify(1, 'item/fileChange/requestApproval', { itemId: 'x' });
  const second = table.classify('1', 'item/fileChange/requestApproval', { itemId: 'x' });
  assert.ok('approval' in first && 'approval' in second);
  assert.equal(table.size, 2);
  assert.equal(table.answer(requestIdFor('1'), 'decline').rpcId, '1');
  assert.equal(table.answer(requestIdFor(1), 'accept').rpcId, 1);
  assert.throws(() => table.answer(requestIdFor(1), 'accept'), CodexRefused);
});

test('a request Codex closed itself (resolved) can no longer be answered; cancelAll closes everything left without granting', () => {
  const table = new ApprovalTable();
  table.classify(5, 'item/commandExecution/requestApproval', { itemId: 'c', command: 'ls' });
  table.classify(6, 'item/permissions/requestApproval', { itemId: 'p', permissions: { network: { enabled: true }, fileSystem: null } });
  table.classify(7, 'item/fileChange/requestApproval', { itemId: 'f' });
  table.resolved(7);
  assert.throws(() => table.answer(requestIdFor(7), 'accept'), CodexRefused);
  const all = table.cancelAll();
  assert.deepEqual(all.map(entry => [entry.rpcId, entry.result]), [[5, { decision: 'cancel' }], [6, { permissions: {}, scope: 'turn' }]]);
  assert.equal(table.size, 0);
});

test('the file table keeps the paths and a bounded diff of each change, caps its size, and forgets a malformed item rather than guess', () => {
  const table = new ApprovalTable();
  table.rememberChanges('f1', [{ path: 'a.ts', kind: { type: 'add' }, diff: 'SOME DIFF' }]);
  table.rememberChanges('bad', [{ path: 'a.ts', kind: { type: 'teleport' } }]);
  const ok = table.classify(1, 'item/fileChange/requestApproval', { itemId: 'f1' });
  const bad = table.classify(2, 'item/fileChange/requestApproval', { itemId: 'bad' });
  assert.ok('approval' in ok && 'approval' in bad);
  assert.deepEqual((ok as { approval: { input: unknown } }).approval.input, { itemId: 'f1', reason: null, grantRoot: null, changes: [{ path: 'a.ts', kind: 'add', diff: 'SOME DIFF' }] });
  assert.equal(((bad as { approval: { input: { changes: unknown } } }).approval.input).changes, null);
  for (let index = 0; index < 400; index += 1) table.rememberChanges(`i${index}`, [{ path: `${index}.ts`, kind: { type: 'add' } }]);
  const forgotten = table.classify(3, 'item/fileChange/requestApproval', { itemId: 'f1' });
  assert.equal(((forgotten as { approval: { input: { changes: unknown } } }).approval.input).changes, null, 'the oldest entries were dropped');
});

test('a diff is cut per change and per item, and the cut is written in the text so a short diff is never mistaken for a whole one', () => {
  const table = new ApprovalTable();
  const changes = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.ts`, kind: { type: 'update' }, diff: `${index}`.repeat(20000) }));
  table.rememberChanges('big', changes);
  const input = (table.classify(1, 'item/fileChange/requestApproval', { itemId: 'big' }) as { approval: { input: { changes: Array<{ path: string; diff?: string }> } } }).approval.input;
  const diffs = input.changes.map(change => change.diff ?? '');
  assert.equal(input.changes.length, 12, 'every path is kept');
  assert.ok(diffs.every(diff => diff.length < 8100), 'one change never carries more than its share');
  assert.match(diffs[0]!, /^0{100}[\s\S]*\n\[12000 more characters of this change not shown\]$/u);
  assert.ok(diffs.reduce((sum, diff) => sum + diff.length, 0) < 70000, 'one item never holds more than its total');
  assert.equal(diffs[11], '[the diff is not kept]', 'a change after the total is used up says so');
  table.rememberChanges('empty', [{ path: 'e.ts', kind: { type: 'delete' }, diff: '' }, { path: 'g.ts', kind: { type: 'add' } }]);
  const none = (table.classify(2, 'item/fileChange/requestApproval', { itemId: 'empty' }) as { approval: { input: { changes: unknown } } }).approval.input.changes;
  assert.deepEqual(none, [{ path: 'e.ts', kind: 'delete' }, { path: 'g.ts', kind: 'add' }], 'no diff given, no diff key');
});

test('forgetChanges drops the paths of one item, so a changed list is never shown stale', () => {
  const table = new ApprovalTable();
  table.rememberChanges('f1', [{ path: 'a.ts', kind: { type: 'add' } }]);
  table.rememberChanges('f2', [{ path: 'b.ts', kind: { type: 'add' } }]);
  table.forgetChanges('f1');
  table.forgetChanges('never-seen');
  const f1 = table.classify(1, 'item/fileChange/requestApproval', { itemId: 'f1' }) as { approval: { input: { changes: unknown } } };
  const f2 = table.classify(2, 'item/fileChange/requestApproval', { itemId: 'f2' }) as { approval: { input: { changes: unknown } } };
  assert.equal(f1.approval.input.changes, null);
  assert.deepEqual(f2.approval.input.changes, [{ path: 'b.ts', kind: 'add' }], 'only that item was forgotten');
});

test('unreadable and unknown requests are declined, never parked as approvals', () => {
  const table = new ApprovalTable();
  for (const [method, params] of [
    ['item/commandExecution/requestApproval', null], ['item/commandExecution/requestApproval', { kind: 'command' }], ['item/fileChange/requestApproval', { itemId: 3 }],
    ['item/commandExecution/requestApproval', { kind: 'humanCommand', itemId: 'x' }], ['item/permissions/requestApproval', { itemId: 'x', permissions: 'all' }],
    ['item/tool/requestUserInput', {}], ['mcpServer/elicitation/request', {}], ['item/tool/call', {}], ['account/chatgptAuthTokens/refresh', {}], ['totally/new', {}],
  ] as const) {
    const classified = table.classify(9, method, params);
    assert.ok('refused' in classified, `${method} ${JSON.stringify(params)}`);
  }
  assert.equal(table.size, 0);
});
