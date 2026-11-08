import { defineMessages } from './define.ts';

// 外の送り先（webhook）へ送る文と、送り先の失敗・上限を知らせる通知の文。送る文は設定の言語（languageOf）で選ぶ
const ja = {
  'local_title.task_done': 'Clive: 手元のモデルの作業が完了しました',
  'local_title.task_waiting': 'Clive: 手元のモデルの作業が返事を待っています',
  'local_title.task_failed': 'Clive: 手元のモデルの作業が失敗しました',
  'local_title.approval_needed': 'Clive: 手元のモデルの作業が承認を待っています',
  'local_title.health_alert': 'Clive: 手元のモデルの作業で異常があります',
  'local_title.info': 'Clive: 手元のモデルの作業からのお知らせがあります',
  'test': 'Clive からの試しの通知です',
  'channel_failing': '通知の送り先「{id}」に {fails} 回続けて送れていません（{reason}）。設定の「通知」で確かめてください',
  'cap_reached': '外の送り先への通知が 1 時間の上限（{max} 件）に達したので、この時間の残りは送りません（設定の notify.limits.maxSendsPerHour）',
};

const en: Record<keyof typeof ja, string> = {
  'local_title.task_done': 'Clive: work on a local model finished',
  'local_title.task_waiting': 'Clive: work on a local model is waiting for a reply',
  'local_title.task_failed': 'Clive: work on a local model failed',
  'local_title.approval_needed': 'Clive: work on a local model is waiting for approval',
  'local_title.health_alert': 'Clive: work on a local model has a problem',
  'local_title.info': 'Clive: there is a notice from work on a local model',
  'test': 'This is a test notification from Clive',
  'channel_failing': 'Notification target "{id}" has failed {fails} times in a row ({reason}). Check Settings > Notifications',
  'cap_reached': 'External notifications reached the hourly limit ({max}); no more will be sent this hour (settings: notify.limits.maxSendsPerHour)',
};

export const notifyText = defineMessages('notify', ja, en);