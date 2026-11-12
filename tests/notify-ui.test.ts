import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { accessWidening, secretEntryAccess } from '../web/src/settings/access.ts';
import { SECTION_GROUPS, sectionSlice, type Config } from '../web/src/settings/model.ts';

// AU-5a T-20: 設定の「通知の送り先」の、画面を使わない部分（広がる変更の検出・文言・節の登録）

const channel = (over: Record<string, unknown> = {}) => ({
  id: 'phone', kind: 'webhook', urlEnv: 'BEAT_NOTIFY_PHONE_URL_SECRET', kinds: ['task_failed'], enabled: true, includeBody: false, ...over,
});
const config = (notify: Record<string, unknown>): Config => ({ notify } as unknown as Config);

test('通知の送り先を足す・宛先を変える・本文を許す・種類を増やす・有効に戻す・リンクの元を決める は、確かめを求める', () => {
  const before = config({ channels: [channel()] });
  assert.deepEqual(accessWidening(before, config({ channels: [channel(), channel({ id: 'tablet', urlEnv: 'BEAT_NOTIFY_TABLET_URL_SECRET' })] })), [{ kind: 'notify-channel-added', id: 'tablet' }, { kind: 'notify-channel-kinds', id: 'tablet', kinds: ['task_failed'] }]);
  // 足すときも、本文を送る・送る種類を並べる
  assert.deepEqual(accessWidening(config({ channels: [] }), config({ channels: [channel({ includeBody: true, kinds: ['info', 'task_failed'] })] })), [
    { kind: 'notify-channel-added', id: 'phone' }, { kind: 'notify-channel-body', id: 'phone' }, { kind: 'notify-channel-kinds', id: 'phone', kinds: ['info', 'task_failed'] },
  ]);
  assert.deepEqual(accessWidening(before, config({ channels: [channel({ urlEnv: 'OTHER_URL' })] })), [{ kind: 'notify-channel-target', id: 'phone' }]);
  assert.deepEqual(accessWidening(before, config({ channels: [channel({ includeBody: true })] })), [{ kind: 'notify-channel-body', id: 'phone' }]);
  assert.deepEqual(accessWidening(before, config({ channels: [channel({ kinds: ['task_failed', 'info'] })] })), [{ kind: 'notify-channel-kinds', id: 'phone', kinds: ['info'] }]);
  assert.deepEqual(accessWidening(config({ channels: [channel({ enabled: false })] }), before), [{ kind: 'notify-channel-enabled', id: 'phone' }]);
  assert.deepEqual(accessWidening(before, config({ channels: [channel()], publicBaseUrl: 'https://beat.example.net' })), [{ kind: 'notify-public-url', url: 'https://beat.example.net' }]);
});

test('狭める・同じ変更は確かめない（種類を減らす・無効にする・本文を止める・リンクの元を消す）', () => {
  const wide = config({ channels: [channel({ kinds: ['task_failed', 'info'], includeBody: true })], publicBaseUrl: 'https://beat.example.net' });
  const narrow = config({ channels: [channel({ kinds: ['task_failed'], enabled: false })] });
  assert.deepEqual(accessWidening(wide, narrow), []);
  assert.deepEqual(accessWidening(wide, wide), []);
});

test('上限を上げるときだけ確かめる。下げるのは確かめない', () => {
  const lim = (n: number) => config({ channels: [], limits: { maxSendsPerHour: n } });
  assert.deepEqual(accessWidening(lim(30), lim(60)), [{ kind: 'limit-raised', key: 'notify.maxSendsPerHour', from: 30, to: 60 }]);
  assert.deepEqual(accessWidening(lim(60), lim(30)), []);
});

test('URL の入れ直しは確かめる（宛先が変わる）。token は確かめない。設定にない送り先は確かめない', () => {
  const c = config({ channels: [channel()] });
  assert.deepEqual(secretEntryAccess({ id: 'phone', field: 'url' }, c), [{ kind: 'notify-channel-target', id: 'phone' }]);
  assert.deepEqual(secretEntryAccess({ id: 'phone', field: 'token' }, c), []);
  assert.deepEqual(secretEntryAccess({ id: 'ghost', field: 'url' }, c), []);
});

test('確かめの文言は、差し込みが入り、日本語が混ざらない', () => {
  const en7 = [en['access.notifyAdded']('p'), en['access.notifyTarget']('p'), en['access.notifyBody']('p'), en['access.notifyKinds']('p', 'Info'), en['access.notifyEnabled']('p'), en['access.notifyPublicUrl']('https://x.example'), en['access.limitRaised']('notify.maxChannels', 4, 8)];
  for (const text of en7) assert.ok(text.includes('p') || text.includes('https://x.example') || text.includes('notify.maxChannels'), text);
  assert.ok(en7[3]!.includes('Info'));
  assert.ok(en7[6]!.includes('4') && en7[6]!.includes('8'));
  for (const text of en7) assert.doesNotMatch(text, /[\u3040-\u30ff\u4e00-\u9fff]/u, text);
});

test('通知の節は「動き」の組に入り、設定の notify を切り出す。画面の文言は en にある', () => {
  const ids = SECTION_GROUPS.flatMap(g => g.items.map(s => s.id));
  assert.ok(ids.includes('notify'));
  assert.deepEqual(sectionSlice(config({ channels: [] }), 'notify'), { channels: [] });
  const keys = (d: Record<string, unknown>) => Object.keys(d).filter(k => k.startsWith('notifications.kind.')).sort();
  assert.ok(keys(en).length >= 6);
  for (const k of keys(en)) {
    const v = (en as Record<string, unknown>)[k];
    const text = typeof v === 'function' ? (v as (...a: unknown[]) => string)('x', 'y') : String(v);
    assert.doesNotMatch(text, /[\u3040-\u30ff\u4e00-\u9fff]/u, k);
  }
});