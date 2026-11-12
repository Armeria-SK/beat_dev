import { defineMessages } from './define.ts';

const en = {
  'changed': 'The plan was changed meanwhile. Reload to see it',
  'too_long': 'The plan is too long (up to {max} characters)',
  'secret': 'The plan looks like it contains a secret key or token. Remove it and save again',
} as const;

export type PlanMessageKey = keyof typeof en;

export const planText = defineMessages<PlanMessageKey>('plan', en);
