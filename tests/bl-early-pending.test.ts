import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingAction } from '../web/src/api.ts';
import { decidedMore } from '../web/src/ui/pending.ts';

// backlog（#268 の審査の残り (3)）: 取り消した Pending の一覧に理由が出ない。DB に残っている reject_reason があれば Details で出す。

const row = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 1, tool: 'shell_run', shown: 'git push', masked: 0, kind: 'send', reason: 'sends data out',
  cwd: null, preview: [], files: [], conversation_id: 'c1', task_id: null, project_id: 'prod01', task_title: null, project_name: 'Shop site',
  status: 'cancelled', reject_reason: null, exit_code: null, output_preview: null, created_at: 1_000, decided_at: 2_000, ran_at: null, ...over,
});

test('bl-early pending: 理由つきで取り消された行は、Details に理由を出す', () => {
  assert.deepEqual(decidedMore(row({ reject_reason: '  The task ended  ' })), { reason: 'The task ended', output: null });
});

test('bl-early pending: 理由の無い取り消しの行は今のまま（Details なし）', () => {
  assert.equal(decidedMore(row({ reject_reason: null })), null);
  assert.equal(decidedMore(row({ reject_reason: '   ' })), null);
});

test('bl-early pending: 却下の行は今までどおり', () => {
  assert.deepEqual(decidedMore(row({ status: 'rejected', reject_reason: 'wrong host' })), { reason: 'wrong host', output: null });
  assert.equal(decidedMore(row({ status: 'rejected' })), null);
});
