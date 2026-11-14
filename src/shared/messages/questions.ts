import { defineMessages } from './define.ts';

const en = {
  'not_found': 'Question {id} was not found',
  'invalid_id': 'The question number is not valid',
  'invalid_status': 'The status must be open or answered',
  'not_in_task': 'Questions can be recorded only while working on a task',
  'empty': 'The question is empty',
  'options_count': 'Give 2 to 4 options',
  'option_empty': 'An option is empty',
  'chosen_required': 'Give chosen (the number of the option you go ahead with), or set blocking when you cannot go on without the answer',
  'chosen_range': 'chosen must be the number of one of the options (0 to {max})',
  'duplicate': 'The same question is already open for this task (#{id})',
  'too_many': 'This task already has {max} questions. Go ahead with your assumptions',
  'recorded': 'Recorded as question #{id}. Keep working with the option you chose: {option}',
  'recorded_blocking': 'Recorded as question #{id}. The task waits for the answer. {end}',
  'task_running': 'The task of question {id} is running now. Answer when it waits for the answer',
  'invalid_answer': 'Answer with one of the options or with your own words',
  'invalid_choice': 'Choice {choice} is not one of the options',
  'fix_title': 'Answer to question #{id}: {question}',
  'fix_body': 'The owner answered a question from a task.\nQuestion: {question}\nAssumed answer: {assumed}\nOwner answer: {answer}\nChange the work so that it follows the owner answer.',
  'fix_send': 'The owner answered that it may be sent.',
  'assumed_none': '(none)',
  'untrusted_note': 'The question came from a run that read text from elsewhere, so this task carries text from elsewhere, and an option the owner picked is not used as the owner request.',
  'reopen_reason': 'The owner answered question #{id}: {answer}',
  'list_open': 'Open questions:',
  'list_answered': 'Recent answers:',
  'list_none': 'No questions yet',
  'list_open_line': '#{id} {question} (assumed: {assumed})',
  'list_answered_line': '#{id} {question} (assumed: {assumed}; answer: {answer})',
} as const;

export type QuestionMessageKey = keyof typeof en;

export const questionText = defineMessages<QuestionMessageKey>('question', en);
