import { defineMessages } from './define.ts';

const en = {
  'send.upload': 'Uploads or publishes to an outside service ({cmd})',
  'send.data': 'Sends data over the network ({cmd})',
  'send.service': 'Writes to an outside service ({cmd})',
  'send.network_program': '{cmd} talks to other computers, and beat cannot tell that it only reads',
  'send.dynamic_target': 'The address for {cmd} is built when the command runs, so beat cannot see where it goes',
  'send.inline_code': 'The code passed to {cmd} can use the network or start other programs',
  'send.git_remote_change': 'Changes where git sends ({cmd})',
  'send.push_options': 'git push with options or environment variables that can change where it sends ({detail})',
  'send.push_target': 'git push to a destination that is not one of this product\'s recorded remotes ({remote})',
  'send.push_no_product': 'git push outside a product (there are no recorded remotes to compare with)',
  'send.git_mail': 'Sends patches by email (git {cmd})',
  'send.unknown_command': 'beat cannot tell what this command runs ({cmd}), so it counts as sending',
  'send.git_unknown': 'git with an option or subcommand beat does not know ({detail})',
  'send.after_change': 'git push after a step that can change git settings or the environment ({detail})',
  'send.tool_config': '{cmd} reads settings from a config file, input or environment that can change what it sends',
  'send.tool': 'This tool can send data outside',
  'send.browser_submit': 'Submits a form in the browser',
  'delete.files': 'Deletes files that git cannot restore and that this work did not create',
  'delete.unresolved': 'Deletes files that cannot be listed before running (wildcards, variables, computed names or piped input)',
  'delete.outside': 'Deletes files outside the product folder',
  'delete.no_product': 'Deletes files in a run that does not belong to a product',
  'delete.git_discard': 'git {cmd} throws away work that is not committed',
  'delete.git_branch': 'Force-deletes a git branch',
  'delete.git_stash': 'Drops saved git stash entries',
  'delete.git_remote_branch': 'Deletes a branch on a remote (git push)',
  'delete.git_history': 'git {cmd} removes history or references that may not be recoverable',
  'delete.inline_code': 'The code passed to {cmd} can delete files',
  'delete.tool': 'This tool can delete data',
  'deny.secret_target': 'The address contains text that looks like a key or password ({target})',
} as const;

export type OutboundMessageKey = keyof typeof en;

export const outboundText = defineMessages<OutboundMessageKey>('outbound', en);
