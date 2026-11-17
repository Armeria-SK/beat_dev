import { defineMessages } from './define.ts';

const en = {
  'unavailable': 'The scout ledger can be written only in a run on a product',
  'closed': 'This product is archived or its folder is missing, so nothing is recorded',
  'unusable': '{file} in the product notes is not a plain file or folder, so the ledger is left as it is',
  'bad_id': 'No ledger entry {id}. Leave id out to add a new entry',
  'empty': 'Give {field} in one short English line',
  'recorded': 'Recorded {id} in scout/ledger.md (commit {commit})',
  'rewritten': 'Rewrote {id} in scout/ledger.md (commit {commit})',
  'paths_dropped': 'Not kept: {count} area paths that are not relative paths inside the product folder ({paths})',
  'no_area_kept': 'No area path was usable, so this entry marks no place as checked',
  'hidden': 'Part of it looked like a secret key or token, so it was hidden',
} as const;

export type ScoutMessageKey = keyof typeof en;

export const scoutText = defineMessages<ScoutMessageKey>('scout', en);
