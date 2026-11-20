import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchItem, ResearchRecord } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import {
  canConfirm, choiceTag, confirmedLines, confirmFailure, confirmPicks, defaultTag, featureGroups, initialPicks, ownSettings, pickedCount, presetChoice, researchModel, setResearch, setResearchModel, statusPill, toggleLanguage,
} from '../web/src/ui/research.ts';

// beat R (M7・R-2u / R-4): 調べた一覧の画面の決まり（DOM なし）

const item = (over: Partial<ResearchItem> & Pick<ResearchItem, 'id' | 'kind' | 'name'>): ResearchItem => ({
  detail: null, url: null, license: null, updated: null, language: null, products: [], options: null, by: null, defaultChecked: false, defaultReason: null, recommended: null, decision: null, reason: null, ...over,
});

const record = (over: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id: 'r1', phase: 'products', mode: 'batch', status: 'done', partial: false, auto: true, stopReason: null, createdAt: 1, finishedAt: 2, confirmedAt: null, shownHash: 'a'.repeat(64),
  items: [
    item({ id: 1, kind: 'similar', name: 'Alpha Notes', url: 'https://alpha.example/notes', license: 'MIT' }),
    item({ id: 2, kind: 'similar', name: 'Beta Notes', url: 'https://beta.example/app' }),
    item({ id: 3, kind: 'feature', name: 'Tag search', products: [1, 2], defaultChecked: true, defaultReason: 'standard' }),
    item({ id: 4, kind: 'feature', name: 'Live preview', products: [1], defaultChecked: true, defaultReason: 'owner_said' }),
    item({ id: 5, kind: 'feature', name: 'Sync', products: [2] }),
    item({ id: 6, kind: 'choice', name: 'How to store notes?', options: ['Files', 'SQLite'], by: 'model', recommended: 1 }),
    item({ id: 7, kind: 'choice', name: 'Which language for the app?', options: ['Go', 'Rust', 'Python'], by: 'code', recommended: 0 }),
  ],
  ...over,
});

const t = (key: string) => (en as Record<string, unknown>)[key];

test('前もっての選び: コードの物差しのおすすめだけ選ばれ、モデルのおすすめは選ばれない（R3.11 L4 (c)）', () => {
  const r = record();
  const picks = initialPicks(r);
  assert.deepEqual(picks.choices, { 7: 0 }, 'the code ruler pre-selects, the model never does');
  assert.equal(presetChoice(r.items[5]!), null);
  assert.equal(presetChoice(r.items[6]!), 0);
  assert.equal(presetChoice(item({ id: 9, kind: 'choice', name: 'Q', options: ['A', 'B'], by: 'code', recommended: 5 })), null, 'an index out of range is not pre-selected');
  assert.equal(presetChoice(item({ id: 9, kind: 'choice', name: 'Q', options: ['A', 'B'], by: 'code', recommended: null })), null);
  assert.deepEqual(picks.features, { 3: 'picked', 4: 'picked', 5: 'later' }, 'features start from the code-made default checks');
  assert.equal(picks.similar, null, 'no similar product is chosen for the owner');
});

test('札: 機能は「あなたが言った」と「定番」を分け、選択は物差しの推しと AI の推しを分ける。推していない選択肢には札が無い', () => {
  const r = record();
  assert.equal(t(defaultTag(r.items[2]!)!), 'Standard');
  assert.equal(t(defaultTag(r.items[3]!)!), 'You said it');
  assert.equal(defaultTag(r.items[4]!), null);
  assert.equal(choiceTag(r.items[5]!, 1), 'ui.rs.tag.ai');
  assert.equal(choiceTag(r.items[5]!, 0), null);
  assert.equal(choiceTag(r.items[6]!, 0), 'ui.rs.tag.measures');
});

