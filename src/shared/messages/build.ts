import { defineMessages } from './define.ts';

const en = {
  'no_plan': 'There is no plan yet. Write the plan before building',
  'changed': 'The plan or the acceptance list changed meanwhile. Reload and check them again',
  'running': 'A build of this product is already running',
  'frozen': 'The acceptance list is already locked (version {version}). Change it before building again',
  'snapshot_taken': 'Snapshot before Build: {hash}. Running `git restore --source={hash} --worktree -- .` in the product folder brings back the files as they were at this point; files created later are not removed, and secret-looking or linked files were left out of the snapshot (it is kept as {ref}).',
  'snapshot_not_git': 'This folder is not a git repository, so beat cannot take a snapshot before Build. The Build goes on without one.',
  'snapshot_unavailable': 'beat could not use git safely in this folder, so no snapshot was taken before Build. The Build goes on without one.',
  'snapshot_timeout': 'The snapshot before Build took longer than {seconds} s, so the Build goes on without a snapshot.',
  'snapshot_failed': 'The snapshot before Build failed, so the Build goes on without one.',
} as const;

export type BuildMessageKey = keyof typeof en;

export const buildText = defineMessages<BuildMessageKey>('build', en);
