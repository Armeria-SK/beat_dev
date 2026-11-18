import { acceptanceJa } from './acceptance.ts';
import { buildJa } from './build.ts';
import { configJa } from './config.ts';
import { deviationJa } from './deviations.ts';
import { engineJa } from './engine.ts';
import { gateJa } from './gate.ts';
import { httpJa } from './http.ts';
import { meshWriteJa } from './mesh-write.ts';
import { pendingJa } from './pending.ts';
import { planJa } from './plans.ts';
import { projectJa } from './projects.ts';
import { providerJa } from './providers.ts';
import { questionJa } from './questions.ts';
import { storeJa } from './stores.ts';
import { taskJa } from './tasks.ts';

export const JA_SERVER: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> = { http: httpJa, task: taskJa, store: storeJa, provider: providerJa, engine: engineJa, config: configJa, project: projectJa, plan: planJa, acceptance: acceptanceJa, build: buildJa, pending: pendingJa, question: questionJa, deviation: deviationJa, meshwrite: meshWriteJa, gate: gateJa };
