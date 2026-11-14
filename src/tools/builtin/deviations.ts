import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { deviationText } from '../../shared/messages/deviations.ts';
import type { ToolDef } from '../types.ts';

export const deviationAdd: ToolDef = {
  name: 'deviation_add',
  description: 'Record where the work differs from the plan and why.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  async execute(_input, ctx) { return { content: deviationText(languageOf(ctx.config), 'unavailable'), isError: true }; },
};
