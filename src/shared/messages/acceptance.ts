import { defineMessages } from './define.ts';

const en = {
  'frozen': 'The acceptance list is already fixed (version {version}). Do not rewrite it: propose a change with acceptance_change',
  'too_many': 'The acceptance list can have up to {max} items and {max} not-doing entries',
  'too_long': 'An acceptance item is too long ({field}: up to {max} characters)',
  'bad_command': 'A check command must be one line of up to {max} characters, without control characters',
  'bad_source': 'An item with source {kind} needs {fields}',
  'secret': 'The acceptance list looks like it contains a secret key or token. Remove it and write again',
  'not_file': 'acceptance.json in the product folder is not a regular file (a folder or a link). Replace it with a file',
  'archived': 'This product is archived. Restore it before changing the acceptance list',
} as const;

export type AcceptanceMessageKey = keyof typeof en;

export const acceptanceText = defineMessages<AcceptanceMessageKey>('acceptance', en);
