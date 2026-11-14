import { defineMessages } from './define.ts';

const en = {
  'unavailable': 'Writing to the map, the glossary and the decisions of the product is not available yet',
} as const;

export type MeshWriteMessageKey = keyof typeof en;

export const meshWriteText = defineMessages<MeshWriteMessageKey>('meshwrite', en);
