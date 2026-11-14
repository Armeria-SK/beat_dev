import { defineMessages } from './define.ts';

const en = {
  'unavailable': 'Recording a difference from the plan is not available yet',
} as const;

export type DeviationMessageKey = keyof typeof en;

export const deviationText = defineMessages<DeviationMessageKey>('deviation', en);
