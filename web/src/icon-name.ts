export const ICON_NAMES = [
  'msg', 'tasks', 'activity', 'wrench', 'book', 'bell', 'sun', 'moon', 'plus', 'archive', 'pencil', 'chevD', 'x', 'check', 'terminal',
  'file', 'filePen', 'globe', 'bookmark', 'loader', 'clock', 'repeat', 'sparkles', 'help', 'circle', 'circleCheck', 'circleX', 'circleSlash',
  'play', 'pause', 'square', 'arrowUp', 'arrowL', 'shield', 'wifi', 'undo', 'folder', 'menu', 'alert', 'refresh', 'cpu', 'sliders', 'search',
  'panel', 'chevR', 'copy', 'slash', 'info', 'paperclip',
] as const;

export type IconName = typeof ICON_NAMES[number];
