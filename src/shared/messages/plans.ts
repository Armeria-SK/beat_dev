import { defineMessages } from './define.ts';

const en = {
  'changed': 'The plan was changed meanwhile. Reload to see it',
  'too_long': 'The plan is too long (up to {max} characters)',
  'secret': 'The plan looks like it contains a secret key or token. Remove it and save again',
  'not_file': 'plan.md in the product folder is not a regular file (a folder or a link). Replace it with a file',
  'writing': 'A conversation in this product is still running and may change the plan. Mark it as reviewed once it is done',
  'archived': 'This product is archived. Restore it before changing the plan',
} as const;

export type PlanMessageKey = keyof typeof en;

export const planText = defineMessages<PlanMessageKey>('plan', en);
