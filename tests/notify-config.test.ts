import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ConfigError, defaultConfig, parseConfig } from '../src/config/store.ts';
import { NOTIFICATION_KINDS, NotificationKindSchema } from '../src/config/schema.ts';
import type { NotificationKind } from '../src/notify/notifications.ts';

const channel = (over: Record<string, unknown> = {}) => ({ id: 'phone', kind: 'webhook', urlEnv: 'CLIVE_NOTIFY_PHONE_URL_SECRET', ...over });
const withNotify = (notify: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(defaultConfig())), notify });

test('T-01 設定に notify が無ければ既定の値になる（送り先なし・リンクの頭なし）', () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, unknown>;
  delete raw.notify;
  const config = parseConfig(raw);
  assert.deepEqual(config.notify.channels, []);
  assert.equal(config.notify.publicBaseUrl, '');
});

test('T-02 NotificationKindSchema は NotificationKind と一致する', () => {
  const all: Record<NotificationKind, true> = { task_done: true, task_waiting: true, task_failed: true, approval_needed: true, health_alert: true, info: true };
  assert.deepEqual([...NOTIFICATION_KINDS].sort(), Object.keys(all).sort());
  for (const kind of Object.keys(all)) assert.ok(Value.Check(NotificationKindSchema, kind), kind);
  assert.ok(!Value.Check(NotificationKindSchema, 'other'));
});

test('チャネルの既定: 種類は 4 つ・有効・本文なし', () => {
  const config = parseConfig(withNotify({ channels: [channel()] }));
  const c = config.notify.channels[0]!;
  assert.deepEqual(c.kinds, ['task_waiting', 'task_failed', 'approval_needed', 'health_alert']);
  assert.equal(c.enabled, true);
  assert.equal(c.includeBody, false);
  assert.equal(c.tokenEnv, undefined);
});

test('T-03 断るもの', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['id の重複', { channels: [channel(), channel({ urlEnv: 'CLIVE_NOTIFY_OTHER_URL_SECRET' })] }],
    ['urlEnv が小文字', { channels: [channel({ urlEnv: 'clive_notify_url_secret' })] }],
    ['id が大文字', { channels: [channel({ id: 'Phone' })] }],
    ['publicBaseUrl が http の外部', { publicBaseUrl: 'http://example.com' }],
    ['publicBaseUrl が URL でない', { publicBaseUrl: 'clive.example' }],
    ['urlEnv が ANTHROPIC_API_KEY', { channels: [channel({ urlEnv: 'ANTHROPIC_API_KEY' })] }],
    ['tokenEnv が ANTHROPIC_API_KEY', { channels: [channel({ tokenEnv: 'ANTHROPIC_API_KEY' })] }],
    ['同じ urlEnv の 2 つ', { channels: [channel(), channel({ id: 'tablet' })] }],
    ['urlEnv と tokenEnv が同じ', { channels: [channel({ tokenEnv: 'CLIVE_NOTIFY_PHONE_URL_SECRET' })] }],
    ['kinds が空', { channels: [channel({ kinds: [] })] }],
    ['kinds に知らない種類', { channels: [channel({ kinds: ['nope'] })] }],
    ['kind が webhook でない', { channels: [channel({ kind: 'ntfy' })] }],
    ['知らない項目', { channels: [channel({ extra: 1 })] }],
  ];
  for (const [label, notify] of bad) assert.throws(() => parseConfig(withNotify(notify)), ConfigError, label);
});

test('T-03 プロバイダの鍵の変数（apiKeyEnv）を指す urlEnv も断る', () => {
  const raw = withNotify({ channels: [channel({ urlEnv: 'CLIVE_OPENAI_API_KEY' })] });
  raw.providers.push({ id: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'CLIVE_OPENAI_API_KEY', maxParallel: 1, timeoutMs: 600_000 });
  assert.throws(() => parseConfig(raw), ConfigError);
});

test('T-03 通す: https と loopback の http の publicBaseUrl', () => {
  assert.equal(parseConfig(withNotify({ publicBaseUrl: 'https://clive.example.ts.net' })).notify.publicBaseUrl, 'https://clive.example.ts.net');
  assert.equal(parseConfig(withNotify({ publicBaseUrl: 'http://127.0.0.1:4777' })).notify.publicBaseUrl, 'http://127.0.0.1:4777');
});

test('T-03b limits: 範囲外は丸めずに ConfigError。既定は §1.3 の表', () => {
  assert.deepEqual(parseConfig(withNotify({})).notify.limits, { maxChannels: 4, maxSendsPerHour: 30, timeoutMs: 5000, retries: 1, failsBeforeAlert: 3 });
  const outOfRange: Array<Record<string, number>> = [
    { maxChannels: 9 }, { maxChannels: 0 }, { maxSendsPerHour: 121 }, { maxSendsPerHour: 0 },
    { timeoutMs: 999 }, { timeoutMs: 15_001 }, { retries: 3 }, { retries: -1 }, { failsBeforeAlert: 0 }, { failsBeforeAlert: 11 },
  ];
  for (const limits of outOfRange) assert.throws(() => parseConfig(withNotify({ limits })), ConfigError, JSON.stringify(limits));
  assert.equal(parseConfig(withNotify({ limits: { maxSendsPerHour: 120, retries: 2, timeoutMs: 15_000, maxChannels: 8, failsBeforeAlert: 10 } })).notify.limits.maxSendsPerHour, 120);
});

test('T-03b maxChannels より多いチャネルは ConfigError', () => {
  const channels = ['a', 'b', 'c'].map(id => channel({ id, urlEnv: `CLIVE_NOTIFY_${id.toUpperCase()}_URL_SECRET` }));
  assert.throws(() => parseConfig(withNotify({ channels, limits: { maxChannels: 2 } })), ConfigError);
  assert.equal(parseConfig(withNotify({ channels, limits: { maxChannels: 3 } })).notify.channels.length, 3);
});

test('チャネルは絶対の上限 8 を越えられない', () => {
  const channels = Array.from({ length: 9 }, (_, i) => channel({ id: `c${i}`, urlEnv: `CLIVE_NOTIFY_C${i}_URL_SECRET` }));
  assert.throws(() => parseConfig(withNotify({ channels, limits: { maxChannels: 8 } })), ConfigError);
});