import { gateJa } from './gate.ts';
import { httpJa } from './http.ts';
import { pendingJa } from './pending.ts';
import { taskJa } from './tasks.ts';

export const JA_SERVER: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> = { http: httpJa, task: taskJa, pending: pendingJa, gate: gateJa };
