import { defineMessages } from './define.ts';

const en = {
  'unknown': 'The product was not found',
  'archived': 'This product is archived. Restore it first',
  'mismatch': 'This conversation belongs to a different product (or to none)',
  'folder_missing': 'The folder of this product could not be found',
  'root_in_use': 'Another product already uses this folder',
  'root_fixed': 'The folder of a product cannot be changed',
  'bad_name': 'The name must be one line of up to 100 characters, without control characters',
  'bad_check_command': 'The check command must be one line of up to 1000 characters',
  'bad_refresh': 'refreshRemotes must be true',
  'fixed_on_conversation': 'The product of a conversation cannot be changed',

  'folder_not_absolute': 'Enter the full path of a folder (without "." or ".." parts)',
  'folder_remote': 'Network and device paths cannot be used',
  'folder_hazard': 'This path has a form that is not safe to use on Windows',
  'folder_not_found': 'The folder was not found',
  'folder_not_directory': 'This is not a folder',
  'folder_unreadable': 'The folder could not be read',
  'folder_drive_root': 'The top of a drive cannot be a product folder',
  'folder_home': 'Your home folder (or a folder above it) cannot be a product folder. Pick a folder inside it',
  'folder_app_data': 'Folders that hold app settings and temporary files cannot be a product folder',
  'folder_system': 'System folders cannot be a product folder',
  'folder_clive': 'The folder of this app and its data cannot be a product folder',
  'folder_secret': 'Folders that hold secrets cannot be a product folder',
  'folder_denied': 'This folder is on the blocked list in the settings',
  'folder_link': 'This is a link. Open it to see the folder it points to',
} as const;

export type ProjectMessageKey = keyof typeof en;

export const projectText = defineMessages<ProjectMessageKey>('project', en);
