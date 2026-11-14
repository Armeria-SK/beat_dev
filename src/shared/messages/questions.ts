import { defineMessages } from './define.ts';

const en = {
  'unavailable': 'Questions are not available yet',
  'not_found': 'Question {id} was not found',
  'invalid_id': 'The question number is not valid',
  'invalid_status': 'The status must be open or answered',
} as const;

export type QuestionMessageKey = keyof typeof en;

export const questionText = defineMessages<QuestionMessageKey>('question', en);
