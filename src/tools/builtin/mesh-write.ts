import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { meshWriteText } from '../../shared/messages/mesh-write.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const unavailable = (ctx: ToolContext): ToolOutput => ({ content: meshWriteText(languageOf(ctx.config), 'unavailable'), isError: true });

export const meshMapSet: ToolDef = {
  name: 'mesh_map_set',
  description: 'Describe a folder of this product in its map.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  async execute(_input, ctx) { return unavailable(ctx); },
};

export const meshGlossarySet: ToolDef = {
  name: 'mesh_glossary_set',
  description: 'Record what a name the owner uses points to in this product.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  async execute(_input, ctx) { return unavailable(ctx); },
};

export const meshDecisionAdd: ToolDef = {
  name: 'mesh_decision_add',
  description: 'Record a decision made while working on this product.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  async execute(_input, ctx) { return unavailable(ctx); },
};
