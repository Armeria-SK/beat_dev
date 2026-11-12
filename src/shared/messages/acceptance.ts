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
  'not_frozen': 'The acceptance list is not locked yet. Write the draft with acceptance_write',
  'bad_change': 'A change is not valid: {detail}',
  'no_change': 'There is no such proposed change for this product',
  'not_pending': 'This proposed change was already decided ({status})',
  'stale': 'The acceptance list changed since this was based on it (now version {version}). Look at the current list and propose again',
} as const;

export type AcceptanceMessageKey = keyof typeof en;

export const acceptanceText = defineMessages<AcceptanceMessageKey>('acceptance', en);
