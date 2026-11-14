import { defineMessages } from './define.ts';

const en = {
  'not_in_task': 'deviation_add works only in a task of a product',
  'no_items': 'This product has no acceptance list yet, so item cannot be given. Leave item out',
  'items_unreadable': 'The acceptance list of this product cannot be read now, so item cannot be checked. Leave item out, or try again later',
  'bad_item': 'There is no acceptance item "{item}" in the current list. Items: {items}. Leave item out if the difference is not about one item',
  'empty': 'Give {field} in one short sentence',
  'too_long': '{field} is too long ({length} characters, up to {max})',
  'duplicate': 'This difference is already recorded ({item})',
  'full': 'deviations.md already has {max} entries. Ask the owner before recording more',
  'file_unusable': 'deviations.md in the product data is not a plain file, so it is left as it is',
  'no_item': 'no item',
  'saved': 'Recorded in deviations.md ({item}). Keep working',
  'saved_external': 'Recorded in deviations.md ({item}). This run has read text from elsewhere, so the entry is marked as such. Keep working',
  'saved_hidden': 'Parts that looked like a secret key or token were hidden',
} as const;

export type DeviationMessageKey = keyof typeof en;

export const deviationText = defineMessages<DeviationMessageKey>('deviation', en);
