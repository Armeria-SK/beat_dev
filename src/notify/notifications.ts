import type { DatabaseSync } from 'node:sqlite';
import { arrangeNotifications, NOTIFICATION_LIST_LIMIT, PINNED_KINDS } from '../shared/notification-list.ts';

export type NotificationKind = 'task_done' | 'task_waiting' | 'task_failed' | 'approval_needed' | 'health_alert' | 'info';

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  dedup_key: string | null;
  read_at: number | null;
  created_at: number;
}

// 聞き手に渡す値。noForward は DB に残さず、外の送り先へ送らない通知の印（health_alert など、送り先の失敗を知らせる通知が自分で連鎖しないように）
export type NotifyEvent = Notification & { noForward?: true };

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string | undefined;
  link?: string | undefined;
  dedupKey?: string | undefined;
  noForward?: true | undefined;
  projectId?: string | null | undefined;
}

export const DEDUP_MS = 24 * 3_600_000;

export class Notifications {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #listeners: Array<(n: NotifyEvent) => void> = [];
  // 聞かれていたことが片づいて既読にした通知の id（持ち主が読んだときの markRead では呼ばない）
  onSettled: ((ids: number[]) => void) | undefined;

  constructor(db: DatabaseSync, now: () => number = Date.now, log: (line: string) => void = () => {}) { this.#db = db; this.#now = now; this.#log = log; }

  // 新しい通知を聞く（画面への配信、外の送り先）。1 本が throw しても、通知の作成と残りの聞き手は止めない
  listen(listener: (n: NotifyEvent) => void): void { this.#listeners.push(listener); }

  notify(input: NotifyInput): Notification | undefined {
    const now = this.#now();
    if (input.dedupKey) {
      const recent = this.#db.prepare('SELECT 1 FROM notifications WHERE dedup_key = ? AND created_at > ?').get(input.dedupKey, now - DEDUP_MS);
      if (recent) return undefined;
    }
    const result = this.#db.prepare('INSERT INTO notifications (kind, title, body, link, dedup_key, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.kind, input.title.slice(0, 200), input.body?.slice(0, 2000) ?? null, input.link ?? null, input.dedupKey ?? null, now, input.projectId ?? null);
    const n = this.#db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as Notification;
    const event: NotifyEvent = input.noForward ? { ...n, noForward: true } : n;
    for (const listener of this.#listeners) {
      try { listener(event); } catch (error) { this.#log(`[ERROR] A notification listener failed: ${(error as Error).message}`); }
    }
    return n;
  }

  list(limit = NOTIFICATION_LIST_LIMIT): Notification[] {
    const kinds = PINNED_KINDS.map(() => '?').join(', ');
    const rows = this.#db.prepare(`SELECT * FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)
      OR (read_at IS NULL AND kind IN (${kinds})) ORDER BY id DESC`).all(limit, ...PINNED_KINDS) as unknown as Notification[];
    return arrangeNotifications(rows, limit);
  }

  unread(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
  }

  // 通知が持ち主に求めていたこと（承認・返事・失敗の確認）が片づいたら、その未読を既読にする。kind と、link か dedupKey が合うものだけ
  settle(kind: NotificationKind, by: { link: string } | { dedupKey: string }): void {
    const rows = ('link' in by
      ? this.#db.prepare('SELECT id FROM notifications WHERE read_at IS NULL AND kind = ? AND link = ?').all(kind, by.link)
      : this.#db.prepare('SELECT id FROM notifications WHERE read_at IS NULL AND kind = ? AND dedup_key = ?').all(kind, by.dedupKey)) as Array<{ id: number }>;
    if (!rows.length) return;
    const ids = rows.map(r => r.id);
    this.settleIds(ids);
    this.onSettled?.(ids);
  }

  // 片づいた通知を既読にし、重ねない印（dedup_key）も外す。外さないと、同じ dedupKey（失敗・相談は task ごとに 1 つ）の次の通知が 24 時間止まる。
  // 持ち主が読んだだけの markRead は印を残す。画面へは流さない（起動の掃除から直に呼ぶ）
  settleIds(ids: readonly number[]): void {
    const now = this.#now();
    for (const id of ids) this.#db.prepare('UPDATE notifications SET read_at = ?, dedup_key = NULL WHERE id = ? AND read_at IS NULL').run(now, id);
  }

  markRead(ids?: readonly number[]): void {
    const now = this.#now();
    if (!ids) { this.#db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now); return; }
    for (const id of ids) this.#db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(now, id);
  }
}
