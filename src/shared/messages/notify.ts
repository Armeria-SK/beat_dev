import { defineMessages } from './define.ts';

// 外の送り先（webhook）へ送る文と、送り先の失敗・上限を知らせる通知の文。送る文は設定の言語（languageOf）で選ぶ
const en = {
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

export const notifyText = defineMessages('notify', en);