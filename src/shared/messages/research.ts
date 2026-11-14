import { defineMessages } from './define.ts';

const en = {
  'not_running': 'Records can be written only while a research run is going on',
  'finished': 'Research {id} has ended, so its records cannot be changed',
  'not_found': 'Research {id} was not found',
  'kind_phase': 'A {kind} row does not belong in this research',
  'url_not_opened': 'This run has not opened {url}. Open the page with web_fetch first, then record it with the URL you read',
  'url_invalid': 'The URL is not a web page address',
  'url_required': 'Give the URL of the page you read',
  'duplicate': 'This research already has a row for {what}',
  'too_many': 'This research already has {max} {kind} rows',
  'options_count': 'Give 2 to 4 options',
  'label_empty': 'The name is empty',
  'label_long': 'The name is longer than {max} characters',
  'label_lines': 'The name must be a single line',
  'label_control': 'The name has control characters',
  'label_url': 'The name looks like a web address',
  'label_code': 'The name has code marks',
  'label_shell': 'The name has shell symbols',
  'label_markup': 'The name has a Markdown link, heading or HTML tag',
  'label_secret': 'The name looks like it holds a key or password',
  'recorded': 'Recorded as #{id}. Unknown (not found word for word on the page): {unknown}',
  'recorded_all': 'Recorded as #{id}.',
  'merged': 'Added to #{id}. Products seen with it: {count}',
} as const;

export type ResearchMessageKey = keyof typeof en;

export const researchText = defineMessages<ResearchMessageKey>('research', en);
