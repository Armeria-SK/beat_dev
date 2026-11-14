import { defineMessages } from './define.ts';

const en = {
  'no_folder': 'The folder of this product cannot be used in this run, so the map and the glossary cannot be written',
  'secret': '{field} looks like it contains a secret key or token. Leave it out',
  'file_unusable': '{file} in the mesh folder is not a plain file, so it is left as it is',
  'map_bad_path': 'The folder "{path}" is not one beat lists for the map (folders up to 2 levels deep in the product folder, without ignored ones). Folders not in the map yet: {folders}',
  'map_bad_entry': 'The entry "{entry}" is not a file inside {path} in the product folder. Give an existing file under that folder, or leave entry out',
  'map_what_empty': 'Give what the folder does, in one short English line',
  'map_what_marks': 'what cannot contain "entry:" or square brackets; give the entry file in entry',
  'map_too_long': 'The line for {path} is too long ({length} characters, up to {max} with the path and the entry). Shorten what; put details in a note',
  'map_owner_row': 'The line for {path} was written by the owner, so it is left as it is. Describe another folder, or ask the owner',
  'map_full': 'MAP.md already has {max} lines. Describe a folder higher up instead',
  'map_saved': 'Updated MAP.md: {path}',
  'map_saved_external': 'Updated MAP.md: {path}. This run has read text from elsewhere, so the line is marked as such',
  'glossary_term_empty': 'Give the name the owner uses, exactly as the owner wrote it',
  'glossary_term_arrow': 'The name cannot contain "→"',
  'glossary_bad_target': 'There is no "{target}" in the product folder or the mesh folder. Give an existing path in the product folder (relative to it), or a mesh file such as plan.md',
  'glossary_too_long': 'The line for this name is too long ({length} characters, up to {max})',
  'glossary_owner_row': 'This name was written by the owner, so its line is left as it is',
  'glossary_full': 'GLOSSARY.md already has {max} names. Use a name that is already there',
  'glossary_saved': 'Updated GLOSSARY.md: {term}',
  'glossary_saved_external': 'Updated GLOSSARY.md: {term}. This run has read text from elsewhere, so the line is marked as such',
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
