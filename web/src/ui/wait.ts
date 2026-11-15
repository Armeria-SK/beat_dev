import type { WaitReason } from '../api.ts';
import { formatDateTimeSmart, t } from '../i18n/index.ts';

export function waitText(reason: WaitReason, now = Date.now()): string {
  switch (reason.kind) {
    case 'paused': return t('ui.wait.paused');
    case 'chat': return t('ui.wait.chat');
    case 'budget': return t('ui.wait.budget', formatDateTimeSmart(reason.at, now));
    case 'product': return t('ui.wait.product');
    case 'slots': return t('ui.wait.slots');
  }
}