test('送る選び: 答えていない選択は何も送らない。選んだ選択だけ送る。機能は全部（選ばないものは later、いらないは理由つき）', () => {
  const r = record();
  const start = initialPicks(r);
  assert.deepEqual(confirmPicks(r, start), [
    { id: 3, decision: 'picked' }, { id: 4, decision: 'picked' }, { id: 5, decision: 'later' }, { id: 7, decision: 0 },
  ], 'the model-recommended choice 6 is absent until the owner answers it');
  const answered = { ...start, choices: { ...start.choices, 6: 0 }, features: { ...start.features, 5: 'not_needed' as const }, reasons: { 5: '  later  ' } };
  assert.deepEqual(confirmPicks(r, answered), [
    { id: 3, decision: 'picked' }, { id: 4, decision: 'picked' }, { id: 5, decision: 'not_needed', reason: 'later' }, { id: 6, decision: 0 }, { id: 7, decision: 0 },
  ]);
});

test('似ているもの: 使う（メモと入れて設定する）・土台にする（足りない機能だけ送る）・自分で作る（最初の行に build）', () => {
  const r = record();
  const start = initialPicks(r);
  const use = confirmPicks(r, { ...start, similar: { id: 2, decision: 'use' }, memo: ' keep it ', setup: true });
  assert.deepEqual(use[0], { id: 2, decision: 'use', reason: 'keep it', setup: true });
  const base = { ...start, similar: { id: 1, decision: 'base' as const }, setup: true };
  assert.deepEqual(confirmPicks(r, base)[0], { id: 1, decision: 'base' }, 'setup and memo go only with use');
  assert.deepEqual(featureGroups(r, base).onBase.map(i => i.id), [3, 4], 'features the base already has are folded away');
  assert.deepEqual(featureGroups(r, base).missing.map(i => i.id), [5]);
  assert.ok(!confirmPicks(r, base).some(p => p.id === 3 || p.id === 4), 'a feature on the base is never sent (the server refuses it)');
  assert.equal(pickedCount(r, base), 0);
  assert.equal(pickedCount(r, start), 2);
  assert.deepEqual(confirmPicks(r, { ...start, similar: 'build' })[0], { id: 1, decision: 'build' });
});

test('確定の誤り: 409 conversation_running は「返事が終わってから」の 1 行、changed は読み直し、ほかは失敗', () => {
  const err = (code: string) => Object.assign(new Error('x'), { status: 409, body: { code } });
  assert.deepEqual(confirmFailure(err('research.conversation_running')), { kind: 'busy' });
  assert.deepEqual(confirmFailure(err('research.changed')), { kind: 'changed' });
  assert.deepEqual(confirmFailure(err('research.source_gone')), { kind: 'failed', detail: 'x' });
  assert.equal(t('ui.rs.busy'), 'The conversation is still replying. Try again after the reply finishes');
});

test('状態: 確定できるのは終わった記録だけ。札の言葉と色', () => {
  assert.equal(canConfirm(record({ status: 'running' })), false);
  assert.equal(canConfirm(record({ status: 'skipped' })), false);
  assert.equal(canConfirm(record({ status: 'confirmed' })), false);
  for (const status of ['done', 'failed', 'cancelled'] as const) assert.equal(canConfirm(record({ status })), true, status);
  assert.deepEqual(statusPill(record({ status: 'running' })), { label: 'ui.rs.status.running', tone: 'running' });
  assert.deepEqual(statusPill(record({ status: 'done', partial: true })), { label: 'ui.rs.status.partial', tone: 'warn' });
  assert.deepEqual(statusPill(record({ status: 'confirmed' })), { label: 'ui.rs.status.confirmed', tone: 'ok' });
  assert.deepEqual(statusPill(record({ status: 'skipped' })), { label: 'ui.rs.status.skipped', tone: undefined });
});

