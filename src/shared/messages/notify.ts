import { defineMessages } from './define.ts';

// 外の送り先（webhook）へ送る文と、送り先の失敗・上限を知らせる通知の文。送る文は英語
const en = {
  'local_title.task_done': 'beat: work on a local model finished',
  'local_title.task_waiting': 'beat: work on a local model is waiting for a reply',
  'local_title.task_failed': 'beat: work on a local model failed',
  'local_title.approval_needed': 'beat: work on a local model is waiting for approval',
  'local_title.health_alert': 'beat: work on a local model has a problem',
  'local_title.info': 'beat: there is a notice from work on a local model',
  'test': 'This is a test notification from beat',
  'channel_failing': 'Notification target "{id}" has failed {fails} times in a row ({reason}). Check Settings > Notifications',
  'cap_reached': 'External notifications reached the hourly limit ({max}); no more will be sent this hour (settings: notify.limits.maxSendsPerHour)',
};

export const notifyText = defineMessages('notify', en);