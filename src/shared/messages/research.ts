import { defineMessages } from './define.ts';

const en = {
  'not_running': 'Records can be written only while a research run is going on',
  'finished': 'Research {id} has ended, so its records cannot be changed',
  'not_found': 'Research {id} was not found',
  'running': 'Research is already running for this product',
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
  'recorded': 'Recorded as #{id}. Unknown (too short, or not found word for word on the page; quote the whole sentence): {unknown}',
  'recorded_all': 'Recorded as #{id}.',
  'merged': 'Added to #{id}. Products seen with it: {count}',
  'evidence_dropped': 'Evidence not kept: {dropped} of {given} ({not_row} with a url that is not a similar row of this research, {not_on_page} too short or not found word for word on that page; quote the whole sentence).',
} as const;

export type ResearchMessageKey = keyof typeof en;

export const researchText = defineMessages<ResearchMessageKey>('research', en);
