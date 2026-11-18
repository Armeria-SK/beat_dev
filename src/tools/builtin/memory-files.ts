export const MEMORY_FILE_DESCRIPTIONS = {
  memory_save: [
    'Save a note in this product\'s memory, so that you, in a later run, can rely on it without looking it up again.',
    'Save when the user asks you to remember something, or when it will clearly help the next piece of work on this product. You may save without asking.',
    'Do not save what the product\'s files, the plan, the acceptance list or a search of past conversations already tell, or how something went only this time.',
    'One topic per note. If you checked it, say in a few words how you checked it. If you did not check it, start the content with "Unverified:".',
  ].join(' '),
  memory_update: [
    'Rewrite a note in this product\'s memory when it is out of date or wrong, or to merge notes on the same topic into one. You may do this without asking.',
    'Keep only what a later run needs and cannot find in the product\'s files, the plan, the acceptance list or past conversations. Say how you checked it, or start the content with "Unverified:".',
  ].join(' '),
  memory_forget: 'Delete a note from this product\'s memory when it is wrong or no longer needed, or when the user asks you to forget it. You may do this without asking.',
} as const;