test('確定のあと: DB の選びから読み戻す（自分で作るは 1 行だけ）', () => {
  const r = record({ status: 'confirmed', items: [
    item({ id: 1, kind: 'similar', name: 'Alpha', decision: 'build' }), item({ id: 2, kind: 'similar', name: 'Beta', decision: 'build' }),
    item({ id: 3, kind: 'feature', name: 'Tags', decision: 'picked' }), item({ id: 4, kind: 'feature', name: 'Sync', decision: 'later' }),
    item({ id: 5, kind: 'choice', name: 'Store?', options: ['Files', 'SQLite'], decision: '1' }), item({ id: 6, kind: 'choice', name: 'Skip?', options: ['A', 'B'], decision: null }),
  ] });
  assert.deepEqual(confirmedLines(r), [{ kind: 'build', name: '' }, { kind: 'feature', name: 'Tags' }, { kind: 'choice', name: 'Store?', option: 'SQLite' }]);
});

test('設定（R-4）: 調べ役のモデル・research の塊の書き方・言語は好きと避けたいの両方に入らない・製品の上書きの空は null', () => {
  assert.equal(researchModel({ routing: { research: ['m2'] } }), 'm2');
  assert.equal(researchModel({ routing: {} }), '');
  assert.deepEqual(setResearchModel({ routing: { chat: ['m1'] } }, 'm2').routing, { chat: ['m1'], research: ['m2'] });
  assert.deepEqual(setResearchModel({ routing: { chat: ['m1'], research: ['m2'] } }, '').routing, { chat: ['m1'] }, 'empty means the same as the conversation');
  assert.deepEqual(setResearch({ research: { when: 'new', limits: { searches: 5 } } }, { limits: { minutes: 9 } }).research, { when: 'new', limits: { searches: 5, minutes: 9 } });
  assert.deepEqual(setResearch({ research: { limits: { searches: 5 } } }, { limits: { searches: undefined } }).research, {}, 'clearing the last limit drops the limits block');
  assert.deepEqual(setResearch({ research: { preferLanguages: ['Go'] } }, { preferLanguages: undefined }).research, {});
  assert.deepEqual(toggleLanguage({ prefer: ['Go'], avoid: ['Python'] }, 'prefer', 'Python'), { prefer: ['Go', 'Python'], avoid: [] });
  assert.deepEqual(toggleLanguage({ prefer: ['Go'], avoid: [] }, 'avoid', 'Go'), { prefer: [], avoid: ['Go'] });
  assert.deepEqual(toggleLanguage({ prefer: ['Go', 'Rust'], avoid: [] }, 'prefer', 'Go'), { prefer: ['Rust'], avoid: [] });
  assert.equal(ownSettings({ limits: {} }), null);
  assert.deepEqual(ownSettings({ when: 'off', limits: { minutes: 3 } }), { when: 'off', limits: { minutes: 3 } });
});

test('受け入れの一覧: 出どころ owner_pick に「あなたが選んだ（調べた一覧から）」の札・選んだ名前・数の行が付く', async () => {
  const { coverageCounts, coverageGroups, itemDetails, sourceLabel } = await import('../web/src/ui/acceptance.ts');
  const source = { kind: 'owner_pick' as const, researchId: 'r1', itemId: 3, label: 'Tag search' };
  assert.equal(t(sourceLabel(source)), 'You picked (research list)');
  const entry = { id: 'A-1', result: 'Notes can be found by tag', source, check: { kind: 'look' as const }, state: 'open' as const, evidence: [], changedIn: null, removedIn: null };
  assert.deepEqual(itemDetails(entry)[0], { label: 'ui.acc.detail.picked', text: 'Tag search' });
  const acc = { version: 1, language: null, items: [entry], not_doing: [], draft: true, hash: null, frozen: null };
  assert.deepEqual(coverageGroups(acc).picks.map(p => [p.label, p.item.id]), [['Tag search', 'A-1']]);
  const counts = coverageCounts({ owner_words: 1, owner_choice: 0, owner_edit: 0, owner_pick: 1, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 });
  assert.deepEqual(counts.map(([key]) => key), ['ui.cov.words', 'ui.cov.answers', 'ui.cov.picks', 'ui.cov.ai', 'ui.cov.byHand']);
  assert.ok(!coverageCounts({ owner_words: 1, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 }).some(([key]) => key === 'ui.cov.picks'), 'no picks line when there are none');
});
