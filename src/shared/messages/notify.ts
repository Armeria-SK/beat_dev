import { defineMessages } from './define.ts';

// 外の送り先（webhook）へ送る文と、送り先の失敗・上限を知らせる通知の文。送る文は英語
const en = {
  'test': 'This is a test notification from beat',
  'channel_failing': 'Notification target "{id}" has failed {fails} times in a row ({reason}). Check Settings > Notifications',
  'question_new': 'Question recorded',
  'question_new_blocking': 'A task is waiting for your answer',
  'cap_reached': 'External notifications reached the hourly limit ({max}); no more will be sent this hour (settings: notify.limits.maxSendsPerHour)',
};

export const notifyText = defineMessages('notify', en);