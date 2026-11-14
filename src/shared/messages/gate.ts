import { defineMessages } from './define.ts';

const en = {
  'run_tool.task_only': 'A tool can start another tool only inside a task run',
  'run_tool.nested': 'A tool started by another tool cannot start one more',
} as const;

export type GateMessageKey = keyof typeof en;

export const gateText = defineMessages<GateMessageKey>('gate', en);
