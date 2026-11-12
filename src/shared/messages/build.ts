import { defineMessages } from './define.ts';

const en = {
  'no_plan': 'There is no plan yet. Write the plan before building',
  'changed': 'The plan or the acceptance list changed meanwhile. Reload and check them again',
  'running': 'A build of this product is already running',
  'frozen': 'The acceptance list is already fixed (version {version}). Change it before building again',
} as const;

export type BuildMessageKey = keyof typeof en;

export const buildText = defineMessages<BuildMessageKey>('build', en);
