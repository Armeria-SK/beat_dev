import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { tempDir } from './helpers.ts';

// 子の担当（agent_run）の会話は、親の作業の内側のもの。履歴の検索・読み出しには、手元のモデル（visibleModelIds を渡さない）でも外のモデルでも出さない（T-40）
test('子の会話は、履歴の検索にも読み出しにも出ない。ふつうの会話は今までどおり出る', t => {
  const db = openDatabase(join(tempDir(t), 'clive.db'), MIGRATIONS);
  try {
    const conversations = new Conversations(db);
    conversations.create({ id: 'parent', title: '親' });
    conversations.create({ id: 'child', title: '子', kind: 'task', source: { conversationId: 'parent' }, parentRunId: 'run-1' });
    conversations.create({ id: 'other', title: 'ほか' });
    conversations.append('parent', { role: 'user', content: 'qqxjournal 親の発言' });
    conversations.append('child', { role: 'assistant', content: 'qqxjournal 子の途中の発言' });
    conversations.append('other', { role: 'user', content: 'qqxjournal ほかの会話' });
    for (const visibleModelIds of [undefined, [] as string[], ['m1']]) {
      const ids = searchHistory(db, 'qqxjournal', { visibleModelIds }).map(h => h.conversationId).sort();
      assert.deepEqual(ids, ['other', 'parent'], JSON.stringify(visibleModelIds));
      assert.deepEqual(readHistory(db, 'child', { visibleModelIds }), [], `読み出し ${JSON.stringify(visibleModelIds)}`);
      assert.equal(readHistory(db, 'parent', { visibleModelIds }).length, 1);
    }
    // 2 文字以下の検索（LIKE の道）でも同じ
    assert.deepEqual(searchHistory(db, '子の').map(h => h.conversationId), []);
  } finally { db.close(); }
});