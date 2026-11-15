import { defineMessages } from './define.ts';

const en = {
  'file_unusable': '{file} in the mesh folder is not a plain file, so it is left as it is',
  'decision_empty': 'Give the decision in one short English line',
  'decision_marks': 'The decision cannot contain square brackets',
  'decision_too_long': 'The decision is too long ({length} characters, up to {max}). Shorten it; put details in a note',
  'decision_closed': 'This product is archived, so no decision is recorded',
  'decision_saved': 'Added a line to DECISIONS.md, marked as recorded by the AI',
  'decision_saved_external': 'Added a line to DECISIONS.md, marked as recorded by the AI. This run has read text from elsewhere, so the line is also marked as such and is not counted in the Mesh',
  'decision_saved_old': 'DECISIONS.md is full of the owner\'s decisions, so this line went to DECISIONS-old.md; mesh_search finds it',
  'decision_external_note': 'This run has read text from elsewhere, so the line is marked as such',
  'decision_hidden': 'Part of it looked like a secret key or token, so it was hidden',
} as const;

export type MeshWriteMessageKey = keyof typeof en;

export const meshWriteText = defineMessages<MeshWriteMessageKey>('meshwrite', en);
